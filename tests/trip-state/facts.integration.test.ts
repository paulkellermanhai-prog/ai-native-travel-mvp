import fs from "node:fs";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openTripCommandService, openSyntheticStorageHarness, type CommandHost } from "../../src/server/trip-state/internal/persistence";
import type { ConfirmRequest } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, object, change } from "../support/bcg-fixtures";
import { clock, uuids, oracle } from "../support/command-fixtures";
import { ingest, cancellation, factActors as actors, factSegments, type FactResult } from "../support/fact-fixtures";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("ExternalFact CI requires real PostgreSQL");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { runtimeUrl: string; migrationUrl: string; runtimeRole: string } : null;
const resources: Array<{ close: () => Promise<void> }> = [];
type Response = TripStateContracts["response"];
let runtime: Client, owner: Client;
async function setup(initial: State = base, start = 4000) {
  const state = structuredClone(initial), tripId = `trip-fact-${crypto.randomBytes(8).toString("hex")}`;
  state.trip_id = tripId; for (const o of state.objects) o.trip_id = tripId; // Test isolation only; no source objects/fields removed.
  const seed = await openSyntheticStorageHarness(config!.runtimeUrl); resources.push(seed); await seed.seedSyntheticSnapshot(state);
  const tokens = Object.fromEntries(Object.keys(actors).map((role) => [role, Object.freeze({})]));
  let now = clock();
  const host: CommandHost = { clock: () => now, uuid: uuids(start), authorize: (trip, credential) => {
    const role = Object.keys(tokens).find((r) => tokens[r] === credential);
    if (trip !== tripId || !role) throw new Error("Host denied access"); return { tripId, actor: actors[role as keyof typeof actors] };
  } };
  const open = async (overrides: Partial<CommandHost> = {}) => { const s = await openTripCommandService(config!.runtimeUrl, { ...host, ...overrides }); resources.push(s); return s; };
  return { state, tripId, tokens, open, s: await open(), at: (time: string) => { now = new Date(time); } };
}
async function stored(tripId: string) {
  const rows = [];
  for (const table of ["TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency"]) rows.push((await runtime.query(`SELECT row_to_json(t) AS value FROM "${table}" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text`, [tripId])).rows);
  return rows;
}
async function counts(tripId: string) {
  return (await runtime.query('SELECT (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS requests', [tripId])).rows[0];
}
function confirm(pending: Response, revision: number): ConfirmRequest { return { expected_revision: revision, idempotency_key: "fact-confirm", proposal_digest: pending.proposal_digest!, accept: true }; }
async function child(message: object) {
  const worker = fork("tests/support/confirmation-process.mjs", [], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; worker.stderr?.on("data", (data) => { errors += String(data); }); const exit = once(worker, "exit");
  try {
    expect((await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]))[0]).toEqual({ ready: true }); worker.send(message);
    const [result] = await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]); await exit;
    return result as { response: Response; processId: number };
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
}

describe.skipIf(!config)("E02-04C real PostgreSQL ExternalFact transactions", () => {
  beforeAll(async () => { runtime = new Client({ connectionString: config!.runtimeUrl }); owner = new Client({ connectionString: config!.migrationUrl }); await runtime.connect(); await owner.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((s) => s.close())); });
  afterAll(async () => { await runtime?.end(); await owner?.end(); });

  it.each(factSegments)("$name: actual stored response/state/history match independently executed Python", async (segment) => {
    const f = await setup(segment.initial, segment.uuidStart), python = oracle<FactResult[]>({ initial: f.state, operations: segment.steps, uuidStart: segment.uuidStart }), actual = [];
    let writes = 0;
    for (const [i, step] of segment.steps.entries()) {
      const before = await stored(f.tripId), response = await f.s.submit(f.tripId, step.request, f.tokens[step.actor.role]);
      const state_after = await f.s.state(f.tripId, f.tokens.user), audit = await f.s.history(f.tripId, f.tokens.user);
      expect({ response, state_after, audit }).toEqual(python[i]);
      if (response.outcome === "applied") writes++; else expect(await stored(f.tripId)).toEqual(before);
      actual.push({ step: i + 1, response, state_after, audit, independent_python_match: true });
    }
    expect(await counts(f.tripId)).toEqual({ history: writes, requests: writes, proposals: 0 });
    if (process.env.E02_FACT_STORAGE_EVIDENCE_PATH) fs.appendFileSync(process.env.E02_FACT_STORAGE_EVIDENCE_PATH, JSON.stringify({ segment: segment.name, namespace_only_change: true, actual }) + "\n");
  });
  it("Tool preview executes rules without writing any of the four tables or consuming an idempotency key", async () => {
    const f = await setup(), request = change(f.state, [ingest()]), before = await stored(f.tripId);
    const preview = await f.s.preview(f.tripId, request, f.tokens.tool);
    expect(preview.outcome).toBe("preview"); expect(await stored(f.tripId)).toEqual(before);
    expect(await f.s.submit(f.tripId, request, f.tokens.tool)).toMatchObject({ outcome: "applied", revision: 1 });
    expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it.each(["user", "model", "system"] as const)("host-authorized %s still cannot impersonate Tool; denied batches leave SQL unchanged", async (role) => {
    const f = await setup(), before = await stored(f.tripId), request = change(f.state, [ingest()]);
    for (const method of ["preview", "submit"] as const) expect(await f.s[method](f.tripId, request, f.tokens[role])).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
    expect(await stored(f.tripId)).toEqual(before);
  });
  it("host access checks reject forged Actor, cross-trip Tool access and request Actor injection", async () => {
    const a = await setup(), b = await setup(), request = change(a.state, [ingest()]), before = await stored(a.tripId);
    await expect(a.s.submit(a.tripId, request, actors.tool)).rejects.toThrow("Host denied");
    await expect(a.s.submit(b.tripId, request, a.tokens.tool)).rejects.toThrow("Host denied");
    expect(await a.s.submit(a.tripId, { ...request, actor: actors.tool }, a.tokens.tool)).toMatchObject({ outcome: "rejected", errors: [{ code: "SCHEMA" }] });
    expect(await stored(a.tripId)).toEqual(before); expect(await b.s.state(b.tripId, b.tokens.user)).toEqual(b.state);
  });
  it("Tool may not combine ingestion with a user operation or fabricate a confirmation", async () => {
    const f = await setup(), before = await stored(f.tripId);
    expect(await f.s.submit(f.tripId, change(f.state, [ingest(), { op: "decide_candidate", id: "candidate-luxor", value: "reject" }]), f.tokens.tool)).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
    expect(await stored(f.tripId)).toEqual(before);
  });
  it("persists distinct timeout evidence across process restart, replays its original response and rejects changed-key content", async () => {
    const f = await setup(), c = ingest(); c.data.query_status = "timeout"; c.data.value = null;
    const request = change(f.state, [c], "persistent-fact-key"), response = await f.s.submit(f.tripId, request, f.tokens.tool); await f.s.close();
    const replay = await child({ method: "submit", syntheticActor: "tool", tripId: f.tripId, request });
    expect(replay.processId).not.toBe(process.pid); expect(replay.response).toEqual(response);
    const reopened = await f.open(), state = (await reopened.state(f.tripId, f.tokens.user))!, before = await stored(f.tripId);
    expect(object(state, c.id, "ExternalFact")).toMatchObject({ query_status: "timeout", value: null, verification: "unverified" });
    expect(await reopened.submit(f.tripId, { ...request, reason: "different content" }, f.tokens.tool)).toMatchObject({ outcome: "conflict", errors: [{ code: "IDEMPOTENCY_CONFLICT" }] });
    expect(await stored(f.tripId)).toEqual(before); expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  }, 15000);
  it("a fresh System OS process expires observations atomically and recovery preserves all original values and provenance", async () => {
    const f = await setup(), request = change(f.state, [{ op: "check_freshness" }], "persistent-expiry"); await f.s.close();
    const result = await child({ method: "submit", syntheticActor: "system", tripId: f.tripId, request, clock: "2030-01-02T00:00:00Z", uuidStart: 4000 });
    const s = await f.open(), python = oracle<FactResult[]>({ initial: f.state, operations: [{ actor: actors.system, request, clock: "2030-01-02T00:00:00Z" }], uuidStart: 4000 });
    expect(result.response).toEqual(python[0].response); expect(await s.state(f.tripId, f.tokens.user)).toEqual(python[0].state_after); expect(await s.history(f.tripId, f.tokens.user)).toEqual(python[0].audit);
    const replay = await child({ method: "submit", syntheticActor: "system", tripId: f.tripId, request }); expect(replay.response).toEqual(result.response);
    expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  }, 15000);
  it("serializes two same-revision fact replacements with one conflict and no lost observation", async () => {
    const f = await setup(), other = await f.open(), commands = (id: string) => [{ op: "transition" as const, id: "fact-cairo-luxor", event: "supersede" as const }, ingest(id)] as const;
    const a = change(f.state, [...commands("fact-update-a")], "replace-a"), b = change(f.state, [...commands("fact-update-b")], "replace-b");
    const results = await Promise.all([f.s.submit(f.tripId, a, f.tokens.tool), other.submit(f.tripId, b, f.tokens.tool)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]); expect(results.find((r) => r.outcome === "conflict")!.errors[0].code).toBe("VERSION_CONFLICT");
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    expect(state.objects.filter((o) => ["fact-update-a", "fact-update-b"].includes(o.id))).toHaveLength(1);
    expect(object(state, "fact-cairo-luxor", "ExternalFact")).toMatchObject({ status: "superseded", value: object(f.state, "fact-cairo-luxor", "ExternalFact").value });
    expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it.each(["TripStateHistory", "TripStateIdempotency"])("real SQL failure at %s rolls back aggregate, history and cache, then retries once", async (table) => {
    const f = await setup(factSegments[0].steps[0].state_after), before = await stored(f.tripId), name = `fact_fail_${crypto.randomBytes(8).toString("hex")}`;
    const request = change(f.state, [{ op: "transition", id: "receipt-luxor", event: "supersede" }, cancellation()], "replace-receipt");
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tripId"='${f.tripId}' THEN RAISE EXCEPTION 'synthetic fact fault'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try { await expect(f.s.submit(f.tripId, request, f.tokens.tool)).rejects.toThrow(); expect(await stored(f.tripId)).toEqual(before); }
    finally { await owner.query(`DROP TRIGGER ${name} ON "${table}"`); await owner.query(`DROP FUNCTION public.${name}()`); }
    expect(await f.s.submit(f.tripId, request, f.tokens.tool)).toMatchObject({ outcome: "applied", revision: 2 });
    expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("a failed late command cannot leave an ingested observation, history or cache behind", async () => {
    const f = await setup(), before = await stored(f.tripId);
    expect(await f.s.submit(f.tripId, change(f.state, [ingest(), { op: "transition", id: "fact-cairo-luxor", event: "archive" }]), f.tokens.tool)).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
    expect(await stored(f.tripId)).toEqual(before);
    const invalid = ingest("bad-observation"); invalid.data.observed_at = "2031-01-01T00:00:00Z";
    expect(await f.s.submit(f.tripId, change(f.state, [ingest(), invalid]), f.tokens.tool)).toMatchObject({ outcome: "rejected", errors: [{ code: "FACT_TIME" }] });
    expect(await stored(f.tripId)).toEqual(before);
  });
  it("User confirmation does not promote inferred or incomplete facts to verified observations", async () => {
    const f = await setup(), c = ingest(); c.data.query_status = "partial";
    const imported = await f.s.submit(f.tripId, change(f.state, [c]), f.tokens.tool); expect(imported.outcome).toBe("applied");
    const state = (await f.s.state(f.tripId, f.tokens.user))!, fact = object(state, c.id, "ExternalFact"), request = change(state, [{ op: "decide_candidate", id: "candidate-luxor", value: "accept" }]);
    expect(fact.verification).toBe("estimated"); const pending = await f.s.submit(f.tripId, request, f.tokens.model);
    expect(pending.outcome).toBe("pending_confirmation"); expect(await f.s.confirm(f.tripId, pending.proposal_id!, confirm(pending, 1), f.tokens.user)).toMatchObject({ outcome: "applied" });
    expect(object((await f.s.state(f.tripId, f.tokens.user))!, c.id, "ExternalFact")).toEqual(fact);
    expect(await f.s.submit(f.tripId, request, f.tokens.model)).toMatchObject({ outcome: "applied" });
  });
  it("an intervening fact change invalidates an older pending decision without consuming it", async () => {
    const f = await setup(), request = change(f.state, [{ op: "decide_candidate", id: "candidate-luxor", value: "accept" }]);
    const pending = await f.s.submit(f.tripId, request, f.tokens.model);
    await f.s.submit(f.tripId, change(f.state, [{ op: "transition", id: "fact-cairo-luxor", event: "contradict" }]), f.tokens.tool);
    const before = await stored(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, confirm(pending, 1), f.tokens.user)).toMatchObject({ outcome: "conflict", errors: [{ code: "VERSION_CONFLICT" }] });
    expect(await stored(f.tripId)).toEqual(before); expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 1 });
  });
  it("fact expiry bounds confirmation deadlines and never authorizes stale proposed decisions", async () => {
    const initial = structuredClone(base); object(initial, "cost-transport", "ExternalFact").expires_at = "2030-01-01T00:00:01Z";
    const f = await setup(initial), request = change(f.state, [{ op: "decide_candidate", id: "candidate-luxor", value: "accept" }]), pending = await f.s.submit(f.tripId, request, f.tokens.model);
    const row = (await runtime.query('SELECT payload FROM "TripStateProposal" WHERE "tripId"=$1', [f.tripId])).rows[0];
    expect(row.payload.details.expires_at).toBe("2030-01-01T00:00:01Z"); f.at("2030-01-01T00:00:01Z");
    const before = await stored(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, confirm(pending, 0), f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "CONFIRMATION_EXPIRED" }] });
    expect(await stored(f.tripId)).toEqual(before);
  });
  it("does not gain runtime UPDATE/DELETE/DDL permissions; fact/history maintenance uses existing restricted transactions", async () => {
    const f = await setup(); await f.s.submit(f.tripId, change(f.state, [ingest()]), f.tokens.tool);
    for (const table of ["TripStateHistory", "TripStateIdempotency", "TripStateProposal"]) for (const privilege of ["UPDATE", "DELETE"]) {
      expect((await runtime.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [`public.\"${table}\"`, privilege])).rows[0].allowed).toBe(false);
      await expect(runtime.query(privilege === "UPDATE" ? `UPDATE "${table}" SET "tripId"="tripId" WHERE "tripId"=$1` : `DELETE FROM "${table}" WHERE "tripId"=$1`, [f.tripId])).rejects.toMatchObject({ code: "42501" });
    }
    expect((await runtime.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed).toBe(false);
  });
});
