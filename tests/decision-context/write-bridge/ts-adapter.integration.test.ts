import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { openIdentity } from "../../../src/server/auth/config";
import { issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { openTSChannels } from "../../../src/server/decision-context/write-bridge/ts-adapter";
import { requestAt } from "../../support/command-fixtures";

const file = process.env.E02_STORAGE_ENV_FILE;
const cfg = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { authUrl: string; migrationUrl: string; runtimeUrl: string; database: string } : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("TS adapter integration requires isolated PostgreSQL and real Session");

describe.skipIf(!cfg?.authUrl)("E03-04 lower TS adapter, real Session and PostgreSQL; not full write bridge", () => {
  it("uses Model for proposal, real User confirmation, durable replay, and live membership revocation", async () => {
    if (!/^antu_e02_test_[a-z0-9_]+$/.test(cfg!.database)) throw new Error("Isolated test database required");
    const secret = crypto.randomBytes(32).toString("hex"), authSecret = crypto.randomBytes(32).toString("hex");
    const application = `e03_bridge_${crypto.randomBytes(6).toString("hex")}`, runtime = new URL(cfg!.runtimeUrl);
    runtime.searchParams.set("application_name", application);
    const env = { ...process.env, DATABASE_URL: runtime.toString(), AUTH_DATABASE_URL: cfg!.authUrl, BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: authSecret };
    const owner = new Client({ connectionString: cfg!.migrationUrl }); await owner.connect();
    const identity = await openIdentity(env), internal = await openInternalTripService(cfg!.runtimeUrl, secret), channels = await openTSChannels(env, secret);
    try {
      const trip = `trip-bridge-${crypto.randomBytes(8).toString("hex")}`;
      async function account() {
        const email = `${crypto.randomUUID()}@example.invalid`, password = crypto.randomBytes(24).toString("base64url");
        const created = await identity.auth.api.signUpEmail({ body: { name: "TS adapter test", email, password } });
        const login = await identity.auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin: "http://127.0.0.1:3117" }), asResponse: true });
        expect(login.status).toBe(200);
        return { id: created.user.id, headers: new Headers({ cookie: login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") }) };
      }
      const user = await account(), other = await account();
      await internal.createTrip(trip, await issueInternalCapability(secret, trip, { role: "system", id: "system-test-provision" }));
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, user.id]);
      const proposal = requestAt(1, 0, "bridge-model-proposal"); proposal.input.target_ids = [];
      const command = proposal.commands[0]; if (command.op !== "create" || command.object_type !== "TripGoal") throw new Error("Source fixture"); command.data.destination_ids = [];
      const token = await issueInternalCapability(secret, trip, { role: "model", id: "model-bridge-test" });
      const [pending, concurrent] = await Promise.all([channels.models.submit(trip, proposal, token), channels.models.submit(trip, proposal, token)]);
      expect(pending.outcome).toBe("pending_confirmation"); expect(concurrent).toEqual(pending);
      expect((await owner.query('SELECT count(*)::int AS n FROM "TripStateHistory" WHERE "tripId"=$1', [trip])).rows[0].n).toBe(1);
      const conflicting = structuredClone(proposal); conflicting.reason = "different payload for same key";
      expect(await channels.models.submit(trip, conflicting, token)).toMatchObject({ outcome: "conflict", errors: [{ code: "IDEMPOTENCY_CONFLICT" }] });
      expect(await channels.users.state(trip, user.headers)).toMatchObject({ revision: 0, objects: [] });
      const confirm = { expected_revision: 0, idempotency_key: "bridge-confirm", proposal_digest: pending.proposal_digest!, accept: true };
      await expect(channels.users.confirm(trip, pending.proposal_id!, confirm, other.headers)).rejects.toMatchObject({ code: "PERMISSION" });
      const result = await channels.users.confirm(trip, pending.proposal_id!, confirm, user.headers); expect(result.outcome).toBe("applied");
      expect(await channels.users.confirm(trip, pending.proposal_id!, confirm, user.headers)).toEqual(result);
      expect(await channels.models.submit(trip, proposal, token)).toEqual(result);
      const before = (await owner.query('SELECT count(*)::int AS n FROM "TripStateHistory" WHERE "tripId"=$1', [trip])).rows[0].n;
      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [trip, user.id]);
      await expect(channels.users.confirm(trip, pending.proposal_id!, confirm, user.headers)).rejects.toMatchObject({ code: "PERMISSION" });
      expect((await owner.query('SELECT count(*)::int AS n FROM "TripStateHistory" WHERE "tripId"=$1', [trip])).rows[0].n).toBe(before);

      // Revoke while a real user write waits for the aggregate lock. The session
      // guard must recheck in that transaction, not rely on the earlier read.
      const raceUser = await account(), raceTrip = `trip-bridge-race-${crypto.randomBytes(8).toString("hex")}`;
      await internal.createTrip(raceTrip, await issueInternalCapability(secret, raceTrip, { role: "system", id: "system-test-provision" }));
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [raceTrip, raceUser.id]);
      const raceRequest = structuredClone(proposal); raceRequest.idempotency_key = "race-user-write";
      const beforeRace = await channels.users.state(raceTrip, raceUser.headers);
      await owner.query("BEGIN"); await owner.query('SELECT 1 FROM "TripStateDocument" WHERE "tripId"=$1 FOR UPDATE', [raceTrip]);
      const submitted = channels.users.submit(raceTrip, raceRequest, raceUser.headers);
      try {
        const observer = new Client({ connectionString: cfg!.migrationUrl }); await observer.connect();
        let blocked = false;
        try {
          for (let i = 0; i < 200 && !blocked; i++) {
            blocked = (await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked", [application])).rows[0].blocked;
            if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
          }
        } finally { await observer.end(); }
        expect(blocked).toBe(true);
        await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [raceTrip, raceUser.id]);
        await owner.query("COMMIT");
        expect(await submitted).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
        const raceRows = await owner.query('SELECT (SELECT "snapshot" FROM "TripStateDocument" WHERE "tripId"=$1) AS snapshot, (SELECT "revision"::text FROM "TripStateDocument" WHERE "tripId"=$1) AS revision, (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS receipts', [raceTrip]);
        expect(raceRows.rows[0]).toEqual({ snapshot: beforeRace, revision: "0", history: 0, proposals: 0, receipts: 0 });
      } finally { await owner.query("ROLLBACK"); await submitted.catch(() => {}); }
    } finally { await Promise.all([channels.close(), internal.close(), identity.close(), owner.end()]); }
  }, 60000);
});
