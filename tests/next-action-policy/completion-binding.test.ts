import { describe, expect, it } from "vitest";
import { NapCompletionBindingError, validateCompletionBinding } from "../../src/server/next-action-policy/completion-binding";
import { NapContractError } from "../../src/server/next-action-policy/contracts";

const date = "2030-01-01T00:00:00Z", stateDigest = "a".repeat(64), planDigest = "b".repeat(64), queryDigest = "c".repeat(64);
const basis = {packet_id: "packet", turn_id: "turn", task_key: "task", state_revision: 4, snapshot_digest: stateDigest, expires_at: date};
const step = {step_id: "step", kind: "query", depends_on: [], capability_id: "transport", arguments: {}, change_request: null, user_message: null};
const action = {action_id: "action", task_key: "task", packet_id: "packet", request_ids: [], goal: "D1", attention: "prepare", reason: "reason", steps: [step]};
const plan = {nap_contract_version: "0.1.0", decision_id: "decision", runtime_id: "runtime", basis: [basis], response: {request_ids: [], disposition: "answered", text: "Answer", evidence_refs: []}, actions: [action]};
const record = {nap_contract_version: "0.1.0", decision_id: "decision", action_id: "action", phase: "running", plan_digest: planDigest, completed_step_ids: [], result_refs: [], error_ref: null, related_action_ids: [], updated_at: date};
const completion = {nap_contract_version: "0.1.0", completion_id: "completion", decision_id: "decision", action_id: "action", step_id: "step", query_digest: queryDigest, basis_state_revision: 4, result_status: "result", provider_ref: "provider", observed_at: date, expires_at: null, raw_result_ref: "result", validated_fact_ids: [], error: null};
const invocation = {decision_id: "decision", runtime_id: "runtime", action_id: "action", step_id: "step", capability_id: "transport", provider_ref: "provider", query_digest: queryDigest, plan_digest: planDigest, basis_state_revision: 4};

describe("in-memory tool completion bindings", () => {
  it("accepts matching records without modifying any input", () => {
    const inputs = structuredClone({plan, record, completion, invocation}); const before = structuredClone(inputs);
    expect(() => validateCompletionBinding(inputs.plan, inputs.record, inputs.completion, inputs.invocation)).not.toThrow();
    expect(inputs).toEqual(before);
  });
  it.each(["result", "partial", "empty", "timeout", "error", "no_service"])("preserves %s as a distinct supplied status", status => {
    const value = {...completion, result_status: status};
    expect(() => validateCompletionBinding(plan, record, value, invocation)).not.toThrow();
    expect(value.result_status).toBe(status);
  });
  it.each(["read", "query", "calculate"])("permits a matched %s step", kind => {
    const next = {...plan, actions: [{...action, steps: [{...step, kind}]}]};
    expect(() => validateCompletionBinding(next, record, completion, invocation)).not.toThrow();
  });
  it("rejects mismatched decision, runtime, action, step, query, provider and plan identifiers", () => {
    for (const changed of [
      {...invocation, decision_id: "other"}, {...invocation, runtime_id: "other"},
      {...invocation, action_id: "other"}, {...invocation, step_id: "other"},
      {...invocation, capability_id: "other"}, {...invocation, provider_ref: "other"},
      {...invocation, query_digest: "d".repeat(64)}, {...invocation, plan_digest: "e".repeat(64)},
      {...invocation, basis_state_revision: 5},
    ]) expect(() => validateCompletionBinding(plan, record, completion, changed)).toThrow(NapCompletionBindingError);
  });
  it("rejects a stale record or a completion with mismatched ids, revision, query or provider", () => {
    expect(() => validateCompletionBinding(plan, {...record, phase: "stale"}, completion, invocation)).toThrow(NapCompletionBindingError);
    for (const changed of [
      {...completion, decision_id: "other"}, {...completion, action_id: "other"}, {...completion, step_id: "other"},
      {...completion, basis_state_revision: 5}, {...completion, query_digest: "d".repeat(64)}, {...completion, provider_ref: "other"},
    ]) expect(() => validateCompletionBinding(plan, record, changed, invocation)).toThrow(NapCompletionBindingError);
  });
  it("does not confuse a step from another action or a non-tool step with the requested step", () => {
    const otherAction = {...action, action_id: "other", steps: [{...step, step_id: "other_step"}]};
    const twoActions = {...plan, actions: [action, otherAction]};
    const altered = {...invocation, step_id: "other_step"};
    expect(() => validateCompletionBinding(twoActions, record, {...completion, step_id: "other_step"}, altered)).toThrow(NapCompletionBindingError);
    const ask = {...step, kind: "ask", capability_id: "transport", user_message: "Question"};
    expect(() => validateCompletionBinding({...plan, actions: [{...action, steps: [ask]}]}, record, completion, invocation)).toThrow(NapCompletionBindingError);
  });
  it("rejects malformed, unknown or unsafe invocation inputs and malformed messages", () => {
    for (const key of Object.keys(invocation)) {
      const missing: Record<string, unknown> = {...invocation}; delete missing[key];
      expect(() => validateCompletionBinding(plan, record, completion, missing)).toThrow(NapCompletionBindingError);
    }
    for (const value of [null, [], {...invocation, extra: true}, {...invocation, basis_state_revision: Number.MAX_SAFE_INTEGER + 1}, {...invocation, provider_ref: ""}]) {
      expect(() => validateCompletionBinding(plan, record, completion, value)).toThrow(NapCompletionBindingError);
    }
    expect(() => validateCompletionBinding(plan, record, {...completion, result_status: "success"}, invocation)).toThrow(NapContractError);
  });
  it("does not authenticate a self-consistent forged completion or prove currentness", () => {
    const fake = {...completion, observed_at: "2000-01-01T00:00:00Z", expires_at: "2000-01-02T00:00:00Z"};
    // All records may be fabricated; a real host must establish origin, current state and time independently.
    expect(() => validateCompletionBinding(plan, record, fake, invocation)).not.toThrow();
  });
  it("cannot detect a newer authoritative revision when all supplied records still claim an old running revision", () => {
    const authoritativeRevision = 5; // Not passed to this pure comparison; host must independently read it.
    expect(basis.state_revision).toBe(4);
    expect(authoritativeRevision).toBeGreaterThan(basis.state_revision);
    expect(record.phase).toBe("running");
    expect(() => validateCompletionBinding(plan, record, completion, invocation)).not.toThrow();
  });
  it("does not deduplicate repeated completion IDs or reject same-ID content changes", () => {
    const repeated = structuredClone(completion);
    const differentContent = {...completion, result_status: "partial", raw_result_ref: "different-result"};
    expect(repeated.completion_id).toBe(differentContent.completion_id);
    expect(repeated.raw_result_ref).not.toBe(differentContent.raw_result_ref);
    // No host storage or prior receipt is available here: all three comparisons can pass.
    for (const value of [completion, repeated, differentContent]) {
      expect(() => validateCompletionBinding(plan, record, value, invocation)).not.toThrow();
    }
  });
});
