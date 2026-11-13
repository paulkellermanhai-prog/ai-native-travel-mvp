import type { State, Skeleton, Constraint, ExternalFact } from "./contracts.generated";
import { applicable, conditionReferences, conditionValue, conflictingFactIds, factUsable } from "./conditions";
import { instantMicros, reservationProfile } from "./semantics";
import { safeCounter } from "./numbers";

type Objects = ReadonlyMap<string, State["objects"][number]>;
function add(a: number, b: number): number { return safeCounter(safeCounter(a, "assessment subtotal") + safeCounter(b, "assessment operand"), "assessment sum"); }

/** Original rules.py assess: deterministic evidence subtotal, never route search or inferred completeness. */
export function assess(skeleton: Skeleton, objects: Objects, now: Date): Skeleton["assessment"] {
  const stamp = now.toISOString().replace(/\.(\d{3})Z$/, (_, ms) => ms === "000" ? "Z" : `.${ms}000Z`);
  const result: Skeleton["assessment"] = { status: "unchecked", total_nights: null, connection_minutes: [], cost_groups: [], cost_coverage: "none", unknowns: [], violations: [], checked_at: stamp };
  if (skeleton.stops.every((s) => s.nights !== null)) result.total_nights = skeleton.stops.reduce((sum, s) => add(sum, s.nights!), 0);
  const unknowns: string[] = [], violations: string[] = [];
  if (result.total_nights === null) unknowns.push("stay_nights_missing");
  const constraints = [...objects.values()].filter((o): o is Constraint => o.type === "Constraint" && o.status === "active" && applicable(o, skeleton));
  const overrides = new Map(skeleton.purpose === "scenario" ? skeleton.overrides.map((o) => [o.constraint_id, o.value]) : []);
  const values = constraints.map((c) => ({ constraint: c, value: overrides.get(c.id) ?? c.value }));
  const windows = values.filter((v) => v.value.kind === "date_window" && v.constraint.hardness === "hard" && ["trip", "skeleton"].includes(v.constraint.scope.kind))
    .map((v) => v.value as Extract<Constraint["value"], { kind: "date_window" }>);
  const window = windows.length ? { start: windows.map((w) => w.start).sort().at(-1)!, end: windows.map((w) => w.end).sort()[0] } : null;
  const contested = conflictingFactIds(objects, now, window);
  if (!window) unknowns.push("travel_dates_missing"); else if (window.start > window.end) violations.push("incompatible_date_windows");
  const cities = new Set(skeleton.stops.map((s) => s.entity_id)), at = BigInt(now.getTime()) * 1000n;
  for (const receipt of objects.values()) {
    const profile = receipt.type === "ExternalFact" ? reservationProfile(receipt) : null;
    if (!profile || receipt.type !== "ExternalFact" || receipt.status !== "active" || profile.commitment_state !== "confirmed") continue;
    if (!window || profile.check_out <= window.start || profile.check_in > window.end) unknowns.push("reservation_outside_or_unknown_trip_window:" + receipt.id);
    else if (!cities.has(profile.city_id)) violations.push("reservation_city_conflict:" + receipt.id);
    else unknowns.push("reservation_dates_not_checked:" + receipt.id);
    if (receipt.freshness !== "current" || instantMicros(receipt.expires_at) <= at || instantMicros(receipt.observed_at) > at) unknowns.push("reservation_receipt_needs_recheck:" + receipt.id);
  }
  const groups = new Map<string, Skeleton["assessment"]["cost_groups"][number]>(), seen = new Set<string>();
  for (const id of skeleton.cost_fact_ids) {
    const fact = objects.get(id);
    if (fact?.type !== "ExternalFact" || !factUsable(fact, now, window) || fact.value?.kind !== "cost") { unknowns.push("cost:" + id); continue; }
    if (contested.has(id)) { violations.push("contested_fact:" + id); unknowns.push("cost:" + id); continue; }
    const value = fact.value;
    if (seen.has(value.item_key)) { unknowns.push("duplicate_cost_item:" + value.item_key); continue; }
    seen.add(value.item_key); safeCounter(value.people, "cost people");
    const key = JSON.stringify([value.currency, value.people]);
    if (!groups.has(key)) groups.set(key, { currency: value.currency, people: value.people, subtotal_minor: 0, fact_ids: [] });
    const group = groups.get(key)!; group.subtotal_minor = add(group.subtotal_minor, value.amount_minor); group.fact_ids.push(id);
  }
  result.cost_groups = [...groups.values()]; result.cost_coverage = groups.size ? "partial" : "none";
  let previousArrival: bigint | null = null;
  const chosen: Array<[bigint, bigint]> = [];
  for (const [n, connection] of skeleton.connections.entries()) {
    const usable = connection.fact_ids.map((id) => objects.get(id)).filter((f): f is ExternalFact => f?.type === "ExternalFact" && factUsable(f, now, window)
      && f.value?.kind === "transport" && f.value.from_id === connection.from_id && f.value.to_id === connection.to_id);
    if (usable.some((f) => contested.has(f.id))) { violations.push(`connection:${n}:contested_evidence`); result.connection_minutes.push(null); continue; }
    if (usable.some((f) => f.query_status === "no_service" || f.value?.kind === "transport" && f.value.service_exists === false)) violations.push(`no_service:${n}`);
    if (usable.length !== 1) { unknowns.push(`connection:${n}:missing_or_conflicting_evidence`); result.connection_minutes.push(null); continue; }
    const fact = usable[0], value = fact.value;
    if (value?.kind !== "transport" || !value.departure || !value.arrival || value.service_exists !== true) { unknowns.push(`connection:${n}:incomplete_schedule`); result.connection_minutes.push(null); continue; }
    const departure = instantMicros(value.departure), arrival = instantMicros(value.arrival);
    const duration = Number(arrival - departure) / 1000000 / 60; // Original datetime.total_seconds()/60.
    if (duration < 0 || !Number.isInteger(duration)) { violations.push(`connection:${n}:invalid_times`); result.connection_minutes.push(null); continue; }
    safeCounter(duration, "connection minutes");
    if (value.duration_minutes !== null && safeCounter(value.duration_minutes, "declared connection minutes") !== duration) violations.push(`connection:${n}:duration_mismatch`);
    if (fact.query.date !== value.departure.slice(0, 10)) violations.push(`connection:${n}:query_date_mismatch`);
    if (window && !(window.start <= value.departure.slice(0, 10) && value.departure.slice(0, 10) <= value.arrival.slice(0, 10) && value.arrival.slice(0, 10) <= window.end)) violations.push(`connection:${n}:outside_dates`);
    if (previousArrival !== null && departure < previousArrival) violations.push(`connection:${n}:missed_connection`);
    previousArrival = arrival; chosen.push([departure, arrival]); result.connection_minutes.push(duration);
  }
  for (const { constraint, value } of values) {
    const failures = constraint.hardness === "hard" ? violations : unknowns;
    if (["date", "traveler", "entity"].includes(constraint.scope.kind)) { unknowns.push("scoped_calculation_not_implemented:" + constraint.id); continue; }
    if (value.kind === "duration" && result.total_nights !== null && result.total_nights > safeCounter(value.maximum_nights, "maximum nights")) failures.push(constraint.id);
    else if (value.kind === "date_window") {
      const available = (Date.parse(value.end) - Date.parse(value.start)) / 86400000;
      if (result.total_nights !== null && result.total_nights > available) failures.push(constraint.id);
    } else if (value.kind === "budget") {
      const subtotal = result.cost_groups.flatMap((g) => g.fact_ids).reduce((sum, id) => {
        const f = objects.get(id);
        return f?.type === "ExternalFact" && f.value?.kind === "cost" && f.value.currency === value.currency && f.value.people === value.people && value.categories.includes(f.value.category) ? add(sum, f.value.amount_minor) : sum;
      }, 0);
      safeCounter(value.people, "budget people");
      if (value.maximum_minor !== null && subtotal > safeCounter(value.maximum_minor, "budget maximum")) failures.push(constraint.id);
      unknowns.push("partial_budget:" + constraint.id);
    } else if (value.kind === "requirement") {
      const outcome = conditionValue(value.condition, objects, now, contested);
      if (outcome === false) failures.push(constraint.id); else if (outcome === null) {
        unknowns.push(constraint.id);
        if (constraint.hardness === "hard" && conditionReferences(value.condition).some((id) => contested.has(id))) violations.push("contested_fact:" + constraint.id);
      }
    } else if (value.kind === "travelers") {
      const goal = [...objects.values()].find((o) => o.type === "TripGoal" && ["active", "revised"].includes(o.status));
      if (goal?.type !== "TripGoal" || !goal.traveler_ids.length) unknowns.push(constraint.id + ":travelers_unknown");
      else if (goal.traveler_ids.length !== safeCounter(value.count, "traveler count")) failures.push(constraint.id);
    } else if (value.kind === "entry_exit") {
      const entry = objects.get(value.entry_entity_id), exit = objects.get(value.exit_entity_id);
      if (entry?.type !== "DestinationEntity" || exit?.type !== "DestinationEntity" || entry.entity_kind !== "city" || exit.entity_kind !== "city") unknowns.push(constraint.id + ":endpoint_mapping_not_implemented");
      else if (skeleton.stops[0].entity_id !== value.entry_entity_id || skeleton.stops.at(-1)!.entity_id !== value.exit_entity_id) failures.push(constraint.id);
      if (value.arrival && chosen.length && chosen[0][0] < instantMicros(value.arrival)) failures.push(constraint.id + ":entry_time");
      if (value.departure && chosen.length && chosen.at(-1)![1] > instantMicros(value.departure)) failures.push(constraint.id + ":exit_time");
      if (!value.arrival || !value.departure) unknowns.push(constraint.id + ":boundary_time_missing");
    }
  }
  result.unknowns = [...new Set(unknowns)].sort(); result.violations = [...new Set(violations)].sort();
  result.status = violations.length ? "blocked" : unknowns.length ? "pending" : "verified";
  return result;
}
