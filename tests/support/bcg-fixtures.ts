import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { traces } from "./command-fixtures";

// Original build.py uses one deterministic UUID sequence across the seven scenarios.
export const bcg = [
  { trace: traces.find((t) => t.scenario === "B-cross-candidate-preference")!, uuidStart: 1021 },
  { trace: traces.find((t) => t.scenario === "C-user-corrects-inference")!, uuidStart: 1030 },
  { trace: traces.find((t) => t.scenario === "G-user-reverses-decision")!, uuidStart: 1083 },
];
export const base = bcg[0].trace.initial_state;
export function object<K extends State["objects"][number]["type"]>(state: State, id: string, kind: K) {
  const value = state.objects.find((o) => o.id === id && o.type === kind);
  if (!value) throw new Error(`Invalid source fixture: ${id}`);
  return value as Extract<State["objects"][number], { type: K }>;
}
export function change(state: State, commands: TripStateContracts["change-request"]["commands"], key = "synthetic-bcg-change"): TripStateContracts["change-request"] {
  return { expected_revision: state.revision, idempotency_key: key, reason: "合成规则验证", input: { kind: "dialogue", reference: "synthetic-input", text: "合成规则验证", target_ids: [] }, commands };
}
export function createFrom(value: State["objects"][number], id: string): TripStateContracts["command"] {
  const data = structuredClone(value) as unknown as Record<string, unknown>;
  for (const key of ["id", "type", "trip_id", "version", "status", "scope", "source", "dependencies", "updated_at", "assessment", "review_state"]) delete data[key];
  return { op: "create", object_type: value.type, id, scope: structuredClone(value.scope), dependencies: structuredClone(value.dependencies), data } as TripStateContracts["command"];
}
