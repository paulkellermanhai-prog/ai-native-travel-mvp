import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIdentity, type Identity } from "../../../src/server/auth/config";
import { openEvidenceHost } from "../../../src/server/decision-context/host-runtime/evidence-host";
import { issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";

const file = process.env.E02_STORAGE_ENV_FILE;
const config = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { migrationUrl: string; runtimeUrl: string; authUrl: string; runtimeRole: string; database: string } : null;
if (process.env.CI && !config?.authUrl) throw new Error("CI requires disposable PostgreSQL and actual Session");

describe.skipIf(!config?.authUrl)("E11 host recording and deletion with real Session and PostgreSQL", () => {
  let owner: Client, runtime: Client, identity: Identity;
  let host: Awaited<ReturnType<typeof openEvidenceHost>>;
  let internal: Awaited<ReturnType<typeof openInternalTripService>>;
  let created = false;
  const secret = randomBytes(32).toString("hex"), trip = `trip_e11_${randomBytes(8).toString("hex")}`;
  const env = { ...process.env, DATABASE_URL: config?.runtimeUrl, AUTH_DATABASE_URL: config?.authUrl,
    BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: randomBytes(32).toString("hex") };
  async function account() {
    const email = `${randomUUID()}@example.invalid`, password = randomBytes(24).toString("base64url");
    const user = (await identity.auth.api.signUpEmail({ body: { name: "E11 test", email, password } })).user;
    const response = await identity.auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin: identity.config.origin }), asResponse: true });
    expect(response.status).toBe(200);
    const headers = new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
    const session = await identity.auth.api.getSession({ headers });
    if (!session) throw new Error("Expected authenticated session");
    return { user, headers, session, email, password };
  }
  beforeAll(async () => {
    if (!config || !/^antu_e02_test_[a-f0-9]+$/.test(config.database) || !/^antu_e02_runtime_[a-f0-9]+$/.test(config.runtimeRole)) throw new Error("Requires provisioned disposable E02 test database");
    owner = new Client({ connectionString: config.migrationUrl }); await owner.connect();
    const db = await owner.query<{ db: string }>("SELECT current_database() AS db");
    if (db.rows[0]?.db !== config.database) throw new Error("Unexpected database");
    const existing = await owner.query<{ relation: string | null }>("SELECT to_regclass('public.\"HostEvidenceEvent\"')::text AS relation");
    if (existing.rows[0]?.relation) throw new Error("Refusing to replace existing evidence tables");
    await owner.query(fs.readFileSync("src/server/decision-context/host-runtime/sql/001-evidence-record-candidate.sql", "utf8")); created = true;
    const role = `"${config.runtimeRole}"`;
    await owner.query(`GRANT EXECUTE ON FUNCTION public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT), public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT), public.host_evidence_delete_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) TO ${role}`);
    runtime = new Client({ connectionString: config.runtimeUrl }); await runtime.connect();
    identity = await openIdentity(env);
    internal = await openInternalTripService(config.runtimeUrl, secret);
    await internal.createTrip(trip, await issueInternalCapability(secret, trip, { role: "system", id: "e11-bootstrap" }));
    host = await openEvidenceHost(env);
  }, 30000);
  afterAll(async () => {
    await host?.close(); await internal?.close(); await identity?.close(); await runtime?.end();
    if (created) {
      await owner.query('DROP FUNCTION public.host_evidence_cleanup_candidate(TEXT), public.host_evidence_delete_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT), public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT)');
      await owner.query('DROP TABLE public."HostEvidenceCleanup", public."HostEvidenceEvent", public."HostEvidenceWorkspace"');
    }
    await owner?.end();
  }, 30000);
  it("binds actual sessions, persists concurrent idempotent records, denies cross-session access, and keeps deletion after failed cleanup", async () => {
    const a = await account(), b = await account();
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)', [trip, a.user.id, b.user.id]);
    const workspace = await host.createWorkspace(trip, a.headers);
    const input = { entry: "dialogue", text: "原话 🌏", idempotency_key: `key_${randomUUID()}` };
    const [first, second] = await Promise.all([host.record(workspace, a.headers, input), host.record(workspace, a.headers, input)]);
    expect(first.event_id).toBe(second.event_id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.durable).toBe(true);
    await expect(host.record(workspace, a.headers, { ...input, text: "不同正文" })).rejects.toMatchObject({ code: "EVENT_KEY_CONFLICT" });
    await expect(host.record(workspace, b.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
    await expect(host.record({ ...workspace }, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
    await expect(runtime.query('SELECT body FROM public."HostEvidenceEvent"')).rejects.toThrow();
    const deleted = await host.deleteEvent(workspace, a.headers, first.event_id);
    expect(deleted).toMatchObject({ durable: true, cleanup_pending: true });
    expect(await host.deleteEvent(workspace, a.headers, first.event_id)).toEqual(deleted);
    await expect(host.record(workspace, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_DELETED" });
    await owner.query("BEGIN");
    await owner.query("SELECT public.host_evidence_cleanup_candidate($1)", [first.event_id]);
    await owner.query("ROLLBACK");
    const pending = await owner.query('SELECT body,deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1', [first.event_id]);
    expect(pending.rows[0]).toMatchObject({ body: input.text }); expect(pending.rows[0].deleted_at).toBeTruthy();
    await expect(host.record(workspace, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_DELETED" });
    await owner.query("SELECT public.host_evidence_cleanup_candidate($1)", [first.event_id]);
    await owner.query("SELECT public.host_evidence_cleanup_candidate($1)", [first.event_id]);
    const cleaned = await owner.query('SELECT body,input_digest,session_ref,deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1', [first.event_id]);
    expect(cleaned.rows[0]).toMatchObject({ body: null, input_digest: null, session_ref: null }); expect(cleaned.rows[0].deleted_at).toBeTruthy();
    expect((await host.deleteEvent(workspace, a.headers, first.event_id)).cleanup_pending).toBe(false);
    await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [trip, a.user.id]);
    await expect(host.record(workspace, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
  }, 30000);
  it("rejects an expired session after a workspace was issued", async () => {
    const a = await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, a.user.id]);
    const workspace = await host.createWorkspace(trip, a.headers);
    await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [a.session.session.id]);
    await expect(host.record(workspace, a.headers, { entry: "dialogue", text: "x", idempotency_key: "expired" })).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
  }, 30000);
  it.each(["revoke", "expire"] as const)("rechecks %s inside the record transaction", async mode => {
    const a = await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, a.user.id]);
    const workspace = await host.createWorkspace(trip, a.headers);
    const pid = (await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN");
    let committed = false;
    try {
      if (mode === "revoke") await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [trip, a.user.id]);
      else await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [a.session.session.id]);
      const pending = host.record(workspace, a.headers, { entry: "dialogue", text: "never persisted", idempotency_key: `race_${randomUUID()}` })
        .then(() => ({ code: "unexpected-success" }), error => ({ code: error?.code as string }));
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await owner.query<{ blocked: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%authorize_trip_session%') AS blocked", [pid]);
        if (result.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      await owner.query("COMMIT"); committed = true;
      expect(await pending).toEqual({ code: "EVIDENCE_ACCESS_DENIED" });
      const records = await owner.query<{ count: string }>('SELECT count(*)::text AS count FROM public."HostEvidenceEvent" WHERE owner_id=$1 AND body=$2', [a.user.id, "never persisted"]);
      expect(records.rows[0].count).toBe("0");
    } finally { if (!committed) await owner.query("ROLLBACK"); }
  }, 30000);
});
