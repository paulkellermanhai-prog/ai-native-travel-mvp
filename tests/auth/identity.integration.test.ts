import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openIdentity, authConfiguration, type Identity } from "../../src/server/auth/config";
import { sessionHost, userActorId } from "../../src/server/auth/authorization";
import { issueInternalCapability, openInternalTripService } from "../../src/server/auth/internal-service";
import { openSyntheticStorageHarness, openTripStateReader, openTripCommandService } from "../../src/server/trip-state/internal/persistence";
import { grantIdentityRuntime } from "../../scripts/grant-identity-runtime.mjs";
import { requestAt } from "../support/command-fixtures";

const file = process.env.E02_STORAGE_ENV_FILE;
const cfg = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { authUrl: string; migrationUrl: string; runtimeUrl: string; database: string } : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("CI requires real isolated authentication storage");
const temporaryRoles: string[] = [];
const quoteRole = (name: string) => `"${name.replaceAll('"', '""')}"`;
const resources: Array<{ close: () => Promise<void> }> = [];
let owner: Client;
function configuration() { return { ...process.env, AUTH_DATABASE_URL: cfg!.authUrl, BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: crypto.randomBytes(32).toString("hex") }; }
async function account(identity: Identity) {
  const password = crypto.randomBytes(24).toString("base64url"), email = `${crypto.randomUUID()}@example.invalid`;
  const created = await identity.auth.api.signUpEmail({ body: { name: "Synthetic real-credential test", email, password } });
  const login = await identity.auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin: identity.config.origin }), asResponse: true });
  expect(login.status).toBe(200);
  const cookies = login.headers.getSetCookie(), cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  expect(cookies.some((c) => /httponly/i.test(c))).toBe(true);
  const headers = new Headers({ cookie });
  const session = await identity.auth.api.getSession({ headers }); expect(session).toBeTruthy();
  return { user: created.user, email, password, headers, session: session! };
}
async function setup() {
  const identity = await openIdentity(configuration()); resources.push(identity);
  const a = await account(identity), tripId = `trip-auth-${crypto.randomBytes(8).toString("hex")}`, secret = crypto.randomBytes(32).toString("hex");
  const internal = await openInternalTripService(cfg!.runtimeUrl, secret); resources.push(internal);
  const system = await issueInternalCapability(secret, tripId, { role: "system", id: "system-test-provision" }); await internal.createTrip(tripId, system);
  await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [tripId, a.user.id]);
  const host = sessionHost(identity), service = await openTripCommandService(cfg!.runtimeUrl, host); resources.push(service);
  return { identity, a, tripId, secret, internal, host, service };
}
function goal() { const r = requestAt(1, 0); r.input.target_ids = []; const c = r.commands[0]; if (c.op !== "create" || c.object_type !== "TripGoal") throw new Error("Source fixture"); c.data.destination_ids = []; return r; }

describe.skipIf(!cfg?.authUrl)("E02-05A real password, database Session and live trip authorization", () => {
  beforeAll(async () => { owner = new Client({ connectionString: cfg!.migrationUrl }); await owner.connect(); });
  afterEach(async () => {
    await Promise.all(resources.splice(0).map((r) => r.close()));
    for (const role of temporaryRoles.splice(0).reverse()) { await owner.query(`DROP OWNED BY ${quoteRole(role)}`); await owner.query(`DROP ROLE ${quoteRole(role)}`); }
  });
  afterAll(async () => { await owner?.end(); });
  it("creates hashed credentials and library-issued sessions, then binds only the actual user ID", async () => {
    const f = await setup(); const stored = await f.identity.db.authAccount.findFirst({ where: { userId: f.a.user.id } });
    expect(Boolean(stored?.password && stored.password !== f.a.password)).toBe(true);
    expect(await f.host.authorize(f.tripId, f.a.headers)).toEqual({ tripId: f.tripId, actor: { role: "user", id: userActorId(f.a.user.id) } });
    expect(await f.service.state(f.tripId, f.a.headers)).toMatchObject({ revision: 0, objects: [] });
  });
  it("rejects anonymous, invalid, tampered and expired sessions", async () => {
    const f = await setup();
    for (const h of [new Headers(), new Headers({ cookie: "better-auth.session_token=invalid" }), new Headers({ cookie: f.a.headers.get("cookie")!.replace(/.$/, "x") })]) await expect(f.host.authorize(f.tripId, h)).rejects.toMatchObject({ code: "PERMISSION" });
    await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [f.a.session.session.id]);
    await expect(f.host.authorize(f.tripId, f.a.headers)).rejects.toMatchObject({ code: "PERMISSION" });
  });
  it("does not accept a wrong password or an account ID as a session", async () => {
    const f = await setup(); const response = await f.identity.auth.api.signInEmail({ body: { email: f.a.email, password: crypto.randomBytes(24).toString("hex") }, asResponse: true });
    expect(response.status).toBe(401); await expect(f.host.authorize(f.tripId, { userId: f.a.user.id })).rejects.toMatchObject({ code: "PERMISSION" });
  });
  it("rejects another real user, unknown trips, and identity/role headers", async () => {
    const f = await setup(), other = await account(f.identity);
    await expect(f.host.authorize(f.tripId, other.headers)).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(f.host.authorize("trip-unassigned", f.a.headers)).rejects.toMatchObject({ code: "PERMISSION" });
    const forged = new Headers({ "x-user-id": f.a.user.id, "x-actor-role": "system" }); await expect(f.host.authorize(f.tripId, forged)).rejects.toMatchObject({ code: "PERMISSION" });
    forged.set("cookie", f.a.headers.get("cookie")!); expect((await f.host.authorize(f.tripId, forged)).actor.role).toBe("user");
  });
  it("revocation blocks reads, preview, submit, confirm and cached replay", async () => {
    const f = await setup(), request = goal(); expect(await f.service.submit(f.tripId, request, f.a.headers)).toMatchObject({ outcome: "applied", revision: 1 });
    await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [f.tripId, f.a.user.id]);
    for (const action of [() => f.service.state(f.tripId, f.a.headers), () => f.service.history(f.tripId, f.a.headers), () => f.service.preview(f.tripId, request, f.a.headers), () => f.service.submit(f.tripId, request, f.a.headers), () => f.service.confirm(f.tripId, "proposal-unknown", {}, f.a.headers)]) await expect(action()).rejects.toMatchObject({ code: "PERMISSION" });
  });
  it("rechecks membership after acquiring the aggregate lock; queued requests cannot write after revocation", async () => {
    const f = await setup(), application = `auth_wait_${crypto.randomBytes(6).toString("hex")}`, url = new URL(cfg!.runtimeUrl); url.searchParams.set("application_name", application);
    const service = await openTripCommandService(url.toString(), f.host); resources.push(service);
    await owner.query("BEGIN"); await owner.query('SELECT 1 FROM "TripStateDocument" WHERE "tripId"=$1 FOR UPDATE', [f.tripId]);
    const submitted = service.submit(f.tripId, goal(), f.a.headers);
    try {
      let blocked = false;
      // A separate connection is needed while the owner transaction holds the row lock.
      const observer = new Client({ connectionString: cfg!.migrationUrl }); await observer.connect();
      try { for (let i = 0; i < 150; i++) {
        blocked = (await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked", [application])).rows[0].blocked;
        if (blocked) break; await new Promise((resolve) => setTimeout(resolve, 20));
      } } finally { await observer.end(); }
      expect(blocked).toBe(true); await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1', [f.tripId]); await owner.query("COMMIT");
      expect(await submitted).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
      expect((await owner.query('SELECT "revision" FROM "TripStateDocument" WHERE "tripId"=$1', [f.tripId])).rows[0].revision).toBe("0");
      expect((await owner.query('SELECT count(*)::int AS n FROM "TripStateHistory" WHERE "tripId"=$1', [f.tripId])).rows[0].n).toBe(0);
    } finally { await owner.query("ROLLBACK"); await submitted.catch(() => {}); }
  });
  it("only signed, short-lived, trip-bound internal principals can create a Model Proposal; User confirms with a real Session", async () => {
    const f = await setup(), token = await issueInternalCapability(f.secret, f.tripId, { role: "model", id: "model-test-planner" });
    const pending = await f.internal.submit(f.tripId, goal(), token); expect(pending.outcome).toBe("pending_confirmation");
    expect(await f.service.state(f.tripId, f.a.headers)).toMatchObject({ revision: 0, objects: [] });
    const response = await f.service.confirm(f.tripId, pending.proposal_id!, { expected_revision: 0, idempotency_key: "real-session-confirm", proposal_digest: pending.proposal_digest!, accept: true }, f.a.headers);
    expect(response.outcome).toBe("applied");
    const history = await f.service.history(f.tripId, f.a.headers); expect(history.changes.at(-1)?.confirmation_actor).toBe(userActorId(f.a.user.id));
    for (const wrong of ["static-test-token", await issueInternalCapability(crypto.randomBytes(32).toString("hex"), f.tripId, { role: "model", id: "model-test-planner" })]) await expect(f.internal.state(f.tripId, wrong)).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(f.internal.state("trip-another", token)).rejects.toMatchObject({ code: "PERMISSION" });
    await expect(issueInternalCapability(f.secret, f.tripId, { role: "user", id: "forged-user" })).rejects.toThrow("cannot mint User");
  });
  it("separates authentication permissions from state/history and protects membership and sessions from the trip identity", async () => {
    await expect(grantIdentityRuntime(owner, new URL(cfg!.runtimeUrl).username, new URL(cfg!.runtimeUrl).username)).rejects.toThrow("must be distinct");
    await expect(openIdentity({ ...configuration(), AUTH_DATABASE_URL: cfg!.runtimeUrl })).rejects.toThrow("unprivileged non-owner");
    const auth = new Client({ connectionString: cfg!.authUrl }), trip = new Client({ connectionString: cfg!.runtimeUrl }); await auth.connect(); await trip.connect();
    try {
      for (const sql of ['SELECT * FROM "TripStateDocument"', 'UPDATE "TripMembership" SET "tripId"="tripId"', 'DELETE FROM "TripStateHistory"']) await expect(auth.query(sql)).rejects.toMatchObject({ code: "42501" });
      for (const sql of ['SELECT * FROM "AuthSession"', 'INSERT INTO "TripMembership" ("tripId","userId") VALUES (\'forged\',\'forged\')', 'UPDATE "AuthSession" SET token=token', 'ALTER TABLE "TripStateHistory" DISABLE TRIGGER ALL']) await expect(trip.query(sql)).rejects.toMatchObject({ code: "42501" });
    } finally { await auth.end(); await trip.end(); }
  });
  // Deliberately misconfigure fresh login aliases, never the shared valid runtime roles.
  // All DDL and grants are confined to the explicitly provisioned disposable test database.
  async function role(login: boolean, inherit = true) {
    if (!/^antu_e02_test_[a-z0-9_]+$/.test(cfg!.database)) throw new Error("Isolated role safety database required");
    const name = `antu_gate_${crypto.randomBytes(10).toString("hex")}`, password = crypto.randomBytes(24).toString("hex");
    await owner.query(`CREATE ROLE ${quoteRole(name)} ${login ? "LOGIN" : "NOLOGIN"} ${inherit ? "INHERIT" : "NOINHERIT"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    temporaryRoles.push(name);
    const url = new URL(cfg!.runtimeUrl); url.username = name; url.password = password;
    if (login) await owner.query(`GRANT CONNECT ON DATABASE ${quoteRole(cfg!.database)} TO ${quoteRole(name)}`);
    return { name, url: url.toString() };
  }
  async function badRole(family: "auth" | "trip", mode: "direct-table" | "direct-column" | "inherited-table" | "inherited-column" | "set-table" | "set-column", table: string, column: string, privilege = "SELECT") {
    const alias = await role(true, !mode.startsWith("set-"));
    const base = new URL(family === "auth" ? cfg!.authUrl : cfg!.runtimeUrl).username;
    await owner.query(`GRANT ${quoteRole(base)} TO ${quoteRole(alias.name)} WITH INHERIT TRUE, SET FALSE`);
    const group = mode.startsWith("direct-") ? alias : await role(false);
    if (mode.startsWith("inherited-")) await owner.query(`GRANT ${quoteRole(group.name)} TO ${quoteRole(alias.name)} WITH INHERIT TRUE, SET FALSE`);
    if (mode.startsWith("set-")) await owner.query(`GRANT ${quoteRole(group.name)} TO ${quoteRole(alias.name)} WITH INHERIT FALSE, SET TRUE`);
    const columns = mode.endsWith("column") ? ` (${quoteRole(column)})` : "";
    await owner.query(`GRANT ${privilege}${columns} ON public.${quoteRole(table)} TO ${quoteRole(group.name)}`);
    // Column-only privileges really do evade has_table_privilege; inherited and SET-only cases have distinct reachability.
    const [probe] = (await owner.query(`SELECT has_table_privilege($1,$2,'${privilege}') AS table_acl,
      has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS column_acl,
      pg_has_role($1,$3,'USAGE') AS inherited, pg_has_role($1,$3,'SET') AS can_set`, [alias.name, `public.${quoteRole(table)}`, group.name])).rows;
    if (mode.endsWith("column")) expect(probe.table_acl).toBe(false);
    if (mode.startsWith("set-")) { expect(probe.inherited).toBe(false); expect(probe.can_set).toBe(true); }
    else if (mode.endsWith("column")) expect(probe.column_acl).toBe(true);
    const tripRole = family === "trip" ? alias.name : new URL(cfg!.runtimeUrl).username;
    const authRole = family === "auth" ? alias.name : new URL(cfg!.authUrl).username;
    await expect(grantIdentityRuntime(owner, tripRole, authRole)).rejects.toThrow("isolated table and column permissions");
    if (family === "auth") await expect(openIdentity({ ...configuration(), AUTH_DATABASE_URL: alias.url })).rejects.toThrow("unprivileged non-owner");
    else {
      await expect(openTripCommandService(alias.url, { authorize: () => { throw new Error("Must fail before authorization"); } })).rejects.toMatchObject({ code: "STORAGE_IDENTITY" });
      await expect(openSyntheticStorageHarness(alias.url)).rejects.toMatchObject({ code: "STORAGE_IDENTITY" });
      const reader = openTripStateReader(alias.url); resources.push(reader);
      await expect(reader.state("trip-unreadable")).rejects.toMatchObject({ code: "STORAGE_IDENTITY" });
    }
  }
  const forbidden = [
    ["auth", "TripStateDocument", "tripId"], ["auth", "TripStateHistory", "sequence"],
    ["auth", "TripStateProposal", "proposalId"], ["auth", "TripStateIdempotency", "key"],
    ["trip", "AuthUser", "id"], ["trip", "AuthSession", "id"], ["trip", "AuthAccount", "id"],
    ["trip", "AuthVerification", "id"], ["trip", "AuthRateLimit", "id"], ["trip", "TripMembership", "tripId"],
  ] as const;
  for (const [family, table, column] of forbidden) {
    for (const mode of ["direct-table", "direct-column", "inherited-table", "inherited-column"] as const) {
      it(`rejects ${family} role ${mode} access to ${table} in deployment and runtime`, async () => {
        await badRole(family, mode, table, column, mode.endsWith("column") ? "UPDATE" : "SELECT");
      });
    }
  }
  for (const [family, table, column] of [forbidden[1], forbidden[7]]) {
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
      it(`rejects ${family} ${privilege} table access to ${table}`, async () => { await badRole(family, "direct-table", table, column, privilege); });
    }
    for (const privilege of ["SELECT", "INSERT", "REFERENCES"]) {
      it(`rejects ${family} ${privilege} column-only access to ${table}`, async () => { await badRole(family, "direct-column", table, column, privilege); });
    }
    for (const mode of ["set-table", "set-column"] as const) {
      it(`rejects ${family} NOINHERIT ${mode} access to ${table}`, async () => { await badRole(family, mode, table, column); });
    }
  }
  for (const family of ["auth", "trip"] as const) {
    it(`allows legitimate inherited ${family} permissions and existing operations`, async () => {
      const alias = await role(true), base = new URL(family === "auth" ? cfg!.authUrl : cfg!.runtimeUrl).username;
      await owner.query(`GRANT ${quoteRole(base)} TO ${quoteRole(alias.name)} WITH INHERIT TRUE, SET FALSE`);
      if (family === "auth") {
        const identity = await openIdentity({ ...configuration(), AUTH_DATABASE_URL: alias.url }); resources.push(identity);
        const user = await account(identity); expect(user.session.user.id).toBe(user.user.id);
      } else {
        const f = await setup(), service = await openTripCommandService(alias.url, f.host); resources.push(service);
        expect(await service.submit(f.tripId, goal(), f.a.headers)).toMatchObject({ outcome: "applied", revision: 1 });
        expect(await service.history(f.tripId, f.a.headers)).toMatchObject({ changes: [{ result_revision: 1 }] });
      }
      await grantIdentityRuntime(owner, family === "trip" ? alias.name : new URL(cfg!.runtimeUrl).username, family === "auth" ? alias.name : new URL(cfg!.authUrl).username);
    });
  }
  it("retains normal authentication grants and exact authorization EXECUTE when deployment is repeated", async () => {
    const f = await setup(), roles = [new URL(cfg!.runtimeUrl).username, new URL(cfg!.authUrl).username];
    const acl = async () => (await owner.query(`SELECT c.relname,c.relacl::text,a.attname,a.attacl::text
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname IN ('AuthUser','AuthSession','AuthAccount','AuthVerification','AuthRateLimit','TripMembership') AND a.attnum>0
      ORDER BY c.relname,a.attnum`)).rows;
    const before = await acl(); await grantIdentityRuntime(owner, roles[0], roles[1]); expect(await acl()).toEqual(before);
    expect((await owner.query(`SELECT has_function_privilege($1,'public.authorize_trip_session(text,text,text)','EXECUTE') AS allowed`, [roles[0]])).rows[0].allowed).toBe(true);
    expect(await f.service.submit(f.tripId, goal(), f.a.headers)).toMatchObject({ outcome: "applied", revision: 1 });
    expect(await f.service.history(f.tripId, f.a.headers)).toMatchObject({ changes: [{ result_revision: 1 }] });
  });
  it("refuses missing configuration, weak secrets, public HTTP origins and privileged authentication databases", async () => {
    expect(authConfiguration({ ...configuration(), BETTER_AUTH_URL: "https://antu.example.invalid" }).secureCookies).toBe(true);
    expect(authConfiguration(configuration()).secureCookies).toBe(false);
    expect(() => authConfiguration({})).toThrow(); expect(() => authConfiguration({ ...configuration(), BETTER_AUTH_SECRET: "weak" })).toThrow();
    expect(() => authConfiguration({ ...configuration(), BETTER_AUTH_URL: "http://public.example.invalid" })).toThrow();
    await expect(openIdentity({ ...configuration(), AUTH_DATABASE_URL: cfg!.migrationUrl })).rejects.toThrow("unprivileged non-owner");
  });
});
