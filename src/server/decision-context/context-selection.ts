import type { State } from "../trip-state/contracts.generated";
import { parseStateReferences } from "../trip-state/references";
import { checkStateCounters } from "../trip-state/numbers";
import { conditionReferences, conditionValue, factUsable } from "../trip-state/conditions";
import { TripStateContractError } from "../trip-state/contracts";

type Item = State["objects"][number];
type Applicability = "applicable" | "not_applicable" | "unknown";
const fail = () : never => { throw new TripStateContractError("DANGLING_REF", "Context references a missing object"); };

/** Pure R6 candidate selection, based on the original TS context reference.
 * No DB read, permission grant, Task service or production Context is created.
 * Integrated TS condition rules are reused; full DC Packet assembly remains out of scope. */
export function selectContextObjects(value: unknown, targetIds: readonly string[]) {
  const state = parseStateReferences(value); checkStateCounters(state);
  const objects = new Map(state.objects.map(o => [o.id,o]));
  const selected = new Set<string>();
  const add = (id:string) => { if (!objects.has(id)) return fail(); selected.add(id); };
  for (const id of targetIds) add(id);
  for (const o of state.objects) {
    if (o.type === "TripGoal" && ["active","revised"].includes(o.status)
      || o.type === "Preference" && o.status === "active"
      || o.type === "Constraint" && o.status === "active"
      || o.type === "Decision" && o.status === "confirmed"
      || o.type === "OpenIssue" && o.status !== "resolved") add(o.id);
  }
  if (state.effective_skeleton_id) add(state.effective_skeleton_id);
  const pending = [...selected];
  for (let i=0;i<pending.length;i++) {
    const o=objects.get(pending[i])!;const references = o.dependencies.map(d=>d.object_id);
    for (const key of ["basis_ids","subject_ids","preference_ids","affected_ids","cost_fact_ids","destination_ids"] as const) {
      const value=(o as unknown as Record<string,unknown>)[key];
      if (Array.isArray(value)) references.push(...value as string[]);
    }
    if (o.type === "Skeleton") references.push(...o.stops.map(s=>s.entity_id),...o.connections.flatMap(c=>c.fact_ids));
    if ("condition" in o) references.push(...conditionReferences(o.condition));
    if ("reconsider_when" in o) references.push(...conditionReferences(o.reconsider_when));
    if (o.type === "Constraint" && o.value.kind === "requirement") references.push(...conditionReferences(o.value.condition));
    if (o.type === "Decision") references.push(o.subject_id);
    for (const id of references) if (!selected.has(id)) { add(id);pending.push(id); }
  }
  const ids=[...selected].sort(), all=state.objects;
  return {
    selected_object_ids:ids,
    must_include_constraints:all.filter(o=>o.type==="Constraint" && o.status==="active" && o.hardness==="hard").map(o=>o.id).sort(),
    active_decisions:all.filter(o=>o.type==="Decision" && o.status==="confirmed").map(o=>o.id).sort(),
    open_issues:all.filter(o=>o.type==="OpenIssue" && o.status!=="resolved").map(o=>o.id).sort(),
    assembled_from_versions:ids.map(id=>({id,version:objects.get(id)!.version})),
  };
}

/** R6 local scope with the integrated TS three-valued condition rules. */
export function scopeApplicability(object: Item, targetIds: readonly string[], objects: ReadonlyMap<string,Item>, now: Date): Applicability {
  const targets=new Set(targetIds);
  if (object.type==="Decision" && !targets.has(object.subject_id)) return "unknown";
  if (object.type==="OpenIssue" && !object.affected_ids.some(id=>targets.has(id))) return "unknown";
  if (object.scope.kind!=="trip") for (const id of targets) if (!objects.has(id)) return fail();
  let result:Applicability="unknown";
  if (object.scope.kind==="trip") result="applicable";
  else if (object.scope.kind==="skeleton") result=object.scope.ids.some(id=>targets.has(id))?"applicable":targets.size?"not_applicable":"unknown";
  else if (object.scope.kind==="entity") {
    const entities=new Set<string>();
    for (const id of targets) {
      const target=objects.get(id);if (!target) return fail();
      if ("subject_ids" in target) for (const entity of target.subject_ids) entities.add(entity);
      if (target.type==="Skeleton") for (const stop of target.stops) entities.add(stop.entity_id);
      if (target.type==="DestinationEntity") entities.add(id);
    }
    result=object.scope.ids.some(id=>entities.has(id))?"applicable":entities.size?"not_applicable":"unknown";
  }
  if ("condition" in object) {
    const condition=conditionValue(object.condition,objects,now);
    if (condition===false) result="not_applicable";
    else if (condition===null && result!=="not_applicable") result="unknown";
  }
  return result;
}
/** Time-dependent single-fact check; this function does not determine cross-fact C12 conflicts. */
export function isCurrentlyUsableFact(object:Item, now:Date):boolean {
  if (object.type!=="ExternalFact") throw new TripStateContractError("SCHEMA", "Expected ExternalFact");
  return factUsable(object,now);
}
