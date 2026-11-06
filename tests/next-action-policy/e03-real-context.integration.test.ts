import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIdentity } from "../../src/server/auth/config";
import { sessionHost } from "../../src/server/auth/authorization";
import { issueInternalCapability, openInternalTripService } from "../../src/server/auth/internal-service";
import { openSessionContextService } from "../../src/server/decision-context/session-context";
import { openTripCommandService } from "../../src/server/trip-state/internal/persistence";
import { NapContractError, validateNapMessage } from "../../src/server/next-action-policy/contracts";
import { requestAt } from "../support/command-fixtures";

// This checks the real Session/PG Context boundary, not the not-yet-implemented Packet service.
// No user data: each test creates synthetic principals and a synthetic trip in a disposable DB.
const path = process.env.E02_STORAGE_ENV_FILE;
const cfg = path ? JSON.parse(fs.readFileSync(path, "utf8")) as {authUrl: string; migrationUrl: string; runtimeUrl: string} : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("CI requires real Session and PostgreSQL");

describe.skipIf(!cfg?.authUrl)("E03 authenticated Context versus the E04 Packet boundary", () => {
  let owner: Client;
  beforeAll(async () => {owner = new Client({connectionString: cfg!.migrationUrl}); await owner.connect();});
  afterAll(async () => {await owner?.end();});

  it("rejects using a real consumed Context as a Packet, and refuses stale or foreign tickets before handoff", async () => {
    const env = {...process.env, DATABASE_URL: cfg!.runtimeUrl, AUTH_DATABASE_URL: cfg!.authUrl,
      BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: crypto.randomBytes(32).toString("hex")};
    const identity = await openIdentity(env);
    const secret = crypto.randomBytes(32).toString("hex"), trip = `trip-e04-boundary-${crypto.randomUUID()}`;
    const internal = await openInternalTripService(cfg!.runtimeUrl, secret);
    const trips = await openTripCommandService(cfg!.runtimeUrl, sessionHost(identity));
    const dc = await openSessionContextService(env);
    try {
      async function account() {
        const email = `${crypto.randomUUID()}@example.invalid`, password = crypto.randomBytes(24).toString("base64url");
        const created = await identity.auth.api.signUpEmail({body: {name: "E03-E04 test", email, password}});
        const login = await identity.auth.api.signInEmail({body: {email, password}, headers: new Headers({origin: identity.config.origin}), asResponse: true});
        expect(login.status).toBe(200);
        return {user: created.user, headers: new Headers({cookie: login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ")})};
      }
      const a = await account(), b = await account();
      await internal.createTrip(trip, await issueInternalCapability(secret, trip, {role: "system", id: "test-bootstrap"}));
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)', [trip, a.user.id, b.user.id]);
      const ticket = await dc.assemble(trip, a.headers, "synthetic-task-label", []);
      const context = await dc.consume(trip, a.headers, ticket);
      expect(context.context.trip_id).toBe(trip);
      expect(context.context.state_revision).toBe(0);
      // This actual Context is not a complete Packet; no invented task/turn/owner fields.
      const request = {nap_contract_version: "0.1.0", decision_id: "synthetic-decision", runtime_id: "synthetic-runtime",
        trigger: {kind: "user_event", reference: "synthetic-event"}, packets: [context]};
      expect(() => validateNapMessage("DecisionRequest", request)).toThrow(NapContractError);
      await expect(dc.consume(trip, b.headers, ticket)).rejects.toMatchObject({code: "PERMISSION"});
      const goal = requestAt(1, 0, `e04-goal-${crypto.randomUUID()}`);
      goal.input.target_ids = [];
      const command = goal.commands[0];
      if (command.op !== "create" || command.object_type !== "TripGoal") throw new Error("Unexpected source fixture");
      command.data.destination_ids = [];
      expect(await trips.submit(trip, goal, b.headers)).toMatchObject({outcome: "applied", revision: 1});
      await expect(dc.consume(trip, a.headers, ticket)).rejects.toMatchObject({code: "PACKET_STALE"});
      const fresh = await dc.assemble(trip, a.headers, "synthetic-task-label", []);
      expect((await dc.consume(trip, a.headers, fresh)).context.state_revision).toBe(1);
    } finally {
      await Promise.all([dc.close(), trips.close(), internal.close()]);
      await identity.close();
    }
  }, 30000);
});
