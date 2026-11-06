import { describe, expect, it } from "vitest";
import { NapPhaseTransitionError, nextActionPhase, type ActionPhase } from "../../src/server/next-action-policy/action-phase";

// Independently transcribed from R3 RT-02: unspecified phase/event pairs must reject.
const phases: ActionPhase[] = ["proposed", "eligible", "waiting_user", "running", "blocked", "partial", "succeeded", "failed", "stale", "cancelled"];
const terminal = new Set<ActionPhase>(["blocked", "partial", "succeeded", "failed", "stale", "cancelled"]);
const events: Array<{name: string; input: Record<string, unknown>}> = [
  {name: "evaluate_ok", input: {kind: "evaluate", structureValid: true, eligibilityPassed: true}},
  {name: "evaluate_bad_structure", input: {kind: "evaluate", structureValid: false, eligibilityPassed: true}},
  {name: "evaluate_bad_eligibility", input: {kind: "evaluate", structureValid: true, eligibilityPassed: false}},
  {name: "evaluate_both_bad", input: {kind: "evaluate", structureValid: false, eligibilityPassed: false}},
  {name: "await_user", input: {kind: "await_user", userInputRequired: true}},
  {name: "start", input: {kind: "start", dependenciesCurrent: true, authorized: true, stepConditionsMet: true, claimAcquired: true}},
  {name: "invalidate", input: {kind: "invalidate"}},
  {name: "resume", input: {kind: "resume", feedbackVerified: true, basisCurrent: true, scopeAuthorized: true}},
  {name: "cancel", input: {kind: "cancel", hostConfirmed: true}},
  {name: "complete_success", input: {kind: "complete", basisCurrent: true, outcome: "success"}},
  {name: "complete_partial", input: {kind: "complete", basisCurrent: true, outcome: "partial"}},
  {name: "complete_failure", input: {kind: "complete", basisCurrent: true, outcome: "failure"}},
  {name: "stale_success", input: {kind: "complete", basisCurrent: false, outcome: "success"}},
  {name: "stale_partial", input: {kind: "complete", basisCurrent: false, outcome: "partial"}},
  {name: "stale_failure", input: {kind: "complete", basisCurrent: false, outcome: "failure"}},
  {name: "unknown", input: {kind: "execution_unknown"}},
];
const allowed: Partial<Record<ActionPhase, Record<string, ActionPhase>>> = {
  proposed: {evaluate_ok: "eligible", evaluate_bad_structure: "blocked", evaluate_bad_eligibility: "blocked", evaluate_both_bad: "blocked", cancel: "cancelled"},
  eligible: {await_user: "waiting_user", start: "running", invalidate: "stale", cancel: "cancelled"},
  waiting_user: {resume: "eligible", invalidate: "stale", cancel: "cancelled"},
  running: {complete_success: "succeeded", complete_partial: "partial", complete_failure: "failed", stale_success: "stale", stale_partial: "stale", stale_failure: "stale", unknown: "running"},
};

describe("R3 state-by-event independent expectation matrix", () => {
  it.each(phases.flatMap(phase => events.map(event => ({phase, event}))))("$phase / $event.name", ({phase, event}) => {
    const expected = allowed[phase]?.[event.name];
    const original = structuredClone(event.input);
    if (expected) {
      expect(nextActionPhase(phase, event.input)).toEqual({phase: expected, receiptLookupRequired: event.name === "unknown"});
    } else {
      expect(() => nextActionPhase(phase, event.input)).toThrow(NapPhaseTransitionError);
      expect(() => nextActionPhase(phase, event.input)).toThrow("NAP candidate action: INVALID_TRANSITION");
    }
    expect(event.input).toEqual(original);
  });
});

describe("bounded sequences and strict event input", () => {
  it("preserves terminal absorption, determinism and immutable inputs across every sequence of up to three listed events", () => {
    // Each of the 10 starting phases is explored over 16^3 event sequences.
    // Rejected events leave the caller's phase unchanged; no host persistence is simulated.
    for (const initial of phases) for (const first of events) for (const second of events) for (const third of events) {
      let current = initial;
      let reachedTerminal = terminal.has(initial);
      for (const item of [first, second, third]) {
        const signal = structuredClone(item.input);
        const before = structuredClone(signal);
        const expected = allowed[current]?.[item.name];
        if (expected) {
          expect(reachedTerminal).toBe(false);
          const a = nextActionPhase(current, signal);
          const b = nextActionPhase(current, signal);
          expect(a).toEqual(b);
          expect(a).toEqual({phase: expected, receiptLookupRequired: item.name === "unknown"});
          current = a.phase;
          reachedTerminal ||= terminal.has(current);
        } else {
          expect(() => nextActionPhase(current, signal)).toThrow(NapPhaseTransitionError);
        }
        expect(signal).toEqual(before);
      }
    }
  }, 30000);
  it("keeps repeated unknown execution in running and requires receipt lookup every time", () => {
    let phase: ActionPhase = "running";
    for (let i = 0; i < 100; i++) {
      const result = nextActionPhase(phase, {kind: "execution_unknown"});
      expect(result).toEqual({phase: "running", receiptLookupRequired: true});
      phase = result.phase;
    }
  });
  it("rejects omitted, wrongly typed or extra fields for every applicable event kind", () => {
    const cases: Array<{phase: ActionPhase; event: Record<string, unknown>}> = [
      {phase: "proposed", event: events[0].input},
      {phase: "eligible", event: events[4].input},
      {phase: "eligible", event: events[5].input},
      {phase: "eligible", event: events[6].input},
      {phase: "waiting_user", event: events[7].input},
      {phase: "proposed", event: events[8].input},
      {phase: "running", event: events[9].input},
      {phase: "running", event: events[15].input},
    ];
    for (const {phase, event} of cases) {
      expect(() => nextActionPhase(phase, {...event, extra: true})).toThrow(NapPhaseTransitionError);
      for (const key of Object.keys(event)) {
        const missing = {...event}; delete missing[key];
        expect(() => nextActionPhase(phase, missing)).toThrow(NapPhaseTransitionError);
        for (const invalid of [null, 0, "invalid", [], {}]) {
          expect(() => nextActionPhase(phase, {...event, [key]: invalid})).toThrow(NapPhaseTransitionError);
        }
      }
    }
    for (const badPhase of [null, undefined, {}, [], "RUNNING"]) expect(() => nextActionPhase(badPhase, events[0].input)).toThrow(NapPhaseTransitionError);
    for (const badEvent of [null, undefined, {}, [], "start", 1]) expect(() => nextActionPhase("eligible", badEvent)).toThrow(NapPhaseTransitionError);
  });
});
