import { describe, expect, it } from "vitest";
import { NapPhaseTransitionError, nextActionPhase } from "../../src/server/next-action-policy/action-phase";

const evaluate = {kind: "evaluate", structureValid: true, eligibilityPassed: true};
const start = {kind: "start", dependenciesCurrent: true, authorized: true, stepConditionsMet: true, claimAcquired: true};
const resume = {kind: "resume", feedbackVerified: true, basisCurrent: true, scopeAuthorized: true};
const cancel = {kind: "cancel", hostConfirmed: true};

describe("candidate action phase transitions, without trusted-host effects", () => {
  it("advances a valid proposal, waits, resumes, starts and completes without mutating inputs", () => {
    const signals = [evaluate, {kind: "await_user", userInputRequired: true}, resume, start, {kind: "complete", basisCurrent: true, outcome: "success"}];
    const before = structuredClone(signals);
    let phase: unknown = "proposed";
    for (const [i, signal] of signals.entries()) {
      const result = nextActionPhase(phase, signal);
      expect(result).toEqual({phase: ["eligible", "waiting_user", "eligible", "running", "succeeded"][i], receiptLookupRequired: false});
      phase = result.phase;
    }
    expect(signals).toEqual(before);
  });
  it("blocks a proposal when structure or eligibility is rejected", () => {
    for (const signal of [{...evaluate, structureValid: false}, {...evaluate, eligibilityPassed: false}]) {
      expect(nextActionPhase("proposed", signal).phase).toBe("blocked");
    }
  });
  it("requires every explicit start and resume guard to be true", () => {
    for (const [phase, signal, keys] of [
      ["eligible", start, ["dependenciesCurrent", "authorized", "stepConditionsMet", "claimAcquired"]],
      ["waiting_user", resume, ["feedbackVerified", "basisCurrent", "scopeAuthorized"]],
    ] as const) for (const key of keys) {
      for (const value of [false, null, "true", 1]) expect(() => nextActionPhase(phase, {...signal, [key]: value})).toThrow(NapPhaseTransitionError);
      const missing: Record<string, unknown> = {...signal}; delete missing[key];
      expect(() => nextActionPhase(phase, missing)).toThrow(NapPhaseTransitionError);
    }
  });
  it("marks eligible or waiting actions stale when a verified invalidation occurs", () => {
    for (const phase of ["eligible", "waiting_user"]) expect(nextActionPhase(phase, {kind: "invalidate"}).phase).toBe("stale");
    expect(() => nextActionPhase("proposed", {kind: "invalidate"})).toThrow(NapPhaseTransitionError);
  });
  it("cancels only a host-confirmed pre-running action", () => {
    for (const phase of ["proposed", "eligible", "waiting_user"]) {
      expect(nextActionPhase(phase, cancel).phase).toBe("cancelled");
      expect(() => nextActionPhase(phase, {...cancel, hostConfirmed: false})).toThrow(NapPhaseTransitionError);
    }
    // A running cancellation is best effort and needs a separate host operation.
    expect(() => nextActionPhase("running", cancel)).toThrow(NapPhaseTransitionError);
  });
  it("separates complete, partial, failure and stale results", () => {
    for (const [outcome, expected] of [["success", "succeeded"], ["partial", "partial"], ["failure", "failed"]]) {
      expect(nextActionPhase("running", {kind: "complete", basisCurrent: true, outcome}).phase).toBe(expected);
      expect(nextActionPhase("running", {kind: "complete", basisCurrent: false, outcome}).phase).toBe("stale");
    }
  });
  it("keeps uncertain execution running and requires an authoritative receipt lookup", () => {
    expect(nextActionPhase("running", {kind: "execution_unknown"})).toEqual({phase: "running", receiptLookupRequired: true});
    expect(() => nextActionPhase("eligible", {kind: "execution_unknown"})).toThrow(NapPhaseTransitionError);
  });
  it("never revives terminal actions and rejects unknown or malformed events", () => {
    for (const phase of ["blocked", "partial", "succeeded", "failed", "stale", "cancelled"]) {
      expect(() => nextActionPhase(phase, evaluate)).toThrow(NapPhaseTransitionError);
    }
    for (const value of [null, [], {}, {...start, extra: true}, {kind: "complete", basisCurrent: true, outcome: "unknown"}]) {
      expect(() => nextActionPhase("running", value)).toThrow(NapPhaseTransitionError);
    }
    expect(() => nextActionPhase("unknown", evaluate)).toThrow(NapPhaseTransitionError);
    expect(() => nextActionPhase("eligible", {kind: "await_user", userInputRequired: false})).toThrow(NapPhaseTransitionError);
    expect(() => nextActionPhase("eligible", {kind: "start", dependenciesCurrent: true})).toThrow(NapPhaseTransitionError);
  });
});
