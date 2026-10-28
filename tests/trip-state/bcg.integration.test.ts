import fs from "node:fs";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openTripCommandService, openSyntheticStorageHarness, type CommandHost } from "../../src/server/trip-state/internal/persistence";
import type { Actor, ConfirmRequest } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, bcg, object, change, createFrom } from "../support/bcg-fixtures";
import { clock, uuids, oracle, traces, type Audit } from "../support/command-fixtures";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("BCG CI requires real PostgreSQL");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { runtimeUrl: string; migrationUrl: string } : null;
const resources: Array<{ close: () => Promise<void> }> = [];
const actors: Record<string, Actor> = { user: { role: "user", id: "scenario-user" }, model: { role: "model", id: "scenario-ai" }, system: { role: "system", id: "scenario-system" } };
type Response = TripStateContracts["response"];
type Result = { response: Response; state_after: State; audit: Audit };
let runtime: Client;

async function setup(initial: State = base, start = 2000) {
  const state = structuredClone(initial), tripId = `trip-bcg-${crypto.randomBytes(8).toString("hex")}`;
  state.trip_id = tripId; for (const o of state.objects) o.trip_id = tripId; // Namespace only; every original object/field stays present.
  const seed = await openSyntheticStorageHarness(config!.runtimeUrl); resources.push(seed); await seed.seedSyntheticSnapshot(state);
  const tokens = Object.fromEntries(Object.keys(actors).map((role) => [role, Object.freeze({})]));
  const host: CommandHost = { clock, uuid: uuids(start), authorize: (trip, credential) => {
    const role = Object.keys(tokens).find((r) => tokens[r] === credential);
    if (trip !== tripId || !role) throw new Error("Host denied access"); return { tripId, actor: actors[role] };
  } };
  const open = async (overrides: Partial<CommandHost> = {}) => { const s = await openTripCommandService(config!.runtimeUrl, { ...host, ...overrides }); resources.push(s); return s; };
  return { state, tripId, tokens, host, open, s: await open() };
}
async function stored(tripId: string) {
  const rows = [];
  for (const table of ["TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency"]) rows.push((await runtime.query(`SELECT row_to_json(t) AS value FROM "${table}" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text`, [tripId])).rows);
  return rows;
}
async function counts(tripId: string) {
  return (await runtime.query('SELECT (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS requests', [tripId])).rows[0];
}
function confirmation(pending: Response, revision: number, accept = true): ConfirmRequest {
  return { expected_revision: revision, idempotency_key: "synthetic-bcg-confirm", proposal_digest: pending.proposal_digest!, accept };
}
async function inChild(message: object) {
  const worker = fork("tests/support/confirmation-process.mjs", [], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; worker.stderr?.on("data", (data) => { errors += String(data); });
  const exit = once(worker, "exit");
  try {
    expect((await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]))[0]).toEqual({ ready: true });
    worker.send(message);
    const [result] = await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]);
    await exit; return result as { response: Response; processId: number };
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
}

describe.skipIf(!config)("E02-04B real PostgreSQL business commands", () => {
  beforeAll(async () => { runtime = new Client({ connectionString: config!.runtimeUrl }); await runtime.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((r) => r.close())); });
  afterAll(async () => { await runtime?.end(); });

  it.each(bcg)("$trace.scenario: persists every actual TS step and journal matching independent Python", async ({ trace, uuidStart }) => {
    const f = await setup(trace.initial_state, uuidStart), python = oracle<Result[]>({ initial: f.state, operations: trace.steps, uuidStart });
    const actual = [];
    for (const [i, step] of trace.steps.entries()) {
      const response = await f.s.submit(f.tripId, step.request, f.tokens[step.actor.role]), state_after = await f.s.state(f.tripId, f.tokens.user), audit = await f.s.history(f.tripId, f.tokens.user);
      expect(response).toEqual(python[i].response); expect(state_after).toEqual(python[i].state_after); expect(audit).toEqual(python[i].audit);
      actual.push({ step: i + 1, response, state_after, audit, independent_python_exact_match: true });
    }
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    for (const original of f.state.objects.filter((o) => o.type === "ExternalFact" || o.id === "pref-culture")) expect(state.objects.find((o) => o.id === original.id)).toEqual(original);
    expect(await counts(f.tripId)).toEqual({ history: trace.steps.length, requests: trace.steps.length, proposals: 0 });
    if (process.env.E02_BCG_STORAGE_EVIDENCE_PATH) fs.appendFileSync(process.env.E02_BCG_STORAGE_EVIDENCE_PATH, JSON.stringify({ scenario: trace.scenario, tripId: f.tripId, namespace_only_change: true, steps: actual }) + "\n");
  });
  it.each([true, false])("Model decision reversal requires a real User confirmation accept=%s and finalizes both cache keys", async (accept) => {
    const g = bcg[2], f = await setup(g.trace.initial_state, g.uuidStart), first = g.trace.steps[0].request, reverse = g.trace.steps[1].request;
    await f.s.submit(f.tripId, first, f.tokens.user);
    const authority = await f.s.state(f.tripId, f.tokens.user), pending = await f.s.submit(f.tripId, reverse, f.tokens.model);
    expect(pending.outcome).toBe("pending_confirmation"); expect(await f.s.state(f.tripId, f.tokens.user)).toEqual(authority);
    const body = confirmation(pending, 1, accept), result = await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user);
    const python = oracle<Result[]>({ mode: "lifecycle", initial: f.state, uuidStart: g.uuidStart, operations: [
      { request: first, actor: actors.user }, { request: reverse, actor: actors.model }, { method: "confirm", proposalIndex: 1, request: body, actor: actors.user },
    ] });
    expect(result).toEqual(python[2].response); expect(await f.s.state(f.tripId, f.tokens.user)).toEqual(python[2].state_after);
    expect(await f.s.history(f.tripId, f.tokens.user)).toEqual(python[2].audit);
    expect(await f.s.submit(f.tripId, reverse, f.tokens.model)).toEqual(result);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, body, f.tokens.user)).toEqual(result);
    expect(await counts(f.tripId)).toEqual({ history: 3, requests: 3, proposals: 0 });
    if (!accept) expect(await f.s.state(f.tripId, f.tokens.user)).toEqual(authority);
  });
  it("rolls back a real duplicate journal failure after updating the reversed aggregate, then retries once", async () => {
    const g = bcg[2], f = await setup(g.trace.initial_state, g.uuidStart);
    await f.s.submit(f.tripId, g.trace.steps[0].request, f.tokens.user);
    const before = await stored(f.tripId), collision = await f.open({ uuid: uuids(g.uuidStart) });
    await expect(collision.submit(f.tripId, g.trace.steps[1].request, f.tokens.user)).rejects.toMatchObject({ code: "P2002" });
    expect(await stored(f.tripId)).toEqual(before);
    expect(await f.s.submit(f.tripId, g.trace.steps[1].request, f.tokens.user)).toMatchObject({ outcome: "applied", revision: 2 });
    expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 0 });
  });
  it("serializes two competing replacement decisions without losing or duplicating prior authority", async () => {
    const g = bcg[2], f = await setup(g.trace.initial_state, g.uuidStart), other = await f.open();
    await f.s.submit(f.tripId, g.trace.steps[0].request, f.tokens.user);
    const reject = { ...g.trace.steps[1].request, idempotency_key: "race-reject" }, retain = change({ ...f.state, revision: 1 }, [{ op: "decide_candidate", id: "candidate-luxor", value: "retain" }], "race-retain");
    const results = await Promise.all([f.s.submit(f.tripId, reject, f.tokens.user), other.submit(f.tripId, retain, f.tokens.user)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
    expect(results.find((r) => r.outcome === "conflict")!.errors[0].code).toBe("VERSION_CONFLICT");
    const state = (await f.s.state(f.tripId, f.tokens.user))!, decisions = state.objects.filter((o) => o.type === "Decision");
    expect(decisions).toHaveLength(2); expect(decisions.filter((d) => d.status === "confirmed")).toHaveLength(1); expect(decisions[0].status).toBe("revised");
    expect(await counts(f.tripId)).toEqual({ history: 2, requests: 2, proposals: 0 });
  });
  it("recovers a pending full-state reversal and confirms/replays it in fresh OS processes", async () => {
    const g = bcg[2], f = await setup(g.trace.initial_state, g.uuidStart), first = g.trace.steps[0].request, reverse = g.trace.steps[1].request;
    await f.s.submit(f.tripId, first, f.tokens.user); const pending = await f.s.submit(f.tripId, reverse, f.tokens.model), body = confirmation(pending, 1);
    await f.s.close();
    const confirmed = await inChild({ method: "confirm", tripId: f.tripId, proposalId: pending.proposal_id, request: body, clock: clock().toISOString(), uuidStart: g.uuidStart + 6 });
    const replay = await inChild({ method: "submit", tripId: f.tripId, request: reverse });
    expect(confirmed.processId).not.toBe(process.pid); expect(replay.processId).not.toBe(confirmed.processId); expect(replay.response).toEqual(confirmed.response);
    const s = await f.open(), python = oracle<Result[]>({ mode: "lifecycle", initial: f.state, uuidStart: g.uuidStart, operations: [
      { request: first, actor: actors.user }, { request: reverse, actor: actors.model }, { method: "confirm", proposalIndex: 1, request: body, actor: actors.user },
    ] });
    expect(confirmed.response).toEqual(python[2].response); expect(await s.state(f.tripId, f.tokens.user)).toEqual(python[2].state_after);
    expect(await s.history(f.tripId, f.tokens.user)).toEqual(python[2].audit); expect(await counts(f.tripId)).toEqual({ history: 3, requests: 3, proposals: 0 });
  }, 15000);
  it("rejects false/unknown reconsider without any partial SQL write or loss of shared preference", async () => {
    const f = await setup(); await f.s.submit(f.tripId, bcg[0].trace.steps[0].request, f.tokens.user);
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    const edit = change(state, [{ op: "revise", object_type: "Candidate", id: "candidate-luxor", changes: { reconsider_when: { op: "eq", object_id: "cairo", path: "/geo_identity", value: "unknown" } } }]);
    await f.s.submit(f.tripId, edit, f.tokens.user);
    const storedBefore = await stored(f.tripId), current = (await f.s.state(f.tripId, f.tokens.user))!;
    const request = change(current, [{ op: "reconsider", id: "candidate-luxor", trigger_id: "cairo" }], "unknown-reconsider");
    expect(await f.s.submit(f.tripId, request, f.tokens.system)).toMatchObject({ outcome: "rejected", errors: [{ code: "CONDITION_UNKNOWN" }] });
    expect(await stored(f.tripId)).toEqual(storedBefore); expect(object(current, "pref-culture", "Preference")).toEqual(object(f.state, "pref-culture", "Preference"));
  });
  it("does not modify unrelated skeletons, observations or candidates for a local constraint", async () => {
    const f = await setup(), next = createFrom(object(f.state, "constraint-nights", "Constraint"), "constraint-aswan-local");
    if (next.op !== "create") throw new Error("Invalid fixture"); next.scope = { kind: "entity", ids: ["aswan"] };
    expect(await f.s.submit(f.tripId, change(f.state, [next]), f.tokens.user)).toMatchObject({ outcome: "applied" });
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    for (const original of f.state.objects) expect(state.objects.find((o) => o.id === original.id)).toEqual(original);
  });
  it("preserves evidence and candidate links when replacing a shared preference in one real transaction", async () => {
    const f = await setup(), original = object(f.state, "pref-culture", "Preference"), next = createFrom(original, "pref-successor");
    if (next.op !== "create") throw new Error("Invalid fixture"); next.dependencies = [{ object_id: original.id, version: original.version, paths: ["/status"], relation: "association" }];
    expect(await f.s.submit(f.tripId, change(f.state, [{ op: "transition", id: original.id, event: "supersede" }, next]), f.tokens.user)).toMatchObject({ outcome: "applied" });
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    expect(object(state, original.id, "Preference")).toMatchObject({ status: "superseded", evidence_refs: original.evidence_refs });
    for (const id of ["candidate-luxor", "candidate-aswan"]) expect(object(state, id, "Candidate")).toMatchObject({ review_state: "stale", preference_ids: [original.id] });
    const audit = await f.s.history(f.tripId, f.tokens.user); expect(audit.changes[0].diff.find((d) => d.id === original.id)?.before).toEqual(original);
  });
  it("guards an existing adopted skeleton and confirms withdrawal without fabricating a new adoption", async () => {
    const initial = traces.find((t) => t.scenario.startsWith("D-"))!.steps[0].state_after, f = await setup(initial);
    const adopted = f.state.objects.find((o) => o.type === "Decision" && o.decision_kind === "adopt_skeleton")!;
    const before = await stored(f.tripId);
    expect(await f.s.submit(f.tripId, change(f.state, [{ op: "decide_candidate", id: "candidate-luxor", value: "reject" }]), f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "CONFIRMED_CANDIDATE" }] });
    expect(await stored(f.tripId)).toEqual(before);
    const request = change(f.state, [{ op: "withdraw_decision", id: adopted.id }]), pending = await f.s.submit(f.tripId, request, f.tokens.model);
    expect(pending.outcome).toBe("pending_confirmation"); expect(await f.s.state(f.tripId, f.tokens.user)).toEqual(f.state);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, confirmation(pending, f.state.revision), f.tokens.user)).toMatchObject({ outcome: "applied", revision: f.state.revision + 1 });
    const state = (await f.s.state(f.tripId, f.tokens.user))!;
    expect(state.effective_skeleton_id).toBeNull(); expect(state.objects.find((o) => o.id === adopted.id)).toMatchObject({ status: "revoked" });
    expect(object(state, "skeleton-a", "Skeleton")).toEqual(object(f.state, "skeleton-a", "Skeleton"));
  });
});
