import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { DecisionContextContracts } from "../../src/server/decision-context/contracts";
import { planCommand } from "../../src/server/trip-state/commands";
import { NapPacketConsistencyError, validatePlanRequestConsistency } from "../../src/server/next-action-policy/plan-packet-consistency";
import { validateCompletionBinding } from "../../src/server/next-action-policy/completion-binding";
import { nextActionPhase } from "../../src/server/next-action-policy/action-phase";
import { scenario, clock, uuids } from "../support/command-fixtures";

type Generated = {runtime_id: string; packet: DecisionContextContracts["packet"]};
function referencePackets(states: unknown[]): Generated[] {
  return JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["tests/support/e04-reference-packet.py"], {
    input: JSON.stringify(states), encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, PYTHONDONTWRITEBYTECODE: "1"},
  })) as Generated[];
}
function messages({runtime_id, packet}: Generated) {
  const basis = {packet_id: packet.packet_id, turn_id: packet.turn_id, task_key: packet.task.task_key,
    state_revision: packet.context.state_revision, snapshot_digest: packet.snapshot_digest, expires_at: packet.context.expires_at};
  const request = {nap_contract_version: "0.1.0", decision_id: "synthetic-decision", runtime_id,
    trigger: {kind: "user_event", reference: "synthetic-event"}, packets: [packet]};
  // This manually constructed plan is a test input, not a policy decision or real tool request.
  const plan = {nap_contract_version: "0.1.0", decision_id: request.decision_id, runtime_id, basis: [basis],
    response: {request_ids: [], disposition: "answered", text: "Synthetic answer", evidence_refs: []},
    actions: [{action_id: "action", task_key: packet.task.task_key, packet_id: packet.packet_id, request_ids: [],
      goal: "D1", attention: "prepare", reason: "synthetic", steps: [{step_id: "step", kind: "query", depends_on: [],
        capability_id: "synthetic", arguments: {}, change_request: null, user_message: null}]}]};
  return {request, plan, basis};
}

describe("reference-only TS → R6 Packet → NAP boundary bridge", () => {
  it("uses real TS snapshots and R6 reference-generated Packets across the existing NAP checks", () => {
    const uuid = uuids();
    const first = planCommand(scenario.initial_state, scenario.steps[0].request, scenario.steps[0].actor, clock, uuid);
    const second = planCommand(first.snapshot, scenario.steps[1].request, scenario.steps[1].actor, clock, uuid);
    expect(first.response.outcome).toBe("applied");
    expect(second.response.outcome).toBe("applied");
    const [oldRef, currentRef] = referencePackets([first.snapshot, second.snapshot]);
    expect(oldRef.packet.context.state_revision).toBe(first.snapshot.revision);
    expect(currentRef.packet.context.state_revision).toBe(second.snapshot.revision);
    expect(currentRef.packet.snapshot_digest).not.toBe(oldRef.packet.snapshot_digest);
    const old = messages(oldRef), current = messages(currentRef);
    expect(() => validatePlanRequestConsistency(old.request, old.plan)).not.toThrow();
    expect(() => validatePlanRequestConsistency(current.request, current.plan)).not.toThrow();
    // A plan anchored to an old packet cannot be paired with a fresh Packet.
    expect(() => validatePlanRequestConsistency(current.request, {...old.plan, runtime_id: current.request.runtime_id})).toThrow(NapPacketConsistencyError);
    // An internally consistent old pair is still accepted: currentness requires the real host.
    expect(first.snapshot.revision).toBeLessThan(second.snapshot.revision);
    expect(() => validatePlanRequestConsistency(old.request, old.plan)).not.toThrow();

    const proposed = nextActionPhase("proposed", {kind: "evaluate", structureValid: true, eligibilityPassed: true});
    const running = nextActionPhase(proposed.phase, {kind: "start", dependenciesCurrent: true, authorized: true, stepConditionsMet: true, claimAcquired: true});
    expect(running.phase).toBe("running"); // Guard values are synthetic; no host authorization happened.
    const date = "2030-01-01T00:00:00Z", planDigest = "b".repeat(64), queryDigest = "c".repeat(64);
    const record = {nap_contract_version: "0.1.0", decision_id: old.request.decision_id, action_id: "action", phase: running.phase,
      plan_digest: planDigest, completed_step_ids: [], result_refs: [], error_ref: null, related_action_ids: [], updated_at: date};
    const completion = {nap_contract_version: "0.1.0", completion_id: "synthetic-completion", decision_id: old.request.decision_id,
      action_id: "action", step_id: "step", query_digest: queryDigest, basis_state_revision: old.basis.state_revision,
      result_status: "result", provider_ref: "synthetic-provider", observed_at: date, expires_at: null, raw_result_ref: "synthetic-result", validated_fact_ids: [], error: null};
    const invocation = {decision_id: old.request.decision_id, runtime_id: old.request.runtime_id, action_id: "action", step_id: "step",
      capability_id: "synthetic", provider_ref: "synthetic-provider", query_digest: queryDigest, plan_digest: planDigest, basis_state_revision: old.basis.state_revision};
    // Binding checks accept the old, self-consistent records; no authoritative state is consulted.
    expect(() => validateCompletionBinding(old.plan, record, completion, invocation)).not.toThrow();
    expect(() => validateCompletionBinding(old.plan, record, {...completion, basis_state_revision: current.basis.state_revision}, invocation)).toThrow();
    expect(nextActionPhase(running.phase, {kind: "complete", basisCurrent: false, outcome: "success"}).phase).toBe("stale");
    expect(nextActionPhase(running.phase, {kind: "execution_unknown"})).toEqual({phase: "running", receiptLookupRequired: true});
  });
});
