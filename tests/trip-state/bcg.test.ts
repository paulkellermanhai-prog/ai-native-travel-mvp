import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { planCommand } from "../../src/server/trip-state/commands";
import { bcg, object } from "../support/bcg-fixtures";
import { clock, uuids, oracle, type Audit } from "../support/command-fixtures";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";

const evidence: unknown[] = [];
describe("E02-04B complete original B/C/G command execution", () => {
  it.each(bcg)("$trace.scenario: exact TS ↔ independent Python ↔ original machine trace", ({ trace, uuidStart }) => {
    const python = oracle<Array<{ response: TripStateContracts["response"]; state_after: State; audit: Audit }>>({ initial: trace.initial_state, operations: trace.steps, uuidStart });
    const uuid = uuids(uuidStart), audit: Audit = { intents: [], changes: [] }, actual = [];
    let state = structuredClone(trace.initial_state);
    for (const [i, step] of trace.steps.entries()) {
      const batch = planCommand(state, step.request, step.actor, clock, uuid); state = batch.snapshot;
      audit.intents.push(batch.intent); audit.changes.push(batch.change);
      expect(batch.response, `${trace.scenario} step ${i + 1}: complete response/diff/digest`).toEqual(step.response);
      expect(state, `${trace.scenario} step ${i + 1}: state/versions/provenance`).toEqual(step.state_after);
      expect({ response: batch.response, state_after: state, audit }).toEqual(python[i]);
      actual.push({ step: i + 1, request: step.request, actor: step.actor, response: batch.response, state_after: state, intent: batch.intent, change: batch.change });
      console.info(`TS ${trace.scenario} step ${i + 1}: ${batch.response.outcome}, revision=${state.revision}; Python+machine exact match`);
    }
    expect(state).toEqual(trace.final_state); expect(audit).toEqual(trace.audit);
    for (const fact of trace.initial_state.objects.filter((o) => o.type === "ExternalFact")) expect(state.objects.find((o) => o.id === fact.id)).toEqual(fact);
    if (trace.scenario.startsWith("B")) {
      expect(object(state, "pref-culture", "Preference")).toEqual(object(trace.initial_state, "pref-culture", "Preference"));
      expect(object(state, "candidate-aswan", "Candidate")).toEqual(object(trace.initial_state, "candidate-aswan", "Candidate"));
      expect(object(state, "pref-luxor-local", "Preference").scope).toEqual({ kind: "entity", ids: ["luxor"] });
      expect(object(state, "candidate-luxor", "Candidate").status).toBe("reintroduced");
    }
    if (trace.scenario.startsWith("C")) expect(object(state, "candidate-cairo", "Candidate").review_state).toBe("stale");
    if (trace.scenario.startsWith("G")) {
      const decisions = state.objects.filter((o) => o.type === "Decision");
      expect(decisions).toHaveLength(2); expect(decisions[0].status).toBe("revised"); expect(decisions[1]).toMatchObject({ status: "confirmed", value: "reject", supersedes: decisions[0].id });
      expect(object(state, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
    }
    evidence.push({ scenario: trace.scenario, producer: "Executed TypeScript from its prior output; no objects removed", original_machine_and_python_exact_match: true, steps: actual });
    if (process.env.E02_BCG_EVIDENCE_PATH) fs.writeFileSync(process.env.E02_BCG_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
  });
});
