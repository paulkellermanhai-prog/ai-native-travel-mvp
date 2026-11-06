"""Generate the human handoff dictionary from the frozen contract and semantic notes."""
import json
from pathlib import Path
from tripstate.contracts import schemas, FIELDS, BASE_FIELDS, MUTABLE, DERIVED, TRANSITIONS, STATES
from build import NOTES, type_summary

ROOT = Path(__file__).resolve().parent
LABELS = dict(zip(
    "acknowledged_unknowns actions active_decisions actor_id actor_role affected_ids applicability aspect assembled_at assembled_from_versions assessment base_revision basis_ids candidate_actions candidate_kind certainty condition confirmation_actor confirmation_scope confirmed_at confirmed_by connections cost_fact_ids coverage created_at current_task decision_kind dependencies destination_ids diff effective_after effective_before entity_kind evidence_ids evidence_refs exclusion_reason expires_at expression freshness geo_identity hardness id inclusion_reason input intent_id issue_ids issue_kind knowledge_refs missing_fields must_include_constraints name observed_at open_issues outcome override_policy overrides owner parent_id polarity preference_ids priority proposal_id provider purpose query query_status question reason reconsider_when relevant_facts request_digest required_inputs resolution result_revision review_state scope selected_object_ids severity source stale_fact_ids state_revision status stops subject_id subject_ids subject_version success_definition supersedes support task_id tradeoffs traveler_ids trip_id type updated_at valid_for value verification version".split(),
    "已承认未知 操作列表 当前决定 操作主体 操作角色 受影响对象 事实适用性 偏好维度 组装时间 引用版本 检查结果 基准版本 决定依据 候选动作 候选类型 表达明确度 生效条件 确认主体 确认范围 确认时间 确认用户 跨城连接 费用事实 知识覆盖 记录时间 当前任务 决定类型 对象依赖 目标目的地 对象差异 提交后采用 提交前采用 实体种类 问题证据 表达证据 排除理由 投影或证据到期 原始含义 事实新鲜度 地理身份 约束硬度 对象标识 纳入理由 原始操作 意图记录 问题引用 问题类型 知识来源 缺失字段 必含约束 实体名称 事实观察 未解决问题 处理结果 覆盖策略 假设覆盖 责任主体 父版本或实体 偏好方向 偏好引用 偏好优先级 提案标识 外部提供者 目的或用途 查询内容 查询结果 问题描述 操作原因 重入条件 相关事实 请求摘要 待补输入 解决理由 结果版本 待复核状态 适用范围 选中对象 严重级别 写入来源 不可用事实 旅行版本 生命周期 停留列表 决定目标 涉及对象 目标版本 成功标准 被替代决定 证据支持 任务标识 取舍说明 参与人 旅行标识 类型标记 更新时间 适用日期 结构值 核验层级 对象版本".split()))

OBJECT_SOURCE = {
    "TripGoal": "用户明确表达", "Preference": "用户表达／模型推断／行为证据",
    "Constraint": "用户明确条件；fixed 可由可信事实纠错", "DestinationEntity": "系统目录适配器",
    "Candidate": "用户操作／模型候选／程序影响", "ExternalFact": "可信外部工具回执",
    "Skeleton": "用户连续编辑／模型提出方案", "Decision": "用户确认或拒绝",
    "OpenIssue": "用户／模型／程序发现缺口", "DecisionContext": "程序读取投影",
    "ChangeRecord": "程序追加审计", "OperationIntent": "经鉴权的原始操作",
}

RELATED = {
    "effective_before": "root.effective_skeleton_id", "effective_after": "root.effective_skeleton_id",
    "destination_ids": "DestinationEntity.id", "subject_ids": "DestinationEntity/Candidate/Skeleton/TripGoal.id，依对象限定",
    "subject_id": "Candidate/Skeleton.id", "basis_ids": "Constraint/ExternalFact 等对象 ID",
    "candidate_kind": "subject_ids", "preference_ids": "Preference.id", "issue_ids": "OpenIssue.id",
    "evidence_ids": "受影响对象的关联证据", "affected_ids": "同旅行对象 ID",
    "cost_fact_ids": "ExternalFact(cost).id", "dependencies": "对象 ID、版本、字段路径",
    "assessment": "Skeleton.stops/connections、Constraint、ExternalFact",
    "review_state": "引用对象和条件表达的变化", "confirmation_scope": "Decision.subject_id 及被展示差异",
    "relevant_facts": "ExternalFact.id", "must_include_constraints": "活动 hard Constraint.id",
    "active_decisions": "confirmed Decision.id", "assembled_from_versions": "选中对象 id/version",
    "intent_id": "OperationIntent.id", "proposal_id": "变更提案", "supersedes": "先前 Decision.id",
    "parent_id": "DestinationEntity/Skeleton.id，依对象限定", "value": "Constraint 或 ExternalFact 专属结构",
}


def nullable(schema):
    return "允许 null；必须按业务分支区分未知／未发生／不适用" if schema.get("type") == "null" or any(b.get("type") == "null" for b in schema.get("anyOf", []) + schema.get("oneOf", [])) else "无默认值；不得用空值猜测"


def authority(kind, field):
    if field in ("id", "trip_id", "type"):
        return "创建请求指定／程序校验", "创建后身份和所属旅行不可原位改"
    if field == "version":
        return "程序派生", "此对象成功改变时递增，不接受客户端指定"
    if field == "updated_at":
        return "程序派生", "此对象成功改变时按宿主时钟写入"
    if field == "status":
        return "按正式转换表的 User/AI/System/Tool 守卫", "仅通过业务事件转换，保留原因"
    if field == "scope":
        return "创建主体提出，程序校验", "当前命令不开放原位修改；扩大表达范围需新对象和证据"
    if field == "dependencies":
        return "创建主体提出，程序校验；计算依赖由程序补齐", "计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖"
    if field == "source":
        return "程序根据经鉴权的本次操作生成", "业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord"
    if kind == "DecisionContext":
        return "程序只读组装", "过期或旅行版本变化后整体重建"
    if kind in ("OperationIntent", "ChangeRecord"):
        return "程序原子追加", "不可原位修改；纠错新增记录"
    if kind == "ExternalFact":
        return ("程序派生" if field in DERIVED["ExternalFact"] else "可信外部工具"), "新查询新 ID；旧事实须显式替代／反证"
    if kind == "Decision":
        return "经鉴权用户＋程序原子确认", "专用决定／撤销命令；不直接写字段"
    if kind == "Skeleton" and field == "assessment" or kind == "Candidate" and field == "review_state":
        return "程序派生", "输入失效时标记待复核；重算后更新"
    if kind == "Constraint":
        return "用户明确指令；fixed 仅有依据系统失效", "明确修改或新增版本；不得由模型放宽"
    if kind == "TripGoal":
        return "用户明确指令", "修正保留历史；模型提案须确认"
    if kind == "Preference":
        return "明确偏好用户；推断偏好模型可提出／修正", "扩大 scope 需独立证据；不能由行为自动升级 explicit"
    if kind == "DestinationEntity":
        return "系统目录适配器", "与本次是否选择无关；日期可用性放事实"
    if kind == "Candidate":
        return "用户／模型／系统，按字段和状态守卫", "退出与重入不删除偏好和证据"
    if kind == "Skeleton":
        return "用户／模型可编辑未确认版本", "已确认版本不可原位改；采用须用户授权"
    return "用户／模型／系统，按问题事件守卫", "解决需关联有效证据；忽略不等于解决"


def make():
    examples = {}
    for kind in list(FIELDS) + ["DecisionContext", "OperationIntent", "ChangeRecord"]:
        examples[kind] = json.loads((ROOT / "examples" / "objects" / f"{kind}.json").read_text(encoding="utf-8"))
    docs = schemas()
    all_fields = set().union(*(set(docs[k]["properties"]) for k in examples))
    assert len(LABELS) == 99 and all_fields == set(LABELS), (all_fields - set(LABELS), set(LABELS) - all_fields)
    lines = ["# Final Field Dictionary｜字段、权威与变更责任", "",
             "此表由 `final_dictionary.py` 从 0.1.0 声明源、语义说明和已验证样例生成。每个对象顶层字段均列出；嵌套类型、enum 的完整值及含义见 [共享结构](SHARED_TYPES.md) 与 [枚举词典](ENUM_GLOSSARY.md)，精确约束见 `schemas/`。", "",
             "所有当前对象字段在存储结构中 Required=是；允许 null 是字段取值，不是省略字段。输入命令的可写字段由 command Schema 白名单限定。示例皆为合成测试数据。表中‘来源’指业务信息起源；‘写入权’指允许维护状态的主体，二者不能混同。", ""]
    for kind, sample in examples.items():
        lines += [f"## {kind}", "", "| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for name, schema in docs[kind]["properties"].items():
            writer, rule = authority(kind, name)
            value = json.dumps(sample.get(name), ensure_ascii=False, separators=(",", ":"))
            value = value.replace("|", "∣")
            history = "追加 ChangeRecord 前后快照" if kind in FIELDS else "本身为追加记录" if kind in ("OperationIntent", "ChangeRecord") else "按需重建，不独立保留真值"
            origin = "程序派生／当前操作来源" if name in ("id", "trip_id", "type", "version", "status", "source", "dependencies", "updated_at") else OBJECT_SOURCE[kind]
            missing = nullable(schema)
            if name == "status" and kind in STATES:
                missing = f"创建初态 `{STATES[kind][0]}`；不得省略"
            elif name == "version":
                missing = "创建为 1；不得用 null 或 0 表未知"
            elif name == "updated_at":
                missing = "程序时间；不得省略或猜测"
            elif kind == "Skeleton" and name == "assessment":
                missing = "创建为 unchecked；未知计算量显式 null"
            elif kind == "Candidate" and name == "review_state":
                missing = "创建为 current；依赖变化改 stale"
            elif kind == "ExternalFact" and name in DERIVED["ExternalFact"]:
                missing = "由工具输入和当前时钟派生；缺证据不可提高核验"
            definition = NOTES[name]
            if name == "purpose":
                definition = "用户表达的本次旅行目标／动机；不表示骨架用途或已采用。" if kind == "TripGoal" else "骨架用途：scenario 仅假设，plan 可规划；是否当前采用只看根引用。"
            elif name == "value" and kind == "Decision":
                definition = "用户对指定候选或骨架版本的接受、拒绝或保留；不代表外部事实成立。"
            elif name == "value" and kind == "ExternalFact":
                definition = "外部观察结果；transport/cost/condition 互斥，查询失败时可为 null，不得伪造已核验值。"
            lines.append("| " + " | ".join((f"`{name}` {LABELS[name]}", definition, type_summary(schema), "是", origin, kind,
                                             writer, rule, missing, history, f"`{value}`", RELATED.get(name, "—"))) + " |")
        lines.append("")
    (ROOT / "FIELD_DICTIONARY_FINAL.md").write_text("\n".join(lines), encoding="utf-8")


def make_transitions():
    actor_names = {"user": "User", "model": "AI", "system": "System", "tool": "External Source"}
    reversible = {
        ("DestinationEntity", "retire"): "可经 restore 重激活",
        ("Candidate", "exclude"): "可经有条件 reconsider 重入",
        ("Candidate", "exclude_conditionally"): "可经有条件 reconsider 重入",
        ("OpenIssue", "resolve"): "新证据可 reopen",
        ("OpenIssue", "dismiss"): "输入变化可 reopen",
        ("OpenIssue", "wait"): "有动作后可 make_actionable",
        ("TripGoal", "revise"): "可经 activate 继续；旧值不原位恢复",
    }
    lines = ["# State Transition Matrix｜正式状态转换矩阵", "",
             "从 `tripstate/contracts.py` 的 TRANSITIONS 同源生成。前置条件还包括对象引用、旅行版本、专用命令、权限和确认摘要校验；不满足任何条件均拒绝整笔业务提交。`Reversible` 指能否通过新事件重新进入判断，不代表删除历史或恢复旧快照。", "",
             "Decision 的 proposed/pending_confirmation 与 DecisionContext 的 assembled/stale/released 保留为契约／外部导入兼容态；本地正常流程分别以待确认提案记录和按需只读投影承载，直接生成 confirmed Decision 或 active Context。这是有意的 runtime 可达性边界，不应伪称所有契约状态都由当前 API 产出。终态无出口为有意设计；需要恢复时创建新版本或按表重开。", "",
             "| Object | From | Trigger | Actor | Preconditions / Confirmation | To | Side Effects | Reversible | Audit Required |",
             "|---|---|---|---|---|---|---|---|---|"]
    for t in TRANSITIONS:
        kind, event = t["object_type"], t["event"]
        actors = ", ".join(actor_names[a] for a in t["actors"])
        audit = "否，短期只读投影" if kind == "DecisionContext" else "是，OperationIntent + ChangeRecord"
        row = [kind, t["from_state"], event, actors, t["guard"] + "；" + t["confirmation"], t["to_state"],
               t["effect"], reversible.get((kind, event), "无原位回退；新命令／版本"), audit]
        lines.append("| " + " | ".join(row) + " |")
    lines += ["", "所有业务态失败结果：拒绝该原子批次、状态不部分生效、返回稳定错误码；用户拒绝待确认提案单独追加 rejected 记录。完整业务守卫及跨对象影响见 [传播规则](PROPAGATION_FINAL.md)。"]
    (ROOT / "STATE_TRANSITIONS_FINAL.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    make()
    make_transitions()
