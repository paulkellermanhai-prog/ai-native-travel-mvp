/** UX-02 history compiler. No writes/grants: use the existing authenticated preview/submit service. */
import { z } from "zod";
import { parseContract, TripStateContractError } from "./contracts";
import { validateStateSemantics, rule } from "./semantics";
import type { State, TripStateContracts } from "./contracts.generated";
import { previewCommand, type CommandRequest } from "./commands";

export type RestorationInput = {
  sourceId: string; newId: string; expectedRevision: number; idempotencyKey: string;
  input: CommandRequest["input"]; reason: string; cityId?: string; insertAt?: number; acknowledgeUnknowns?: boolean;
};
export function restorationRequest(value: State, options: RestorationInput): CommandRequest {
  const state = validateStateSemantics(value), objects = new Map(state.objects.map((o) => [o.id, o]));
  const { sourceId, newId, expectedRevision, idempotencyKey, input, reason, cityId, insertAt } = options;
  rule(expectedRevision === state.revision, "VERSION_CONFLICT", "恢复基准已变，重新预览");
  const source = objects.get(sourceId), current = state.effective_skeleton_id ? objects.get(state.effective_skeleton_id) : undefined;
  rule(source?.type === "Skeleton" && source.purpose === "plan", "RESTORE_SOURCE", "恢复来源必须是历史规划骨架");
  rule(!objects.has(newId), "DUPLICATE_ID", "恢复必须生成新骨架");
  let stops = structuredClone(source.stops), connections = structuredClone(source.connections), costs = [...source.cost_fact_ids];
  if (cityId === undefined) rule(insertAt === undefined, "RESTORE_SCOPE", "整份恢复不接受城市位置");
  else {
    rule(current?.type === "Skeleton", "RESTORE_SCOPE", "城市恢复需要当前有效骨架");
    const selected = source.stops.filter((s) => s.entity_id === cityId);
    rule(selected.length === 1, "RESTORE_SCOPE", "来源必须包含目标城市");
    stops = structuredClone(current.stops);
    const position = stops.findIndex((s) => s.entity_id === cityId);
    if (position >= 0) {
      rule(insertAt === undefined, "RESTORE_SCOPE", "已有城市保持当前顺序；改序须单独预览");
      stops[position] = structuredClone(selected[0]);
    } else {
      rule(Number.isSafeInteger(insertAt) && insertAt! >= 0 && insertAt! <= stops.length, "RESTORE_POSITION_REQUIRED", "城市已不在当前方案，需明确插入位置");
      stops.splice(insertAt!, 0, structuredClone(selected[0]));
    }
    connections = stops.slice(0, -1).map((stop, i) => {
      const left = stop.entity_id, right = stops[i + 1].entity_id;
      const pool = [left, right].includes(cityId) ? source.connections : current.connections;
      const edge = pool.find((c) => c.from_id === left && c.to_id === right);
      return edge ? structuredClone(edge) : { from_id: left, to_id: right, fact_ids: [] };
    });
    const touches = (id: string) => { const o = objects.get(id); return o?.type === "ExternalFact" && o.subject_ids.includes(cityId); };
    costs = [...new Set([...current.cost_fact_ids.filter((id) => !touches(id)), ...source.cost_fact_ids.filter(touches)])];
  }
  const command: Extract<TripStateContracts["command"], { op: "create"; object_type: "Skeleton" }> = {
    op: "create", object_type: "Skeleton", id: newId, scope: { kind: "trip", ids: [] }, dependencies: [],
    data: { purpose: "plan", stops, connections, cost_fact_ids: costs, parent_id: state.effective_skeleton_id,
      overrides: [], tradeoffs: { gains: [], losses: [] } },
  };
  return parseContract("change-request", { expected_revision: expectedRevision, idempotency_key: idempotencyKey,
    input: { ...structuredClone(input), target_ids: [...new Set([...input.target_ids, sourceId, ...(state.effective_skeleton_id ? [state.effective_skeleton_id] : []), ...(cityId ? [cityId] : [])])] },
    reason: `${reason} | UX02 restore source=${sourceId}${cityId ? ` city=${cityId}` : " whole"}`,
    commands: [command, { op: "adopt_skeleton", id: newId, acknowledge_unknowns: options.acknowledgeUnknowns ?? false, confirmation_scope: ["cities", "order", "stays", "connections"] }],
  });
}

const restoreShape = z.object({
  source_id: z.string().min(1), new_id: z.string().min(1), expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: z.string().min(1), reason: z.string().min(1),
  input: z.object({ kind: z.enum(["dialogue", "map", "timeline", "tool", "system"]), reference: z.string().min(1), text: z.string().min(1), target_ids: z.array(z.string()) }).strict(),
  city_id: z.string().min(1).optional(), insert_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), acknowledge_unknowns: z.boolean().optional(),
}).strict();
export function parseRestorationInput(value: unknown): RestorationInput {
  const result = restoreShape.safeParse(value);
  if (!result.success) throw new TripStateContractError("SCHEMA", "Invalid restoration input");
  const b = result.data;
  return { sourceId: b.source_id, newId: b.new_id, expectedRevision: b.expected_revision, idempotencyKey: b.idempotency_key,
    input: b.input, reason: b.reason, cityId: b.city_id, insertAt: b.insert_at, acknowledgeUnknowns: b.acknowledge_unknowns };
}

/** A blocked adoption still needs an explainable candidate/assessment. This dry run never grants a write. */
export function restorationImpact(state: State, request: CommandRequest, clock: () => Date = () => new Date()) {
  const calculation = { ...structuredClone(request), commands: [request.commands[0], { op: "recalculate" as const, id: (request.commands[0] as { id: string }).id }] as CommandRequest["commands"] };
  return previewCommand(state, calculation, { role: "system", id: "restoration-preview-calculator" }, clock);
}
