"""Reproducible code generation; never touches project source documents."""
import json
from pathlib import Path
from copy import deepcopy
from uuid import UUID
from unittest.mock import patch
from tripstate.contracts import schemas, TRANSITIONS, FIELDS, BASE_FIELDS, STATES
from tripstate.engine import Store, Actor
from tripstate.fixtures import NOW, initial_state, minimal_state, request, adopt, create_command, preference, skeleton
from tripstate.rules import index, validate_shape

ROOT = Path(__file__).resolve().parent


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


NOTES = {
    "id": "稳定标识，旅行内唯一；类型与身份不可原位更改。", "trip_id": "所属旅行；禁止跨旅行引用。",
    "type": "业务对象判别常量。", "version": "对象单调版本；成功改变该对象时加一。",
    "status": "本对象专属生命周期；见状态转换表，不表示事实可信程度。",
    "scope": "适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。",
    "source": "最近一次业务写入的输入或工具来源；已提交旧来源保存在历史快照，不承诺留存未提交话语。",
    "dependencies": "引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。",
    "updated_at": "UTC ISO 8601 更新时间；由维护程序设置。", "destination_ids": "目标目的地实体引用。",
    "purpose": "本对象的用途；具体语义依拥有对象而定。", "success_definition": "本次旅行成功标准。",
    "traveler_ids": "本次旅行参与人外部标识登记，不增加参与人业务对象。", "current_task": "当前任务说明；不等于 DC 当前任务或 NAP 行动策略。",
    "subject_ids": "被表达、考虑或描述的实体／对象引用，按对象类型限制目标。", "aspect": "偏好维度，如文化、节奏或转场负担。",
    "polarity": "正向、负向或条件取舍，不自动成为去／不去的决定。", "certainty": "表达明确程度；不代表证据真假或用户批准。",
    "support": "证据支持标签；单次行为可以为 weak，不能凭此升级 certainty。", "priority": "偏好重要程度，不等于硬约束。",
    "expression": "保留用户表达含义。", "condition": "三值条件表达；value=null 或必要输入缺失时为未知。",
    "evidence_refs": "输入、实际展示/互动或资料的证据定位符；TS 不从字符串证明曝光或推断稳定兴趣。",
    "hardness": "soft/hard；预算意向和区间为 soft，明确硬上限为 hard。",
    "override_policy": "user 表示用户可明确修改；fixed 表示现实固定条件不可普通放宽。",
    "value": "类型专属结构值；金额使用最小币种单位整数，未知显式 null。", "entity_kind": "目录实体种类，与旅行选择无关。",
    "name": "实体显示名。", "parent_id": "父实体或父骨架引用；无父项时 null。", "geo_identity": "地理身份外部标识；未建立则 null。",
    "knowledge_refs": "可追溯知识来源标识。", "coverage": "目录资料覆盖水平，不代表现实可用。",
    "candidate_kind": "城市、体验、连接或组合候选。", "inclusion_reason": "纳入理由，未形成则 null。",
    "exclusion_reason": "排除理由；进入任一排除态必须非空。", "reconsider_when": "重新考虑条件；须引用真实触发对象且条件成立。",
    "preference_ids": "可复用偏好引用；不得复制为候选私有偏好真相。", "issue_ids": "关联问题 ID；resolved/dismissed 不抹掉历史关联。",
    "review_state": "当前依据是否待复核；stale 不撤销原用户选择。", "query": "查询日期与命名参数，缺日期为 null。",
    "provider": "外部提供方标识；真实性由宿主的可信适配器校验。", "query_status": "结果、部分、空集、超时、错误、证实无服务分别记录。",
    "verification": "证据层级；本实现最多产生 date_specific，不宣称真实库存或可购买性。",
    "freshness": "上次维护时记录的新鲜度；消费时还必须比较 expires_at。",
    "applicability": "是否适用于当前明确旅行条件，独立于事实原始观察。", "observed_at": "事实观察时刻，不得是未来。",
    "expires_at": "事实证据失效时刻；等于当前时刻即已过期。", "valid_for": "业务适用日期闭区间。",
    "missing_fields": "适配器报告与程序实测缺项的并集。", "stops": "有序停留项，顺序即城市顺序，避免独立 order 副本。",
    "connections": "逐项对应相邻停留，引用交通事实；不把画线当班次。", "cost_fact_ids": "分项费用事实引用；按 item_key 防止重复计费。",
    "overrides": "仅假设骨架允许的约束覆盖；不改写原约束。", "tradeoffs": "方案获得与放弃的解释。",
    "assessment": "程序派生：停留、交通、分组费用、未知、冲突及检查时间；客户端不可赋值。",
    "subject_id": "用户决定针对的候选或骨架。", "subject_version": "用户确认时的目标版本。",
    "decision_kind": "采用骨架或候选选择。", "confirmation_scope": "用户确认的精确范围；骨架采用要求城市、顺序、停留、连接四项。",
    "basis_ids": "选择依赖的条件与证据对象。", "acknowledged_unknowns": "用户确认时已经展示且承认的未知项，不改变事实。",
    "confirmed_by": "经宿主鉴权后的用户标识。", "confirmed_at": "确认时刻；与确认主体同时存在。",
    "supersedes": "同范围旧决定引用，无旧决定则 null。", "issue_kind": "缺失、冲突、核验、依赖变化或不支持。",
    "question": "仍需解决的具体问题。", "affected_ids": "受影响或被阻塞对象。", "severity": "问题影响程度，不是自动行动授权。",
    "required_inputs": "缺少的输入名称。", "candidate_actions": "问题处理的候选动作提示；不等于 NAP 候选行动或价值排序。",
    "owner": "用户、系统或提供方责任。", "resolution": "解决／暂忽略理由；开放状态为 null。", "evidence_ids": "解决问题的有效关联证据。",
    "task_id": "TS 只读投影的任务标识；不代替独立 DC 任务身份或权威旅行状态。",
    "state_revision": "投影组装时权威旅行版本；不一致即拒绝使用。",
    "assembled_at": "投影组装时刻，UTC。", "selected_object_ids": "种子对象及依赖闭包，只保存引用。",
    "must_include_constraints": "所有活动硬约束的完整 ID 集合，不得按模型相关性删减。",
    "active_decisions": "所有当前 confirmed 决定引用。", "open_issues": "尚未证明已解决的问题，包括 dismissed。",
    "relevant_facts": "引用闭包内全部事实。", "assembled_from_versions": "每个选中对象的 ID 与组装时版本。",
    "stale_fact_ids": "消费时不可用事实集合，含过期、失败、不适用和未消歧争议；不是仅 freshness=stale。",
    "actor_id": "宿主鉴权后注入的操作主体，不接受请求伪造。", "actor_role": "主体角色，不由自然语言内容决定。",
    "input": "已提交或待确认业务操作的入口、原始表达、来源引用与目标对象；未提交话语由 DC/宿主按授权留存。",
    "base_revision": "请求或确认处理所依据的旅行版本。", "created_at": "追加记录时刻，UTC。",
    "proposal_id": "提案关联标识；待确认和处理结果通过此值关联。", "intent_id": "同旅行 OperationIntent 引用。",
    "outcome": "applied 已应用；pending_confirmation 拟议；rejected 为用户拒绝提案。",
    "actions": "本批次有序业务操作名称，具体字段变化见 diff。", "reason": "变化或拒绝理由，不得为空。",
    "result_revision": "处理后的旅行版本；无业务变化时可以等于 base_revision。",
    "confirmation_actor": "明确授权或执行确认／拒绝的用户 ID；尚未确认时为 null。",
    "request_digest": "绑定请求、展示差异和拟议采用引用的 SHA-256 摘要；不是权限凭证。",
    "effective_before": "提交前根采用引用，无则 null。", "effective_after": "提交后根采用引用，无则 null。",
    "diff": "对象 before/after 快照；新增 before=null；pending 的 after 只是拟议结果。",
}


def type_summary(schema):
    if "$ref" in schema:
        return schema["$ref"].split("/")[-1]
    if "const" in schema:
        return "常量 " + str(schema["const"])
    if "enum" in schema:
        return " / ".join(map(str, schema["enum"]))
    if "oneOf" in schema or "anyOf" in schema:
        return "联合类型（按分支严格校验）"
    return str(schema.get("type", "见 Schema"))


def leaf_rows(schema, path="", required=True):
    yield dict(path=path or "/", required=required, schema=schema)
    for name, child in schema.get("properties", {}).items():
        yield from leaf_rows(child, path + "/" + name, name in schema.get("required", []))
    if "items" in schema:
        yield from leaf_rows(schema["items"], path + "/*", True)
    for union in ("oneOf", "anyOf"):
        for n, child in enumerate(schema.get(union, [])):
            yield from leaf_rows(child, path + f"[{union}:{n}]", required)


def generate_contracts():
    for name, schema in schemas().items():
        write_json(ROOT / "schemas" / (name + ".schema.json"), schema)
    write_json(ROOT / "rules" / "transitions.json", TRANSITIONS)
    dictionary = {name: list(leaf_rows(schema)) for name, schema in schemas().items()}
    write_json(ROOT / "rules" / "field-dictionary.json", dictionary)
    lines = ["# 字段字典与类型规范", "", "生成源：tripstate/contracts.py。所有对象禁止额外字段；完整嵌套路径、分支条件、约束见同目录 JSON 字典与 schemas。",
             "", "未提供与 null 不等价：当前持久对象列出的字段全部必填；允许未知的字段通过 nullable 显式列出。命令中的 changes 只要求本次修改字段。",
             "", "金额为最小币种单位整数；人数为人，停留为夜，交通时长为分钟。时间必须带时区；旅行日期为 YYYY-MM-DD。", "", "## 共享元数据", "",
             "| 字段 | 结构 | 语义 |", "|---|---|---|"]
    for name, schema in BASE_FIELDS.items():
        lines.append(f"| `{name}` | {type_summary(schema)} | {NOTES.get(name, '见 Schema')} |")
    for kind, fields in FIELDS.items():
        lines += ["", "## " + kind, "", "| 字段 | 结构／枚举 | 语义 |", "|---|---|---|"]
        for name, schema in fields.items():
            lines.append(f"| `{name}` | {type_summary(schema)} | {NOTES[name]} |")
    lines += ["", "嵌套字段及接口封装语义见 [共享结构与接口字段](SHARED_TYPES.md)。", "", "## DecisionContext 与系统记录", "", "这三类采用专属结构，不强套业务对象共享字段。", ""]
    for kind in ("DecisionContext", "OperationIntent", "ChangeRecord"):
        lines += ["### " + kind, "", "| 字段 | 结构 | 语义 |", "|---|---|---|"]
        for name, schema in schemas()[kind]["properties"].items():
            note = "投影到期边界；最多 5 分钟且不晚于下一事实到期点。" if kind == "DecisionContext" and name == "expires_at" else NOTES[name]
            lines.append(f"| `{name}` | {type_summary(schema)} | {note} |")
        lines += [""]
    (ROOT / "FIELD_DICTIONARY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    lines = ["# 正式状态转换表", "", "未列出的转换均非法。所有转换还需通过规格中的引用、版本、权限和业务守卫；命令不可直接写 status。",
             "", "部分中间态用于契约／导入兼容；参考实现新建 Decision 时直接经专用命令产生 confirmed，不独立持久化待确认 Decision。待确认提案由 ChangeRecord 和 OperationIntent 留痕。",
             "", "| 对象 | 起点 | 事件 | 终点 | 主体 | 确认要求 | 守卫 | 关联影响 |", "|---|---|---|---|---|---|---|---|"]
    for t in TRANSITIONS:
        lines.append("| " + " | ".join([t["object_type"], t["from_state"], t["event"], t["to_state"], ", ".join(t["actors"]), t["confirmation"], t["guard"], t["effect"]]) + " |")
    lines += ["", "所有失败统一拒绝整笔业务提交，返回规则错误，原有效状态保持。用户拒绝待确认提案会另外留下 rejected 变更记录。",
              "", "## 正交维度维护", "", "| 维度 | 触发 | 维护规则 |", "|---|---|---|",
              "| Preference.certainty/support | 明确用户纠错或模型提出候选解释 | 明确值只有用户能修改；模型覆盖进入待确认，不直接生效 |",
              "| ExternalFact.freshness | 时效检查 / 消费时钟 | 到期即不可消费；重新查询创建新事实，不直接把 stale 改回 current |",
              "| ExternalFact.applicability | 旅行日期变化 | 原观察保留；不适用事实不能支撑新日期结论 |",
              "| Skeleton.assessment | 输入变化 / 确定性重算 | 先 stale，再计算 pending / verified / blocked；无法计算保持未知 |",
              "| Candidate/Decision.review_state | 所依赖字段变化 | 变 stale；用户决定 status 不因此被撤销；新确认建立当前依据 |",
              "| 根 effective_skeleton_id | adopt_skeleton / withdraw_decision | 与确认记录及旧版本替代关系原子更新 |",
              "| DecisionContext 生命周期 | 组装、版本变化、时间到期、释放 | 只读派生；context_is_current 在消费前验证，过期对象应丢弃重建 |"]
    (ROOT / "STATE_TRANSITIONS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def generate_examples():
    user, model, system = Actor("user", "user-demo"), Actor("model", "model-demo"), Actor("system", "system-demo")
    write_json(ROOT / "examples" / "minimal-state.json", minimal_state())
    write_json(ROOT / "examples" / "initial-egypt-state.json", initial_state())
    counter = iter(range(1, 10000))
    with patch("tripstate.engine.uuid4", side_effect=lambda: UUID(int=next(counter))):
        store = Store(initial_state(), clock=lambda: NOW)
        trace = []

        def step(label, commands, actor, expected):
            body = request(store, *commands, key="example-" + str(len(trace)), reason=label)
            result = store.submit(body, actor)
            assert result["outcome"] == expected, result
            trace.append(dict(label=label, actor=dict(role=actor.role, id=actor.id), request=body, expected_outcome=expected,
                              response=result, after=store.get_state()))
            return result

        step("探索中新增推断兴趣；不确认城市", [create_command(preference("pref-explore", "inferred"))], model, "applied")
        step("条件性排除卢克索，保留偏好证据", [dict(op="transition", id="candidate-luxor", event="exclude_conditionally")], user, "applied")
        step("满足条件后重新考虑，不自动成为已选", [dict(op="reconsider", id="candidate-luxor", trigger_id="constraint-nights")], system, "applied")
        pending = step("模型提出采用骨架，等待用户确认", [adopt()], model, "pending_confirmation")
        confirm = dict(expected_revision=store.get_state()["revision"], idempotency_key="example-reject", proposal_digest=pending["proposal_digest"], accept=False)
        rejected = store.confirm(pending["proposal_id"], confirm, user)
        trace.append(dict(label="用户拒绝，当前骨架仍为空", confirm_proposal=pending["proposal_id"], request=confirm, expected_outcome="rejected", response=rejected, after=store.get_state()))
        step("用户明确采用；预算缺项仍然存在", [adopt()], user, "applied")
        context = store.context(dict(task_id="task-compare", selected_object_ids=["skeleton-a"]))
        write_json(ROOT / "examples" / "complete-egypt-state.json", store.get_state())
        write_json(ROOT / "examples" / "decision-context.json", context)
        step("连续编辑前创建独立暂定版本", [create_command(skeleton("skeleton-b"))], user, "applied")
        step("暂定版本停留调整，不替换当前骨架", [dict(op="revise", object_type="Skeleton", id="skeleton-b", changes=dict(stops=[dict(entity_id="cairo", nights=1), dict(entity_id="luxor", nights=2)]))], user, "applied")
        step("修改日期导致旧交通证据不适用", [dict(op="revise", object_type="Constraint", id="constraint-dates", changes=dict(value=dict(kind="date_window", start="2030-02-10", end="2030-02-14")))], user, "applied")
        step("有限重算返回未知，不编造新日期班次", [dict(op="recalculate", id="skeleton-a")], system, "applied")
        write_json(ROOT / "examples" / "multi-turn-trace.json", trace)
        write_json(ROOT / "examples" / "history.json", store.get_history())
        write_json(ROOT / "examples" / "final-state.json", store.get_state())
        for kind in FIELDS:
            sample = next(o for o in store.get_state()["objects"] if o["type"] == kind)
            write_json(ROOT / "examples" / "objects" / (kind + ".json"), sample)
        write_json(ROOT / "examples" / "objects" / "DecisionContext.json", context)
        write_json(ROOT / "examples" / "objects" / "OperationIntent.json", store.get_history()["intents"][0])
        write_json(ROOT / "examples" / "objects" / "ChangeRecord.json", store.get_history()["changes"][0])
        for n, turn in enumerate(trace):
            validate_shape("response", turn["response"])
            write_json(ROOT / "examples" / "api" / f"{n:02d}-request.json", turn["request"])
            write_json(ROOT / "examples" / "api" / f"{n:02d}-response.json", turn["response"])
        invalid = []
        state = initial_state()
        state["objects"].append(deepcopy(state["objects"][0]))
        invalid.append(dict(name="duplicate_id", schema="state", expected_error="DUPLICATE_ID", value=state))
        state = initial_state()
        index(state)["candidate-luxor"]["subject_ids"] = ["missing"]
        invalid.append(dict(name="dangling_reference", schema="state", expected_error="DANGLING_REF", value=state))
        state = initial_state()
        index(state)["constraint-budget"]["hardness"] = "hard"
        invalid.append(dict(name="intent_as_hard_budget", schema="state", expected_error="BUDGET_HARDNESS", value=state))
        body = request(0, adopt())
        body["actor"] = "user"
        invalid.append(dict(name="forged_actor", schema="change-request", expected_error="SCHEMA", value=body))
        write_json(ROOT / "examples" / "invalid-cases.json", invalid)


if __name__ == "__main__":
    generate_contracts()
    generate_examples()
    from final_dictionary import make, make_transitions
    make()
    make_transitions()
    from scenario_runner import run_scenarios
    write_json(ROOT / "examples" / "scenario-traces.json", run_scenarios())
    print("Generated offline schemas, field dictionary, transition table and synthetic examples.")
