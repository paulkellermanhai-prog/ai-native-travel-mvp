import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { DecisionContextContractError, type DecisionContextContracts } from "../../src/server/decision-context/contracts";
import { NapContractError } from "../../src/server/next-action-policy/contracts";
import { NapPlanIntegrityError } from "../../src/server/next-action-policy/plan-integrity";
import { NapPacketConsistencyError, validatePlanRequestConsistency } from "../../src/server/next-action-policy/plan-packet-consistency";

const fixtures = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: unknown}>;
const packet = fixtures.find(row => row.schema === "packet")!.value as DecisionContextContracts["packet"];
const basisOf = (p: typeof packet) => ({packet_id: p.packet_id, turn_id: p.turn_id, task_key: p.task.task_key, state_revision: p.context.state_revision, snapshot_digest: p.snapshot_digest, expires_at: p.context.expires_at});
const request = (packets: typeof packet[] = [packet]) => ({nap_contract_version: "0.1.0", decision_id: "decision", runtime_id: "runtime", trigger: {kind: "user_event", reference: "event"}, packets});
const plan = (basis = [basisOf(packet)]) => ({nap_contract_version: "0.1.0", decision_id: "decision", runtime_id: "runtime", basis, response: {request_ids: [], disposition: "answered", text: "Answer", evidence_refs: []}, actions: []});

describe("supplied plan and packet consistency, not trusted origin or authorization", () => {
  it("accepts matching single and multiple packets without mutating either input", () => {
    const other = structuredClone(packet);
    other.packet_id = "packet2"; other.turn_id = "turn2"; other.task.task_key = "task2"; other.context.task_id = "task2";
    const req = request([packet, other]); const p = plan([basisOf(packet), basisOf(other)]);
    const before = structuredClone({req, p});
    expect(() => validatePlanRequestConsistency(req, p)).not.toThrow();
    expect({req, p}).toEqual(before);
    expect(() => validatePlanRequestConsistency(request(), plan())).not.toThrow();
  });
  it("requires plan decision and runtime IDs to match the supplied request", () => {
    for (const patch of [{decision_id: "other"}, {runtime_id: "other"}]) expect(() => validatePlanRequestConsistency(request(), {...plan(), ...patch})).toThrow(NapPacketConsistencyError);
  });
  it("requires each basis to match its packet, task, turn, revision, digest, and exact expiry", () => {
    const b = basisOf(packet);
    for (const changed of [
      {...b, packet_id: "missing"}, {...b, turn_id: "other"}, {...b, task_key: "other"},
      {...b, state_revision: b.state_revision + 1}, {...b, snapshot_digest: "a".repeat(64)},
      {...b, expires_at: "2030-01-01T00:05:00+00:00"},
    ]) expect(() => validatePlanRequestConsistency(request(), plan([changed]))).toThrow(NapPacketConsistencyError);
  });
  it("rejects ambiguous repeated packet IDs, including byte-identical packets", () => {
    expect(() => validatePlanRequestConsistency(request([packet, structuredClone(packet)]), plan())).toThrow(NapPacketConsistencyError);
  });
  it("rejects a packet whose context and task name different tasks", () => {
    const inconsistent = structuredClone(packet);
    inconsistent.context.task_id = "other-task";
    expect(() => validatePlanRequestConsistency(request([inconsistent]), plan([basisOf(inconsistent)]))).toThrow(NapPacketConsistencyError);
  });
  it("rejects supplied packets that disagree about trip, state revision or snapshot digest", () => {
    for (const change of ["trip", "revision", "digest"] as const) {
      const second = structuredClone(packet); second.packet_id = "packet2";
      if (change === "trip") second.context.trip_id = "another-trip";
      if (change === "revision") second.context.state_revision += 1;
      if (change === "digest") second.snapshot_digest = "b".repeat(64);
      expect(() => validatePlanRequestConsistency(request([packet, second]), plan())).toThrow(NapPacketConsistencyError);
    }
  });
  it("rejects a plan whose action references a different task within the stated basis", () => {
    const bad = {...plan(), actions: [{action_id: "action", task_key: "other", packet_id: packet.packet_id, request_ids: [], goal: "D1", attention: "primary", reason: "reason", steps: [{step_id: "step", kind: "read", depends_on: [], capability_id: "capability", arguments: {}, change_request: null, user_message: null}]}]};
    expect(() => validatePlanRequestConsistency(request(), bad)).toThrow(NapPlanIntegrityError);
  });
  it("checks underlying DC packet structure and does not silently accept malformed input", () => {
    const malformed = {...packet, runtime_contract_version: "0.2.0"};
    expect(() => validatePlanRequestConsistency(request([malformed as typeof packet]), plan())).toThrow(NapContractError);
    expect(() => validatePlanRequestConsistency({secret: "raw content"}, plan())).toThrow(NapContractError);
  });
  it("rejects empty packet and basis collections at the original schema boundary", () => {
    expect(() => validatePlanRequestConsistency(request([]), plan())).toThrow(NapContractError);
    expect(() => validatePlanRequestConsistency(request(), plan([]))).toThrow(NapContractError);
  });
  it("accepts a safe maximum revision and rejects the next in-memory integer at the DC boundary", () => {
    const safe = structuredClone(packet); safe.context.state_revision = Number.MAX_SAFE_INTEGER;
    expect(() => validatePlanRequestConsistency(request([safe]), plan([basisOf(safe)]))).not.toThrow();
    const unsafe = structuredClone(packet); unsafe.context.state_revision = Number.MAX_SAFE_INTEGER + 1;
    try {
      validatePlanRequestConsistency(request([unsafe]), plan([basisOf(unsafe)]));
      throw new Error("Expected unsafe revision rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionContextContractError);
      expect(error).toMatchObject({code: "INTEGER_REPRESENTATION"});
    }
  });
  it("checks unselected extra packets instead of ignoring incompatible data", () => {
    const extra = structuredClone(packet);
    extra.packet_id = "packet2"; extra.task.task_key = "task2"; extra.context.task_id = "task2";
    expect(() => validatePlanRequestConsistency(request([packet, extra]), plan())).not.toThrow();
    const stale = structuredClone(extra); stale.context.state_revision += 1;
    expect(() => validatePlanRequestConsistency(request([packet, stale]), plan())).toThrow(NapPacketConsistencyError);
    const inconsistentTask = structuredClone(extra); inconsistentTask.context.task_id = "other-task";
    expect(() => validatePlanRequestConsistency(request([packet, inconsistentTask]), plan())).toThrow(NapPacketConsistencyError);
    expect(() => validatePlanRequestConsistency(request([packet, structuredClone(packet)]), plan())).toThrow(NapPacketConsistencyError);
  });
  it("cannot prove origin, authorization, current time or current state from self-consistent data", () => {
    const forged = structuredClone(packet);
    forged.context.expires_at = "2000-01-01T00:00:00Z";
    forged.snapshot_digest = "f".repeat(64);
    // A trusted host must reject this unauthenticated and expired packet before execution.
    expect(() => validatePlanRequestConsistency(request([forged]), plan([basisOf(forged)]))).not.toThrow();
  });
});
