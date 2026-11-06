import { validateNapMessage } from "./contracts";
import { validatePlanInternalIntegrity } from "./plan-integrity";

type Basis = {packet_id: string; task_key: string; state_revision: number};
type Step = {step_id: string; kind: string; capability_id: string | null};
type Plan = {decision_id: string; runtime_id: string; basis: Basis[]; actions: {action_id: string; task_key: string; packet_id: string; steps: Step[]}[]};
type RecordValue = {decision_id: string; action_id: string; phase: string; plan_digest: string};
type Completion = {decision_id: string; action_id: string; step_id: string; query_digest: string; basis_state_revision: number; provider_ref: string};
type Invocation = {decision_id: string; runtime_id: string; action_id: string; step_id: string; capability_id: string; provider_ref: string; query_digest: string; plan_digest: string; basis_state_revision: number};

export class NapCompletionBindingError extends Error {
  constructor() { super("NAP candidate completion: BINDING"); this.name = "NapCompletionBindingError"; }
}

const invocationKeys = ["decision_id", "runtime_id", "action_id", "step_id", "capability_id", "provider_ref", "query_digest", "plan_digest", "basis_state_revision"];
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/;
const digestPattern = /^[0-9a-f]{64}$/;

/**
 * Compares four caller-supplied in-memory records. It does not authenticate their
 * source, compute hashes, read state/clock, deduplicate, store or execute anything.
 * A mismatch rejects eligibility for this live binding; hosts must still retain
 * late/stale results as historical evidence under the applicable privacy rules.
 */
export function validateCompletionBinding(planValue: unknown, recordValue: unknown, completionValue: unknown, invocationValue: unknown): void {
  validatePlanInternalIntegrity(planValue);
  validateNapMessage("ActionRecord", recordValue);
  validateNapMessage("ToolCompletion", completionValue);
  if (!invocationValue || typeof invocationValue !== "object" || Array.isArray(invocationValue)) throw new NapCompletionBindingError();
  const invocation = invocationValue as Record<string, unknown>;
  if (Object.keys(invocation).length !== invocationKeys.length || invocationKeys.some(key => !Object.hasOwn(invocation, key))) throw new NapCompletionBindingError();
  for (const key of ["decision_id", "runtime_id", "action_id", "step_id", "capability_id"]) {
    if (typeof invocation[key] !== "string" || !idPattern.test(invocation[key])) throw new NapCompletionBindingError();
  }
  for (const key of ["query_digest", "plan_digest"]) {
    if (typeof invocation[key] !== "string" || !digestPattern.test(invocation[key])) throw new NapCompletionBindingError();
  }
  if (typeof invocation.provider_ref !== "string" || invocation.provider_ref.length === 0 ||
    !Number.isSafeInteger(invocation.basis_state_revision) || (invocation.basis_state_revision as number) < 0) throw new NapCompletionBindingError();

  const plan = planValue as Plan;
  const record = recordValue as RecordValue;
  const completion = completionValue as Completion;
  const expected = invocation as Invocation;
  if (plan.decision_id !== expected.decision_id || plan.runtime_id !== expected.runtime_id ||
    record.decision_id !== expected.decision_id || completion.decision_id !== expected.decision_id ||
    record.action_id !== expected.action_id || completion.action_id !== expected.action_id ||
    completion.step_id !== expected.step_id || record.phase !== "running" ||
    record.plan_digest !== expected.plan_digest || completion.query_digest !== expected.query_digest ||
    completion.provider_ref !== expected.provider_ref || !Number.isSafeInteger(completion.basis_state_revision) ||
    completion.basis_state_revision !== expected.basis_state_revision) throw new NapCompletionBindingError();

  const action = plan.actions.find(item => item.action_id === expected.action_id);
  const step = action?.steps.find(item => item.step_id === expected.step_id);
  const basis = plan.basis.find(item => item.packet_id === action?.packet_id && item.task_key === action?.task_key);
  if (!step || !["read", "query", "calculate"].includes(step.kind) || step.capability_id !== expected.capability_id ||
    !basis || !Number.isSafeInteger(basis.state_revision) || basis.state_revision !== expected.basis_state_revision) throw new NapCompletionBindingError();
}
