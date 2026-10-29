import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openIdentity, authConfiguration, type Identity } from "../../src/server/auth/config";
import { sessionHost, userActorId } from "../../src/server/auth/authorization";
import { issueInternalCapability, openInternalTripService } from "../../src/server/auth/internal-service";
import { openTripCommandService } from "../../src/server/trip-state/internal/persistence";
import { grantIdentityRuntime } from "../../scripts/grant-identity-runtime.mjs";
import { requestAt } from "../support/command-fixtures";

const file = process.env.E02_STORAGE_ENV_FILE;
const cfg = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { authUrl: string; migrationUrl: string; runtimeUrl: string } : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("CI requires real isolated authentication storage");
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
  afterEach(async () => { await Promise.all(resources.splice(0).map((r) => r.close())); });
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
  it("refuses missing configuration, weak secrets, public HTTP origins and privileged authentication databases", async () => {
    expect(authConfiguration({ ...configuration(), BETTER_AUTH_URL: "https://antu.example.invalid" }).secureCookies).toBe(true);
    expect(authConfiguration(configuration()).secureCookies).toBe(false);
    expect(() => authConfiguration({})).toThrow(); expect(() => authConfiguration({ ...configuration(), BETTER_AUTH_SECRET: "weak" })).toThrow();
    expect(() => authConfiguration({ ...configuration(), BETTER_AUTH_URL: "http://public.example.invalid" })).toThrow();
    await expect(openIdentity({ ...configuration(), AUTH_DATABASE_URL: cfg!.migrationUrl })).rejects.toThrow("unprivileged non-owner");
  });
});
