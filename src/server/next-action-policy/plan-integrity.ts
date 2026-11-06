import { validateNapMessage } from "./contracts";

type Step = {step_id: string; kind: string; depends_on: string[]; arguments: Record<string, unknown>; change_request: unknown; user_message: string | null};
type Action = {action_id: string; task_key: string; packet_id: string; attention: string; steps: Step[]};
type Basis = {packet_id: string; task_key: string; turn_id: string; state_revision: number; snapshot_digest: string; expires_at: string};
type Plan = {basis: Basis[]; actions: Action[]};

export class NapPlanIntegrityError extends Error {
  constructor() { super("NAP candidate plan: INTERNAL_REFERENCE"); this.name = "NapPlanIntegrityError"; }
}

/**
 * Checks only self-contained plan structure and relationships. It cannot establish
 * trusted packet origin, current authorization, complete delivery, or execution eligibility.
 * Never use this function as an HTTP/security boundary or a substitute for G02.
 */
export function validatePlanInternalIntegrity(value: unknown): void {
  validateNapMessage("DecisionPlan", value);
  const plan = value as Plan;
  const packets = new Map<string, Basis>();
  for (const basis of plan.basis) {
    const prior = packets.get(basis.packet_id);
    // Repeated identical claims are harmless. Compare the exact copied expiry string;
    // normalizing different representations would weaken the host's exact-basis check.
    if (prior && (prior.task_key !== basis.task_key || prior.turn_id !== basis.turn_id ||
      prior.state_revision !== basis.state_revision || prior.snapshot_digest !== basis.snapshot_digest ||
      prior.expires_at !== basis.expires_at)) throw new NapPlanIntegrityError();
    packets.set(basis.packet_id, basis);
  }
  const actionIds = new Set<string>();
  const steps = new Map<string, Step>();
  let primaryCount = 0;
  for (const action of plan.actions) {
    if (actionIds.has(action.action_id)) throw new NapPlanIntegrityError();
    actionIds.add(action.action_id);
    if (action.attention === "primary" && ++primaryCount > 1) throw new NapPlanIntegrityError();
    // This checks the self-reported plan only; the host must match basis against real packets.
    if (packets.get(action.packet_id)?.task_key !== action.task_key) throw new NapPlanIntegrityError();
    for (const step of action.steps) {
      if (steps.has(step.step_id)) throw new NapPlanIntegrityError();
      if (!["read", "query", "calculate"].includes(step.kind) && Object.keys(step.arguments).length !== 0) throw new NapPlanIntegrityError();
      if ((step.kind === "change") !== (step.change_request !== null)) throw new NapPlanIntegrityError();
      if (["ask", "deliver"].includes(step.kind) && step.user_message === null) throw new NapPlanIntegrityError();
      steps.set(step.step_id, step);
    }
  }
  // Kahn's algorithm is iterative: deep valid plans cannot overflow the call stack.
  const remaining = new Map<string, number>();
  const dependants = new Map<string, string[]>();
  for (const step of steps.values()) {
    remaining.set(step.step_id, step.depends_on.length);
    for (const dependency of step.depends_on) {
      if (!steps.has(dependency)) throw new NapPlanIntegrityError();
      const list = dependants.get(dependency) ?? [];
      list.push(step.step_id);
      dependants.set(dependency, list);
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) {
    for (const id of dependants.get(ready[i]) ?? []) {
      const count = remaining.get(id)! - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  if (ready.length !== steps.size) throw new NapPlanIntegrityError();
}
