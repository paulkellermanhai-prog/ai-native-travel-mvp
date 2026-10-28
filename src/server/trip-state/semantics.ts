import { parseStateReferences } from "./references";
import { TripStateContractError } from "./contracts";
import { checkStateCounters } from "./numbers";
import type { State, Constraint, ExternalFact } from "./contracts.generated";

export function rule(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new TripStateContractError(code, message);
}

// Python datetime compares microseconds; Date.parse alone would silently collapse distinct instants.
export function instantMicros(value: string): bigint {
  const fraction = /\.(\d+)(?=Z|[+-]\d\d:\d\d$)/.exec(value)?.[1] ?? "";
  const seconds = Date.parse(value.replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, ""));
  rule(Number.isFinite(seconds), "SCHEMA", "Invalid timestamp");
  return BigInt(seconds) * 1000n + BigInt((fraction + "000000").slice(0, 6));
}

// Original strict receipt profile; used by static validation and controlled command guards.
export function reservationProfile(fact: ExternalFact): Record<string, string> | null {
  const raw = fact.query.parameters;
  if (!raw.some((p) => p.name === "profile" && p.value === "reservation-v0.1")) return null;
  const fields = Object.fromEntries(raw.map((p) => [p.name, p.value]));
  const required = ["profile", "commitment_kind", "confirmation_ref", "city_id", "check_in", "check_out", "commitment_state"];
  rule(raw.length === Object.keys(fields).length && required.length === raw.length && required.every((k) => Object.hasOwn(fields, k)), "RESERVATION_PROFILE", "预订回执参数必须唯一且完整");
  rule(fields.commitment_kind === "lodging" && ["confirmed", "cancelled"].includes(String(fields.commitment_state)), "RESERVATION_PROFILE", "当前只支持只读住宿确认／取消回执");
  rule(required.every((k) => typeof fields[k] === "string" && fields[k]), "RESERVATION_PROFILE", "预订回执字段须为非空文本");
  const f = fields as Record<string, string>;
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  rule(validDate(f.check_in) && validDate(f.check_out), "RESERVATION_PROFILE", "预订日期格式错误");
  rule(f.check_in < f.check_out && fact.query.date === f.check_in, "RESERVATION_PROFILE", "住宿起止日期或查询日期不一致");
  rule(fact.valid_for.start <= f.check_in && f.check_out <= fact.valid_for.end, "RESERVATION_PROFILE", "回执适用日期未覆盖住宿期间");
  rule(fact.query_status === "result" && fact.value?.kind === "condition" && fact.value.value === (f.commitment_state === "confirmed") && fact.source.actor === "tool"
    && fact.missing_fields.length === 0 && ["date_specific", "purchasable"].includes(fact.verification), "RESERVATION_PROFILE", "预订状态只能来自完整的可信工具回执");
  rule(fact.subject_ids.includes(f.city_id), "RESERVATION_PROFILE", "城市必须是事实主体");
  return f;
}

/** Full static validate_state invariants in the original Python rule set, not command authorization. */
export function validateStateSemantics(value: unknown): State {
  const state = parseStateReferences(value); checkStateCounters(state);
  const objects = new Map(state.objects.map((o) => [o.id, o]));
  const target = (id: string) => { const result = objects.get(id); rule(result, "DANGLING_REF", `引用不存在: ${id}`); return result; };
  rule(state.objects.filter((o) => o.type === "TripGoal" && ["active", "revised"].includes(o.status)).length <= 1, "GOAL_AUTHORITY", "一趟旅行最多一个当前目标");
  function constraint(value: Constraint["value"], hardness: Constraint["hardness"]) {
    if (value.kind === "budget") {
      rule(value.minimum_minor === null || value.maximum_minor === null || value.minimum_minor <= value.maximum_minor, "BUDGET_RANGE", "预算区间反向");
      rule((value.mode === "ceiling") === (hardness === "hard"), "BUDGET_HARDNESS", "预算意向/区间为软，明确上限为硬");
      rule(value.mode !== "ceiling" || value.maximum_minor !== null, "BUDGET_MISSING", "硬上限必须明确金额");
      rule(value.mode !== "range" || value.minimum_minor !== null && value.maximum_minor !== null, "BUDGET_MISSING", "目标区间必须有上下界");
      rule(value.categories.length, "BUDGET_SCOPE", "费用口径不得为空");
    }
    if (value.kind === "date_window") rule(value.start <= value.end, "DATE_RANGE", "旅行日期反向");
    if (value.kind === "entry_exit") rule(!value.arrival || !value.departure || instantMicros(value.arrival) < instantMicros(value.departure), "DATE_RANGE", "入离境时间反向");
  }
  const receiptRefs: string[] = [];
  for (const o of state.objects) {
    if (o.type === "Preference") {
      rule(o.evidence_refs.length, "EVIDENCE", "偏好必须保留表达证据");
      if (o.status === "superseded") rule(state.objects.some((p) => p.type === "Preference" && p.dependencies.some((d) => d.object_id === o.id && d.relation === "association" && d.paths.includes("/status"))), "PREFERENCE_SUCCESSOR", "被替代偏好必须有可追溯的后继表达；单纯撤回应使用 withdrawn");
    }
    if (o.type === "Constraint") constraint(o.value, o.hardness);
    if (o.type === "Candidate" && ["excluded", "conditionally_excluded"].includes(o.status)) rule(o.exclusion_reason, "EXCLUSION_REASON", "排除须保留原因");
    if (o.type === "ExternalFact") {
      rule(instantMicros(o.observed_at) < instantMicros(o.expires_at), "FACT_TIME", "失效时间必须晚于观察时间");
      rule(o.valid_for.start <= o.valid_for.end, "FACT_TIME", "事实适用日期反向");
      if (["empty", "timeout", "error"].includes(o.query_status)) rule(o.value === null && o.verification === "unverified", "FALSE_VERIFICATION", "失败或空集不得有已核验结论");
      if (["date_specific", "purchasable"].includes(o.verification)) {
        rule(["result", "no_service"].includes(o.query_status) && o.missing_fields.length === 0 && o.query.date !== null && o.value !== null, "FALSE_VERIFICATION", "核验缺少结果、日期或必需字段");
        if (o.value?.kind === "condition") rule(o.value.value !== null, "FALSE_VERIFICATION", "条件值未知不能核验成功");
      }
      if (o.value?.kind === "transport") {
        rule(target(o.value.from_id).type === "DestinationEntity" && target(o.value.to_id).type === "DestinationEntity", "REF_TYPE", "交通端点须引用目的地实体");
        if (["date_specific", "purchasable"].includes(o.verification) && o.query_status === "result") rule(o.value.service_exists === true && o.value.departure !== null && o.value.arrival !== null, "FALSE_VERIFICATION", "指定日期班次核验须明确服务存在与起止时间");
      }
      if (o.query_status === "no_service") rule(o.value?.kind === "transport" && o.value.service_exists === false, "NO_SERVICE_EVIDENCE", "证实无服务须有显式证据");
      const profile = reservationProfile(o);
      if (profile) {
        const city = target(profile.city_id); rule(city.type === "DestinationEntity" && city.entity_kind === "city", "RESERVATION_PROFILE", "住宿回执须锚定城市");
        if (o.status === "active") receiptRefs.push(profile.confirmation_ref);
      }
    }
    if (o.type === "Skeleton") {
      rule(o.purpose === "scenario" || o.overrides.length === 0, "SCENARIO_LEAK", "规划版本不得携带假设覆盖");
      rule(new Set(o.overrides.map((v) => v.constraint_id)).size === o.overrides.length, "SCENARIO_OVERRIDE", "同一约束不能有两个假设覆盖");
      for (const override of o.overrides) {
        const original = target(override.constraint_id); rule(original.type === "Constraint", "REF_TYPE", "假设覆盖须引用约束");
        rule(override.value.kind === original.value.kind, "SCENARIO_OVERRIDE", "假设覆盖不得改变约束种类"); constraint(override.value, original.hardness);
      }
    }
    if (o.type === "Decision" && o.status === "confirmed") {
      rule(o.confirmed_by !== null && o.confirmed_at !== null && o.confirmation_scope.length, "CONFIRMATION", "确认缺少主体、时间或范围");
      const scope = o.decision_kind === "adopt_skeleton" ? ["cities", "order", "stays", "connections"] : ["candidate"];
      rule(scope.length === o.confirmation_scope.length && scope.every((s) => o.confirmation_scope.includes(s)), "CONFIRMATION_SCOPE", "确认范围不完整或含未知范围");
      rule(o.decision_kind !== "adopt_skeleton" || o.value === "accept", "DECISION_SCOPE", "采用骨架决定必须为接受");
    }
    if (o.type === "OpenIssue" && ["resolved", "dismissed"].includes(o.status)) rule(o.resolution !== null, "ISSUE_REASON", "关闭问题必须有理由");
  }
  rule(new Set(receiptRefs).size === receiptRefs.length, "RESERVATION_PROFILE", "同一预订回执不能有两个当前版本");
  const adopted = state.objects.filter((o) => o.type === "Decision" && o.status === "confirmed" && o.decision_kind === "adopt_skeleton");
  rule(adopted.length === (state.effective_skeleton_id ? 1 : 0), "ADOPTION_AUTHORITY", "当前采用引用与有效确认决定数量不一致");
  const choices = state.objects.filter((o) => o.type === "Decision" && o.status === "confirmed" && o.decision_kind === "candidate_choice").map((o) => o.type === "Decision" ? o.subject_id : "");
  rule(choices.length === new Set(choices).size, "DECISION_AUTHORITY", "同一候选不可同时有多个有效选择");
  if (state.effective_skeleton_id) {
    const sk = target(state.effective_skeleton_id);
    rule(sk.type === "Skeleton" && sk.purpose === "plan" && sk.status === "active", "EFFECTIVE_SKELETON", "当前骨架必须为活动规划版本");
    rule(adopted.filter((o) => o.type === "Decision" && o.subject_id === sk.id && o.value === "accept").length === 1, "ADOPTION_AUTHORITY", "当前骨架必须有唯一确认决定");
  }
  return state;
}
