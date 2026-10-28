import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { planCommand, failureResponse, type Actor, type CommandRequest } from "../../src/server/trip-state/commands";
import { decodeCommandJson, digest } from "../../src/server/trip-state/command-json";
import { validateStateSemantics } from "../../src/server/trip-state/semantics";
import { parseContract, TripStateContractError } from "../../src/server/trip-state/contracts";
import type { State } from "../../src/server/trip-state/contracts.generated";
import { scenario, traces, clock, uuids, oracle, requestAt, type Audit } from "../support/command-fixtures";

const user: Actor = { role: "user", id: "scenario-user" }, model: Actor = { role: "model", id: "scenario-ai" };
function execute(state: State, request: CommandRequest, actor: Actor = user) {
  try { const batch = planCommand(state, request, actor, clock, uuids()); return { response: batch.response, state: batch.snapshot }; }
  catch (error) { if (!(error instanceof TripStateContractError)) throw error; return { response: failureResponse(state, error), state }; }
}
describe("E02-03 original Scenario A execution", () => {
  it("executes seven TS commands and exactly matches independent Python and every machine field", () => {
    const python = oracle<Array<{ response: unknown; state_after: State; audit: Audit }>>({ initial: scenario.initial_state, operations: scenario.steps });
    let state = structuredClone(scenario.initial_state);
    const uuid = uuids(), audit: Audit = { intents: [], changes: [] }, actual = [];
    for (const [index, step] of scenario.steps.entries()) {
      const batch = planCommand(state, step.request, step.actor, clock, uuid);
      audit.intents.push(batch.intent); audit.changes.push(batch.change); state = batch.snapshot;
      expect(batch.response, `step ${index + 1} response/digest/diff`).toEqual(step.response);
      expect(state, `step ${index + 1} state/version/provenance`).toEqual(step.state_after);
      expect({ response: batch.response, state_after: state, audit }).toEqual(python[index]);
      actual.push({ step: index + 1, response: batch.response, state_after: state, intent: batch.intent, change: batch.change });
      console.info(`TS Scenario A step ${index + 1}: ${batch.response.outcome}, revision=${state.revision}; Python+machine exact match`);
    }
    expect(state).toEqual(scenario.final_state); expect(audit).toEqual(scenario.audit);
    expect(state.effective_skeleton_id).toBeNull();
    expect(state.objects.find((o) => o.type === "Candidate")).toMatchObject({ status: "retained", version: 2 });
    expect(state.objects.find((o) => o.type === "Decision")).toMatchObject({ status: "confirmed", value: "accept", subject_version: 2 });
    expect(state.objects.find((o) => o.id === "new-city")).toMatchObject({ geo_identity: null, coverage: "partial" });
    if (process.env.E02_ENGINE_EVIDENCE_PATH) fs.writeFileSync(process.env.E02_ENGINE_EVIDENCE_PATH, JSON.stringify({
      producer: "TypeScript planCommand executed from previous TS snapshot; fixed original clock and UUID sequence", scenario: scenario.scenario, steps: actual,
    }, null, 2) + "\n");
  });
  it("propagates preference changes through candidate and confirmed decision without inventing adoption", () => {
    const request = requestAt(4, 7); request.commands = [{ op: "revise", object_type: "Preference", id: "pref-new", changes: { expression: "用户再次明确修正", evidence_refs: ["synthetic-new-evidence"] } }];
    const batch = planCommand(scenario.final_state, request, user, clock, uuids(2000));
    const python = oracle<Array<{ response: unknown; state_after: State }>>({ initial: scenario.final_state, operations: [{ request, actor: user }], uuidStart: 2000 });
    expect(batch.response).toEqual(python[0].response); expect(batch.snapshot).toEqual(python[0].state_after);
    expect(batch.snapshot.objects.find((o) => o.type === "Candidate")).toMatchObject({ review_state: "stale", status: "retained" });
    expect(batch.snapshot.objects.find((o) => o.type === "Decision")).toMatchObject({ review_state: "stale", status: "confirmed" });
    expect(batch.snapshot.objects.find((o) => o.type === "OpenIssue")).toMatchObject({ issue_kind: "dependency", status: "open" });
    expect(batch.snapshot.effective_skeleton_id).toBeNull();
  });
  it("preserves microsecond timestamp spelling and Unicode/float request digests against Python", () => {
    const request = requestAt(0, 0), now = () => new Date("2030-01-01T00:00:00.123Z");
    const actual = planCommand(scenario.initial_state, request, scenario.steps[0].actor, now, uuids());
    const python = oracle<Array<{ response: unknown; state_after: State }>>({ initial: scenario.initial_state, operations: [{ request, actor: scenario.steps[0].actor }], clock: now().toISOString() });
    expect(actual.response).toEqual(python[0].response); expect(actual.snapshot).toEqual(python[0].state_after);
    const values = [{ "😀": 0.000001, "\uffff": 1.2e-7, a: 1e21, b: -0, c: 1.2345, d: 0.0001 }, [true, null, "旅行\n\"", 1e-10]];
    expect(values.map(digest)).toEqual(oracle({ mode: "digests", values }));
  });
  it.each(["association", "input"] as const)("preserves field-sensitive %s dependency meaning", (relation) => {
    const state = structuredClone(scenario.final_state), candidate = state.objects.find((o) => o.type === "Candidate")!;
    candidate.dependencies = [{ object_id: "new-city", version: 1, paths: ["/name"], relation }];
    const request = requestAt(0, 7, `dependency-${relation}`);
    request.commands = [{ op: "revise", object_type: "DestinationEntity", id: "new-city", changes: { name: "更新目录名称" } }];
    const batch = planCommand(state, request, scenario.steps[0].actor, clock, uuids(2000));
    const python = oracle<Array<{ response: unknown; state_after: State }>>({ initial: state, operations: [{ request, actor: scenario.steps[0].actor }], uuidStart: 2000 });
    expect(batch.response).toEqual(python[0].response); expect(batch.snapshot).toEqual(python[0].state_after);
    expect(batch.snapshot.objects.find((o) => o.type === "Candidate")).toMatchObject({ review_state: relation === "input" ? "stale" : "current" });
  });
});

describe("command permissions, lifecycle and failure atomicity", () => {
  const cases: Array<{ name: string; step: number; state: State; actor?: Actor; code: string; mutate?: (r: CommandRequest) => void }> = [
    { name: "user cannot maintain catalog", step: 0, state: scenario.initial_state, code: "PERMISSION" },
    { name: "tool cannot create state", step: 0, state: scenario.initial_state, actor: { role: "tool", id: "trusted-tool" }, code: "PERMISSION" },
    { name: "model cannot promote inferred expression to explicit", step: 4, state: scenario.steps[3].state_after, actor: model, code: "PERMISSION" },
    { name: "explicit preference cannot be overwritten by model", step: 4, state: scenario.steps[4].state_after, actor: model, code: "E02_SLICE_UNSUPPORTED" },
    { name: "pending user confirmation is never faked", step: 1, state: scenario.steps[0].state_after, actor: model, code: "E02_SLICE_UNSUPPORTED" },
    { name: "model acceptance never impersonates user", step: 6, state: scenario.steps[5].state_after, actor: model, code: "E02_SLICE_UNSUPPORTED" },
    { name: "double activation follows original transition table", step: 2, state: scenario.steps[2].state_after, code: "ILLEGAL_TRANSITION" },
    { name: "missing intent target", step: 2, state: scenario.steps[1].state_after, code: "DANGLING_REF", mutate: (r) => { r.input.target_ids = ["missing"]; } },
    { name: "unknown destination reference", step: 1, state: scenario.steps[0].state_after, code: "DANGLING_REF", mutate: (r) => { const c = r.commands[0]; if (c.op === "create" && c.object_type === "TripGoal") c.data.destination_ids = ["missing"]; } },
    { name: "empty preference evidence", step: 3, state: scenario.steps[2].state_after, actor: model, code: "EVIDENCE", mutate: (r) => { const c = r.commands[0]; if (c.op === "create" && c.object_type === "Preference") c.data.evidence_refs = []; } },
    { name: "duplicate creation", step: 0, state: scenario.steps[0].state_after, actor: scenario.steps[0].actor, code: "DUPLICATE_ID" },
    { name: "excluded candidate requires reconsideration", step: 6, state: (() => { const s = structuredClone(scenario.steps[5].state_after), c = s.objects.find((o) => o.type === "Candidate")!; if (c.type === "Candidate") { c.status = "excluded"; c.exclusion_reason = "用户排除"; } return s; })(), code: "CANDIDATE_EXCLUDED" },
    { name: "terminal expression is immutable", step: 4, state: (() => { const s = structuredClone(scenario.steps[4].state_after); s.objects.find((o) => o.id === "pref-new")!.status = "withdrawn"; return s; })(), code: "IMMUTABLE_HISTORY" },
    { name: "dedicated confirmation cannot be a status transition", step: 2, state: scenario.steps[1].state_after, code: "DEDICATED_COMMAND", mutate: (r) => { r.commands = [{ op: "transition", id: "goal-new", event: "confirm" }]; } },
  ];
  it.each(cases)("$name", ({ step, state, actor, code, mutate }) => {
    const before = structuredClone(state), request = requestAt(step, state.revision); mutate?.(request);
    const actual = execute(state, request, actor);
    expect(actual.response).toMatchObject({ outcome: "rejected", diff: [], errors: [{ code }] });
    expect(actual.state).toEqual(before); expect(state).toEqual(before);
    if (code !== "E02_SLICE_UNSUPPORTED") {
      const python = oracle<Array<{ response: { errors: Array<{ code: string }> }; state_after: State }>>({ initial: state, operations: [{ request, actor: actor ?? user }] });
      expect(python[0].response.errors[0].code).toBe(code); expect(python[0].state_after).toEqual(before);
    }
  });
  it("rejects arbitrary actor, patch, status and source fields through original command schema", () => {
    const r = requestAt(4, 4);
    for (const value of [{ ...r, actor: user }, { ...r, commands: [{ op: "patch", id: "pref-new", status: "active" }] },
      { ...r, commands: [{ op: "revise", object_type: "Preference", id: "pref-new", changes: { status: "active" } }] },
      { ...r, commands: [{ ...r.commands[0], source: { actor: "user" } }] }]) {
      expect(() => planCommand(scenario.steps[3].state_after, value, user)).toThrowError(TripStateContractError);
    }
  });
  it("rolls back a multi-command plan when its second command fails", () => {
    const state = structuredClone(scenario.initial_state), request = requestAt(0, 0);
    request.commands.push(structuredClone(request.commands[0]));
    expect(execute(state, request, scenario.steps[0].actor).response.errors[0].code).toBe("DUPLICATE_ID");
    expect(state).toEqual(scenario.initial_state);
  });
  it("fails closed for states needing later fact/constraint/skeleton command processing", () => {
    const state = traces[1].initial_state;
    expect(() => planCommand(state, requestAt(0, state.revision), scenario.steps[0].actor)).toThrowError(expect.objectContaining({ code: "E02_SLICE_UNSUPPORTED" }));
  });
});

describe("safe integer representation without changing the original contract", () => {
  it.each(["9007199254740992", "9007199254740993", "9007199254740991.1", "1.00000000000000001", "-1", "1e100"])("rejects loss/overflow before JSON token %s can be hidden", (n) => {
    expect(() => decodeCommandJson(`{"expected_revision":${n}}`)).toThrowError(expect.objectContaining({ code: "INTEGER_REPRESENTATION" }));
  });
  it.each(["9007199254740991", "1.0", "1e0", "0e999999"])("accepts exactly representable integer token %s", (n) => {
    expect(decodeCommandJson(`{"expected_revision":${n}}`)).toEqual({ expected_revision: Number(n) });
  });
  it("rejects overflowing state or object increment before any state mutation", () => {
    const state = structuredClone(scenario.initial_state); state.revision = Number.MAX_SAFE_INTEGER;
    expect(validateStateSemantics(state).revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(execute(state, requestAt(0, state.revision), scenario.steps[0].actor).response.errors[0].code).toBe("INTEGER_REPRESENTATION");
    expect(state.objects).toEqual([]);
    const version = structuredClone(scenario.steps[3].state_after); version.objects.find((o) => o.id === "pref-new")!.version = Number.MAX_SAFE_INTEGER;
    expect(execute(version, requestAt(4, version.revision)).response.errors[0].code).toBe("INTEGER_REPRESENTATION");
    const wide = { ...scenario.initial_state, revision: 2 ** 53 };
    expect(parseContract("state", wide)).toEqual(wide); // Contract itself has no newly imposed maximum.
    expect(() => validateStateSemantics(wide)).toThrowError(expect.objectContaining({ code: "INTEGER_REPRESENTATION" }));
  });
});
