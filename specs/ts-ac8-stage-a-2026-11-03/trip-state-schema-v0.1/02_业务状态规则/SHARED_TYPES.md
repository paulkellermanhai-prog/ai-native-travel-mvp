# 共享结构、嵌套字段与接口封装

本页补充 [字段字典](../90_可运行工程包/FIELD_DICTIONARY.md)。字段的确切数据类型、枚举、必填条件和额外字段限制以离线 JSON Schema 为准。未知仅在 Schema 允许处使用 `null`；空数组表示尚无记录，不证明现实中不存在。金额为币种最小单位整数，人数为人，停留为夜，交通时长为分钟；日期为 `YYYY-MM-DD`，时刻必须带时区。

## 根容器与公共结构

| 结构 | 字段 | 语义 |
|---|---|---|
| root | schema_version、trip_id、revision | 契约固定 0.1.0、旅行身份、用于乐观并发的聚合版本 |
| root | effective_skeleton_id、objects | 当前采用版本的唯一权威引用（未采用为 null）；九类持久业务对象数组 |
| scope | kind、ids | trip 的 ids 为空；entity、skeleton、traveler 范围明确非空 ID，且在本旅行解析 |
| scope | start、end | date 范围的闭区间，start≤end，此时 ids 为空 |
| source | actor、actor_id、reference、text、at | 宿主鉴权主体、输入／回执定位、原始表达摘要与时刻；旧来源见历史 |
| dependency | object_id、version、paths、relation | 所依赖对象版本、非空字段路径集与 input/evidence/association 关系；input 无环，association 不触发重算 |

路径逐层解析对象键或数组序号，例如 `/value/start`、`/stops/0/nights`；不存在的键或序号非法，nullable 父级值为 null 时下层保持未知。实体、骨架的 parent_id 与决定 supersedes 是身份或版本谱系，均不得成环。Decision.supersedes 必须是同类决定；候选决定还须属于同一候选。

## 条件表达

| op | 字段 | 规则 |
|---|---|---|
| always | op | 恒真，不能作为未知条件的默认补值 |
| all / any | args：至少一个子条件 | 三值逻辑；all 中 false 优先，any 中 true 优先，其余传播 unknown |
| not | arg | 真值反转，unknown 不变 |
| eq/ne/lt/lte/gt/gte | object_id、path、value | 读取同旅行对象标量字段；阈值可为 null；缺值、不可用事实、类型不匹配得 unknown |

大小比较只对数字进行，bool 不是数字；无字符串或币种的隐式转换。条件引用属于隐式依赖；所指对象变化时，候选或骨架须复核。未知不能自动变成排除决定。

## Constraint.value：互斥类型

| kind | 字段 | 规则 |
|---|---|---|
| budget | mode、minimum_minor、maximum_minor、currency、people、categories | intent 意向、range 目标区间、ceiling 硬上限；上下限允许 null 的位置见 Schema；range 必须有两端，ceiling 必须有上限；三位币种、正人数、非空费用类别定义合计口径 |
| date_window | start、end | 日期闭区间，不可反向；未知日期以问题表达，不猜测 |
| duration | maximum_nights | 非负夜数；0 是明确零夜，不是未知 |
| travelers | count | 正人数；按当前 TripGoal.traveler_ids 核对；未登记返回未知 |
| entry_exit | entry_entity_id、exit_entity_id、arrival、departure | 入离境实体与可空时刻；当前计算只直接核对城市端点，交通节点映射未知 |
| requirement | description、condition | 原意及受限三值条件，unknown 不视为通过 |

假设骨架 overrides 的 `constraint_id` 唯一，`value.kind` 须与原 Constraint 相同；仅 scenario 使用，不改写权威约束。局部日期、实体和参与人范围目前保存但细粒度计算返回未知。

## ExternalFact 的查询、结果与核验

| 结构 | 字段 | 语义 |
|---|---|---|
| query | date、parameters[] | 查询业务日期可为 null；每个参数含 name、标量或 null 的 value |
| valid_for | start、end | 观察事实的适用日期闭区间，独立于证据时效 |
| value=null | 无 | 无有效结果；empty、timeout、error 均不能推断无服务 |
| transport | from_id、to_id、departure、arrival、duration_minutes、service_exists | 端点实体；时刻／时长可 null；服务存在取 true、false 或 null；false 需明确 no_service 证据 |
| cost | amount_minor、currency、people、category、item_key | 单项费用、口径与去重键；不能冒充行程总价 |
| condition | value、description | 布尔或 null 的事实值及含义；null 不能核验为 date_specific |

查询状态、证据层级、新鲜度和适用性四轴独立。`missing_fields` 是适配器缺项和程序检查缺项的并集。费用仅按相同币种、人数及类别汇总，不换汇；重复 `item_key` 不重复计入。

`reservation-v0.1` 是 ExternalFact 的受限只读 profile，并不增加业务对象或 JSON 字段。`query.parameters` 恰含七个不重复键：`profile="reservation-v0.1"`、`commitment_kind="lodging"`、非空 `confirmation_ref`、城市实体 `city_id`、ISO 日期 `check_in`/`check_out`、`commitment_state="confirmed"|"cancelled"`。`query.date=check_in`，`check_in<check_out`，`valid_for` 覆盖该住宿期间；`subject_ids` 包含该城市；`query_status=result`、`value.kind=condition`、`value.value` 与确认／取消状态一致；`source.actor=tool`、`missing_fields=[]`，核验须达到 date_specific。旅行窗口与住宿期间相交时计算城市是否在骨架中；日期已完全移开时保留回执并标记待处理未知。不能证明具体入住日期与夜数完全吻合，必须保留 `reservation_dates_not_checked`。同一回执同时只能有一个 active 版本；旧确认不得无可信同回执后继在同笔提交中解除。

## 骨架内容与 assessment

| 结构 | 字段 | 语义 |
|---|---|---|
| stops[] | entity_id、nights | 有序城市停留；nights 可 null 表示尚未分配，0 仅表示明确零夜 |
| connections[] | from_id、to_id、fact_ids | 一一对应相邻停留，可引用交通事实或无值查询记录；连接数为停留数减一 |
| cost_fact_ids、overrides | 事实 ID 集；约束覆盖数组 | 费用只引用费用事实或无值查询记录；覆盖仅 scenario 有效 |
| tradeoffs | gains、losses | 获得与放弃的解释数组，不等于用户决定 |
| assessment | status、checked_at | unchecked/pending/verified/blocked/stale 与本次检查时刻；仅覆盖已实现计算 |
| assessment | total_nights、connection_minutes | 总夜数；任一停留未知则 null；逐段交通分钟，缺证据为 null |
| cost_groups[] | currency、people、subtotal_minor、fact_ids | 同口径已知分项和来源；非完整总价 |
| assessment | cost_coverage、unknowns、violations | 费用覆盖只能 none/partial；未知和已知硬冲突分别保留 |

候选 city/experience 各恰好引用一个同类实体；connection 引用两个有序城市或交通节点。当前城市级骨架的停留只能指向 city。node→city 接驳、换乘安全时间等未实现时必须显示未知。

## 请求、响应与历史字段

| 结构 | 字段 | 语义 |
|---|---|---|
| change-request | expected_revision、idempotency_key、reason、input、commands | 旅行版本、幂等键、理由、操作原文与有序命令；整批原子提交 |
| input | kind、reference、text、target_ids | 对话／地图／时间轴／工具／系统入口，来源、原意与目标引用 |
| create/revise | object_type、id、scope、dependencies、data / changes | 创建用完整白名单数据；修正只能改白名单字段且至少一项；派生值由程序维护 |
| transition | id、event | 正式状态事件；专用确认／撤销／骨架替代等不能走通用命令 |
| adopt_skeleton | id、acknowledge_unknowns、confirmation_scope | 规划骨架与已展示未知；范围恰含 cities/order/stays/connections |
| decide_candidate | id、value | accept/reject/retain；排除态须先 reconsider；候选确认不自动采用骨架 |
| reconsider / recalculate | id、trigger_id / id | 条件实际触发对象与候选重入；或确定性重新计算 |
| check_freshness / ingest_fact | op / id、scope、dependencies、data | 系统时效入口；可信工具导入事实，不允许普通请求写核验派生字段 |
| resolve_issue / dismiss_issue / withdraw_decision | id、reason、evidence_ids（仅 resolve）/ id、reason / id | 证据解决、用户暂忽略或撤销确认；操作都留历史 |
| confirm-request | expected_revision、idempotency_key、proposal_digest、accept | 版本、幂等、绑定展示内容的摘要与接受／拒绝 |
| context-request | task_id、selected_object_ids | 任务与种子对象；组装时加全量活动硬约束、确认决定和相关问题 |
| response | outcome、revision、proposal_id、proposal_digest、confirmation_required、affected_ids、diff、errors | 结果、权威版本、提案绑定、受影响对象、差异及稳定错误码／说明 |
| diff[] | id、before、after | 完整对象前后快照；新增 before=null；待确认 after 仅为拟议值 |
| errors[] | code、message | 机器码与人类可读说明，不能根据说明文字反推权限 |
| history | intents、changes | 追加的 OperationIntent 和 ChangeRecord；本地参考实现未分页 |

DecisionContext.assembled_from_versions 的每项是对象 `id` 与正整数 `version`，只读消费时再次检查旅行版本和事实时效。ChangeRecord.confirmation_actor 记录明确授权或确认／拒绝的用户；尚未确认时为 null。
