export type ActionPhase = "proposed" | "eligible" | "blocked" | "waiting_user" | "running" | "partial" | "succeeded" | "failed" | "stale" | "cancelled";
export type PhaseResult = {phase: ActionPhase; receiptLookupRequired: boolean};

export class NapPhaseTransitionError extends Error {
  constructor() { super("NAP candidate action: INVALID_TRANSITION"); this.name = "NapPhaseTransitionError"; }
}

const terminal = new Set<ActionPhase>(["blocked", "partial", "succeeded", "failed", "stale", "cancelled"]);
const phases = new Set<ActionPhase>(["proposed", "eligible", "blocked", "waiting_user", "running", "partial", "succeeded", "failed", "stale", "cancelled"]);

/**
 * A pure candidate phase transition, not a host or security boundary. Guard inputs
 * are assertions supplied by the caller; this function does not verify their origin,
 * persist state, claim a step, make a side effect, or prove a user actually consented.
 */
export function nextActionPhase(current: unknown, signal: unknown): PhaseResult {
  if (typeof current !== "string" || !phases.has(current as ActionPhase) || terminal.has(current as ActionPhase)) throw new NapPhaseTransitionError();
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) throw new NapPhaseTransitionError();
  const event = signal as Record<string, unknown>;
  const exact = (...fields: string[]) => {
    const keys = Object.keys(event);
    if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(event, key))) throw new NapPhaseTransitionError();
  };
  const allTrue = (...fields: string[]) => {
    if (fields.some(key => event[key] !== true)) throw new NapPhaseTransitionError();
  };
  let phase: ActionPhase;
  let receiptLookupRequired = false;
  switch (event.kind) {
    case "evaluate":
      exact("kind", "structureValid", "eligibilityPassed");
      if (current !== "proposed" || typeof event.structureValid !== "boolean" || typeof event.eligibilityPassed !== "boolean") throw new NapPhaseTransitionError();
      phase = event.structureValid && event.eligibilityPassed ? "eligible" : "blocked";
      break;
    case "await_user":
      exact("kind", "userInputRequired");
      if (current !== "eligible") throw new NapPhaseTransitionError();
      allTrue("userInputRequired");
      phase = "waiting_user";
      break;
    case "start":
      exact("kind", "dependenciesCurrent", "authorized", "stepConditionsMet", "claimAcquired");
      if (current !== "eligible") throw new NapPhaseTransitionError();
      allTrue("dependenciesCurrent", "authorized", "stepConditionsMet", "claimAcquired");
      phase = "running";
      break;
    case "invalidate":
      exact("kind");
      if (current !== "eligible" && current !== "waiting_user") throw new NapPhaseTransitionError();
      phase = "stale";
      break;
    case "resume":
      exact("kind", "feedbackVerified", "basisCurrent", "scopeAuthorized");
      if (current !== "waiting_user") throw new NapPhaseTransitionError();
      allTrue("feedbackVerified", "basisCurrent", "scopeAuthorized");
      phase = "eligible";
      break;
    case "cancel":
      exact("kind", "hostConfirmed");
      if (current !== "proposed" && current !== "eligible" && current !== "waiting_user") throw new NapPhaseTransitionError();
      allTrue("hostConfirmed");
      phase = "cancelled";
      break;
    case "complete":
      exact("kind", "basisCurrent", "outcome");
      if (current !== "running" || typeof event.basisCurrent !== "boolean" || !["success", "partial", "failure"].includes(event.outcome as string)) throw new NapPhaseTransitionError();
      phase = !event.basisCurrent ? "stale" : event.outcome === "success" ? "succeeded" : event.outcome === "partial" ? "partial" : "failed";
      break;
    case "execution_unknown":
      exact("kind");
      if (current !== "running") throw new NapPhaseTransitionError();
      phase = "running";
      receiptLookupRequired = true;
      break;
    default:
      throw new NapPhaseTransitionError();
  }
  return {phase, receiptLookupRequired};
}
