"""Declarative contract source. build.py materializes offline JSON and dictionaries."""
from copy import deepcopy

BASE = "https://trip-state.example/spec/0.1/"
DRAFT = "https://json-schema.org/draft/2020-12/schema"


def text(description="非空文本"):
    return {"type": "string", "minLength": 1, "description": description}


def enum(*values):
    return {"type": "string", "enum": list(values)}


def integer(minimum=0):
    return {"type": "integer", "minimum": minimum}


def array(items, minimum=0):
    return {"type": "array", "items": items, "minItems": minimum}


def unique(items):
    return {**array(items), "uniqueItems": True}


def obj(properties, required=None):
    return {"type": "object", "properties": properties,
            "required": list(properties) if required is None else required,
            "additionalProperties": False}


def nullable(schema):
    return {"anyOf": [schema, {"type": "null"}]}


def ref(name):
    return {"$ref": BASE + name + ".schema.json"}


def common(name):
    return {"$ref": BASE + "common.schema.json#/$defs/" + name}


ID = {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,95}$"}
TIME = {"type": "string", "format": "date-time"}
DATE = {"type": "string", "format": "date"}
BOOL = {"type": "boolean"}
SCALAR = {"type": ["string", "number", "boolean", "null"]}
SCOPE = {"oneOf": [obj({"kind": enum("trip", "entity", "skeleton", "traveler"), "ids": unique(ID)}),
                    obj({"kind": enum("date"), "ids": {**unique(ID), "maxItems": 0}, "start": DATE, "end": DATE})]}
DEP = obj({"object_id": ID, "version": integer(1),
           "paths": unique({"type": "string", "pattern": "^/[A-Za-z_][A-Za-z0-9_/]*$"}),
           "relation": enum("input", "evidence", "association")})
SOURCE = obj({"actor": enum("user", "model", "system", "tool"), "actor_id": ID,
              "reference": text("输入或适配器证据标识"), "text": text("原始表达或结果摘要"),
              "at": TIME})
CONDITION = {"oneOf": [
    obj({"op": enum("always")}),
    obj({"op": enum("all", "any"), "args": array(common("condition"), 1)}),
    obj({"op": enum("not"), "arg": common("condition")}),
    obj({"op": enum("eq", "ne", "lt", "lte", "gt", "gte"), "object_id": ID,
         "path": {"type": "string", "pattern": "^/[A-Za-z_][A-Za-z0-9_/]*$"},
         "value": SCALAR})]}
CONSTRAINT_VALUE = {"oneOf": [
    obj({"kind": enum("budget"), "mode": enum("intent", "range", "ceiling"),
         "minimum_minor": nullable(integer()), "maximum_minor": nullable(integer()),
         "currency": {"type": "string", "pattern": "^[A-Z]{3}$"}, "people": integer(1),
         "categories": unique(text())}),
    obj({"kind": enum("date_window"), "start": DATE, "end": DATE}),
    obj({"kind": enum("duration"), "maximum_nights": integer()}),
    obj({"kind": enum("travelers"), "count": integer(1)}),
    obj({"kind": enum("entry_exit"), "entry_entity_id": ID, "exit_entity_id": ID,
         "arrival": nullable(TIME), "departure": nullable(TIME)}),
    obj({"kind": enum("requirement"), "description": text(), "condition": CONDITION})]}
FACT_VALUE = {"oneOf": [
    {"type": "null"},
    obj({"kind": enum("transport"), "from_id": ID, "to_id": ID,
         "departure": nullable(TIME), "arrival": nullable(TIME),
         "duration_minutes": nullable(integer()), "service_exists": nullable(BOOL)}),
    obj({"kind": enum("cost"), "amount_minor": integer(),
         "currency": {"type": "string", "pattern": "^[A-Z]{3}$"},
         "people": integer(1), "category": text(), "item_key": text("费用项去重键")}),
    obj({"kind": enum("condition"), "value": nullable(BOOL), "description": text()})]}
ASSESSMENT = obj({"status": enum("unchecked", "pending", "verified", "blocked", "stale"),
                  "total_nights": nullable(integer()), "connection_minutes": array(nullable(integer())),
                  "cost_groups": array(obj({"currency": text(), "people": integer(1),
                                            "subtotal_minor": integer(), "fact_ids": unique(ID)})),
                  "cost_coverage": enum("partial", "none"), "unknowns": unique(text()),
                  "violations": unique(text()), "checked_at": nullable(TIME)})

FIELDS = {
    "TripGoal": {"destination_ids": unique(ID), "purpose": text(), "success_definition": text(),
                 "traveler_ids": unique(ID), "current_task": text()},
    "Preference": {"subject_ids": unique(ID), "aspect": text(), "polarity": enum("positive", "negative", "tradeoff"),
                   "certainty": enum("explicit", "inferred", "ambiguous", "unknown"),
                   "support": enum("weak", "supported"), "priority": enum("ordinary", "important", "critical"),
                   "expression": text(), "condition": CONDITION, "evidence_refs": unique(text())},
    "Constraint": {"hardness": enum("soft", "hard"), "override_policy": enum("user", "fixed"),
                   "value": CONSTRAINT_VALUE},
    "DestinationEntity": {"entity_kind": enum("country", "city", "region", "experience", "transport_node"),
                          "name": text(), "parent_id": nullable(ID), "geo_identity": nullable(text()),
                          "knowledge_refs": unique(text()), "coverage": enum("unknown", "partial", "covered")},
    "Candidate": {"subject_ids": unique(ID), "candidate_kind": enum("city", "experience", "connection", "combination"),
                  "inclusion_reason": nullable(text()), "exclusion_reason": nullable(text()),
                  "reconsider_when": CONDITION, "preference_ids": unique(ID), "issue_ids": unique(ID),
                  "review_state": enum("current", "stale")},
    "ExternalFact": {"subject_ids": unique(ID), "query": obj({"date": nullable(DATE), "parameters": array(obj({"name": text(), "value": SCALAR}))}),
                     "provider": text(), "query_status": enum("result", "partial", "empty", "timeout", "error", "no_service"),
                     "verification": enum("unverified", "estimated", "date_specific", "purchasable"),
                     "freshness": enum("current", "stale"), "applicability": enum("applicable", "unknown", "not_applicable"),
                     "observed_at": TIME, "expires_at": TIME, "valid_for": obj({"start": DATE, "end": DATE}),
                     "missing_fields": unique(text()), "value": FACT_VALUE},
    "Skeleton": {"purpose": enum("scenario", "plan"),
                 "stops": array(obj({"entity_id": ID, "nights": nullable(integer())}), 1),
                 "connections": array(obj({"from_id": ID, "to_id": ID, "fact_ids": unique(ID)})),
                 "cost_fact_ids": unique(ID), "parent_id": nullable(ID),
                 "overrides": array(obj({"constraint_id": ID, "value": CONSTRAINT_VALUE})),
                 "tradeoffs": obj({"gains": array(text()), "losses": array(text())}),
                 "assessment": ASSESSMENT},
    "Decision": {"subject_id": ID, "subject_version": integer(1),
                 "decision_kind": enum("adopt_skeleton", "candidate_choice"),
                 "value": enum("accept", "reject", "retain"), "confirmation_scope": unique(text()),
                 "basis_ids": unique(ID), "acknowledged_unknowns": unique(text()),
                 "confirmed_by": nullable(ID), "confirmed_at": nullable(TIME),
                 "supersedes": nullable(ID), "review_state": enum("current", "stale")},
    "OpenIssue": {"issue_kind": enum("missing", "conflict", "verification", "dependency", "unsupported"),
                  "question": text(), "affected_ids": unique(ID), "severity": enum("info", "warning", "blocking"),
                  "required_inputs": array(text()), "candidate_actions": unique(enum("clarify", "verify", "calculate", "compare", "confirm")),
                  "owner": enum("user", "system", "provider"), "resolution": nullable(text()), "evidence_ids": unique(ID)},
}

STATES = {
    "TripGoal": ["draft", "active", "revised", "closed"],
    "Preference": ["active", "superseded", "withdrawn"],
    "Constraint": ["proposed", "active", "relaxed", "invalidated"],
    "DestinationEntity": ["known", "retired"],
    "Candidate": ["exploring", "retained", "conditionally_excluded", "excluded", "reintroduced"],
    "ExternalFact": ["active", "superseded", "contradicted"],
    "Skeleton": ["active", "superseded", "archived"],
    "Decision": ["proposed", "pending_confirmation", "confirmed", "revised", "revoked"],
    "OpenIssue": ["open", "actionable", "waiting", "resolved", "dismissed"],
    "DecisionContext": ["assembled", "active", "stale", "released"],
}

# (object, from, event, to, actor, guard, effect); unmatched edges are forbidden.
TRANSITIONS = []


def edges(kind, starts, event, target, actors, guard, effect):
    confirmation = "不增加用户确认；仍执行权限与证据守卫"
    if kind in ("TripGoal", "Constraint"):
        confirmation = "用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外）"
    if kind == "Preference":
        confirmation = "仅用户明确替代／撤回；推断偏好可另行修正字段"
    if (kind == "Candidate" and event == "exclude" or kind == "Skeleton" and event == "archive"
            or kind == "Decision" and event in ("confirm", "revoke") or kind == "OpenIssue" and event == "dismiss"):
        confirmation = "用户明确授权；模型提案须先确认"
    if kind in ("Skeleton", "Decision") and event == "supersede":
        confirmation = "仅由已授权的采用／选择命令原子触发，不开放单独替代"
    for start in starts.split():
        TRANSITIONS.append(dict(object_type=kind, from_state=start, event=event, to_state=target,
                                actors=actors.split(), confirmation=confirmation, guard=guard, effect=effect,
                                failure="拒绝整笔业务提交；原状态保持，返回规则错误"))


edges("TripGoal", "draft revised", "activate", "active", "user", "目标范围明确", "传播输入变化")
edges("TripGoal", "active", "revise", "revised", "user", "明确修正", "保留历史并传播")
edges("TripGoal", "draft active revised", "close", "closed", "user", "明确结束", "保留历史")
edges("Preference", "active", "supersede", "superseded", "user", "明确替代；同笔最终状态存在无环的后继 Preference association /status", "传播输入变化")
edges("Preference", "active", "withdraw", "withdrawn", "user", "明确撤回", "保留证据")
edges("Constraint", "proposed", "activate", "active", "user", "硬约束不得缺关键值", "影响范围重新校验")
edges("Constraint", "active", "relax", "relaxed", "user", "override_policy=user", "不改写原值")
edges("Constraint", "active proposed", "invalidate", "invalidated", "user system", "用户约束须确认；固定约束仅系统凭被反证／替代证据纠错", "影响范围重新校验")
edges("DestinationEntity", "known", "retire", "retired", "system", "知识目录维护", "不删除引用")
edges("DestinationEntity", "retired", "restore", "known", "system", "知识目录维护", "恢复目录可见性")
edges("Candidate", "exploring reintroduced", "retain", "retained", "user model system", "不意味着确认", "仅候选判断")
edges("Candidate", "exploring retained reintroduced", "exclude_conditionally", "conditionally_excluded", "user model system", "排除理由明确且不覆盖确认决定", "保留偏好与证据")
edges("Candidate", "exploring retained reintroduced conditionally_excluded", "exclude", "excluded", "user", "不覆盖确认决定", "保留偏好与证据")
edges("Candidate", "excluded conditionally_excluded", "reconsider", "reintroduced", "user system", "触发引用存在且条件成立", "不自动成为已选")
edges("ExternalFact", "active", "supersede", "superseded", "tool system", "证据可追溯", "依赖失效")
edges("ExternalFact", "active", "contradict", "contradicted", "tool system", "反证有来源", "依赖失效")
edges("Skeleton", "active", "supersede", "superseded", "system", "采用另一版本且原版本不再当前", "保留旧骨架")
edges("Skeleton", "active superseded", "archive", "archived", "user", "不是当前有效骨架", "保留旧版本")
edges("Decision", "proposed", "request_confirmation", "pending_confirmation", "user model system", "具体范围明确", "不应用选择")
edges("Decision", "proposed pending_confirmation", "confirm", "confirmed", "user", "专用确认命令；版本、范围、权限与约束通过", "原子应用选择")
edges("Decision", "confirmed", "supersede", "revised", "system", "新决定替代同范围旧决定", "保留历史")
edges("Decision", "proposed pending_confirmation confirmed", "revoke", "revoked", "user", "专用撤销命令", "必要时清空当前采用引用")
edges("OpenIssue", "open waiting", "make_actionable", "actionable", "system user", "至少有可尝试的候选动作", "不等于缺口已补齐或解决")
edges("OpenIssue", "open actionable", "wait", "waiting", "system user", "等待输入或工具", "保持未知")
edges("OpenIssue", "open actionable waiting", "resolve", "resolved", "system user", "证据有效且原阻塞已消除", "保留解决依据")
edges("OpenIssue", "open actionable waiting", "dismiss", "dismissed", "user", "理由非空", "不改变事实或可行性")
edges("OpenIssue", "resolved dismissed", "reopen", "open", "system user", "问题再次出现", "恢复可见问题")
edges("DecisionContext", "assembled", "activate", "active", "system", "版本与时效检查通过", "只读投影")
edges("DecisionContext", "assembled active", "invalidate", "stale", "system", "旅行版本变化或时间过期", "禁止用于新提交")
edges("DecisionContext", "assembled active stale", "release", "released", "system", "任务结束", "可重建")

BASE_FIELDS = {"id": ID, "trip_id": ID, "type": text(), "version": integer(1), "status": text(),
               "scope": SCOPE, "source": SOURCE, "dependencies": array(DEP), "updated_at": TIME}
DERIVED = {"Candidate": {"review_state"}, "ExternalFact": {"verification", "freshness", "applicability"},
           "Skeleton": {"assessment"}, "Decision": {"confirmed_by", "confirmed_at", "review_state"}}
MUTABLE = {
    "TripGoal": ["purpose", "success_definition", "destination_ids", "current_task"],
    "Preference": ["subject_ids", "aspect", "polarity", "certainty", "support", "priority", "expression", "condition", "evidence_refs"],
    "Constraint": ["value", "hardness"],
    "DestinationEntity": ["name", "geo_identity", "knowledge_refs", "coverage"],
    "Candidate": ["inclusion_reason", "exclusion_reason", "reconsider_when", "preference_ids", "issue_ids"],
    "Skeleton": ["stops", "connections", "cost_fact_ids", "tradeoffs", "overrides"],
    "OpenIssue": ["question", "required_inputs", "candidate_actions", "owner"],
}


def document(name, schema):
    return {"$schema": DRAFT, "$id": BASE + name + ".schema.json", "title": name, **schema}


def schemas():
    result = {"common": document("common", {"$defs": {"scope": SCOPE, "source": SOURCE,
                                                     "dependency": DEP, "condition": CONDITION,
                                                     "constraint_value": CONSTRAINT_VALUE}})}
    for name, fields in FIELDS.items():
        props = {**deepcopy(BASE_FIELDS), **deepcopy(fields)}
        props["type"] = {"const": name}
        props["status"] = enum(*STATES[name])
        result[name] = document(name, obj(props))
    context = obj({"id": ID, "type": {"const": "DecisionContext"}, "trip_id": ID,
                   "task_id": ID, "status": enum(*STATES["DecisionContext"]),
                   "state_revision": integer(), "assembled_at": TIME, "expires_at": TIME,
                   "selected_object_ids": unique(ID), "must_include_constraints": unique(ID),
                   "active_decisions": unique(ID), "open_issues": unique(ID),
                   "relevant_facts": unique(ID), "assembled_from_versions": array(obj({"id": ID, "version": integer(1)})),
                   "stale_fact_ids": unique(ID)})
    result["DecisionContext"] = document("DecisionContext", context)
    union = {"oneOf": [ref(name) for name in FIELDS]}
    result["state"] = document("state", obj({"schema_version": {"const": "0.1.0"}, "trip_id": ID,
                                              "revision": integer(), "effective_skeleton_id": nullable(ID),
                                              "objects": array(union)}))
    input_schema = obj({"kind": enum("dialogue", "map", "timeline", "tool", "system"),
                        "reference": text(), "text": text(), "target_ids": unique(ID)})
    result["OperationIntent"] = document("OperationIntent", obj({"id": ID, "type": {"const": "OperationIntent"},
        "trip_id": ID, "actor_id": ID, "actor_role": enum("user", "model", "system", "tool"),
        "input": input_schema, "base_revision": integer(), "created_at": TIME}))
    result["ChangeRecord"] = document("ChangeRecord", obj({"id": ID, "type": {"const": "ChangeRecord"},
        "trip_id": ID, "proposal_id": ID, "intent_id": ID, "outcome": enum("applied", "pending_confirmation", "rejected"),
        "actions": array(text(), 1), "reason": text(), "base_revision": integer(), "result_revision": integer(),
        "created_at": TIME, "confirmation_actor": nullable(ID), "request_digest": text(),
        "affected_ids": unique(ID), "effective_before": nullable(ID), "effective_after": nullable(ID),
        "diff": array(obj({"id": ID, "before": nullable(union), "after": nullable(union)}))}))
    creates = []
    for name in MUTABLE:
        fields = {k: v for k, v in FIELDS[name].items() if k not in DERIVED.get(name, set())}
        creates.append(obj({"op": {"const": "create"}, "object_type": {"const": name}, "id": ID,
                            "scope": SCOPE, "dependencies": array(DEP), "data": obj(fields)}))
    revisions = [obj({"op": {"const": "revise"}, "object_type": {"const": name}, "id": ID,
                      "changes": {**obj({k: FIELDS[name][k] for k in fields}, []), "minProperties": 1}})
                 for name, fields in MUTABLE.items()]
    commands = creates + revisions + [
        obj({"op": {"const": "transition"}, "id": ID, "event": enum(*sorted({t["event"] for t in TRANSITIONS}))}),
        obj({"op": {"const": "adopt_skeleton"}, "id": ID, "acknowledge_unknowns": BOOL,
             "confirmation_scope": {**unique(enum("cities", "order", "stays", "connections")), "minItems": 4}}),
        obj({"op": {"const": "decide_candidate"}, "id": ID, "value": enum("accept", "reject", "retain")}),
        obj({"op": {"const": "reconsider"}, "id": ID, "trigger_id": ID}),
        obj({"op": {"const": "recalculate"}, "id": ID}),
        obj({"op": {"const": "check_freshness"}}),
        obj({"op": {"const": "resolve_issue"}, "id": ID, "reason": text(), "evidence_ids": unique(ID)}),
        obj({"op": {"const": "dismiss_issue"}, "id": ID, "reason": text()}),
        obj({"op": {"const": "withdraw_decision"}, "id": ID}),
        obj({"op": {"const": "ingest_fact"}, "id": ID, "scope": SCOPE, "dependencies": array(DEP),
             "data": obj({k: v for k, v in FIELDS["ExternalFact"].items() if k not in DERIVED["ExternalFact"]})}),
    ]
    result["command"] = document("command", {"oneOf": commands})
    result["change-request"] = document("change-request", obj({"expected_revision": integer(),
        "idempotency_key": text(), "reason": text(), "input": input_schema, "commands": array(ref("command"), 1)}))
    result["confirm-request"] = document("confirm-request", obj({"expected_revision": integer(),
        "idempotency_key": text(), "proposal_digest": text(), "accept": BOOL}))
    result["context-request"] = document("context-request", obj({"task_id": ID, "selected_object_ids": unique(ID)}))
    result["response"] = document("response", obj({"outcome": enum("applied", "pending_confirmation", "rejected", "conflict", "preview"),
        "revision": integer(), "proposal_id": nullable(ID), "proposal_digest": nullable(text()),
        "confirmation_required": BOOL, "affected_ids": unique(ID),
        "diff": array(obj({"id": ID, "before": nullable(union), "after": nullable(union)})),
        "errors": array(obj({"code": text(), "message": text()}))}))
    result["history"] = document("history", obj({"intents": array(ref("OperationIntent")), "changes": array(ref("ChangeRecord"))}))
    return result
