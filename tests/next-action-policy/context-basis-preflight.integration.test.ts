import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openIdentity, type Identity } from "../../src/server/auth/config";
import { sessionHost } from "../../src/server/auth/authorization";
import { issueInternalCapability, openInternalTripService } from "../../src/server/auth/internal-service";
import { openSyntheticStorageHarness, openTripCommandService } from "../../src/server/trip-state/internal/persistence";
import { openNapContextBasisPreflight, NapContextBasisError } from "../../src/server/next-action-policy/context-basis-preflight";
import * as assembly from "../../src/server/decision-context/context-assembly";
import { requestAt } from "../support/command-fixtures";
import { base } from "../support/bcg-fixtures";

const path = process.env.E02_STORAGE_ENV_FILE;
const cfg = path ? JSON.parse(fs.readFileSync(path, "utf8")) as {authUrl: string; migrationUrl: string; runtimeUrl: string} : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("CI requires real Session and PostgreSQL");
const resources: Array<{close: () => Promise<void>}> = [];
let owner: Client;
function config() {return {...process.env, DATABASE_URL: cfg!.runtimeUrl, AUTH_DATABASE_URL: cfg!.authUrl,
  BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: crypto.randomBytes(32).toString("hex")};}
async function account(identity: Identity) {
  const email = `${crypto.randomUUID()}@example.invalid`, password = crypto.randomBytes(24).toString("base64url");
  const created = await identity.auth.api.signUpEmail({body: {name: "Synthetic preflight", email, password}});
  const login = await identity.auth.api.signInEmail({body: {email, password}, headers: new Headers({origin: identity.config.origin}), asResponse: true});
  expect(login.status).toBe(200);
  return {user: created.user, email, password, headers: new Headers({cookie: login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ")})};
}
async function setup() {
  const env = config(), identity = await openIdentity(env); resources.push(identity);
  const a = await account(identity), b = await account(identity), trip = `trip-nap-preflight-${crypto.randomUUID()}`;
  const secret = crypto.randomBytes(32).toString("hex"), internal = await openInternalTripService(cfg!.runtimeUrl, secret); resources.push(internal);
  await internal.createTrip(trip, await issueInternalCapability(secret, trip, {role: "system", id: "test-bootstrap"}));
  await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)', [trip, a.user.id, b.user.id]);
  const trips = await openTripCommandService(cfg!.runtimeUrl, sessionHost(identity)); resources.push(trips);
  const preflight = await openNapContextBasisPreflight(env); resources.push(preflight);
  return {a, b, trip, trips, preflight, identity, env};
}
function plan(context: Awaited<ReturnType<Awaited<ReturnType<typeof openNapContextBasisPreflight>>["assemble"]>>["context"]) {
  return {nap_contract_version: "0.1.0", decision_id: "synthetic-decision", runtime_id: "synthetic-runtime",
    basis: [{packet_id: "unverified-packet", turn_id: "unverified-turn", task_key: context.context.task_id,
      state_revision: context.context.state_revision, snapshot_digest: context.snapshot_digest, expires_at: context.context.expires_at}],
    response: {request_ids: [], disposition: "answered", text: "Synthetic answer", evidence_refs: []}, actions: []};
}

describe.skipIf(!cfg?.authUrl)("read-only NAP comparison against a real Session/PG Context", () => {
  beforeAll(async () => {owner = new Client({connectionString: cfg!.migrationUrl}); await owner.connect();});
  afterAll(async () => {await owner?.end();});
  it("rechecks a live Context, rejects mismatched basis, foreign sessions, revocation and a changed TS revision", async () => {
    const f = await setup();
    try {
      const {ticket, context} = await f.preflight.assemble(f.trip, f.a.headers, "synthetic-task", []), candidate = plan(context);
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, candidate)).resolves.toBeUndefined();
      // Neither fabricated Packet ID nor turn ID is checked by this Context-only adapter.
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, {...candidate, basis: [{...candidate.basis[0], packet_id: "forged", turn_id: "forged"}]})).resolves.toBeUndefined();
      for (const patch of [{task_key: "other"}, {state_revision: 1}, {snapshot_digest: "f".repeat(64)}, {expires_at: "2030-01-01T00:00:00Z"}]) {
        await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, {...candidate, basis: [{...candidate.basis[0], ...patch}]})).rejects.toBeInstanceOf(NapContextBasisError);
      }
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, {...candidate, basis: [...candidate.basis, candidate.basis[0]]})).rejects.toBeInstanceOf(NapContextBasisError);
      await expect(f.preflight.inspect(f.trip, f.b.headers, ticket, candidate)).rejects.toMatchObject({code: "PERMISSION"});
      await expect(f.preflight.inspect(f.trip, f.a.headers, {...ticket}, candidate)).rejects.toMatchObject({code: "PERMISSION"});
      const pending = f.preflight.inspect(f.trip, f.a.headers, ticket, candidate);
      candidate.basis[0].state_revision = 1;
      await expect(pending).resolves.toBeUndefined(); // Mutation after call cannot alter the captured plan.
      candidate.basis[0].state_revision = 0;
      const goal = requestAt(1, 0, `nap-goal-${crypto.randomUUID()}`); goal.input.target_ids = [];
      const command = goal.commands[0]; if (command.op !== "create" || command.object_type !== "TripGoal") throw new Error("Unexpected fixture");
      command.data.destination_ids = [];
      expect(await f.trips.submit(f.trip, goal, f.b.headers)).toMatchObject({outcome: "applied", revision: 1});
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, candidate)).rejects.toMatchObject({code: "PACKET_STALE"});
      const refreshed = await f.preflight.assemble(f.trip, f.a.headers, "synthetic-task", []);
      await expect(f.preflight.inspect(f.trip, f.a.headers, refreshed.ticket, plan(refreshed.context))).resolves.toBeUndefined();
      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [f.trip, f.a.user.id]);
      await expect(f.preflight.inspect(f.trip, f.a.headers, refreshed.ticket, plan(refreshed.context))).rejects.toMatchObject({code: "PERMISSION"});
    } finally {await Promise.all(resources.splice(0).map(r => r.close()));}
  }, 30000);
  it("rejects the same user in a different Session and never restores a ticket in another service or process", async () => {
    const f = await setup();
    try {
      const {ticket, context} = await f.preflight.assemble(f.trip, f.a.headers, "synthetic-task", []), candidate = plan(context);
      const secondLogin = await f.identity.auth.api.signInEmail({body: {email: f.a.email, password: f.a.password},
        headers: new Headers({origin: f.identity.config.origin}), asResponse: true});
      expect(secondLogin.status).toBe(200);
      const otherHeaders = new Headers({cookie: secondLogin.headers.getSetCookie().map(c => c.split(";")[0]).join("; ")});
      const firstSession = await f.identity.auth.api.getSession({headers: f.a.headers, query: {disableCookieCache: true}});
      const secondSession = await f.identity.auth.api.getSession({headers: otherHeaders, query: {disableCookieCache: true}});
      expect(firstSession).toBeTruthy(); expect(secondSession).toBeTruthy();
      expect(firstSession?.user.id).toBe(secondSession?.user.id);
      expect(firstSession?.session.id).not.toBe(secondSession?.session.id);
      await expect(f.preflight.inspect(f.trip, otherHeaders, ticket, candidate)).rejects.toMatchObject({code: "PERMISSION"});
      const otherService = await openNapContextBasisPreflight(f.env); resources.push(otherService);
      await expect(otherService.inspect(f.trip, f.a.headers, ticket, candidate)).rejects.toMatchObject({code: "PERMISSION"});
      // An opaque ticket has no transferable contents. A new process with the same
      // credentials and DB receives its serialized value over stdin, never a grant.
      const child = `
        import fs from "node:fs";
        import {openNapContextBasisPreflight} from "./src/server/next-action-policy/context-basis-preflight.ts";
        const p=JSON.parse(fs.readFileSync(0,"utf8"));
        const service=await openNapContextBasisPreflight(p.env);
        try {await service.inspect(p.trip,new Headers({cookie:p.cookie}),p.ticket,p.plan);process.stdout.write("UNEXPECTED_SUCCESS");}
        catch(e) {process.stdout.write(e?.code === "PERMISSION" ? "PERMISSION" : "UNEXPECTED_ERROR");}
        finally {await service.close();}
      `;
      const childEnv = {DATABASE_URL: f.env.DATABASE_URL, AUTH_DATABASE_URL: f.env.AUTH_DATABASE_URL,
        BETTER_AUTH_URL: f.env.BETTER_AUTH_URL, BETTER_AUTH_SECRET: f.env.BETTER_AUTH_SECRET};
      const input = {env: childEnv, trip: f.trip, cookie: f.a.headers.get("cookie"), ticket: JSON.parse(JSON.stringify(ticket)), plan: candidate};
      let result: string;
      try {result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child],
        {input: JSON.stringify(input), encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"]}).trim();}
      catch {throw new Error("Isolated preflight process failed; details suppressed");}
      expect(result).toBe("PERMISSION");
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, candidate)).resolves.toBeUndefined();
    } finally {await Promise.all(resources.splice(0).map(r => r.close()));}
  }, 30000);

  it("denies membership revoked between E03's first and final Context checks", async () => {
    const f = await setup();
    try {
      const {ticket, context} = await f.preflight.assemble(f.trip, f.a.headers, "synthetic-task", []), candidate = plan(context);
      const original = assembly.validateContextSnapshot;
      let checks = 0;
      // Test-only synchronization inserts a real committed DB revocation between
      // the two existing E03 checks; production receives no test callback.
      const child = `
        import fs from "node:fs";
        import pg from "pg";
        const p=JSON.parse(fs.readFileSync(0,"utf8"));
        const db=new pg.Client({connectionString:p.url});await db.connect();
        try {const r=await db.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[p.trip,p.user]);
          if(r.rowCount!==1)throw Error("membership not revoked");process.stdout.write("REVOKED");}
        finally {await db.end();}
      `;
      const spy = vi.spyOn(assembly, "validateContextSnapshot").mockImplementation((...args) => {
        checks++; original(...args);
        if (checks === 1) {
          try {
            const result = execFileSync(process.execPath, ["--input-type=module", "-e", child], {
              input: JSON.stringify({url: cfg!.migrationUrl, trip: f.trip, user: f.a.user.id}), encoding: "utf8", timeout: 15000,
              stdio: ["pipe", "pipe", "pipe"],
            });
            if (result !== "REVOKED") throw new Error("Revocation did not commit");
          } catch {throw new Error("Isolated PostgreSQL revocation failed; details suppressed");}
        }
      });
      try {
        await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, candidate)).rejects.toMatchObject({code: "PERMISSION"});
        expect(checks).toBe(1); // The second live authorization rejected before a second snapshot validation.
      } finally {spy.mockRestore();}
    } finally {await Promise.all(resources.splice(0).map(r => r.close()));}
  }, 30000);

  it("does not promise a previous successful observation remains authorized after revocation", async () => {
    const f = await setup();
    try {
      const {ticket, context} = await f.preflight.assemble(f.trip, f.a.headers, "synthetic-task", []), candidate = plan(context);
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, candidate)).resolves.toBeUndefined();
      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [f.trip, f.a.user.id]);
      await expect(f.preflight.inspect(f.trip, f.a.headers, ticket, candidate)).rejects.toMatchObject({code: "PERMISSION"});
      // The earlier return is only a completed observation; there is no transaction
      // spanning it and a later side effect or durable token to revoke.
    } finally {await Promise.all(resources.splice(0).map(r => r.close()));}
  }, 30000);
  it("rejects the old basis on selected fact expiry even when revision has not changed", async () => {
    const f = await setup();
    try {
      const trip = `trip-nap-expiry-${crypto.randomUUID()}`, state = structuredClone(base), now = Date.now();
      state.trip_id = trip;
      for (const item of state.objects) {item.trip_id = trip; if (item.type === "ExternalFact") {
        item.observed_at = new Date(now - 60000).toISOString(); item.expires_at = new Date(now + 60000).toISOString().replace("Z", "500Z");
      }}
      const seed = await openSyntheticStorageHarness(cfg!.runtimeUrl); resources.push(seed); await seed.seedSyntheticSnapshot(state);
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, f.a.user.id]);
      const assembled = await f.preflight.assemble(trip, f.a.headers, "synthetic-task", ["skeleton-a"]);
      const candidate = plan(assembled.context);
      expect(Date.parse(candidate.basis[0].expires_at)).toBe(now + 60000);
      await expect(f.preflight.inspect(trip, f.a.headers, assembled.ticket, candidate)).resolves.toBeUndefined();
      vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(now + 60000);
      await expect(f.preflight.inspect(trip, f.a.headers, assembled.ticket, candidate)).rejects.toBeInstanceOf(NapContextBasisError);
      vi.setSystemTime(now + 60001);
      await expect(f.preflight.inspect(trip, f.a.headers, assembled.ticket, candidate)).rejects.toMatchObject({code: "PACKET_EXPIRED"});
      const fresh = await f.preflight.assemble(trip, f.a.headers, "synthetic-task", ["skeleton-a"]);
      expect(fresh.context.context.state_revision).toBe(state.revision);
      expect(fresh.context.context.stale_fact_ids).toContain("fact-cairo-luxor");
    } finally {vi.useRealTimers(); await Promise.all(resources.splice(0).map(r => r.close()));}
  }, 30000);
});
