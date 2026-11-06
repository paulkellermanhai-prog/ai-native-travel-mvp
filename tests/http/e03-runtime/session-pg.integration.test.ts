import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { openIdentity } from "../../../src/server/auth/config";
import { issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { createRuntimeHandler } from "../../../src/server/decision-context/http-adapter/handler";
import { openTSChannels } from "../../../src/server/decision-context/write-bridge/ts-adapter";

const file = process.env.E02_STORAGE_ENV_FILE;
const cfg = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { authUrl: string; migrationUrl: string; runtimeUrl: string; database: string } : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("E03 HTTP integration requires isolated PostgreSQL and real Session");

describe.skipIf(!cfg?.authUrl)("E03 HTTP socket with real Session and PG; unimplemented runtime endpoints stay closed", () => {
  it("authorizes via real session and membership, denies cross-user, expired and revoked sessions with no business writes", async () => {
    if (!/^antu_e02_test_[a-z0-9_]+$/.test(cfg!.database)) throw new Error("Isolated test database required");
    let origin = "", channels: Awaited<ReturnType<typeof openTSChannels>> | undefined;
    const handler = createRuntimeHandler({ get origin() { return origin; }, async authorize(tripId, headers) {
      // Real service revalidates Cookie Session and TripMembership in its read transaction.
      if (!channels || !(await channels.users.state(tripId, headers))) throw new Error("Unavailable");
      return {}; // No DC operation is installed until its actual service is ready.
    } });
    const server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const method = req.method ?? "GET";
        const request = new Request(origin + req.url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
        const response = await handler(request); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    origin = `http://127.0.0.1:${address.port}`;
    const secret = crypto.randomBytes(32).toString("hex"), authSecret = crypto.randomBytes(32).toString("hex");
    const env = { ...process.env, DATABASE_URL: cfg!.runtimeUrl, AUTH_DATABASE_URL: cfg!.authUrl, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret };
    const resources: Array<{ close: () => Promise<void> }> = [];
    const owner = new Client({ connectionString: cfg!.migrationUrl });
    try {
      await owner.connect();
      const identity = await openIdentity(env); resources.push(identity);
      const internal = await openInternalTripService(cfg!.runtimeUrl, secret); resources.push(internal);
      channels = await openTSChannels(env, secret); resources.push(channels);
      async function account() {
        const email = `${crypto.randomUUID()}@example.invalid`, password = crypto.randomBytes(24).toString("base64url");
        const created = await identity.auth.api.signUpEmail({ body: { name: "Runtime HTTP Session test", email, password } });
        const login = await identity.auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin }), asResponse: true });
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
        const session = await identity.auth.api.getSession({ headers: new Headers({ cookie }) }); expect(session).toBeTruthy();
        return { userId: created.user.id, cookie, sessionId: session!.session.id };
      }
      const user = await account(), other = await account(), trip = `trip-http-dc-${crypto.randomBytes(8).toString("hex")}`;
      await internal.createTrip(trip, await issueInternalCapability(secret, trip, { role: "system", id: "system-test-provision" }));
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, user.userId]);
      const fingerprint = async () => (await owner.query('SELECT (SELECT md5("snapshot"::text) FROM "TripStateDocument" WHERE "tripId"=$1) AS snapshot_hash, (SELECT "revision"::text FROM "TripStateDocument" WHERE "tripId"=$1) AS revision, (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS receipts', [trip])).rows[0];
      const before = await fingerprint();
      const call = async (cookie: string, operation = "turns", requestOrigin = origin) => fetch(`${origin}/runtime/trips/${trip}/${operation}`, { method: "POST", headers: { origin: requestOrigin, cookie, "content-type": "application/json" }, body: "{}" });
      expect((await call(user.cookie)).status).toBe(500); // The missing Turn service cannot claim success.
      expect((await call(user.cookie, "checkpoints/save")).status).toBe(503);
      expect((await call(user.cookie, "turns", "http://evil.invalid")).status).toBe(403);
      expect((await call("")).status).toBe(403);
      expect((await call(other.cookie)).status).toBe(403);
      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [trip, user.userId]);
      expect((await call(user.cookie)).status).toBe(403);
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, user.userId]);
      await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [user.sessionId]);
      expect((await call(user.cookie)).status).toBe(403);
      expect(await fingerprint()).toEqual(before);
    } finally {
      await Promise.all(resources.map(r => r.close())); await owner.end();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  }, 60000);
});
