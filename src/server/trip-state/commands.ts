import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import transitions from "../../../specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/rules/transitions.json";
import { parseContract, TripStateContractError } from "./contracts";
import { digest } from "./command-json";
import { validateStateSemantics, rule, instantMicros } from "./semantics";
import { incrementCounter, safeCounter } from "./numbers";
import type { State, TripStateContracts, Condition } from "./contracts.generated";

export type Actor = Readonly<{ role: "user" | "model" | "system" | "tool"; id: string }>;
export type CommandRequest = TripStateContracts["change-request"];
export type ConfirmRequest = TripStateContracts["confirm-request"];
export type PendingDetails = { diff: TripStateContracts["response"]["diff"]; effective: string | null; created_at: string; expires_at: string };
export type CommandBatch = {
  tripId: string; request: CommandRequest; key: { actorId: string; operationDomain: Actor["role"]; key: string; requestDigest: string };
  proposalExpiresAt?: Date; proposalCreatedAt?: Date; proposalDetails?: PendingDetails;
  snapshot: State; intent: TripStateContracts["OperationIntent"]; change: TripStateContracts["ChangeRecord"]; response: TripStateContracts["response"];
};
type ObjectRecord = State["objects"][number];
export const defaultUuid = () => randomUUID().replaceAll("-", "");
export function validateActor(actor: Actor): void {
  rule(actor && ["user", "model", "system", "tool"].includes(actor.role) && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(actor.id), "ACTOR", "执行主体必须由宿主鉴权后注入");
}
export function failureResponse(state: State, error: TripStateContractError): TripStateContracts["response"] {
  safeCounter(state.revision, "revision");
  return parseContract("response", { outcome: ["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(error.code) ? "conflict" : "rejected", revision: state.revision,
    proposal_id: null, proposal_digest: null, confirmation_required: false, affected_ids: [], diff: [], errors: [{ code: error.code, message: error.message }] });
}
function conditionRefs(c: Condition): string[] {
  return "object_id" in c ? [c.object_id] : "args" in c ? c.args.flatMap(conditionRefs) : "arg" in c ? conditionRefs(c.arg) : [];
}
function changedPaths(old: unknown, next: unknown, prefix = ""): Set<string> {
  if (old && next && typeof old === "object" && typeof next === "object" && !Array.isArray(old) && !Array.isArray(next)) {
    const a = old as Record<string, unknown>, b = next as Record<string, unknown>, result = new Set<string>();
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a) || !(key in b)) result.add(`${prefix}/${key}`);
      else for (const p of changedPaths(a[key], b[key], `${prefix}/${key}`)) result.add(p);
    }
    return result;
  }
  return same(old, next) ? new Set() : new Set([prefix]);
}
function diff(before: State, after: State) {
  const a = new Map(before.objects.map((o) => [o.id, o])), b = new Map(after.objects.map((o) => [o.id, o]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((id) => !same(a.get(id), b.get(id)))
    .map((id) => ({ id, before: a.get(id) ?? null, after: b.get(id) ?? null }));
}
function checkedInput(beforeValue: unknown, requestValue: unknown, actor: Actor) {
  validateActor(actor);
  const before = validateStateSemantics(beforeValue), request = parseContract("change-request", requestValue);
  if (before.objects.some((o) => !["DestinationEntity", "TripGoal", "Preference", "Candidate", "Decision", "OpenIssue"].includes(o.type))) {
    throw new TripStateContractError("E02_SLICE_UNSUPPORTED", "This state needs the later constraint/fact/skeleton command slice; no partial processing is allowed");
  }
  safeCounter(request.expected_revision, "expected_revision");
  rule(request.expected_revision === before.revision, "VERSION_CONFLICT", "旅行版本已改变；重新读取并预览");
  for (const id of request.input.target_ids) rule(before.objects.some((o) => o.id === id), "DANGLING_REF", "操作意图引用不存在");
  return { before, request };
}
export function needsConfirmation(state: State, request: CommandRequest, actor: Actor): boolean {
  if (actor.role === "user") return false;
  const objects = new Map(state.objects.map((o) => [o.id, o]));
  return request.commands.some((cmd) => {
    if (["adopt_skeleton", "decide_candidate", "withdraw_decision", "dismiss_issue"].includes(cmd.op)) return true;
    if (cmd.op === "create" && (["TripGoal", "Constraint"].includes(cmd.object_type) || cmd.object_type === "Preference" && cmd.data.certainty === "explicit")) return true;
    const old = "id" in cmd ? objects.get(cmd.id) : undefined;
    if (!old || cmd.op !== "revise" && cmd.op !== "transition") return false;
    if (old.type === "Constraint" && old.override_policy === "fixed" && cmd.op === "transition" && cmd.event === "invalidate" && actor.role === "system") return false;
    return ["TripGoal", "Constraint"].includes(old.type) || old.type === "Preference" && old.certainty === "explicit"
      || cmd.op === "transition" && actor.role === "model" && ["exclude", "archive", "withdraw", "supersede"].includes(cmd.event);
  });
}
export function stampTime(now: Date): string {
  rule(Number.isFinite(now.getTime()), "SCHEMA", "Invalid host clock");
  return now.getUTCMilliseconds() === 0 ? now.toISOString().replace(".000Z", "Z") : now.toISOString().replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}000Z`);
}

// Pure execution. A hypothetical pending-user is used only for proposal calculation, never a storage grant.
function executeCommands(before: State, request: CommandRequest, actor: Actor, proposal: string, now: Date): State {
  const old = new Map(before.objects.map((o) => [o.id, o]));
  const state = structuredClone(before), objects = new Map(state.objects.map((o) => [o.id, o]));
  const stamp = stampTime(now);
  const source = { actor: actor.role, actor_id: actor.id, reference: request.input.reference, text: request.input.text, at: stamp };
  const unsupported = (message: string): never => { throw new TripStateContractError("E02_SLICE_UNSUPPORTED", message); };
  function get(id: string): ObjectRecord { const o = objects.get(id); rule(o, "DANGLING_REF", `引用不存在: ${id}`); return o; }
  function make(id: string, kind: "TripGoal" | "Preference" | "DestinationEntity" | "Candidate" | "Decision" | "OpenIssue", data: object, scope = { kind: "trip", ids: [] } as ObjectRecord["scope"], dependencies: ObjectRecord["dependencies"] = []) {
    rule(!objects.has(id), "DUPLICATE_ID", id);
    const initial = { TripGoal: "draft", Preference: "active", DestinationEntity: "known", Candidate: "exploring", Decision: "proposed", OpenIssue: "open" };
    const o = parseContract(kind, { id, type: kind, trip_id: state.trip_id, version: 1, status: initial[kind], scope: structuredClone(scope), source: structuredClone(source), dependencies: structuredClone(dependencies), updated_at: stamp, ...data });
    state.objects.push(o); objects.set(id, o); return o;
  }
  function transition(o: ObjectRecord, event: string) {
    const edge = transitions.find((t) => t.object_type === o.type && t.from_state === o.status && t.event === event);
    rule(edge, "ILLEGAL_TRANSITION", `${o.type}:${o.status} -> ${event}`);
    rule(edge.actors.includes(actor.role), "PERMISSION", "执行主体没有此转换权限");
    Object.assign(o, { status: edge.to_state });
  }
  for (const cmd of request.commands) {
    if (cmd.op === "create") {
      if (!["DestinationEntity", "TripGoal", "Preference", "Candidate"].includes(cmd.object_type)) unsupported("Create kind is outside the reviewed Scenario A slice");
      rule(cmd.object_type !== "DestinationEntity" || actor.role === "system", "PERMISSION", "目录由系统适配器维护");
      rule(cmd.object_type !== "TripGoal" || actor.role === "user", "PERMISSION", "目标和约束须用户明确表达");
      rule(cmd.object_type !== "Preference" || cmd.data.certainty !== "explicit" || actor.role === "user", "PERMISSION", "明确偏好须有用户表达");
      if (cmd.object_type === "Candidate") make(cmd.id, "Candidate", { ...cmd.data, review_state: "current" }, cmd.scope, cmd.dependencies);
      else if (cmd.object_type === "TripGoal" || cmd.object_type === "Preference" || cmd.object_type === "DestinationEntity") make(cmd.id, cmd.object_type, cmd.data, cmd.scope, cmd.dependencies);
    } else if (cmd.op === "revise") {
      if (!["DestinationEntity", "TripGoal", "Preference", "Candidate"].includes(cmd.object_type)) unsupported("Revise kind is outside this slice");
      const o = get(cmd.id); rule(o.type === cmd.object_type, "REF_TYPE", cmd.id);
      rule(!["superseded", "withdrawn", "invalidated", "relaxed", "closed", "retired", "archived", "resolved", "dismissed"].includes(o.status), "IMMUTABLE_HISTORY", "终态不得原位修改；创建新对象或允许的重开操作");
      rule(o.type !== "DestinationEntity" || actor.role === "system", "PERMISSION", "目录仅系统维护");
      rule(o.type !== "TripGoal" && !(o.type === "Preference" && o.certainty === "explicit") || actor.role === "user", "PERMISSION", "明确值不得被推断覆盖");
      if (cmd.object_type === "Preference") rule(cmd.changes.certainty !== "explicit" || actor.role === "user", "PERMISSION", "推断不能升级为明确表达");
      // 'changes' already passed the original per-kind field whitelist; never accept a generic patch.
      Object.assign(o, structuredClone(cmd.changes), { source: structuredClone(source) });
    } else if (cmd.op === "transition") {
      const o = get(cmd.id);
      rule(!["confirm", "reconsider", "resolve", "dismiss", "revoke"].includes(cmd.event), "DEDICATED_COMMAND", "此转换必须经专用业务命令");
      if (o.type !== "TripGoal" || cmd.event !== "activate") unsupported("Only TripGoal.activate is enabled in this command slice");
      transition(o, cmd.event); o.source = structuredClone(source);
    } else if (cmd.op === "decide_candidate") {
      rule(actor.role === "user", "PERMISSION", "用户决定必须经确认");
      if (cmd.value !== "accept") unsupported("Decision rejection/reversal is reserved for E02-04");
      const o = get(cmd.id); rule(o.type === "Candidate", "REF_TYPE", cmd.id);
      rule(!["excluded", "conditionally_excluded"].includes(o.status), "CANDIDATE_EXCLUDED", "被排除候选须先重新考虑");
      if (state.objects.some((d) => d.type === "Decision" && d.subject_id === o.id && d.status === "confirmed")) unsupported("Existing confirmed decisions require the reviewed E02-04 reversal path");
      if (o.status !== "retained") transition(o, "retain");
      const decision = make(`decision-${proposal}-${objects.size}`, "Decision", { subject_id: o.id, subject_version: o.version,
        decision_kind: "candidate_choice", value: "accept", confirmation_scope: ["candidate"], basis_ids: [], acknowledged_unknowns: [],
        confirmed_by: actor.id, confirmed_at: stamp, supersedes: null, review_state: "current" });
      transition(decision, "confirm");
    } else unsupported("Operation belongs to a later E02 slice");
  }
  validateStateSemantics(state);
  // Original field-sensitive propagation, including implicit links; no calculations or fact mutation.
  const changed = new Map(state.objects.filter((o) => !same(old.get(o.id), o)).map((o) => [o.id, changedPaths(old.get(o.id) ?? {}, o)]));
  const affected = new Set<string>();
  while (true) {
    const added = new Set<string>();
    for (const o of [...objects.values()]) {
      if (affected.has(o.id) || o.type === "Decision" && (o.status !== "confirmed" || !old.has(o.id))) continue;
      let hits = o.dependencies.some((d) => ["input", "evidence"].includes(d.relation) && d.paths.some((p) => [...(changed.get(d.object_id) ?? [])].some((q) => p === q || p.startsWith(q + "/") || q.startsWith(p + "/"))));
      if (o.type === "Preference") hits ||= conditionRefs(o.condition).some((id) => changed.has(id));
      if (o.type === "Candidate") hits ||= [...o.preference_ids, ...conditionRefs(o.reconsider_when)].some((id) => changed.has(id));
      if (o.type === "Decision") hits ||= [o.subject_id, ...o.basis_ids].some((id) => changed.has(id));
      if (!hits) continue;
      if (o.type === "Candidate" || o.type === "Decision") o.review_state = "stale";
      added.add(o.id);
    }
    if (!added.size) break;
    for (const id of added) { affected.add(id); const paths = changedPaths(old.get(id) ?? {}, get(id)); changed.set(id, paths.size ? paths : new Set([""])); }
  }
  for (const id of [...affected].sort()) if (get(id).type === "Decision") {
    const issueId = `issue-dependency-${id}`, existing = objects.get(issueId);
    if (existing) { rule(existing.type === "OpenIssue", "REF_TYPE", issueId); existing.status = "open"; existing.resolution = null; }
    else make(issueId, "OpenIssue", { issue_kind: "dependency", question: "输入变化，需要重新核验或计算", affected_ids: [id], severity: "warning",
      required_inputs: ["fresh_dependencies"], candidate_actions: ["verify", "calculate", "confirm"], owner: "system", resolution: null, evidence_ids: [] });
  }
  for (const o of state.objects) {
    const previous = old.get(o.id);
    if (previous && !same(previous, o)) { o.version = incrementCounter(previous.version, "object version"); o.updated_at = stamp; }
  }
  for (const o of state.objects) if (o.type === "Decision" && !old.has(o.id)) o.subject_version = get(o.subject_id).version;
  const delta = diff(before, state);
  if (delta.length || before.effective_skeleton_id !== state.effective_skeleton_id) state.revision = incrementCounter(before.revision, "revision");
  validateStateSemantics(state);
  return state;
}

function prepared(beforeValue: unknown, requestValue: unknown, actor: Actor, clock: () => Date, uuid: () => string) {
  const { before, request } = checkedInput(beforeValue, requestValue, actor), now = clock(), proposal = `proposal-${uuid()}`;
  const needs = needsConfirmation(before, request, actor);
  rule(actor.role !== "tool", "PERMISSION", "工具仅能导入事实或使已有事实被替代／反证");
  const after = executeCommands(before, request, needs ? { role: "user", id: "pending-user" } : actor, proposal, now);
  const delta = diff(before, after), proposalDigest = digest({ request, diff: delta, effective: after.effective_skeleton_id });
  return { before, request, now, proposal, needs, after, delta, proposalDigest };
}
function response(outcome: TripStateContracts["response"]["outcome"], revision: number, proposal: string, proposalDigest: string, delta: TripStateContracts["response"]["diff"], confirmationRequired = false) {
  return parseContract("response", { outcome, revision, proposal_id: proposal, proposal_digest: proposalDigest,
    confirmation_required: confirmationRequired, affected_ids: delta.map((d) => d.id), diff: delta, errors: [] });
}
function journal(before: State, after: State, request: CommandRequest, actor: Actor, result: TripStateContracts["response"], now: Date, uuid: () => string, confirmationActor: string | null = null) {
  const stamp = stampTime(now);
  const intent = parseContract("OperationIntent", { id: `intent-${uuid()}`, type: "OperationIntent", trip_id: before.trip_id, actor_id: actor.id, actor_role: actor.role,
    input: structuredClone(request.input), base_revision: request.expected_revision, created_at: stamp });
  const change = parseContract("ChangeRecord", { id: `change-${uuid()}`, type: "ChangeRecord", trip_id: before.trip_id, proposal_id: result.proposal_id, intent_id: intent.id,
    outcome: result.outcome, actions: request.commands.map((c) => c.op), reason: request.reason, base_revision: before.revision, result_revision: after.revision,
    created_at: stamp, confirmation_actor: confirmationActor ?? (actor.role === "user" && result.outcome === "applied" ? actor.id : null), request_digest: result.proposal_digest,
    affected_ids: result.affected_ids, effective_before: before.effective_skeleton_id, effective_after: after.effective_skeleton_id, diff: result.diff });
  return { intent, change };
}
export function proposalDeadline(state: State, now: Date): string {
  let expiry = BigInt(now.getTime()) * 1000n + 300000000n;
  for (const o of state.objects) if (o.type === "ExternalFact") {
    const next = instantMicros(o.expires_at);
    if (next > BigInt(now.getTime()) * 1000n && next < expiry) expiry = next;
  }
  const remainder = (expiry % 1000000n + 1000000n) % 1000000n;
  const base = new Date(Number((expiry - remainder) / 1000n)).toISOString().replace(/\.\d{3}Z$/, "");
  const fraction = remainder.toString().padStart(6, "0");
  return base + (fraction === "000000" ? "Z" : `.${fraction}Z`);
}

/** Real TS execution; no trace/Python imports. A pending diff never becomes the authoritative snapshot. */
export function planCommand(beforeValue: unknown, requestValue: unknown, actor: Actor, clock: () => Date = () => new Date(), uuid = defaultUuid): CommandBatch {
  const p = prepared(beforeValue, requestValue, actor, clock, uuid), snapshot = p.needs ? structuredClone(p.before) : p.after;
  const result = response(p.needs ? "pending_confirmation" : "applied", snapshot.revision, p.proposal, p.proposalDigest, p.delta, p.needs);
  return { tripId: p.before.trip_id, request: p.request,
    key: { actorId: actor.id, operationDomain: actor.role, key: p.request.idempotency_key, requestDigest: digest(p.request) },
    snapshot, response: result, ...journal(p.before, snapshot, p.request, actor, result, p.now, uuid),
    ...(p.needs ? { proposalExpiresAt: new Date(proposalDeadline(p.before, p.now)), proposalCreatedAt: p.now,
      proposalDetails: { diff: p.delta, effective: p.after.effective_skeleton_id, created_at: stampTime(p.now), expires_at: proposalDeadline(p.before, p.now) } } : {}) };
}
export function previewCommand(beforeValue: unknown, requestValue: unknown, actor: Actor, clock: () => Date = () => new Date(), uuid = defaultUuid) {
  const p = prepared(beforeValue, requestValue, actor, clock, uuid);
  return response("preview", p.before.revision, p.proposal, p.proposalDigest, p.delta, p.needs);
}

export type PendingProposal = {
  proposalId: string; request: CommandRequest; actor: Actor; digest: string; expires: string; details: PendingDetails;
};
export function planConfirmation(beforeValue: unknown, pending: PendingProposal, requestValue: unknown, actor: Actor, clock: () => Date = () => new Date(), uuid = defaultUuid) {
  validateActor(actor); rule(actor.role === "user", "PERMISSION", "只有经鉴权用户可确认");
  const request = parseContract("confirm-request", requestValue), before = validateStateSemantics(beforeValue);
  safeCounter(request.expected_revision, "expected_revision");
  rule(request.proposal_digest === pending.digest, "CONFIRMATION_SCOPE", "确认内容与所展示提案不同");
  rule(request.expected_revision === before.revision && before.revision === pending.request.expected_revision, "VERSION_CONFLICT", "确认依据已变化，必须重新预览");
  const now = clock(); stampTime(now);
  rule(BigInt(now.getTime()) * 1000n < instantMicros(pending.expires), "CONFIRMATION_EXPIRED", "确认已过期，必须重新核验");
  const { request: original } = checkedInput(before, pending.request, pending.actor);
  rule(needsConfirmation(before, original, pending.actor) && pending.actor.role !== "tool", "STORAGE_INTEGRITY", "Persisted proposal must require an authorized confirmation");
  rule(instantMicros(pending.expires) === instantMicros(proposalDeadline(before, new Date(pending.details.created_at))), "STORAGE_INTEGRITY", "Proposal expiry does not match its original creation/dependency conditions");
  const preview = executeCommands(before, original, { role: "user", id: "pending-user" }, pending.proposalId, new Date(pending.details.created_at));
  rule(same(diff(before, preview), pending.details.diff) && preview.effective_skeleton_id === pending.details.effective
    && digest({ request: original, diff: pending.details.diff, effective: pending.details.effective }) === pending.digest,
  "STORAGE_INTEGRITY", "Persisted request, displayed diff and digest disagree");
  const after = request.accept ? executeCommands(before, original, actor, pending.proposalId, now) : structuredClone(before);
  const result = response(request.accept ? "applied" : "rejected", after.revision, pending.proposalId, pending.digest, diff(before, after));
  return { snapshot: after, response: result, ...journal(before, after, original, pending.actor, result, now, uuid, actor.id) };
}
