/** UX-02 history compiler. No writes/grants: use the existing authenticated preview/submit service. */
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { parseContract, TripStateContractError } from "./contracts";
import { validateStateSemantics, rule } from "./semantics";
import type { State, TripStateContracts } from "./contracts.generated";
import { previewCommand, type CommandRequest } from "./commands";

export type RestorationInput = {
  sourceId: string; sourceVersion: number; newId: string; expectedRevision: number; idempotencyKey: string;
  input: CommandRequest["input"]; reason: string; cityId?: string; insertAt?: number; acknowledgeUnknowns?: boolean;
};
export function restorationRequest(value: State, options: RestorationInput, history: TripStateContracts["history"] = { intents: [], changes: [] }): CommandRequest {
  const state = validateStateSemantics(value), objects = new Map(state.objects.map((o) => [o.id, o]));
  const { sourceId, sourceVersion, newId, expectedRevision, idempotencyKey, input, reason, cityId, insertAt } = options;
  rule(expectedRevision === state.revision, "VERSION_CONFLICT", "恢复基准已变，重新预览");
  rule(Number.isSafeInteger(sourceVersion) && sourceVersion > 0, "SCHEMA", "必须指定历史来源版本");
  const currentSource = objects.get(sourceId), candidates = [currentSource, ...history.changes.filter(c => c.outcome === "applied" && c.trip_id === state.trip_id && c.result_revision <= state.revision).flatMap(c => c.diff.filter(d => d.id === sourceId).flatMap(d => [d.before, d.after]))]
    .filter((o): o is Extract<State["objects"][number], { type: "Skeleton" }> => !!o && o.type === "Skeleton" && o.id === sourceId && o.trip_id === state.trip_id && o.version === sourceVersion);
  rule(candidates.length > 0, "RESTORE_SOURCE_VERSION", "所选历史来源版本不可用");
  rule(candidates.every(o => isDeepStrictEqual(o, candidates[0])), "RESTORE_SOURCE_INTEGRITY", "同一历史版本的来源不一致");
  const source = candidates[0], current = state.effective_skeleton_id ? objects.get(state.effective_skeleton_id) : undefined;
  rule(source.purpose === "plan", "RESTORE_SOURCE", "恢复来源必须是历史规划骨架");
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
    reason: `${reason} | UX02 restore source=${sourceId} version=${sourceVersion}${cityId ? ` city=${cityId}` : " whole"}`,
    commands: [command, { op: "adopt_skeleton", id: newId, acknowledge_unknowns: options.acknowledgeUnknowns ?? false, confirmation_scope: ["cities", "order", "stays", "connections"] }],
  });
}

const restoreShape = z.object({
  source_id: z.string().min(1), source_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), new_id: z.string().min(1), expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: z.string().min(1), reason: z.string().min(1),
  input: z.object({ kind: z.enum(["dialogue", "map", "timeline", "tool", "system"]), reference: z.string().min(1), text: z.string().min(1), target_ids: z.array(z.string()) }).strict(),
  city_id: z.string().min(1).optional(), insert_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), acknowledge_unknowns: z.boolean().optional(),
}).strict();
export function parseRestorationInput(value: unknown): RestorationInput {
  const result = restoreShape.safeParse(value);
  if (!result.success) throw new TripStateContractError("SCHEMA", "Invalid restoration input");
  const b = result.data;
  return { sourceId: b.source_id, sourceVersion: b.source_version, newId: b.new_id, expectedRevision: b.expected_revision, idempotencyKey: b.idempotency_key,
    input: b.input, reason: b.reason, cityId: b.city_id, insertAt: b.insert_at, acknowledgeUnknowns: b.acknowledge_unknowns };
}

/** A blocked adoption still needs an explainable candidate/assessment. This dry run never grants a write. */
export function restorationImpact(state: State, request: CommandRequest, clock: () => Date = () => new Date()) {
  const calculation = { ...structuredClone(request), commands: [request.commands[0], { op: "recalculate" as const, id: (request.commands[0] as { id: string }).id }] as CommandRequest["commands"] };
  return previewCommand(state, calculation, { role: "system", id: "restoration-preview-calculator" }, clock);
}

/** Validate either documented HTTP response shape without assuming a shape from status alone. */
export function parseRestorationHttpResponse(value: unknown, status: number) {
  const envelope = z.object({ request: z.unknown(), preview: z.unknown(), impact: z.unknown(), can_submit: z.boolean(), warnings: z.array(z.string()) }).strict().safeParse(value);
  if (envelope.success) {
    const request = parseContract("change-request", envelope.data.request), preview = parseContract("response", envelope.data.preview), impact = parseContract("response", envelope.data.impact);
    rule(envelope.data.can_submit === (preview.outcome === "preview"), "SCHEMA", "提交资格与预览结果不一致");
    const expected = preview.outcome === "preview" ? 200 : preview.outcome === "conflict" ? 409 : preview.outcome === "rejected" ? 422 : 0;
    rule(status === expected, "SCHEMA", "预览结果与HTTP状态不一致");
    return { kind: "preview" as const, request, preview, impact, can_submit: envelope.data.can_submit, warnings: envelope.data.warnings };
  }
  const error = parseContract("response", value), code = error.errors[0]?.code;
  const expected = ["PERMISSION", "ACTOR"].includes(code ?? "") ? 403 : code === "NOT_FOUND" ? 404 : code === "METHOD_NOT_ALLOWED" ? 405 : code === "INTERNAL_FAILURE" || code?.startsWith("STORAGE_") ? 500 : error.outcome === "conflict" ? 409 : 422;
  rule(["rejected", "conflict"].includes(error.outcome) && expected === status, "SCHEMA", "错误响应与HTTP状态不一致");
  return { kind: "error" as const, error };
}
