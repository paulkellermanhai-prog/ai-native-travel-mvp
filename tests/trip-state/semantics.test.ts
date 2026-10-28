import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStateSemantics } from "../../src/server/trip-state/semantics";
import { TripStateContractError } from "../../src/server/trip-state/contracts";
import type { State } from "../../src/server/trip-state/contracts.generated";
import { scenario, traces, source, oracle } from "../support/command-fixtures";

const initial = JSON.parse(fs.readFileSync(`${source}/examples/initial-egypt-state.json`, "utf8")) as State;
function object<K extends State["objects"][number]["type"]>(s: State, id: string, kind: K) {
  const o = s.objects.find((o) => o.id === id && o.type === kind);
  if (!o) throw new Error("Invalid test fixture");
  return o as Extract<State["objects"][number], { type: K }>;
}
const cases: Array<{ name: string; code: string; base?: State; mutate: (s: State) => void }> = [
  { name: "single current goal", code: "GOAL_AUTHORITY", base: scenario.final_state, mutate: (s) => { const g = structuredClone(object(s, "goal-new", "TripGoal")); g.id = "goal-duplicate"; s.objects.push(g); } },
  { name: "expression evidence", code: "EVIDENCE", base: scenario.final_state, mutate: (s) => { object(s, "pref-new", "Preference").evidence_refs = []; } },
  { name: "superseded expression ancestry", code: "PREFERENCE_SUCCESSOR", base: scenario.final_state, mutate: (s) => { object(s, "pref-new", "Preference").status = "superseded"; } },
  { name: "exclusion reason", code: "EXCLUSION_REASON", base: scenario.final_state, mutate: (s) => { object(s, "candidate-new", "Candidate").status = "excluded"; } },
  { name: "confirmation actor", code: "CONFIRMATION", base: scenario.final_state, mutate: (s) => { const d = s.objects.find((o) => o.type === "Decision")!; if (d.type === "Decision") d.confirmed_by = null; } },
  { name: "confirmation scope", code: "CONFIRMATION_SCOPE", base: scenario.final_state, mutate: (s) => { const d = s.objects.find((o) => o.type === "Decision")!; if (d.type === "Decision") d.confirmation_scope = ["cities"]; } },
  { name: "one confirmed candidate choice", code: "DECISION_AUTHORITY", base: scenario.final_state, mutate: (s) => { const d = structuredClone(s.objects.find((o) => o.type === "Decision")!); d.id = "decision-duplicate"; s.objects.push(d); } },
  { name: "budget range", code: "BUDGET_RANGE", mutate: (s) => { const c = object(s, "constraint-budget", "Constraint"); if (c.value.kind === "budget") c.value.minimum_minor = 3000000; } },
  { name: "budget hardness", code: "BUDGET_HARDNESS", mutate: (s) => { object(s, "constraint-budget", "Constraint").hardness = "hard"; } },
  { name: "budget required amount", code: "BUDGET_MISSING", mutate: (s) => { const c = object(s, "constraint-budget", "Constraint"); if (c.value.kind === "budget") c.value.mode = "range"; } },
  { name: "budget category", code: "BUDGET_SCOPE", mutate: (s) => { const c = object(s, "constraint-budget", "Constraint"); if (c.value.kind === "budget") c.value.categories = []; } },
  { name: "date ordering", code: "DATE_RANGE", mutate: (s) => { const c = object(s, "constraint-dates", "Constraint"); if (c.value.kind === "date_window") c.value.end = "2029-01-01"; } },
  { name: "fact expiry ordering", code: "FACT_TIME", mutate: (s) => { const f = object(s, "fact-cairo-luxor", "ExternalFact"); f.expires_at = f.observed_at; } },
  { name: "failed query is not verified", code: "FALSE_VERIFICATION", mutate: (s) => { object(s, "fact-cairo-luxor", "ExternalFact").query_status = "timeout"; } },
  { name: "dated transport requires times", code: "FALSE_VERIFICATION", mutate: (s) => { const f = object(s, "fact-cairo-luxor", "ExternalFact"); if (f.value?.kind === "transport") f.value.departure = null; } },
  { name: "no service needs explicit evidence", code: "NO_SERVICE_EVIDENCE", mutate: (s) => { object(s, "fact-cairo-luxor", "ExternalFact").query_status = "no_service"; } },
  { name: "scenario assumptions cannot leak", code: "SCENARIO_LEAK", mutate: (s) => { object(s, "skeleton-a", "Skeleton").overrides = [{ constraint_id: "constraint-nights", value: { kind: "duration", maximum_nights: 6 } }]; } },
  { name: "closed issue needs resolution", code: "ISSUE_REASON", mutate: (s) => { object(s, "issue-cost", "OpenIssue").status = "resolved"; } },
];

describe("original static semantic invariants (not later command acceptance)", () => {
  it("preserves Python microsecond ordering rather than collapsing it to JS milliseconds", () => {
    const state = structuredClone(initial), fact = object(state, "fact-cairo-luxor", "ExternalFact");
    fact.observed_at = "2030-01-01T00:00:00.000001Z"; fact.expires_at = "2030-01-01T00:00:00.000002Z";
    expect(oracle({ mode: "states", states: [state] })).toEqual([null]);
    expect(validateStateSemantics(state)).toEqual(state);
  });
  it("validates every original scenario snapshot against independent Python", () => {
    const states = traces.flatMap((t) => [t.initial_state, ...t.steps.map((step) => step.state_after), t.final_state]);
    expect(oracle({ mode: "states", states })).toEqual(states.map(() => null));
    for (const state of states) expect(validateStateSemantics(state)).toEqual(state);
  });
  it.each(cases)("$name", ({ code, base, mutate }) => {
    const state = structuredClone(base ?? initial); mutate(state);
    expect(oracle({ mode: "states", states: [state] })).toEqual([code]);
    expect(() => validateStateSemantics(state)).toThrowError(expect.objectContaining({ code }));
    try { validateStateSemantics(state); } catch (error) { expect(error).toBeInstanceOf(TripStateContractError); }
  });
});
