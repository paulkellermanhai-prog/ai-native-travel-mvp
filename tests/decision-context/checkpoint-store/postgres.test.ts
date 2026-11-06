import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgCheckpointRepository } from "../../../src/server/decision-context/checkpoint-store/repository";

// Explicit isolated local database only; a CI test must not silently skip missing PG.
const e02File = process.env.E02_STORAGE_ENV_FILE;
const e02 = e02File ? JSON.parse(readFileSync(e02File, "utf8")) as { migrationUrl: string } : null;
const url = process.env.E03_CHECKPOINT_TEST_ADMIN_URL ?? e02?.migrationUrl;
const run = Boolean(url) || Boolean(process.env.CI);
const role = `e03_checkpoint_test_${randomUUID().replaceAll("-", "")}`;
const password = randomUUID();
let admin: Pool, runtime: Pool, runtimeUrl: string, roleCreated = false;
const now = new Date("2030-01-01T00:00:00Z");
const sample = (JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string; value:unknown}[]).find((x) => x.schema === "checkpoint-payload")!.value;
const scope = () => ({ owner: randomUUID(), trip: "trip-egypt-test", workspace: "workspace" });
async function waitFor(predicate: () => Promise<boolean>, label: string) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve,20)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitingFor(functionName: string) {
  const row = await admin.query<{ waiting:boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE $2) AS waiting", [role, `%${functionName}%`]);
  return row.rows[0].waiting;
}
async function expiredAt(timestamp: string) {
  return (await admin.query<{expired:boolean}>("SELECT clock_timestamp() >= $1::timestamptz AS expired",[timestamp])).rows[0].expired;
}

describe.skipIf(!run)("E03 checkpoint isolated PostgreSQL repository candidate", () => {
  beforeAll(async () => {
    if (!url) throw new Error("CI requires a disposable E02_STORAGE_ENV_FILE or E03_CHECKPOINT_TEST_ADMIN_URL");
    const parsed = new URL(url);
    const db = parsed.pathname.slice(1);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
        !(db.startsWith("antu_e03_test_") || (url === e02?.migrationUrl && db.startsWith("antu_e02_test_"))))
      throw new Error("Only an explicitly provisioned local E02/E03 disposable test database may be modified");
    admin = new Pool({ connectionString: url });
    const migration = readFileSync("src/server/decision-context/checkpoint-store/migration.sql", "utf8");
    const client = await admin.connect();
    try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext('e03_checkpoint_test_migration'))");
      await client.query(migration); await client.query(migration); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    roleCreated = true;
    const quotedDb = db.replaceAll('"', '""');
    await admin.query(`GRANT CONNECT ON DATABASE "${quotedDb}" TO "${role}"`);
    await admin.query(`GRANT USAGE ON SCHEMA e03_checkpoint TO "${role}"`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA e03_checkpoint TO "${role}"`);
    parsed.username = role; parsed.password = password;
    runtimeUrl = parsed.toString(); runtime = new Pool({ connectionString: runtimeUrl });
  });
  afterAll(async () => {
    await runtime?.end();
    if (admin) { if (roleCreated) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); } await admin.end(); }
  });
  it("executes migration twice and denies direct table/DDL access", async () => {
    await expect(runtime.query("SELECT * FROM e03_checkpoint.heads")).rejects.toThrow();
    await expect(runtime.query("CREATE TABLE e03_checkpoint.bad(id int)")).rejects.toThrow();
  });
  it("serializes independent connections racing the same revision", async () => {
    const s = scope(), a = new PgCheckpointRepository(runtime, null), b = new PgCheckpointRepository(runtime, null);
    const results = await Promise.allSettled([a.save(s, 0, "a", sample, now), b.save(s, 0, "b", sample, now)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CHECKPOINT_CONFLICT" } });
    expect((await a.load(s, now)).revision).toBe(1);
  });
  it("serializes separate OS processes on the same empty checkpoint", async () => {
    const s = scope();
    const children = ["one", "two"].map((key) => spawn(process.execPath,
      ["--import", "tsx", "tests/decision-context/checkpoint-store/race-child.ts"],
      { env: { ...process.env, E03_CHILD_DATABASE_URL: runtimeUrl, E03_CHILD_SCOPE: JSON.stringify(s), E03_CHILD_KEY: key }, stdio: ["pipe", "pipe", "pipe"] }));
    try {
      const outputs = children.map((child) => {
        let output = "", started = false;
        return new Promise<string>((resolve, reject) => {
          child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (!started && output.startsWith("ready\n")) { started = true; child.stdin.end("go\n"); } });
          child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`child exit ${code}`)));
        });
      });
      const rows = (await Promise.all(outputs)).map((value) => JSON.parse(value.trim().split("\n").at(-1)!));
      expect(rows.filter((row) => row.revision === 1)).toHaveLength(1);
      expect(rows.filter((row) => row.code === "CHECKPOINT_CONFLICT")).toHaveLength(1);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  }, 20000);
  it("rolls back before commit and retries an uncertain committed save", async () => {
    const s = scope();
    const failBefore = new PgCheckpointRepository(runtime, null, (p) => { if (p === "before_commit") throw Error("simulated"); });
    await expect(failBefore.save(s, 0, "before", sample, now)).rejects.toMatchObject({ code: "CHECKPOINT_STORAGE" });
    const normal = new PgCheckpointRepository(runtime, null);
    await expect(normal.load(s, now)).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
    const failAfter = new PgCheckpointRepository(runtime, null, (p) => { if (p === "after_commit") throw Error("lost response"); });
    await expect(failAfter.save(s, 0, "after", sample, now)).rejects.toMatchObject({ code: "CHECKPOINT_ACK_UNKNOWN" });
    expect((await normal.save(s, 0, "after", sample, now)).checkpoint_revision).toBe(1);
    await expect(normal.save(s, 1, "after", sample, now)).rejects.toMatchObject({ code: "CHECKPOINT_IDEMPOTENCY" });
  });
  it("does not resurrect deleted payload from an old save receipt", async () => {
    const s = scope(), repo = new PgCheckpointRepository(runtime, null);
    await repo.save(s, 0, "old", sample, now);
    const ack = await repo.delete(s, 1, "delete", now);
    expect(await repo.delete(s, 1, "delete", now)).toEqual(ack);
    await expect(repo.save(s, 0, "old", sample, now)).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
    await expect(repo.load(s, now)).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
  });
  it("separates keys and enforces superseded receipts", async () => {
    const s = scope(), repo = new PgCheckpointRepository(runtime, null);
    await repo.save(s, 0, "first", sample, now);
    await expect(repo.load({ ...s, owner: randomUUID() }, now)).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
    await repo.save(s, 1, "next", sample, now);
    await expect(repo.save(s, 0, "first", sample, now)).rejects.toMatchObject({ code: "CHECKPOINT_SUPERSEDED" });
  });
  it.each(["save","load"] as const)("uses post-lock database time when %s waits across expiry", async (operation) => {
    const s = scope(), repo = new PgCheckpointRepository(runtime, 2);
    const before = (await admin.query<{time:Date}>("SELECT clock_timestamp() AS time")).rows[0].time;
    const initial = await repo.save(s,0,"initial",sample,now);
    const after = (await admin.query<{time:Date}>("SELECT clock_timestamp() AS time")).rows[0].time;
    expect(initial.expires_at).not.toBeNull();
    expect(Date.parse(initial.expires_at!) - Date.parse(initial.saved_at)).toBe(2000);
    expect(Date.parse(initial.saved_at)).toBeGreaterThanOrEqual(before.getTime()-1);
    expect(Date.parse(initial.saved_at)).toBeLessThanOrEqual(after.getTime()+1); // DB clock, not supplied now
    const locker = await admin.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))",[s.owner,s.trip,s.workspace]);
      const pending = (operation === "save" ? repo.save(s,1,"after-expiry",sample,now) : repo.load(s,now))
        .then((value) => ({value}), (error) => ({error}));
      await waitFor(() => waitingFor(operation === "save" ? "write_scene" : "read_scene"),"checkpoint lock");
      await waitFor(() => expiredAt(initial.expires_at!),"checkpoint deadline");
      await locker.query("COMMIT");
      expect(await pending).toMatchObject({error:{code:"CHECKPOINT_EXPIRED"}});
      expect(await repo.revision(s,now)).toBe(1);
      expect((await repo.list(s.owner,s.trip,now))[0].available).toBe(false);
      // A replay returns its original historical ACK only; it does not extend the deadline.
      expect(await repo.save(s,0,"initial",sample,now)).toEqual(initial);
    } finally { await locker.query("ROLLBACK").catch(() => undefined); locker.release(); }
  }, 15000);
});
