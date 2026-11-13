import { instantMicros, rule, timestampParts } from "./semantics";
import type { Condition, State, ExternalFact, Constraint, Skeleton } from "./contracts.generated";

type Objects = ReadonlyMap<string, State["objects"][number]>;
type EvidenceClock = Date | bigint;
/** Exact probe ticks for Context validation; Date callers retain existing R6 millisecond behavior. */
export function instantAttoseconds(value: string): bigint {
  const { milliseconds, fraction } = timestampParts(value);
  return BigInt(milliseconds) * 1_000_000_000_000_000n + BigInt((fraction + "000000000000000000").slice(0, 18));
}
export function conditionReferences(c: Condition): string[] {
  return "object_id" in c ? [c.object_id] : "args" in c ? c.args.flatMap(conditionReferences) : "arg" in c ? conditionReferences(c.arg) : [];
}

// Read existing observation metadata only. No provider calls, verification upgrade or freshness writes.
export function factUsable(fact: ExternalFact, now: EvidenceClock, window: { start: string; end: string } | null = null): boolean {
  const at = typeof now === "bigint" ? now : BigInt(now.getTime()) * 1000n;
  const instant = typeof now === "bigint" ? instantAttoseconds : instantMicros;
  return fact.status === "active" && fact.freshness === "current" && fact.applicability === "applicable"
    && instant(fact.expires_at) > at && instant(fact.observed_at) <= at && fact.missing_fields.length === 0
    && ["result", "no_service"].includes(fact.query_status) && fact.query.date !== null
    && fact.valid_for.start <= fact.query.date && fact.query.date <= fact.valid_for.end
    && (!window || window.start <= fact.query.date && fact.query.date <= window.end)
    && ["date_specific", "purchasable"].includes(fact.verification);
}
export function conflictingFactIds(objects: Objects, now: EvidenceClock, window: { start: string; end: string } | null = null): Set<string> {
  const usable = [...objects.values()].filter((o): o is ExternalFact => o.type === "ExternalFact" && factUsable(o, now, window));
  const groups = new Map<string, { yes: string[]; no: string[] }>();
  for (const fact of usable) {
    const value = fact.value;
    if (value?.kind !== "transport" || value.service_exists === null) continue;
    const scope = fact.scope;
    const key = JSON.stringify([fact.query.date, value.from_id, value.to_id,
      fact.query.parameters.map((p) => JSON.stringify([p.name, p.value])).sort(), scope.kind, [...scope.ids].sort(),
      scope.kind === "date" ? scope.start : null, scope.kind === "date" ? scope.end : null]);
    const group = groups.get(key) ?? { yes: [], no: [] };
    (value.service_exists ? group.yes : group.no).push(fact.id); groups.set(key, group);
  }
  const contested = new Set<string>();
  for (const group of groups.values()) if (group.yes.length && group.no.length)
    for (const id of [...group.yes, ...group.no]) contested.add(id);
  const usableIds = new Set(usable.map((f) => f.id));
  for (const issue of objects.values()) if (issue.type === "OpenIssue" && issue.issue_kind === "conflict" && issue.status !== "resolved") {
    const related = issue.affected_ids.filter((id) => usableIds.has(id));
    if (related.length > 1) for (const id of related) contested.add(id);
  }
  return contested;
}
function pointer(value: unknown, path: string): unknown {
  for (const part of path.replace(/^\/+|\/+$/g, "").split("/")) {
    if (Array.isArray(value)) {
      // Match the reference's integer array offsets, including negative offsets and digit separators.
      const token = part.replace(/^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "")
        .replace(/\p{Decimal_Number}/gu, (digit) => {
          const code = digit.codePointAt(0)!; let first = code;
          while (first > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(first - 1))) first--;
          return String((code - first) % 10);
        });
      if (!/^[+-]?\d(?:_?\d)*$/.test(token)) return null;
      const index = Number(token.replaceAll("_", ""));
      if (!Number.isSafeInteger(index)) return null;
      value = value[index < 0 ? value.length + index : index];
    } else if (value && typeof value === "object" && Object.hasOwn(value, part)) value = (value as Record<string, unknown>)[part];
    else return null;
  }
  return value ?? null;
}

/** Original three-valued rules.condition_value: never coerce unknown, booleans or text to numeric truth. */
export function conditionValue(condition: Condition, objects: Objects, now: EvidenceClock, contested?: ReadonlySet<string>): boolean | null {
  if (condition.op === "always") return true;
  if (condition.op === "not") { const value = conditionValue(condition.arg, objects, now, contested); return value === null ? null : !value; }
  if ("args" in condition) {
    const values = condition.args.map((c) => conditionValue(c, objects, now, contested));
    const decisive = condition.op === "any";
    return values.includes(decisive) ? decisive : values.includes(null) ? null : !decisive;
  }
  const object = objects.get(condition.object_id);
  if (!object || ["superseded", "withdrawn", "invalidated", "relaxed", "contradicted"].includes(object.status)
    || object.type === "ExternalFact" && (!factUsable(object, now) || (contested ?? conflictingFactIds(objects, now)).has(object.id))) return null;
  const left = pointer(object, condition.path), right = condition.value;
  if (left === null || right === null || typeof left === "object" || typeof left !== typeof right) return null;
  if (typeof left === "number" && typeof right === "number") {
    rule((!Number.isInteger(left) || Number.isSafeInteger(left)) && (!Number.isInteger(right) || Number.isSafeInteger(right)), "INTEGER_REPRESENTATION", "Condition integer operands must be exactly representable");
    switch (condition.op) { case "eq": return left === right; case "ne": return left !== right; case "lt": return left < right; case "lte": return left <= right; case "gt": return left > right; case "gte": return left >= right; }
  }
  return condition.op === "eq" ? left === right : condition.op === "ne" ? left !== right : null;
}
export function applicable(constraint: Constraint, skeleton: Skeleton): boolean {
  const scope = constraint.scope;
  return ["trip", "date", "traveler"].includes(scope.kind) || scope.kind === "skeleton" && scope.ids.includes(skeleton.id)
    || scope.kind === "entity" && scope.ids.some((id) => skeleton.stops.some((stop) => stop.entity_id === id));
}
export function reservationOverlapsTrip(profile: Record<string, string>, objects: Objects): boolean {
  const windows = [...objects.values()].filter((o): o is Constraint => o.type === "Constraint" && o.status === "active" && o.hardness === "hard" && o.scope.kind === "trip")
    .flatMap((o) => o.value.kind === "date_window" ? [o.value] : []);
  if (!windows.length) return true;
  const start = windows.map((w) => w.start).sort().at(-1)!, end = windows.map((w) => w.end).sort()[0];
  return start > end || !(profile.check_out <= start || profile.check_in > end);
}
