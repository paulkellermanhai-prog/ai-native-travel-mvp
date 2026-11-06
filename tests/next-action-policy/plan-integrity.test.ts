import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePlanInternalIntegrity } from "../../src/server/next-action-policy/plan-integrity";

const hash = "a".repeat(64);
const basis = {packet_id: "packet", turn_id: "turn", task_key: "task", state_revision: 0, snapshot_digest: hash, expires_at: "2030-01-01T00:00:00Z"};
type TestStep = {step_id: string; kind: string; depends_on: string[]; capability_id: string; arguments: Record<string, unknown>; change_request: unknown; user_message: string | null};
const step = (id: string, depends_on: string[] = []): TestStep => ({step_id: id, kind: "read", depends_on, capability_id: "capability", arguments: {}, change_request: null, user_message: null});
const action = (id: string, steps: ReturnType<typeof step>[], attention = "prepare") => ({action_id: id, task_key: "task", packet_id: "packet", request_ids: [], goal: "D1", attention, reason: "reason", steps});
const plan = (actions: ReturnType<typeof action>[] = []) => ({nap_contract_version: "0.1.0", decision_id: "decision", runtime_id: "runtime", basis: [basis], response: {request_ids: [], disposition: "answered", text: "Answer", evidence_refs: []}, actions});

describe("candidate plan internal integrity, not authorization", () => {
  it("accepts an empty action list and a valid multi-action DAG without mutation", () => {
    expect(() => validatePlanInternalIntegrity(plan())).not.toThrow();
    const input = plan([action("first", [step("s1")], "primary"), action("second", [step("s2", ["s1"])])]);
    const before = structuredClone(input);
    expect(() => validatePlanInternalIntegrity(input)).not.toThrow();
    expect(input).toEqual(before);
  });
  it("rejects an action that does not match a packet/task pair in the plan basis", () => {
    const a = action("first", [step("s1")]);
    for (const altered of [{...a, packet_id: "other"}, {...a, task_key: "other"}]) expect(() => validatePlanInternalIntegrity(plan([altered]))).toThrow();
  });
  it("rejects contradictory declarations for the same packet even when one matches the action", () => {
    const input = plan([action("first", [step("s1")])]);
    const conflicts = [
      {...basis, task_key: "other_task"},
      {...basis, turn_id: "other_turn"},
      {...basis, state_revision: 1},
      {...basis, snapshot_digest: "b".repeat(64)},
      {...basis, expires_at: "2030-01-02T00:00:00Z"},
      // Even equivalent time representations must be exact copied basis strings.
      {...basis, expires_at: "2030-01-01T00:00:00+00:00"},
    ];
    for (const conflict of conflicts) {
      expect(() => validatePlanInternalIntegrity({...input, basis: [basis, conflict]})).toThrow();
      expect(() => validatePlanInternalIntegrity({...input, actions: [], basis: [conflict, basis]})).toThrow();
    }
  });
  it("allows identical repeated basis claims and distinct packets with distinct tasks", () => {
    const second = {...basis, packet_id: "packet2", task_key: "task2", turn_id: "turn2", expires_at: "2030-01-02T00:00:00Z"};
    const firstAction = action("first", [step("s1")]);
    const secondAction = {...action("second", [step("s2", ["s1"])]), packet_id: "packet2", task_key: "task2"};
    const input = {...plan([firstAction, secondAction]), basis: [basis, {...basis}, second]};
    const before = structuredClone(input);
    expect(() => validatePlanInternalIntegrity(input)).not.toThrow();
    expect(input).toEqual(before);
  });
  it("rejects duplicate actions, duplicate steps and multiple primary actions", () => {
    expect(() => validatePlanInternalIntegrity(plan([action("a", [step("s1")]), action("a", [step("s2")])]))).toThrow();
    expect(() => validatePlanInternalIntegrity(plan([action("a", [step("s1")]), action("b", [step("s1")])]))).toThrow();
    expect(() => validatePlanInternalIntegrity(plan([action("a", [step("s1")], "primary"), action("b", [step("s2")], "primary")]))).toThrow();
  });
  it("rejects missing step references, self cycles and cycles across actions", () => {
    for (const actions of [
      [action("a", [step("s1", ["missing"])])],
      [action("a", [step("s1", ["s1"])])],
      [action("a", [step("s1", ["s2"])]), action("b", [step("s2", ["s1"])])],
    ]) expect(() => validatePlanInternalIntegrity(plan(actions))).toThrow();
  });
  it("checks step-kind data use rather than trusting shape alone", () => {
    const invalid = [
      {...step("s1"), kind: "change", change_request: null},
      {...step("s1"), kind: "ask", arguments: {unsafe: true}, user_message: "Question"},
      {...step("s1"), kind: "deliver", user_message: null},
    ];
    for (const s of invalid) expect(() => validatePlanInternalIntegrity(plan([action("a", [s])]))).toThrow();
    const ask = {...step("s1"), kind: "ask", user_message: "Question"};
    expect(() => validatePlanInternalIntegrity(plan([action("a", [ask])]))).not.toThrow();
    const dc = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: {request: unknown}}>;
    const request = dc.find(row => row.schema === "change")!.value.request;
    const change = {...step("s2"), kind: "change", change_request: request};
    expect(() => validatePlanInternalIntegrity(plan([action("a", [change])]))).not.toThrow();
  });
  it("does not treat self-consistent packet claims as trusted provenance", () => {
    const input = plan([action("first", [step("s1")])]);
    // Deliberately fabricated but internally consistent: a host must independently reject it.
    input.basis[0] = {...basis, snapshot_digest: "b".repeat(64)};
    expect(() => validatePlanInternalIntegrity(input)).not.toThrow();
  });
  it("rejects invalid root messages before checking relationships", () => {
    expect(() => validatePlanInternalIntegrity({...plan(), nap_contract_version: "0.2.0"})).toThrow();
  });
});

describe("R3 selected source lock", () => {
  it("checks every selected file and confirms the original NAP schema is unchanged", () => {
    const root = "specs/nap-r3-2026-11-06";
    const selection = fs.readFileSync(`${root}/selection.json`);
    expect(createHash("sha256").update(selection).digest("hex")).toBe("c24a942588cb54fab20a3b66cd104d9d273f25aba259794605572ab9f7c5e952");
    const manifest = JSON.parse(selection.toString("utf8")) as {files: {path: string; sha256: string; bytes: number}[]};
    expect(manifest.files).toHaveLength(15);
    for (const file of manifest.files) {
      const bytes = fs.readFileSync(`${root}/sources/${file.path}`);
      expect(bytes.length).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(fs.readFileSync(`${root}/sources/engineering/contracts.schema.json`)).toEqual(fs.readFileSync("specs/nap-candidate-2026-11-06/contracts.schema.json"));
  });
});
