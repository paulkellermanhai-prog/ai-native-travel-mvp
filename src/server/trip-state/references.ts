import { parseContract, TripStateContractError } from "./contracts";
import type { Condition, State } from "./contracts.generated";

type ObjectRecord = State["objects"][number];
type ObjectType = ObjectRecord["type"];

function requireRule(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new TripStateContractError(code, message);
}

function conditionReferences(condition: Condition): string[] {
  if ("object_id" in condition) return [condition.object_id];
  if ("args" in condition) return condition.args.flatMap(conditionReferences);
  return "arg" in condition ? conditionReferences(condition.arg) : [];
}

function assertAcyclic(graph: Map<string, string[]>, code: string): void {
  const visiting = new Set<string>(), finished = new Set<string>();
  function visit(id: string) {
    requireRule(!visiting.has(id), code, `Reference cycle: ${id}`);
    if (finished.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id);
    finished.add(id);
  }
  for (const id of graph.keys()) visit(id);
}

/**
 * E02-01 snapshot reference integrity, ported from tripstate/rules.py:validate_state.
 * Does NOT validate all business invariants, authorize a caller, or apply a command.
 * In particular fact authority, transitions, adoption consistency and confirmation are later gates.
 */
export function parseStateReferences(value: unknown): State {
  const state = parseContract("state", value);
  const objects = new Map(state.objects.map((object) => [object.id, object]));
  requireRule(objects.size === state.objects.length, "DUPLICATE_ID", "Object IDs must be unique within a trip");

  function target(id: string): ObjectRecord;
  function target<K extends ObjectType>(id: string, kinds: readonly K[]): Extract<ObjectRecord, { type: K }>;
  function target(id: string, kinds?: readonly ObjectType[]): ObjectRecord {
    const object = objects.get(id);
    requireRule(object !== undefined, "DANGLING_REF", `Unresolved reference: ${id}`);
    requireRule(!kinds || kinds.includes(object.type), "REF_TYPE", `Wrong reference type: ${id}`);
    return object;
  }

  const ancestry = new Map<string, string[]>();
  const inputs = new Map<string, string[]>();
  const preferenceSuccessors = new Map<string, string[]>();
  for (const object of state.objects) {
    requireRule(object.trip_id === state.trip_id, "CROSS_TRIP", `Cross-trip object: ${object.id}`);
    const scope = object.scope;
    requireRule((scope.kind === "trip" || scope.kind === "date") === (scope.ids.length === 0), "SCOPE", "Invalid scope references");
    if (scope.kind === "date") requireRule(scope.start <= scope.end, "SCOPE", "Reversed scope dates");
    for (const id of scope.ids) {
      if (scope.kind === "traveler") {
        requireRule(state.objects.some((goal) => goal.type === "TripGoal" && goal.traveler_ids.includes(id)), "SCOPE", "Traveler must be registered in TripGoal");
      } else target(id, scope.kind === "entity" ? ["DestinationEntity"] : ["Skeleton"]);
    }
    for (const dependency of object.dependencies) {
      const other = target(dependency.object_id);
      requireRule(dependency.version <= other.version, "FUTURE_REF", "Dependency refers to a future version");
      requireRule(dependency.paths.length > 0, "DEPENDENCY_PATH", "Dependency paths are required");
      for (const path of dependency.paths) {
        let node: unknown = other;
        for (const segment of path.split("/").slice(1)) {
          if (node === null) break; // Null parent means unknown, as in the Python reference.
          if (Array.isArray(node)) {
            requireRule(/^\d+$/.test(segment) && Number(segment) < node.length, "DEPENDENCY_PATH", "Unknown array position");
            node = node[Number(segment)];
          } else {
            requireRule(typeof node === "object" && node !== null && Object.hasOwn(node, segment), "DEPENDENCY_PATH", "Unknown dependency field");
            node = (node as Record<string, unknown>)[segment];
          }
        }
      }
    }
    inputs.set(object.id, object.dependencies.filter((d) => d.relation === "input").map((d) => d.object_id));
    if ("condition" in object) for (const id of conditionReferences(object.condition)) target(id);
    if ("reconsider_when" in object) for (const id of conditionReferences(object.reconsider_when)) target(id);

    switch (object.type) {
      case "TripGoal":
        for (const id of object.destination_ids) target(id, ["DestinationEntity"]);
        break;
      case "Preference":
        for (const id of object.subject_ids) target(id, ["DestinationEntity", "Candidate", "Skeleton", "TripGoal"]);
        for (const dependency of object.dependencies) {
          if (dependency.relation === "association" && dependency.paths.includes("/status") && target(dependency.object_id).type === "Preference") {
            const successors = preferenceSuccessors.get(dependency.object_id) ?? [];
            preferenceSuccessors.set(dependency.object_id, [...successors, object.id]);
          }
        }
        break;
      case "Constraint":
        if (object.value.kind === "entry_exit") {
          target(object.value.entry_entity_id, ["DestinationEntity"]);
          target(object.value.exit_entity_id, ["DestinationEntity"]);
        }
        if (object.value.kind === "requirement") for (const id of conditionReferences(object.value.condition)) target(id);
        break;
      case "DestinationEntity":
        if (object.parent_id) target(object.parent_id, ["DestinationEntity"]);
        break;
      case "Candidate":
        requireRule(object.subject_ids.length > 0, "CANDIDATE_SUBJECT", "Candidate requires a subject");
        for (const id of object.subject_ids) target(id, ["DestinationEntity"]);
        if (object.candidate_kind === "city" || object.candidate_kind === "experience") {
          requireRule(object.subject_ids.length === 1 && target(object.subject_ids[0], ["DestinationEntity"]).entity_kind === object.candidate_kind, "REF_TYPE", "Candidate subject kind mismatch");
        }
        if (object.candidate_kind === "connection") {
          requireRule(object.subject_ids.length === 2 && object.subject_ids.every((id) => ["city", "transport_node"].includes(target(id, ["DestinationEntity"]).entity_kind)), "REF_TYPE", "Connection endpoints must be cities or transport nodes");
        }
        for (const id of object.preference_ids) target(id, ["Preference"]);
        for (const id of object.issue_ids) target(id, ["OpenIssue"]);
        break;
      case "ExternalFact":
        for (const id of object.subject_ids) target(id);
        break;
      case "Skeleton":
        for (const override of object.overrides) target(override.constraint_id, ["Constraint"]);
        if (object.parent_id) target(object.parent_id, ["Skeleton"]);
        for (const stop of object.stops) requireRule(target(stop.entity_id, ["DestinationEntity"]).entity_kind === "city", "REF_TYPE", "Stops must reference cities");
        requireRule(object.connections.length === object.stops.length - 1, "CONNECTION_COUNT", "Connections must match adjacent stops");
        for (const [i, connection] of object.connections.entries()) {
          requireRule(connection.from_id === object.stops[i].entity_id && connection.to_id === object.stops[i + 1].entity_id, "CONNECTION_ORDER", "Connection order mismatch");
          for (const id of connection.fact_ids) {
            const fact = target(id, ["ExternalFact"]);
            requireRule(fact.value === null || fact.value.kind === "transport", "REF_TYPE", "Connection requires transport evidence");
          }
        }
        for (const id of object.cost_fact_ids) {
          const fact = target(id, ["ExternalFact"]);
          requireRule(fact.value === null || fact.value.kind === "cost", "REF_TYPE", "Cost requires cost evidence");
        }
        break;
      case "Decision":
        requireRule(object.subject_version <= target(object.subject_id, object.decision_kind === "adopt_skeleton" ? ["Skeleton"] : ["Candidate"]).version, "FUTURE_REF", "Decision refers to a future version");
        for (const id of object.basis_ids) target(id);
        if (object.supersedes) {
          const prior = target(object.supersedes, ["Decision"]);
          requireRule(prior.decision_kind === object.decision_kind && (object.decision_kind === "adopt_skeleton" || prior.subject_id === object.subject_id), "DECISION_SCOPE", "Decision predecessor scope mismatch");
        }
        break;
      case "OpenIssue":
        for (const id of [...object.affected_ids, ...object.evidence_ids]) target(id);
        break;
    }
    const parent = "supersedes" in object ? object.supersedes : "parent_id" in object ? object.parent_id : null;
    ancestry.set(object.id, parent ? [parent] : []);
  }
  if (state.effective_skeleton_id) target(state.effective_skeleton_id, ["Skeleton"]);
  assertAcyclic(ancestry, "LINEAGE_CYCLE");
  assertAcyclic(inputs, "DEPENDENCY_CYCLE");
  assertAcyclic(preferenceSuccessors, "LINEAGE_CYCLE");
  return state;
}
