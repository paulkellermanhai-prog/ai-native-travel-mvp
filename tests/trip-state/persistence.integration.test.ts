import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openSyntheticStorageHarness, openTripStateReader, type SyntheticStorageBatch, type StorageCheckpoint } from "../../src/server/trip-state/internal/persistence";
import type { State } from "../../src/server/trip-state/contracts.generated";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("CI must provision real storage integration tests; skipping is forbidden");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { migrationUrl: string; runtimeUrl: string; database: string; runtimeRole: string; emptyTablesBeforeMigration: number } : null;
const resources: Array<{ close: () => Promise<void> }> = [];
let owner: Client, runtime: Client;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(kind: "applied" | "pending" | "fact-expiry" = "applied") {
  const trip = `trip-test-${crypto.randomBytes(8).toString("hex")}`;
  const value = JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["tests/support/storage-fixtures.py", trip, kind], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })) as { initial: State; batches: SyntheticStorageBatch[]; advance: SyntheticStorageBatch | null };
  for (const batch of value.batches) if (batch.proposalExpiresAt) batch.proposalExpiresAt = new Date(batch.proposalExpiresAt);
  return value;
}
async function harness(fault?: (point: StorageCheckpoint) => void | Promise<void>) {
  const h = await openSyntheticStorageHarness(config!.runtimeUrl, fault); resources.push(h); return h;
}
function reader() { const r = openTripStateReader(config!.runtimeUrl); resources.push(r); return r; }
async function counts(trip: string) {
  const { rows } = await runtime.query(`SELECT
    (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history,
    (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals,
    (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS requests`, [trip]);
  return rows[0];
}
function alternate(batch: SyntheticStorageBatch) {
  const b = structuredClone(batch);
  b.request.idempotency_key += "-other"; b.key.key = b.request.idempotency_key;
  b.key.requestDigest = crypto.createHash("sha256").update(JSON.stringify(b.request)).digest("hex");
  b.intent.id += "-other"; b.change.id += "-other"; b.change.intent_id = b.intent.id;
  return b;
}

describe.skipIf(!config)("E02-02 real PostgreSQL storage", () => {
  beforeAll(async () => {
    owner = new Client({ connectionString: config!.migrationUrl }); runtime = new Client({ connectionString: config!.runtimeUrl });
    await owner.connect(); await runtime.connect();
    const { rows } = await runtime.query("SHOW server_version");
    expect(rows[0].server_version).toMatch(/^17\./);
    expect((await runtime.query("SHOW timezone")).rows[0].TimeZone).toBe("Asia/Shanghai");
    console.info(`Storage integration: PostgreSQL ${rows[0].server_version}; runtime is a separate non-owner identity`);
  });
  afterEach(async () => { await Promise.all(resources.splice(0).map((r) => r.close())); vi.unstubAllEnvs(); });
  afterAll(async () => { await owner?.end(); await runtime?.end(); });

  it("migrates a genuinely empty database and can deploy again without drift", async () => {
    expect(config!.emptyTablesBeforeMigration).toBe(0);
    const { rows } = await owner.query('SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL');
    expect(rows).toHaveLength(1); expect(rows[0].migration_name).toBe("202610280001_trip_state_storage"); expect(rows[0].finished_at).toBeTruthy();
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { encoding: "utf8", env: { ...process.env, MIGRATION_DATABASE_URL: config!.migrationUrl }, stdio: "pipe" });
  });
  it("round-trips real source snapshots and append-only intent/change history", async () => {
    const f = fixture(), h = await harness(), r = reader();
    await h.seedSyntheticSnapshot(f.initial); expect(await r.state(f.initial.trip_id)).toEqual(f.initial);
    for (const batch of f.batches) {
      expect(await h.commitSyntheticBatch(batch)).toEqual({ replayed: false, response: batch.response });
      expect(await r.state(batch.tripId)).toEqual(batch.snapshot);
    }
    expect(await r.history(f.initial.trip_id)).toEqual({ intents: f.batches.map((b) => b.intent), changes: f.batches.map((b) => b.change) });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 7, requests: 7, proposals: 0 });
  });
  it("enforces JSONB trip/version identity in the database even when the adapter is bypassed", async () => {
    const f = fixture(), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    await expect(owner.query('UPDATE "TripStateDocument" SET "revision"=99 WHERE "tripId"=$1', [f.initial.trip_id])).rejects.toMatchObject({ code: "23514" });
    for (const snapshot of [{ ...f.initial, trip_id: "other-trip" }, { ...f.initial, schema_version: "0.2.0" }, { ...f.initial, revision: null }]) {
      await expect(owner.query('UPDATE "TripStateDocument" SET "snapshot"=$1::jsonb WHERE "tripId"=$2', [JSON.stringify(snapshot), f.initial.trip_id])).rejects.toMatchObject({ code: "23514" });
    }
    expect(await reader().state(f.initial.trip_id)).toEqual(f.initial);
  });
  it("stores revisions above the 32-bit SQL integer range without narrowing the source contract", async () => {
    const f = fixture(), h = await harness(); f.initial.revision = 2147483648;
    await h.seedSyntheticSnapshot(f.initial); expect(await reader().state(f.initial.trip_id)).toEqual(f.initial);
  });
  it("rejects inconsistent snapshot/journal/response batches without any partial write", async () => {
    const f = fixture(), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    const b = structuredClone(f.batches[0]); b.change.result_revision += 1;
    await expect(h.commitSyntheticBatch(b)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await reader().state(b.tripId)).toEqual(f.initial); expect(await counts(b.tripId)).toEqual({ history: 0, requests: 0, proposals: 0 });
  });
  it("detects history uniqueness failures and rolls the already-updated snapshot back", async () => {
    const f = fixture(), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]);
    const b = structuredClone(f.batches[1]); b.intent.id = f.batches[0].intent.id; b.change.intent_id = b.intent.id;
    await expect(h.commitSyntheticBatch(b)).rejects.toMatchObject({ code: "P2002" });
    expect(await reader().state(b.tripId)).toEqual(f.batches[0].snapshot); expect(await counts(b.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("serializes two independent connections and rejects the losing expected revision", async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
    const a = await harness(async (point) => { if (point === "snapshot") { entered(); await gate; } }), b = await harness();
    await a.seedSyntheticSnapshot(f.initial);
    const first = a.commitSyntheticBatch(f.batches[0]); await started;
    let secondFinished = false;
    const second = b.commitSyntheticBatch(alternate(f.batches[0])).finally(() => { secondFinished = true; });
    const outcomes = Promise.allSettled([first, second]);
    try { await pause(30); expect(secondFinished).toBe(false); } finally { release(); }
    const result = await outcomes;
    expect(result[0].status).toBe("fulfilled"); expect(result[1]).toMatchObject({ status: "rejected", reason: { code: "VERSION_CONFLICT" } });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("replays persisted idempotency before stale-version rejection and only appends once", async () => {
    const f = fixture(), a = await harness(), b = await harness(); await a.seedSyntheticSnapshot(f.initial);
    const results = await Promise.all([a.commitSyntheticBatch(f.batches[0]), b.commitSyntheticBatch(f.batches[0])]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0].response).toEqual(results[1].response);
    expect(await reader().idempotency(f.initial.trip_id, { actorId: f.batches[0].key.actorId, operationDomain: f.batches[0].key.operationDomain, key: f.batches[0].key.key })).toMatchObject({ requestDigest: f.batches[0].key.requestDigest, response: f.batches[0].response });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("rejects a different body under the same key even if a caller reuses the digest", async () => {
    const f = fixture(), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]);
    const b = structuredClone(f.batches[0]); if ("reason" in b.request) b.request.reason += "changed";
    await expect(h.commitSyntheticBatch(b)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const digestChanged = structuredClone(f.batches[0]); digestChanged.key.requestDigest = "different";
    await expect(h.commitSyntheticBatch(digestChanged)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await counts(b.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("isolates identical object IDs, journal IDs and idempotency keys between trips", async () => {
    const a = fixture(), b = fixture(), h = await harness();
    await h.seedSyntheticSnapshot(a.initial); await h.seedSyntheticSnapshot(b.initial);
    await h.commitSyntheticBatch(a.batches[0]); await h.commitSyntheticBatch(b.batches[0]);
    expect(await reader().state(a.initial.trip_id)).toEqual(a.batches[0].snapshot);
    expect(await reader().state(b.initial.trip_id)).toEqual(b.batches[0].snapshot);
    expect(await counts(a.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 0 });
    expect(await counts(b.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("persists a pending proposal without merging its proposed diff into the state", async () => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]);
    expect(await reader().state(f.initial.trip_id)).toEqual(f.initial);
    const pending = await reader().pending(f.initial.trip_id, f.batches[0].change.proposal_id);
    expect(pending.basisRevision).toBe(0n); expect(pending.expiresAt).toEqual(f.batches[0].proposalExpiresAt);
    expect(pending.payload).toMatchObject({ request: f.batches[0].request, digest: f.batches[0].change.request_digest,
      actor: { id: f.batches[0].intent.actor_id, role: f.batches[0].intent.actor_role },
      cache_key: [f.batches[0].key.actorId, f.batches[0].key.operationDomain, f.batches[0].key.key] });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 1 });
  });
  it("rejects proposal ID reuse and rolls back its new history/cache", async () => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]);
    await expect(h.commitSyntheticBatch(alternate(f.batches[0]))).rejects.toMatchObject({ code: "P2002" });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 1 });
  });
  it.each(["expired", "over-five-minutes"])("rejects %s proposal insertion and rolls back", async (kind) => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    f.batches[0].proposalExpiresAt = new Date(Date.now() + (kind === "expired" ? -1000 : 360000));
    await expect(h.commitSyntheticBatch(f.batches[0])).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 0, requests: 0, proposals: 0 });
  });
  it("caps expiry at the next existing fact expiry", async () => {
    const f = fixture("fact-expiry"), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    f.batches[0].proposalExpiresAt = new Date(f.batches[0].proposalExpiresAt!.getTime() + 1000);
    await expect(h.commitSyntheticBatch(f.batches[0])).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 0, requests: 0, proposals: 0 });
  });
  it("uses actual elapsed database time to reject an expired persisted proposal", async () => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    f.batches[0].proposalExpiresAt = new Date(Date.now() + 2500); await h.commitSyntheticBatch(f.batches[0]);
    await pause(Math.max(0, f.batches[0].proposalExpiresAt.getTime() - Date.now()) + 30);
    await expect(reader().pending(f.initial.trip_id, f.batches[0].change.proposal_id)).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 1 });
  });
  it("marks a proposal unusable when its basis revision changes", async () => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    await h.commitSyntheticBatch(f.batches[0]); await h.commitSyntheticBatch(f.advance!);
    await expect(reader().pending(f.initial.trip_id, f.batches[0].change.proposal_id)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await reader().state(f.initial.trip_id)).toEqual(f.advance!.snapshot);
  });
  for (const outcome of ["applied", "pending"] as const) {
    it.each<StorageCheckpoint>(["snapshot", "history", "proposal", "idempotency", "before-commit"])(`rolls back ${outcome} at %s`, async (point) => {
      const f = fixture(outcome), h = await harness((p) => { if (p === point) throw new Error(`injected:${point}`); });
      await h.seedSyntheticSnapshot(f.initial);
      await expect(h.commitSyntheticBatch(f.batches[0])).rejects.toThrow(`injected:${point}`);
      expect(await reader().state(f.initial.trip_id)).toEqual(f.initial);
      expect(await counts(f.initial.trip_id)).toEqual({ history: 0, requests: 0, proposals: 0 });
    });
  }
  it("separates migration ownership from runtime and forbids all history rewrites", async () => {
    const f = fixture(), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]);
    const identity = (await runtime.query('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(identity).toMatchObject({ name: config!.runtimeRole, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    for (const command of ['UPDATE "TripStateHistory" SET "sequence"="sequence"', 'DELETE FROM "TripStateHistory"', 'TRUNCATE "TripStateHistory"', 'ALTER TABLE "TripStateHistory" DISABLE TRIGGER ALL', 'CREATE TABLE public.runtime_cannot_own(id int)', 'UPDATE "TripStateDocument" SET "tripId"="tripId"', 'UPDATE "_prisma_migrations" SET checksum=checksum']) {
      await expect(runtime.query(command)).rejects.toMatchObject({ code: "42501" });
    }
    for (const command of ['UPDATE "TripStateHistory" SET "sequence"="sequence"', 'DELETE FROM "TripStateHistory"', 'TRUNCATE "TripStateHistory"']) await expect(owner.query(command)).rejects.toMatchObject({ code: "42501" });
    expect(await counts(f.initial.trip_id)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("cannot rewrite persisted idempotency identity or extend a proposal using the runtime role", async () => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]);
    await expect(runtime.query('UPDATE "TripStateIdempotency" SET "requestDigest"=\'forged\'')).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query('UPDATE "TripStateProposal" SET "expiresAt"="expiresAt"+interval \'1 minute\'')).rejects.toMatchObject({ code: "42501" });
  });
  it("recovers snapshot/history/proposal/cache after disconnect and in a separate Node process", async () => {
    const f = fixture("pending"), h = await harness(); await h.seedSyntheticSnapshot(f.initial); await h.commitSyntheticBatch(f.batches[0]); await h.close();
    const output = JSON.parse(execFileSync(process.execPath, ["tests/support/storage-process.mjs"], { encoding: "utf8", env: { ...process.env, E02_READ_TRIP_ID: f.initial.trip_id }, timeout: 15000 }));
    expect(output.processId).not.toBe(process.pid); expect(output.state).toEqual(f.initial);
    expect(output.history).toEqual([{ intent: f.batches[0].intent, change: f.batches[0].change }]);
    expect(output.proposals).toHaveLength(1); expect(output.requests[0]).toEqual({ requestDigest: f.batches[0].key.requestDigest, request: f.batches[0].request, response: f.batches[0].response });
    expect(await (await harness()).commitSyntheticBatch(f.batches[0])).toEqual({ replayed: true, response: f.batches[0].response });
    expect(await reader().pending(f.initial.trip_id, f.batches[0].change.proposal_id)).toMatchObject({ basisRevision: 0n });
  });
  it("rolls back an uncommitted snapshot and history when an independent process is killed", async () => {
    const f = fixture(), h = await harness(); await h.seedSyntheticSnapshot(f.initial);
    const child = fork("tests/support/storage-process.mjs", [], { env: { ...process.env, E02_PROCESS_MODE: "crash" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    try {
      const [ready] = await once(child, "message"); expect(ready).toEqual({ ready: true });
      child.send(f.batches[0]); const [staged] = await once(child, "message"); expect(staged).toEqual({ staged: true });
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      expect(await reader().state(f.initial.trip_id)).toEqual(f.initial); expect(await counts(f.initial.trip_id)).toEqual({ history: 0, requests: 0, proposals: 0 });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
  it("rejects overprivileged test connections and never creates a production writer", async () => {
    const f = fixture(), h = await harness();
    await expect(openSyntheticStorageHarness(config!.migrationUrl)).rejects.toMatchObject({ code: "STORAGE_IDENTITY" });
    vi.stubEnv("NODE_ENV", "production");
    await expect(openSyntheticStorageHarness(config!.runtimeUrl)).rejects.toMatchObject({ code: "STORAGE_WRITE_DISABLED" });
    await expect(h.seedSyntheticSnapshot(f.initial)).rejects.toMatchObject({ code: "STORAGE_WRITE_DISABLED" });
    await expect(h.commitSyntheticBatch(f.batches[0])).rejects.toMatchObject({ code: "STORAGE_WRITE_DISABLED" });
  });
});
