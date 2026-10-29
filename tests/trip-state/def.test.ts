import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { planCommand, failureResponse } from "../../src/server/trip-state/commands";
import { TripStateContractError } from "../../src/server/trip-state/contracts";
import { clock, uuids, oracle, traces, type Audit } from "../support/command-fixtures";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";

type Result = { response: TripStateContracts["response"]; state_after: State; audit: Audit };
export const def = traces.filter((t) => /^[DEF]-/.test(t.scenario));
const evidence: unknown[] = [];
describe("E02-04D complete original D/E/F execution", () => {
  it.each(def)("$scenario: exact full TS ↔ independent Python ↔ machine trace", (trace) => {
    const uuidStart = parseInt(trace.steps[0].response.proposal_id!.slice("proposal-".length), 16), uuid = uuids(uuidStart);
    const python = oracle<Result[]>({ initial: trace.initial_state, operations: trace.steps, uuidStart });
    let state = structuredClone(trace.initial_state); const audit: Audit = { intents: [], changes: [] }, actual = [];
    for (const [i, step] of trace.steps.entries()) {
      let response;
      try { const batch = planCommand(state, step.request, step.actor, clock, uuid); state = batch.snapshot;
        audit.intents.push(batch.intent); audit.changes.push(batch.change); response = batch.response;
      } catch (error) { if (!(error instanceof TripStateContractError)) throw error; response = failureResponse(state, error); }
      expect(response, `step ${i + 1} full response/diff`).toEqual(step.response);
      expect(state, `step ${i + 1} full state/assessment/versions/root`).toEqual(step.state_after);
      expect({ response, state_after: state, audit }).toEqual(python[i]);
      actual.push({ step: i + 1, request: step.request, actor: step.actor, response, state_after: structuredClone(state), audit: structuredClone(audit) });
      console.info(`TS ${trace.scenario} step ${i + 1}: ${response.outcome}, revision=${state.revision}; Python+machine exact match`);
    }
    expect(state).toEqual(trace.final_state); expect(audit).toEqual(trace.audit);
    evidence.push({ scenario: trace.scenario, producer: "Actual TypeScript from previous own output; no adopted-state seeding", independent_python_and_machine_exact_match: true, steps: actual });
    if (process.env.E02_DEF_EVIDENCE_PATH) fs.writeFileSync(process.env.E02_DEF_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
  });
});
