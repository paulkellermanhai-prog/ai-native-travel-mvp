import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import transitions from "../../../specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/rules/transitions.json";
import { parseContract, TripStateContractError } from "./contracts";
import { digest } from "./command-json";
import { validateStateSemantics, rule, instantMicros, reservationProfile } from "./semantics";
import { incrementCounter, safeCounter } from "./numbers";
import { assess } from "./assessment";
import { conditionValue, conditionReferences as conditionRefs, applicable, factUsable, reservationOverlapsTrip } from "./conditions";
import type { State, TripStateContracts } from "./contracts.generated";

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
// Python sorted(set(...)) orders Unicode code points rather than UTF-16 code units.
function missingFields(fields: string[]): string[] {
  return [...new Set(fields)].sort((a, b) => {
    const x = Array.from(a, (c) => c.codePointAt(0)!), y = Array.from(b, (c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}
function checkedInput(beforeValue: unknown, requestValue: unknown, actor: Actor) {
  validateActor(actor);
  const before = validateStateSemantics(beforeValue), request = parseContract("change-request", requestValue);
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
  const recalculations = new Set<string>(), adoptions: Array<Extract<TripStateContracts["command"], { op: "adopt_skeleton" }>> = [];
  function get(id: string): ObjectRecord { const o = objects.get(id); rule(o, "DANGLING_REF", `引用不存在: ${id}`); return o; }
  function make(id: string, kind: ObjectRecord["type"], data: object, scope = { kind: "trip", ids: [] } as ObjectRecord["scope"], dependencies: ObjectRecord["dependencies"] = []) {
    rule(!objects.has(id), "DUPLICATE_ID", id);
    const initial = { TripGoal: "draft", Preference: "active", Constraint: "proposed", DestinationEntity: "known", Candidate: "exploring", Skeleton: "active", Decision: "proposed", OpenIssue: "open", ExternalFact: "active" };
    const o = parseContract(kind, { id, type: kind, trip_id: state.trip_id, version: 1, status: initial[kind], scope: structuredClone(scope), source: structuredClone(source), dependencies: structuredClone(dependencies), updated_at: stamp, ...data });
    state.objects.push(o); objects.set(id, o); return o;
  }
  function transition(o: ObjectRecord, event: string, role = actor.role) {
    const edge = transitions.find((t) => t.object_type === o.type && t.from_state === o.status && t.event === event);
    rule(edge, "ILLEGAL_TRANSITION", `${o.type}:${o.status} -> ${event}`);
    rule(edge.actors.includes(role), "PERMISSION", "执行主体没有此转换权限");
    Object.assign(o, { status: edge.to_state });
  }
  function hasCommitment(candidate: Extract<ObjectRecord, { type: "Candidate" }>) {
    return state.objects.some((f) => {
      const profile = f.type === "ExternalFact" && f.status === "active" ? reservationProfile(f) : null;
      return profile && profile.commitment_state === "confirmed" && candidate.subject_ids.includes(profile.city_id) && reservationOverlapsTrip(profile, objects);
    });
  }
  for (const cmd of request.commands) {
    if (cmd.op === "create") {
      rule(cmd.object_type !== "DestinationEntity" || actor.role === "system", "PERMISSION", "目录由系统适配器维护");
      rule(!["TripGoal", "Constraint"].includes(cmd.object_type) || actor.role === "user", "PERMISSION", "目标和约束须用户明确表达");
      rule(cmd.object_type !== "Preference" || cmd.data.certainty !== "explicit" || actor.role === "user", "PERMISSION", "明确偏好须有用户表达");
      if (cmd.object_type === "Candidate") make(cmd.id, "Candidate", { ...cmd.data, review_state: "current" }, cmd.scope, cmd.dependencies);
      else if (cmd.object_type === "Skeleton") make(cmd.id, "Skeleton", { ...cmd.data, assessment: { status: "unchecked", total_nights: null,
        connection_minutes: [], cost_groups: [], cost_coverage: "none", unknowns: [], violations: [], checked_at: null } }, cmd.scope, cmd.dependencies);
      else {
        const created = make(cmd.id, cmd.object_type, cmd.data, cmd.scope, cmd.dependencies);
        if (created.type === "OpenIssue") rule(created.resolution === null && created.evidence_ids.length === 0, "ISSUE_STATE", "新问题不能伪装已解决");
      }
    } else if (cmd.op === "revise") {
      const o = get(cmd.id); rule(o.type === cmd.object_type, "REF_TYPE", cmd.id);
      rule(!["superseded", "withdrawn", "invalidated", "relaxed", "closed", "retired", "archived", "resolved", "dismissed"].includes(o.status), "IMMUTABLE_HISTORY", "终态不得原位修改；创建新对象或允许的重开操作");
      rule(o.id !== state.effective_skeleton_id, "EFFECTIVE_IMMUTABLE", "修改有效骨架须创建暂定版本");
      if (o.type === "Skeleton") rule(!state.objects.some((d) => d.type === "Decision" && d.subject_id === o.id && d.status === "confirmed"), "CONFIRMED_IMMUTABLE", "确认过的骨架须新建版本");
      if (o.type === "Constraint") rule(o.override_policy !== "fixed", "FIXED_CONSTRAINT", "固定现实条件不可通过普通修改放宽；新增证据并走纠错");
      rule(o.type !== "DestinationEntity" || actor.role === "system", "PERMISSION", "目录仅系统维护");
      rule(!["TripGoal", "Constraint"].includes(o.type) && !(o.type === "Preference" && o.certainty === "explicit") || actor.role === "user", "PERMISSION", "明确值不得被推断覆盖");
      if (cmd.object_type === "Preference") rule(cmd.changes.certainty !== "explicit" || actor.role === "user", "PERMISSION", "推断不能升级为明确表达");
      // 'changes' already passed the original per-kind field whitelist; never accept a generic patch.
      Object.assign(o, structuredClone(cmd.changes), { source: structuredClone(source) });
    } else if (cmd.op === "transition") {
      const o = get(cmd.id);
      rule(!["confirm", "reconsider", "resolve", "dismiss", "revoke"].includes(cmd.event), "DEDICATED_COMMAND", "此转换必须经专用业务命令");
      rule(!(cmd.event === "supersede" && ["Skeleton", "Decision"].includes(o.type)), "DEDICATED_COMMAND", "骨架及决定的替代只能由专用采用／选择命令原子完成");
      if (o.type === "OpenIssue" && cmd.event === "make_actionable") rule(o.candidate_actions.length > 0, "ACTION_NOT_READY", "至少需要一个可尝试的候选动作");
      transition(o, cmd.event);
      if (o.type === "Constraint" && o.override_policy === "fixed") {
        rule(cmd.event === "invalidate" && actor.role === "system", "FIXED_CONSTRAINT", "固定约束只允许系统有依据地失效");
        rule(o.dependencies.some((d) => d.relation === "evidence" && get(d.object_id).type === "ExternalFact" && ["contradicted", "superseded"].includes(get(d.object_id).status)), "FIXED_CONSTRAINT_EVIDENCE", "固定条件失效须有已被反证或替代的事实依据；单纯过期仍保留原约束");
      }
      rule(o.id !== state.effective_skeleton_id, "EFFECTIVE_IMMUTABLE", "当前有效骨架不能单独归档或替代");
      if (o.type === "Candidate" && ["exclude", "exclude_conditionally"].includes(cmd.event)) {
        rule(!hasCommitment(o), "COMMITTED_FACT_CONFLICT", "已有住宿确认，不能单独排除其城市；先核验取消／变更");
        if (actor.role !== "user") rule(o.preference_ids.some((id) => {
          const p = get(id);
          return p.type === "Preference" && p.status === "active" && p.polarity === "tradeoff" && p.certainty === "explicit"
            && (p.scope.kind === "trip" || p.scope.kind === "entity" && p.scope.ids.some((id) => o.subject_ids.includes(id)))
            && conditionValue(p.condition, objects, now) === true;
        }), "CONDITION_UNKNOWN", "未确认适用取舍条件成立，不得自动排除");
        rule(!state.objects.some((d) => d.type === "Decision" && d.subject_id === o.id && d.status === "confirmed" && d.value === "accept"), "CONFIRMED_CANDIDATE", "先明确撤销该候选决定");
        const effective = state.effective_skeleton_id ? get(state.effective_skeleton_id) : null;
        rule(!effective || effective.type !== "Skeleton" || !effective.stops.some((stop) => o.subject_ids.includes(stop.entity_id)), "CONFIRMED_CANDIDATE", "排除会影响当前骨架，须创建并确认替代方案");
        o.exclusion_reason = request.reason;
      }
      o.source = structuredClone(source);
    } else if (cmd.op === "recalculate") {
      const o = get(cmd.id); rule(o.type === "Skeleton", "REF_TYPE", cmd.id);
      rule(o.status === "active", "IMMUTABLE_HISTORY", "历史版本不可重算覆盖；创建新暂定版本");
      rule(["system", "user"].includes(actor.role), "PERMISSION", "计算由确定性程序执行");
      recalculations.add(o.id);
    } else if (cmd.op === "adopt_skeleton") {
      rule(actor.role === "user", "PERMISSION", "采用骨架须用户确认");
      const o = get(cmd.id); rule(o.type === "Skeleton", "REF_TYPE", cmd.id);
      rule(o.purpose === "plan" && o.status === "active", "SCENARIO_ADOPTION", "假设、归档或替代版本不能直接采用");
      rule(state.effective_skeleton_id !== o.id, "ALREADY_ADOPTED", "已经是当前骨架");
      recalculations.add(o.id); adoptions.push(cmd);
    } else if (cmd.op === "decide_candidate") {
      rule(actor.role === "user", "PERMISSION", "用户决定必须经确认");
      const o = get(cmd.id); rule(o.type === "Candidate", "REF_TYPE", cmd.id);
      if (cmd.value !== "reject") rule(!["excluded", "conditionally_excluded"].includes(o.status), "CANDIDATE_EXCLUDED", "被排除候选须先重新考虑");
      if (cmd.value === "reject") {
        const effective = state.effective_skeleton_id ? get(state.effective_skeleton_id) : null;
        rule(!effective || effective.type !== "Skeleton" || !effective.stops.some((stop) => o.subject_ids.includes(stop.entity_id)), "CONFIRMED_CANDIDATE", "拒绝当前骨架中的城市须先确认替代骨架");
        rule(!hasCommitment(o), "COMMITTED_FACT_CONFLICT", "已有住宿确认，须先核验取消／变更");
      }
      const prior = state.objects.filter((d) => d.type === "Decision" && d.subject_id === o.id && d.status === "confirmed");
      for (const d of prior) transition(d, "supersede", "system"); // Derived effect of the authorized dedicated command, not a caller-supplied Actor.
      if (o.status !== (cmd.value === "reject" ? "excluded" : "retained")) transition(o, cmd.value === "reject" ? "exclude" : "retain");
      if (cmd.value === "reject") o.exclusion_reason = request.reason;
      const decision = make(`decision-${proposal}-${objects.size}`, "Decision", { subject_id: o.id, subject_version: o.version,
        decision_kind: "candidate_choice", value: cmd.value, confirmation_scope: ["candidate"], basis_ids: [], acknowledged_unknowns: [],
        confirmed_by: actor.id, confirmed_at: stamp, supersedes: prior.at(-1)?.id ?? null, review_state: "current" });
      transition(decision, "confirm");
    } else if (cmd.op === "reconsider") {
      const o = get(cmd.id); rule(o.type === "Candidate", "REF_TYPE", cmd.id); get(cmd.trigger_id);
      rule(conditionRefs(o.reconsider_when).includes(cmd.trigger_id), "RECONSIDER_TRIGGER", "触发对象必须属于重新考虑条件");
      rule(conditionValue(o.reconsider_when, objects, now) === true, "CONDITION_UNKNOWN", "重新考虑条件未成立或未知");
      transition(o, "reconsider"); o.review_state = "current";
    } else if (cmd.op === "withdraw_decision") {
      const o = get(cmd.id); rule(o.type === "Decision", "REF_TYPE", cmd.id); transition(o, "revoke");
      if (o.decision_kind === "adopt_skeleton" && o.subject_id === state.effective_skeleton_id) state.effective_skeleton_id = null;
    } else if (cmd.op === "ingest_fact") {
      rule(actor.role === "tool", "PERMISSION", "事实由可信适配器导入，普通用户/模型不能写核验结论");
      // The command whitelist excludes derived metadata; the trusted adapter supplies observations only.
      const o = make(cmd.id, "ExternalFact", { ...cmd.data, verification: "unverified", freshness: "stale", applicability: "unknown" }, cmd.scope, cmd.dependencies);
      rule(o.type === "ExternalFact", "REF_TYPE", cmd.id);
      const at = BigInt(now.getTime()) * 1000n;
      rule(instantMicros(o.observed_at) <= at, "FACT_TIME", "观察时间不能来自未来");
      if (o.value?.kind === "transport" && o.query_status === "result") {
        const value = o.value;
        const missing: string[] = (["service_exists", "departure", "arrival"] as const).filter((key) => value[key] === null);
        if (o.value.service_exists === false) missing.push("explicit_no_service_outcome_required");
        o.missing_fields = missingFields([...o.missing_fields, ...missing]);
      }
      if (o.value?.kind === "condition" && o.value.value === null) o.missing_fields = missingFields([...o.missing_fields, "value"]);
      const complete = ["result", "no_service"].includes(o.query_status) && o.query.date !== null && o.missing_fields.length === 0 && o.value !== null;
      o.verification = complete ? "date_specific" : o.value !== null ? "estimated" : "unverified";
      o.freshness = instantMicros(o.expires_at) > at ? "current" : "stale";
      o.applicability = complete && o.valid_for.start <= o.query.date! && o.query.date! <= o.valid_for.end ? "applicable" : "unknown";
    } else if (cmd.op === "check_freshness") {
      rule(actor.role === "system", "PERMISSION", "时效维护由系统执行");
      for (const o of objects.values()) if (o.type === "ExternalFact" && instantMicros(o.expires_at) <= BigInt(now.getTime()) * 1000n) o.freshness = "stale";
    } else if (cmd.op === "resolve_issue" || cmd.op === "dismiss_issue") {
      const o = get(cmd.id); rule(o.type === "OpenIssue", "REF_TYPE", cmd.id);
      transition(o, cmd.op === "resolve_issue" ? "resolve" : "dismiss");
      if (cmd.op === "resolve_issue") {
        rule(cmd.evidence_ids.length, "RESOLUTION_EVIDENCE", "解决问题必须提供证据");
        for (const id of cmd.evidence_ids) {
          const evidence = get(id);
          rule(["ExternalFact", "Constraint", "Decision", "Skeleton"].includes(evidence.type), "RESOLUTION_EVIDENCE", "证据类型不能解决问题");
          if (evidence.type === "ExternalFact") rule(factUsable(evidence, now), "RESOLUTION_EVIDENCE", "解决依据不可过期或未知");
          const allowed = new Set(o.affected_ids);
          for (const affected of o.affected_ids) {
            const subject = get(affected);
            for (const d of subject.dependencies) allowed.add(d.object_id);
            if (subject.type === "Skeleton") for (const ref of [...subject.cost_fact_ids, ...subject.connections.flatMap((c) => c.fact_ids)]) allowed.add(ref);
          }
          rule(allowed.has(id), "RESOLUTION_EVIDENCE", "证据必须与问题对象或其依赖关联");
        }
        for (const id of o.affected_ids) {
          const item = get(id);
          if (item.type === "ExternalFact") rule(factUsable(item, now), "ISSUE_STILL_BLOCKED", "原事实仍未核验");
          if (item.type === "Constraint") rule(item.status === "active", "ISSUE_STILL_BLOCKED", "条件尚未生效");
          if (item.type === "Decision") rule(item.status === "confirmed" && item.review_state === "current", "ISSUE_STILL_BLOCKED", "决定依据仍待检查");
          if (item.type === "Candidate") rule(item.review_state === "current", "ISSUE_STILL_BLOCKED", "候选仍待重新判断");
          if (item.type === "Skeleton") rule(assess(item, objects, now).status === "verified", "ISSUE_STILL_BLOCKED", "受影响骨架仍有未知或冲突");
        }
        o.evidence_ids = structuredClone(cmd.evidence_ids);
      }
      o.resolution = cmd.reason;
    }
  }
  // An existing confirmed commitment cannot disappear without one fresh, same-receipt successor.
  for (const previous of before.objects) {
    const profile = previous.type === "ExternalFact" ? reservationProfile(previous) : null;
    if (!profile || previous.status !== "active" || profile.commitment_state !== "confirmed" || !["superseded", "contradicted"].includes(get(previous.id).status)) continue;
    const successors = state.objects.filter((f) => f.type === "ExternalFact" && !old.has(f.id) && reservationProfile(f)?.confirmation_ref === profile.confirmation_ref);
    const next = successors[0], at = BigInt(now.getTime()) * 1000n;
    rule(successors.length === 1 && next?.type === "ExternalFact" && next.status === "active" && next.freshness === "current"
      && instantMicros(next.expires_at) > at && instantMicros(next.observed_at) <= at, "COMMITTED_FACT_EVIDENCE", "取消或变更已确认住宿须在同笔提交中导入可信同回执后继");
  }
  validateStateSemantics(state);
  // Original date-edit normalization of existing observations; never upgrades verification/freshness or imports facts.
  const windows = state.objects.flatMap((o) => o.type === "Constraint" && o.status === "active" && o.hardness === "hard" && o.scope.kind === "trip" && o.value.kind === "date_window" ? [o.value] : []);
  for (const fact of state.objects) if (fact.type === "ExternalFact" && fact.query.date !== null) {
    if (windows.length && !windows.every((w) => w.start <= fact.query.date! && fact.query.date! <= w.end)) fact.applicability = "not_applicable";
    else if (["date_specific", "purchasable"].includes(fact.verification) && fact.valid_for.start <= fact.query.date && fact.query.date <= fact.valid_for.end) fact.applicability = "applicable";
  }
  // Original field-sensitive propagation, including implicit links; no calculations or observation-value writes.
  function propagate(recomputed = new Set<string>()) {
    const changed = new Map(state.objects.filter((o) => !same(old.get(o.id), o)).map((o) => [o.id, changedPaths(old.get(o.id) ?? {}, o)]));
    const affected = new Set<string>();
    while (true) {
      const added = new Set<string>();
      for (const o of [...objects.values()]) {
        if (affected.has(o.id) || recomputed.has(o.id) || o.type === "Skeleton" && o.status !== "active" || o.type === "Decision" && (o.status !== "confirmed" || !old.has(o.id))) continue;
        let hits = o.dependencies.some((d) => ["input", "evidence"].includes(d.relation) && d.paths.some((p) => [...(changed.get(d.object_id) ?? [])].some((q) => p === q || p.startsWith(q + "/") || q.startsWith(p + "/"))));
        if (o.type === "Preference") hits ||= conditionRefs(o.condition).some((id) => changed.has(id));
        if (o.type === "Constraint" && o.value.kind === "requirement") hits ||= conditionRefs(o.value.condition).some((id) => changed.has(id));
        if (o.type === "Candidate") hits ||= [...o.preference_ids, ...conditionRefs(o.reconsider_when)].some((id) => changed.has(id));
        if (o.type === "Decision") hits ||= [o.subject_id, ...o.basis_ids].some((id) => changed.has(id));
        if (o.type === "Candidate") hits ||= [...changed.keys()].some((id) => { const r = get(id), p = r.type === "ExternalFact" ? reservationProfile(r) : null; return p && o.subject_ids.includes(p.city_id); });
        if (o.type === "Skeleton") {
          hits ||= [...o.cost_fact_ids, ...o.connections.flatMap((c) => c.fact_ids)].some((id) => changed.has(id));
          hits ||= [...changed.keys()].some((id) => { const r = get(id); return r.type === "Constraint" && applicable(r, o) || r.type === "TripGoal"
            || r.type === "ExternalFact" && !!reservationProfile(r) || r.type === "Candidate" && r.subject_ids.some((id) => o.stops.some((s) => s.entity_id === id)); });
          hits ||= [...(changed.get(o.id) ?? [])].some((p) => ["/stops", "/connections", "/cost_fact_ids", "/overrides"].includes(p));
        }
        if (!hits) continue;
        if (o.type === "Skeleton") { o.assessment.status = "stale"; o.assessment.unknowns = [...new Set([...o.assessment.unknowns, "inputs_changed"])].sort(); }
        if (o.type === "Candidate" || o.type === "Decision") o.review_state = "stale";
        added.add(o.id);
      }
      if (!added.size) break;
      for (const id of added) { affected.add(id); const paths = changedPaths(old.get(id) ?? {}, get(id)); changed.set(id, paths.size ? paths : new Set([""])); }
    }
    for (const id of [...affected].sort()) if (["Skeleton", "Decision"].includes(get(id).type)) {
      const issueId = `issue-dependency-${id}`, existing = objects.get(issueId);
      if (existing) { rule(existing.type === "OpenIssue", "REF_TYPE", issueId); existing.status = "open"; existing.resolution = null; }
      else make(issueId, "OpenIssue", { issue_kind: "dependency", question: "输入变化，需要重新核验或计算", affected_ids: [id], severity: "warning",
        required_inputs: ["fresh_dependencies"], candidate_actions: ["verify", "calculate", "confirm"], owner: "system", resolution: null, evidence_ids: [] });
    }
  }
  propagate();
  for (const id of recalculations) {
    const o = get(id); rule(o.type === "Skeleton", "REF_TYPE", id);
    o.assessment = assess(o, objects, now);
    const dependencies = new Set(o.dependencies.map((d) => d.object_id));
    const required = [...objects.values()].filter((c) => c.type === "Constraint" && c.status === "active" && applicable(c, o)).map((c) => c.id);
    required.push(...o.cost_fact_ids, ...o.connections.flatMap((c) => c.fact_ids));
    for (const ref of [...new Set(required)].filter((r) => !dependencies.has(r)).sort()) {
      const source = get(ref);
      o.dependencies.push({ object_id: ref, version: source.version, paths: source.type === "Constraint" ? ["/status", "/value"] : ["/status", "/value", "/freshness", "/applicability", "/expires_at"], relation: "input" });
    }
    for (const d of o.dependencies) d.version = get(d.object_id).version;
  }
  // Time alone may change computed output. Propagate it without invalidating freshly computed skeletons.
  if (recalculations.size) propagate(recalculations);
  rule(adoptions.length <= 1, "MULTIPLE_ADOPTIONS", "一笔提交只能采用一个骨架");
  for (const cmd of adoptions) {
    const o = get(cmd.id); rule(o.type === "Skeleton", "REF_TYPE", cmd.id);
    const cities = new Set(o.stops.map((s) => s.entity_id));
    for (const choice of state.objects) if (choice.type === "Decision" && choice.status === "confirmed" && choice.decision_kind === "candidate_choice") {
      const candidate = get(choice.subject_id); rule(candidate.type === "Candidate", "REF_TYPE", choice.subject_id);
      if (candidate.candidate_kind === "city") {
        const included = candidate.subject_ids.every((id) => cities.has(id));
        rule(!(choice.value === "accept" && !included || choice.value === "reject" && included), "CONFIRMED_CANDIDATE", "新骨架与明确候选决定冲突，须在同笔提交中明确撤销该决定");
      }
    }
    rule(o.assessment.status !== "blocked", "HARD_CONFLICT", "已知硬约束冲突阻止新骨架生效");
    rule(!o.assessment.unknowns.length || cmd.acknowledge_unknowns, "UNKNOWN_ACK", "必须承认已展示待核验项");
    const previous = state.objects.filter((d) => d.type === "Decision" && d.status === "confirmed" && d.decision_kind === "adopt_skeleton");
    for (const d of previous) transition(d, "supersede", "system");
    if (state.effective_skeleton_id) transition(get(state.effective_skeleton_id), "supersede", "system");
    const decision = make(`decision-${proposal}`, "Decision", { subject_id: o.id, subject_version: o.version, decision_kind: "adopt_skeleton", value: "accept",
      confirmation_scope: structuredClone(cmd.confirmation_scope), basis_ids: o.dependencies.map((d) => d.object_id), acknowledged_unknowns: structuredClone(o.assessment.unknowns),
      confirmed_by: actor.id, confirmed_at: stamp, supersedes: previous.at(-1)?.id ?? null, review_state: "current" });
    transition(decision, "confirm"); state.effective_skeleton_id = o.id;
  }
  for (const o of state.objects) {
    const previous = old.get(o.id);
    if (previous && !same(previous, o)) { o.version = incrementCounter(previous.version, "object version"); o.updated_at = stamp; }
  }
  for (const o of state.objects) {
    if (o.type === "Decision" && !old.has(o.id)) o.subject_version = get(o.subject_id).version;
    if (recalculations.has(o.id)) for (const d of o.dependencies) d.version = get(d.object_id).version;
  }
  const delta = diff(before, state);
  if (delta.length || before.effective_skeleton_id !== state.effective_skeleton_id) state.revision = incrementCounter(before.revision, "revision");
  validateStateSemantics(state);
  return state;
}

function prepared(beforeValue: unknown, requestValue: unknown, actor: Actor, clock: () => Date, uuid: () => string) {
  const { before, request } = checkedInput(beforeValue, requestValue, actor), now = clock(), proposal = `proposal-${uuid()}`;
  const needs = needsConfirmation(before, request, actor);
  rule(actor.role !== "tool" || request.commands.every((c) => c.op === "ingest_fact" || c.op === "transition" && ["supersede", "contradict"].includes(c.event)
    && before.objects.some((o) => o.id === c.id && o.type === "ExternalFact")), "PERMISSION", "工具仅能导入事实或使已有事实被替代／反证");
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
