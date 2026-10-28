import type { Actor, CommandRequest } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { traces, type Audit } from "./command-fixtures";
import { base, object } from "./bcg-fixtures";

export const factActors: Record<Actor["role"], Actor> = {
  tool: { role: "tool", id: "scenario-provider" }, system: { role: "system", id: "scenario-system" },
  user: { role: "user", id: "scenario-user" }, model: { role: "model", id: "scenario-ai" },
};
export type Ingest = Extract<TripStateContracts["command"], { op: "ingest_fact" }>;
export type FactResult = { response: TripStateContracts["response"]; state_after: State; audit: Audit };
export function ingest(id = "synthetic-fact"): Ingest {
  const fact = object(base, "fact-cairo-luxor", "ExternalFact");
  const { subject_ids, query, provider, query_status, observed_at, expires_at, valid_for, missing_fields, value } = structuredClone(fact);
  return { op: "ingest_fact", id, scope: structuredClone(fact.scope), dependencies: [], data: { subject_ids, query, provider, query_status, observed_at, expires_at, valid_for, missing_fields, value } };
}
const e = traces.find((t) => t.scenario.startsWith("E-"))!, f = traces.find((t) => t.scenario.startsWith("F-"))!;
export const booking = () => structuredClone(e.steps[0].request.commands[0]) as Ingest;
export const cancellation = () => structuredClone(e.steps[4].request.commands[1]) as Ingest;
function segment(name: string, trace: typeof e, initial: State, steps: typeof e.steps) {
  const proposals = new Set(steps.map((s) => s.response.proposal_id));
  const changes = trace.audit.changes.filter((c) => proposals.has(c.proposal_id));
  const intents = trace.audit.intents.filter((i) => changes.some((c) => c.intent_id === i.id));
  return { name, initial, steps, audit: { intents, changes }, uuidStart: parseInt(steps[0].response.proposal_id!.slice("proposal-".length), 16) };
}
// All source objects remain intact. Adoption/calculation steps are explicitly deferred to E02-04D.
export const factSegments = [
  segment("E steps 1-3: receipt, guarded rejection, draft skeleton", e, e.initial_state, e.steps.slice(0, 3)),
  segment("E step 5: atomic receipt replacement (source step 4 was a rejected adoption)", e, e.steps[3].state_after, [e.steps[4]]),
  segment("F steps 2-3: service contradiction and draft replacement; adopted source state is a fixture", f, f.steps[0].state_after, f.steps.slice(1, 3)),
];
export type FactOperation = { request: CommandRequest; actor: Actor; clock?: string };
