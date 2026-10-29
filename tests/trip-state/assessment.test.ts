import { describe, expect, it } from "vitest";
import { planCommand } from "../../src/server/trip-state/commands";
import type { State, Constraint, ExternalFact } from "../../src/server/trip-state/contracts.generated";
import { base, object, change } from "../support/bcg-fixtures";
import { clock, uuids, oracle, traces, type Audit } from "../support/command-fixtures";
import { factActors as actors } from "../support/fact-fixtures";

function skeleton(s: State) { return object(s, "skeleton-a", "Skeleton"); }
function fact(s: State) { return object(s, "fact-cairo-luxor", "ExternalFact"); }
function constraint(s: State, value: Constraint["value"], hardness: Constraint["hardness"] = "hard") {
  const c = structuredClone(object(s, "constraint-nights", "Constraint")); c.id = "constraint-assess"; c.value = value; c.hardness = hardness; s.objects.push(c); return c;
}
function cost(s: State, id: string, currency = "CNY", people = 2, category = "experience", amount = 500) {
  const f = structuredClone(object(s, "cost-transport", "ExternalFact")); f.id = id;
  f.value = { kind: "cost", amount_minor: amount, currency, people, category, item_key: id }; s.objects.push(f); skeleton(s).cost_fact_ids.push(id); return f;
}
type Case = { name: string; edit?: (s: State) => void; time?: string; unknown?: string; violation?: string; inspect?: (s: State) => void };
const cases: Case[] = [
  { name: "known nights and UTC duration", inspect: (s) => expect(skeleton(s).assessment).toMatchObject({ total_nights: 4, connection_minutes: [60], status: "pending", cost_coverage: "partial" }) },
  { name: "unknown nights are not zero", edit: (s) => { skeleton(s).stops[0].nights = null; }, unknown: "stay_nights_missing" },
  { name: "hard duration", edit: (s) => { object(s, "constraint-nights", "Constraint").value = { kind: "duration", maximum_nights: 3 }; }, violation: "constraint-nights" },
  { name: "soft duration", edit: (s) => { const c = object(s, "constraint-nights", "Constraint"); c.hardness = "soft"; c.value = { kind: "duration", maximum_nights: 3 }; }, unknown: "constraint-nights" },
  { name: "hard date allocation", edit: (s) => { skeleton(s).stops[0].nights = 5; }, violation: "constraint-dates" },
  { name: "soft date allocation", edit: (s) => { constraint(s, { kind: "date_window", start: "2030-01-10", end: "2030-01-11" }, "soft"); }, unknown: "constraint-assess" },
  { name: "incompatible hard windows", edit: (s) => { constraint(s, { kind: "date_window", start: "2030-02-10", end: "2030-02-14" }); }, violation: "incompatible_date_windows" },
  { name: "missing travel dates", edit: (s) => { object(s, "constraint-dates", "Constraint").status = "proposed"; }, unknown: "travel_dates_missing" },
  ...["date", "traveler", "entity"].map((kind): Case => ({ name: `unsupported scoped ${kind} stays unknown`, edit: (s) => {
    const c = constraint(s, { kind: "duration", maximum_nights: 0 }); c.scope = kind === "date" ? { kind, ids: [], start: "2030-01-10", end: "2030-01-14" } : { kind: kind as "traveler" | "entity", ids: [kind === "traveler" ? "traveler-demo" : "luxor"] };
  }, unknown: "scoped_calculation_not_implemented:constraint-assess" })),
  { name: "unrelated entity constraint", edit: (s) => { constraint(s, { kind: "duration", maximum_nights: 0 }).scope = { kind: "entity", ids: ["aswan"] }; }, inspect: (s) => expect(skeleton(s).assessment.unknowns).not.toContain("scoped_calculation_not_implemented:constraint-assess") },
  { name: "scenario overrides do not alter real constraints", edit: (s) => { const sk = skeleton(s); sk.purpose = "scenario"; sk.overrides = [{ constraint_id: "constraint-nights", value: { kind: "duration", maximum_nights: 2 } }]; }, violation: "constraint-nights", inspect: (s) => expect(object(s, "constraint-nights", "Constraint").value).toEqual({ kind: "duration", maximum_nights: 4 }) },
  ...["partial", "empty", "timeout", "error"].map((query_status): Case => ({ name: `${query_status} is not no_service`, edit: (s) => {
    const f = fact(s); f.query_status = query_status as ExternalFact["query_status"]; f.verification = query_status === "partial" ? "estimated" : "unverified"; if (query_status !== "partial") f.value = null;
  }, unknown: "connection:0:missing_or_conflicting_evidence", inspect: (s) => expect(skeleton(s).assessment.violations).not.toContain("no_service:0") })),
  { name: "explicit no service", edit: (s) => { const f = fact(s); f.query_status = "no_service"; if (f.value?.kind === "transport") Object.assign(f.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null }); }, violation: "no_service:0", unknown: "connection:0:incomplete_schedule" },
  { name: "expired evidence", time: "2030-01-02T00:00:00Z", unknown: "connection:0:missing_or_conflicting_evidence" },
  ...["stale", "unknown-applicability", "outside-valid-for", "unknown-date", "future-observation"].map((kind): Case => ({ name: kind, edit: (s) => {
    const f = fact(s);
    if (kind === "stale") f.freshness = "stale";
    if (kind === "unknown-applicability") { f.applicability = "unknown"; f.verification = "estimated"; }
    if (kind === "outside-valid-for") f.valid_for.start = f.valid_for.end = "2030-01-13";
    if (kind === "unknown-date") { f.query.date = null; f.verification = "estimated"; }
    if (kind === "future-observation") { f.observed_at = "2030-01-01T00:00:00.000001Z"; }
  }, unknown: "connection:0:missing_or_conflicting_evidence" })),
  { name: "wrong geographic evidence endpoints", edit: (s) => { const f = fact(s); if (f.value?.kind === "transport") [f.value.from_id, f.value.to_id] = [f.value.to_id, f.value.from_id]; }, unknown: "connection:0:missing_or_conflicting_evidence" },
  { name: "conflicting schedules", edit: (s) => { const f = structuredClone(fact(s)); f.id = "conflicting-schedule"; s.objects.push(f); skeleton(s).connections[0].fact_ids.push(f.id); }, unknown: "connection:0:missing_or_conflicting_evidence" },
  ...["negative", "fractional-minute", "mismatched-duration", "query-date", "outside-dates"].map((kind): Case => ({ name: `time ${kind}`, edit: (s) => {
    const f = fact(s); if (f.value?.kind !== "transport") throw new Error("Fixture");
    if (kind === "negative") f.value.arrival = "2030-01-12T09:00:00+02:00";
    if (kind === "fractional-minute") f.value.arrival = "2030-01-12T11:00:00.000001+02:00";
    if (kind === "mismatched-duration") f.value.duration_minutes = 61;
    if (kind === "query-date") { f.value.departure = "2030-01-13T10:00:00+02:00"; f.value.arrival = "2030-01-13T11:00:00+02:00"; }
    if (kind === "outside-dates") f.value.arrival = "2030-01-15T11:00:00+02:00";
  }, violation: `connection:0:${["negative", "fractional-minute"].includes(kind) ? "invalid_times" : kind === "mismatched-duration" ? "duration_mismatch" : kind === "query-date" ? "query_date_mismatch" : "outside_dates"}` })),
  { name: "missed cross-city connection", edit: (s) => {
    const f = structuredClone(fact(s)); f.id = "fact-luxor-aswan"; f.subject_ids = ["luxor", "aswan"];
    if (f.value?.kind !== "transport") throw new Error("Fixture"); Object.assign(f.value, { from_id: "luxor", to_id: "aswan", departure: "2030-01-12T10:30:00+02:00", arrival: "2030-01-12T11:30:00+02:00" });
    s.objects.push(f); skeleton(s).stops.push({ entity_id: "aswan", nights: 0 }); skeleton(s).connections.push({ from_id: "luxor", to_id: "aswan", fact_ids: [f.id] });
  }, violation: "connection:1:missed_connection" },
  { name: "cost grouping preserves currency/people", edit: (s) => { cost(s, "cost-usd", "USD"); cost(s, "cost-solo", "CNY", 1); }, inspect: (s) => expect(skeleton(s).assessment.cost_groups.map((g) => [g.currency, g.people, g.subtotal_minor])).toEqual([["CNY", 2, 120000], ["USD", 2, 500], ["CNY", 1, 500]]) },
  { name: "duplicate cost items are not doubled", edit: (s) => { const f = cost(s, "duplicate-cost"); if (f.value?.kind === "cost") f.value.item_key = (object(s, "cost-transport", "ExternalFact").value as Extract<ExternalFact["value"], { kind: "cost" }>).item_key; }, unknown: "duplicate_cost_item:synthetic-cairo-luxor-fare", inspect: (s) => expect(skeleton(s).assessment.cost_groups[0].subtotal_minor).toBe(120000) },
  ...[true, false].map((hard): Case => ({ name: `${hard ? "hard ceiling" : "soft intent"} never claims full costs`, edit: (s) => { constraint(s, { kind: "budget", mode: hard ? "ceiling" : "intent", minimum_minor: null, maximum_minor: 100, currency: "CNY", people: 2, categories: ["transport"] }, hard ? "hard" : "soft"); }, unknown: "partial_budget:constraint-assess", ...(hard ? { violation: "constraint-assess" } : {}) })),
  { name: "budget filters categories/currency/people", edit: (s) => { cost(s, "unrelated-cost", "USD", 1, "lodging", 99999); constraint(s, { kind: "budget", mode: "ceiling", minimum_minor: null, maximum_minor: 0, currency: "CNY", people: 2, categories: ["lodging"] }); }, unknown: "partial_budget:constraint-assess", inspect: (s) => expect(skeleton(s).assessment.violations).not.toContain("constraint-assess") },
  ...[true, false, null].map((value): Case => ({ name: `requirement ${value}`, edit: (s) => { constraint(s, { kind: "requirement", description: "合成条件", condition: { op: "eq", object_id: "constraint-nights", path: "/value/maximum_nights", value: value === null ? null : value ? 4 : 5 } }); }, ...(value === false ? { violation: "constraint-assess" } : value === null ? { unknown: "constraint-assess" } : {}) })),
  ...["matching", "mismatch", "unknown"].map((kind): Case => ({ name: `traveler count ${kind}`, edit: (s) => {
    const goal = s.objects.find((o) => o.type === "TripGoal")!; if (goal.type !== "TripGoal") throw new Error("Fixture");
    constraint(s, { kind: "travelers", count: kind === "mismatch" ? goal.traveler_ids.length + 1 : goal.traveler_ids.length }); if (kind === "unknown") goal.traveler_ids = [];
  }, ...(kind === "mismatch" ? { violation: "constraint-assess" } : kind === "unknown" ? { unknown: "constraint-assess:travelers_unknown" } : {}) })),
  ...["matching", "wrong-city", "country", "missing-boundaries", "entry-time", "exit-time"].map((kind): Case => ({ name: `entry/exit ${kind}`, edit: (s) => {
    constraint(s, { kind: "entry_exit", entry_entity_id: kind === "country" ? "egypt" : kind === "wrong-city" ? "aswan" : "cairo", exit_entity_id: "luxor", arrival: kind === "missing-boundaries" ? null : kind === "entry-time" ? "2030-01-12T10:01:00+02:00" : "2030-01-10T10:00:00+02:00", departure: kind === "missing-boundaries" ? null : kind === "exit-time" ? "2030-01-12T10:59:00+02:00" : "2030-01-14T10:00:00+02:00" });
  }, ...(kind === "wrong-city" ? { violation: "constraint-assess" } : kind === "country" ? { unknown: "constraint-assess:endpoint_mapping_not_implemented" } : kind === "missing-boundaries" ? { unknown: "constraint-assess:boundary_time_missing" } : kind === "entry-time" ? { violation: "constraint-assess:entry_time" } : kind === "exit-time" ? { violation: "constraint-assess:exit_time" } : {}) })),
];

describe("E02-04D original deterministic assessment via real recalculate commands", () => {
  it.each(cases)("$name: full response/state/history matches independent Python Store", ({ edit, time, unknown, violation, inspect }) => {
    const state = structuredClone(base); edit?.(state); const request = change(state, [{ op: "recalculate", id: "skeleton-a" }]);
    const at = time ? () => new Date(time) : clock;
    const expected = oracle<Array<{ response: unknown; state_after: State; audit: Audit }>>({ initial: state, operations: [{ actor: actors.system, request }], clock: at().toISOString() })[0];
    const result = planCommand(state, request, actors.system, at, uuids());
    expect({ response: result.response, state_after: result.snapshot, audit: { intents: [result.intent], changes: [result.change] } }).toEqual(expected);
    const a = skeleton(result.snapshot).assessment;
    if (unknown) expect(a.unknowns).toContain(unknown); if (violation) expect(a.violations).toContain(violation);
    inspect?.(result.snapshot);
  });
  it.each(["included", "missing-city", "expired", "outside-dates"])("lodging commitment assessment: %s", (kind) => {
    const state = structuredClone(traces.find((t) => t.scenario.startsWith("E-"))!.steps[0].state_after);
    if (kind === "missing-city") { skeleton(state).stops = [{ entity_id: "cairo", nights: 4 }]; skeleton(state).connections = []; }
    if (kind === "outside-dates") object(state, "constraint-dates", "Constraint").value = { kind: "date_window", start: "2030-02-10", end: "2030-02-14" };
    const at = kind === "expired" ? () => new Date("2030-01-03T00:00:00Z") : clock;
    const request = change(state, [{ op: "recalculate", id: "skeleton-a" }]), r = planCommand(state, request, actors.system, at, uuids());
    const py = oracle<Array<{ response: unknown; state_after: State }>>({ initial: state, operations: [{ request, actor: actors.system }], clock: at().toISOString() })[0];
    expect(r.response).toEqual(py.response); expect(r.snapshot).toEqual(py.state_after);
    const a = skeleton(r.snapshot).assessment;
    if (kind === "missing-city") expect(a.violations).toContain("reservation_city_conflict:receipt-luxor");
    else expect(a.unknowns).toContain(kind === "outside-dates" ? "reservation_outside_or_unknown_trip_window:receipt-luxor" : kind === "expired" ? "reservation_receipt_needs_recheck:receipt-luxor" : "reservation_dates_not_checked:receipt-luxor");
  });
  it.each(["nights", "cost-sum", "operand"])("rejects unrepresentable %s arithmetic explicitly without changing the schema", (kind) => {
    const state = structuredClone(base);
    if (kind === "nights") skeleton(state).stops[0].nights = Number.MAX_SAFE_INTEGER;
    else if (kind === "operand") { const f = object(state, "cost-transport", "ExternalFact"); if (f.value?.kind === "cost") f.value.amount_minor = Number.MAX_SAFE_INTEGER + 1; }
    else cost(state, "overflow-cost", "CNY", 2, "experience", Number.MAX_SAFE_INTEGER);
    expect(() => planCommand(state, change(state, [{ op: "recalculate", id: "skeleton-a" }]), actors.system, clock, uuids())).toThrowError(expect.objectContaining({ code: "INTEGER_REPRESENTATION" }));
  });
});
