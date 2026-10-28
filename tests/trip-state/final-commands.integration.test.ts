import fs from "node:fs";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openTripCommandService, openSyntheticStorageHarness, type CommandHost } from "../../src/server/trip-state/internal/persistence";
import type { CommandRequest, ConfirmRequest } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, uuids, oracle, traces, type Audit } from "../support/command-fixtures";
import { factActors as actors } from "../support/fact-fixtures";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("E02-04D CI requires real PostgreSQL");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { runtimeUrl: string; migrationUrl: string } : null;
const resources: Array<{ close: () => Promise<void> }> = [];
type Response = TripStateContracts["response"];
type Result = { response: Response; state_after: State; audit: Audit };
const adopt = (id = "skeleton-a"): TripStateContracts["command"] => ({ op: "adopt_skeleton", id, acknowledge_unknowns: true, confirmation_scope: ["cities", "order", "stays", "connections"] });
let runtime: Client, owner: Client;
async function setup(initial: State = base, start = 6000) {
  const state = structuredClone(initial), tripId = `trip-final-${crypto.randomBytes(8).toString("hex")}`;
  state.trip_id = tripId; for (const o of state.objects) o.trip_id = tripId;
  const seed = await openSyntheticStorageHarness(config!.runtimeUrl); resources.push(seed); await seed.seedSyntheticSnapshot(state);
  const tokens = Object.fromEntries(Object.keys(actors).map((role) => [role, Object.freeze({})]));
  const host: CommandHost = { clock, uuid: uuids(start), authorize: (trip, credential) => {
    const role = Object.keys(tokens).find((r) => tokens[r] === credential);
    if (trip !== tripId || !role) throw new Error("Host denied access"); return { tripId, actor: actors[role as keyof typeof actors] };
  } };
  const open = async (overrides: Partial<CommandHost> = {}) => { const s = await openTripCommandService(config!.runtimeUrl, { ...host, ...overrides }); resources.push(s); return s; };
  return { state, tripId, tokens, s: await open(), open };
}
async function stored(tripId: string) {
  const rows = [];
  for (const table of ["TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency"]) rows.push((await runtime.query(`SELECT row_to_json(t) AS value FROM "${table}" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text`, [tripId])).rows);
  return rows;
}
async function counts(tripId: string) { return (await runtime.query('SELECT (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS requests', [tripId])).rows[0]; }
function confirm(pending: Response, revision: number, accept = true): ConfirmRequest { return { expected_revision: revision, idempotency_key: "final-confirm", proposal_digest: pending.proposal_digest!, accept }; }
async function child(message: object) {
  const worker = fork("tests/support/confirmation-process.mjs", [], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; worker.stderr?.on("data", (d) => { errors += String(d); }); const exit = once(worker, "exit");
  try { expect((await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]))[0]).toEqual({ ready: true }); worker.send(message);
    const [r] = await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]); await exit;
    return r as { response: Response; processId: number; state: State; history: Audit };
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
}
function evidence(value: unknown) { if (process.env.E02_FINAL_STORAGE_EVIDENCE_PATH) fs.appendFileSync(process.env.E02_FINAL_STORAGE_EVIDENCE_PATH, JSON.stringify(value) + "\n"); }

describe.skipIf(!config)("E02-04D real PostgreSQL final business commands", () => {
  beforeAll(async () => { runtime = new Client({ connectionString: config!.runtimeUrl }); owner = new Client({ connectionString: config!.migrationUrl }); await runtime.connect(); await owner.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((s) => s.close())); });
  afterAll(async () => { await runtime?.end(); await owner?.end(); });
  it.each(traces.filter((t) => /^[DEF]-/.test(t.scenario)))("$scenario: complete actual commands and accumulated database history match Python", async (trace) => {
    const start = parseInt(trace.steps[0].response.proposal_id!.slice("proposal-".length), 16), f = await setup(trace.initial_state, start);
    const python = oracle<Result[]>({ initial: f.state, operations: trace.steps, uuidStart: start }), actual = []; let writes = 0;
    for (const [i, step] of trace.steps.entries()) {
      const before = await stored(f.tripId), response = await f.s.submit(f.tripId, step.request, f.tokens[step.actor.role]);
      const state_after = await f.s.state(f.tripId, f.tokens.user), audit = await f.s.history(f.tripId, f.tokens.user);
      expect({ response, state_after, audit }).toEqual(python[i]);
      if (response.outcome === "applied") writes++; else expect(await stored(f.tripId)).toEqual(before);
      actual.push({ step: i + 1, response, state_after, audit });
    }
    expect(await counts(f.tripId)).toEqual({ history: writes, requests: writes, proposals: 0 });
    evidence({ scenario: trace.scenario, namespace_only_change: true, independent_python_exact_match: true, actual });
  });
  it("original Issue examples: create → resolve → proposed dismiss → confirm → reopen → resolve, with exact Python histories", async () => {
    const f = await setup(), issue = structuredClone(object(f.state, "issue-cost", "OpenIssue"));
    Object.assign(issue, { id: "issue-fact", issue_kind: "verification", question: "该测试班次是否已核验", affected_ids: ["fact-cairo-luxor"], required_inputs: ["schedule"], candidate_actions: ["verify"] });
    const operations: object[] = [], actual = [];
    async function send(commands: CommandRequest["commands"], role: keyof typeof actors) {
      const state = (await f.s.state(f.tripId, f.tokens.user))!, request = change(state, commands, `issue-step-${operations.length}`);
      operations.push({ request, actor: actors[role] }); const response = await f.s.submit(f.tripId, request, f.tokens[role]);
      actual.push({ response, state_after: await f.s.state(f.tripId, f.tokens.user), audit: await f.s.history(f.tripId, f.tokens.user) }); return response;
    }
    await send([createFrom(issue, issue.id)], "user");
    await send([{ op: "resolve_issue", id: issue.id, evidence_ids: ["fact-cairo-luxor"], reason: "测试适配器提供完整日期班次" }], "user");
    const pending = await send([{ op: "dismiss_issue", id: "issue-cost", reason: "用户决定暂不处理费用未知" }], "model");
    expect(pending.outcome).toBe("pending_confirmation");
    const body = confirm(pending, 2), response = await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user);
    operations.push({ method: "confirm", proposalIndex: 2, request: body, actor: actors.user });
    actual.push({ response, state_after: await f.s.state(f.tripId, f.tokens.user), audit: await f.s.history(f.tripId, f.tokens.user) });
    await send([{ op: "transition", id: issue.id, event: "reopen" }], "system");
    await send([{ op: "resolve_issue", id: issue.id, evidence_ids: ["fact-cairo-luxor"], reason: "重新核验关联证据" }], "system");
    const py = oracle<Result[]>({ mode: "lifecycle", initial: f.state, operations, uuidStart: 6000 });
    expect(actual).toEqual(py.map(({ response, state_after, audit }) => ({ response, state_after, audit })));
    expect(await counts(f.tripId)).toEqual({ history: 6, requests: 6, proposals: 0 }); evidence({ scenario: "Original Issue examples composed from test_tripstate.py and transition table; not a fabricated machine fixture", independent_python_exact_match: true, actual });
  });
  it.each(["adopt", "dismiss"].flatMap((command) => [true, false].map((accept) => ({ command, accept }))))("Model $command accept=$accept: preview/pending/final replay are atomic and preserve fact verification", async ({ command, accept }) => {
    const initial = structuredClone(base);
    if (command === "adopt") { const fact = object(initial, "fact-cairo-luxor", "ExternalFact"); fact.query_status = "partial"; fact.verification = "estimated"; fact.applicability = "unknown"; }
    const f = await setup(initial), cmd = command === "adopt" ? adopt() : { op: "dismiss_issue" as const, id: "issue-cost", reason: "合成用户理由" }, request = change(f.state, [cmd]);
    const before = await stored(f.tripId), preview = await f.s.preview(f.tripId, request, f.tokens.model); expect(await stored(f.tripId)).toEqual(before);
    const pending = await f.s.submit(f.tripId, request, f.tokens.model); expect(await f.s.state(f.tripId, f.tokens.user)).toEqual(f.state);
    const body = confirm(pending, f.state.revision, accept), response = await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user);
    const py = oracle<Result[]>({ mode: "lifecycle", initial: f.state, uuidStart: 6000, operations: [{ method: "preview", request, actor: actors.model }, { request, actor: actors.model }, { method: "confirm", proposalIndex: 1, request: body, actor: actors.user }] });
    expect(preview).toEqual(py[0].response); expect(pending).toEqual(py[1].response); expect(response).toEqual(py[2].response);
    const s = (await f.s.state(f.tripId, f.tokens.user))!; expect(s).toEqual(py[2].state_after); expect(await f.s.history(f.tripId, f.tokens.user)).toEqual(py[2].audit);
    for (const fact of f.state.objects.filter((o) => o.type === "ExternalFact")) expect(s.objects.find((o) => o.id === fact.id)).toEqual(fact);
    expect(await f.s.submit(f.tripId, request, f.tokens.model)).toEqual(response); expect(await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user)).toEqual(response);
    expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 0 });
  });
  it("hard conflict rejects an entire create-and-adopt batch without new skeleton, root, history or cache", async () => {
    const f = await setup(), c = createFrom(object(f.state, "skeleton-a", "Skeleton"), "skeleton-hard-conflict");
    if (c.op !== "create" || c.object_type !== "Skeleton") throw new Error("Fixture"); c.data.stops[0].nights = 5;
    const before = await stored(f.tripId), response = await f.s.submit(f.tripId, change(f.state, [c, adopt(c.id)]), f.tokens.user);
    expect(response).toMatchObject({ outcome: "rejected", errors: [{ code: "HARD_CONFLICT" }] }); expect(await stored(f.tripId)).toEqual(before);
  });
  it.each(["stale-fact", "pending-skeleton", "wrong-evidence", "model-resolve"])("Issue resolution rejects %s and leaves all four tables unchanged", async (kind) => {
    const initial = structuredClone(base); object(initial, "issue-cost", "OpenIssue").affected_ids = [kind === "pending-skeleton" ? "skeleton-a" : "fact-cairo-luxor"];
    if (kind === "stale-fact") object(initial, "fact-cairo-luxor", "ExternalFact").freshness = "stale";
    const f = await setup(initial), before = await stored(f.tripId), proof = kind === "pending-skeleton" ? "cost-transport" : kind === "wrong-evidence" ? "constraint-nights" : "fact-cairo-luxor";
    const r = await f.s.submit(f.tripId, change(f.state, [{ op: "resolve_issue", id: "issue-cost", reason: "测试拒绝", evidence_ids: [proof] }]), f.tokens[kind === "model-resolve" ? "model" : "user"]);
    expect(r).toMatchObject({ outcome: "rejected", errors: [{ code: kind === "model-resolve" ? "PERMISSION" : kind === "pending-skeleton" ? "ISSUE_STILL_BLOCKED" : "RESOLUTION_EVIDENCE" }] });
    expect(await stored(f.tripId)).toEqual(before);
  });
  it("competing adoptions cannot lose authority or create two confirmed adoption decisions", async () => {
    const f = await setup(); await f.s.submit(f.tripId, change(f.state, [createFrom(object(f.state, "skeleton-a", "Skeleton"), "skeleton-next")]), f.tokens.model);
    const s = (await f.s.state(f.tripId, f.tokens.user))!, other = await f.open();
    const results = await Promise.all([f.s.submit(f.tripId, change(s, [adopt()], "race-a"), f.tokens.user), other.submit(f.tripId, change(s, [adopt("skeleton-next")], "race-b"), f.tokens.user)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
    expect(results.find((r) => r.outcome === "conflict")!.errors[0].code).toBe("VERSION_CONFLICT");
    const after = (await f.s.state(f.tripId, f.tokens.user))!, decisions = after.objects.filter((o) => o.type === "Decision" && o.decision_kind === "adopt_skeleton" && o.status === "confirmed");
    expect(decisions).toHaveLength(1); expect(decisions[0]).toMatchObject({ subject_id: after.effective_skeleton_id }); expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 0 });
  });
  it("concurrent fact change and User confirmation serialize without a stale adoption or partial Proposal consumption", async () => {
    const f = await setup(), request = change(f.state, [adopt()]), pending = await f.s.submit(f.tripId, request, f.tokens.model), other = await f.open();
    const body = confirm(pending, 0), factRequest = change(f.state, [{ op: "transition", id: "fact-cairo-luxor", event: "contradict" }], "concurrent-fact-change");
    const [confirmation, factChange] = await Promise.all([f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user), other.submit(f.tripId, factRequest, f.tokens.tool)]);
    expect([confirmation.outcome, factChange.outcome].sort()).toEqual(["applied", "conflict"]);
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    expect(state.revision).toBe(1);
    if (confirmation.outcome === "applied") { expect(state.effective_skeleton_id).toBe("skeleton-a"); expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 0 }); }
    else { expect(confirmation.errors[0].code).toBe("VERSION_CONFLICT"); expect(state.effective_skeleton_id).toBeNull(); expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 1 }); }
  });
  it("duplicate concurrent adoption is replayed once, while changed-key content is rejected", async () => {
    const f = await setup(), other = await f.open(), request = change(f.state, [adopt()], "adopt-idempotent");
    const [a, b] = await Promise.all([f.s.submit(f.tripId, request, f.tokens.user), other.submit(f.tripId, request, f.tokens.user)]); expect(a).toEqual(b); expect(a.outcome).toBe("applied");
    const before = await stored(f.tripId);
    expect(await f.s.submit(f.tripId, { ...request, reason: "different content" }, f.tokens.user)).toMatchObject({ outcome: "conflict", errors: [{ code: "IDEMPOTENCY_CONFLICT" }] });
    expect(await stored(f.tripId)).toEqual(before); expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it.each(["adopt", "resolve", "recalculate"].flatMap((command) => ["TripStateHistory", "TripStateIdempotency"].map((table) => ({ command, table }))))("$command SQL failure at $table rolls back, then retries", async ({ command, table }) => {
    const initial = structuredClone(base); if (command === "resolve") object(initial, "issue-cost", "OpenIssue").affected_ids = ["fact-cairo-luxor"];
    const f = await setup(initial), request = change(f.state, [command === "adopt" ? adopt() : command === "recalculate" ? { op: "recalculate", id: "skeleton-a" } : { op: "resolve_issue", id: "issue-cost", reason: "合成解决", evidence_ids: ["fact-cairo-luxor"] }]), before = await stored(f.tripId);
    const name = `final_fail_${crypto.randomBytes(8).toString("hex")}`;
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tripId"='${f.tripId}' THEN RAISE EXCEPTION 'synthetic final-command fault'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try { await expect(f.s.submit(f.tripId, request, f.tokens.user)).rejects.toThrow(); expect(await stored(f.tripId)).toEqual(before); }
    finally { await owner.query(`DROP TRIGGER ${name} ON "${table}"`); await owner.query(`DROP FUNCTION public.${name}()`); }
    expect(await f.s.submit(f.tripId, request, f.tokens.user)).toMatchObject({ outcome: "applied", revision: 1 }); expect(await counts(f.tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("failed Proposal consumption rolls back adoption root/decision/history/final caches together", async () => {
    const f = await setup(), request = change(f.state, [adopt()]), pending = await f.s.submit(f.tripId, request, f.tokens.model), body = confirm(pending, 0), before = await stored(f.tripId);
    const name = `final_consume_${crypto.randomBytes(8).toString("hex")}`;
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."tripId"='${f.tripId}' THEN RAISE EXCEPTION 'synthetic consumption fault'; END IF; RETURN OLD; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE DELETE ON "TripStateProposal" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try { expect(await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "INTERNAL_FAILURE" }] }); expect(await stored(f.tripId)).toEqual(before); }
    finally { await owner.query(`DROP TRIGGER ${name} ON "TripStateProposal"`); await owner.query(`DROP FUNCTION public.${name}()`); }
    const result = await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user); expect(result.outcome).toBe("applied");
    expect(await f.s.submit(f.tripId, request, f.tokens.model)).toEqual(result); expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 0 });
  });
  it("independent processes recover the actual adopted root/history, replay and then recalculate after time advances", async () => {
    const f = await setup(), request = change(f.state, [adopt()]); const response = await f.s.submit(f.tripId, request, f.tokens.user); await f.s.close();
    const replay = await child({ method: "submit", syntheticActor: "user", tripId: f.tripId, request, includeSnapshot: true });
    expect(replay.processId).not.toBe(process.pid); expect(replay.response).toEqual(response); expect(replay.state.effective_skeleton_id).toBe("skeleton-a");
    const recalc = change(replay.state, [{ op: "recalculate", id: "skeleton-a" }], "restart-recalculate");
    const result = await child({ method: "submit", syntheticActor: "system", tripId: f.tripId, request: recalc, includeSnapshot: true, clock: "2030-01-03T00:00:00Z", uuidStart: 6003 });
    const py = oracle<Result[]>({ initial: f.state, uuidStart: 6000, operations: [{ actor: actors.user, request }, { actor: actors.user, request }, { actor: actors.system, request: recalc, clock: "2030-01-03T00:00:00Z" }] });
    expect({ response: replay.response, state_after: replay.state, audit: replay.history }).toEqual(py[1]);
    expect({ response: result.response, state_after: result.state, audit: result.history }).toEqual(py[2]); expect(result.processId).not.toBe(replay.processId);
    expect(result.state.effective_skeleton_id).toBe("skeleton-a"); expect(result.state.objects.find((o) => o.type === "Decision")).toMatchObject({ status: "confirmed", review_state: "stale" });
    evidence({ scenario: "Independent-process adoption recovery and time-only recalculation", independent_python_exact_match: true, replay, result });
  }, 15000);
});
