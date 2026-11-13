# 枚举值与业务定义

精确允许值以 `schemas/` 为准。本词典解释业务含义。对象 `status` 只表达生命周期或候选判断；事实核验、用户确认、方案可行性均有独立字段。

## 对象生命周期

| 对象 | 值 → 业务含义 |
|---|---|
| TripGoal | `draft` 尚在整理目标；`active` 当前目标；`revised` 经用户明确修正仍可用；`closed` 目标结束，原对象不再修改 |
| Preference | `active` 当前可考虑；`superseded` 有继承表达取代；`withdrawn` 用户撤回；三者不代表明确程度 |
| Constraint | `proposed` 尚未生效；`active` 当前适用；`relaxed` 用户明确放宽的旧记录；`invalidated` 依据被纠正后的旧记录 |
| DestinationEntity | `known` 当前目录实体；`retired` 从目录退役但历史引用保留；不表达日期可用性 |
| Candidate | `exploring` 正在探索；`retained` 保留候选但未被确认；`conditionally_excluded` 条件性退出；`excluded` 明确退出；`reintroduced` 条件变化后重新考虑，未被自动选中 |
| ExternalFact | `active` 当前观察记录；`superseded` 新观察替代；`contradicted` 被可靠反证；时效另由 freshness 表达 |
| Skeleton | `active` 可讨论的版本，是否被采用看根引用；`superseded` 被新采用版本替代；`archived` 不再参与当前计算；scenario/plan 是 purpose |
| Decision | `proposed` 契约兼容的拟议决定；`pending_confirmation` 待用户确认；`confirmed` 具体范围已确认；`revised` 被新决定替代；`revoked` 用户撤销；正常本地流程通过提案记录承载中间态，不持久化中间 Decision 对象 |
| OpenIssue | `open` 缺口存在；`actionable` 有可尝试动作；`waiting` 等待输入；`resolved` 依据证明问题已解决；`dismissed` 用户暂不处理，但事实不变 |
| DecisionContext | `assembled` 理论组装态；`active` 当前可消费投影；`stale` 版本／时效已失效；`released` 任务结束；本地实现直接产生 active 快照，消费前实时判断是否过期，不持久化其余态 |

## 独立业务属性

| 字段 | 值 → 业务含义 |
|---|---|
| scope.kind | `trip` 全程；`entity` 指定地点／体验；`skeleton` 指定方案版本；`date` 日期段；`traveler` 指定同行人 |
| dependency.relation | `input` 计算输入，需无环；`evidence` 支撑依据，变化触发待复核；`association` 普通关联，不自动重算 |
| source.actor / OperationIntent.actor_role | `user` 经鉴权用户；`model` AI；`system` 确定性程序；`tool` 经宿主认可的外部适配器 |
| Preference.polarity | `positive` 兴趣；`negative` 顾虑；`tradeoff` 有条件取舍 |
| Preference.certainty | `explicit` 用户明确表达；`inferred` 模型推断；`ambiguous` 表达不明确；`unknown` 尚不能判定；不等于用户决定 |
| Preference.support | `weak` 证据较弱；`supported` 已有可追溯支持；不是外部真实性核验 |
| Preference.priority | `ordinary` 普通；`important` 重要；`critical` 极重要；仍不是 hard Constraint |
| Constraint.hardness | `soft` 意向／目标；`hard` 明确不可突破的限制；不能由模型从“重要”推断为硬 |
| Constraint.override_policy | `user` 用户可明确改；`fixed` 现实固定，必须有新的反证／替代依据才能失效 |
| budget.mode | `intent` 模糊意向；`range` 有上下界的目标区间；`ceiling` 明确硬上限 |
| Constraint.value.kind | `budget` 预算；`date_window` 日期；`duration` 夜数；`travelers` 人数；`entry_exit` 入离境；`requirement` 受限条件要求 |
| DestinationEntity.entity_kind | `country` 国家；`city` 城市；`region` 地区；`experience` 体验；`transport_node` 交通节点 |
| DestinationEntity.coverage | `unknown` 知识覆盖未知；`partial` 部分；`covered` 目录覆盖充分；不承诺现实开放 |
| Candidate.candidate_kind | `city` 城市；`experience` 体验；`connection` 连接；`combination` 组合 |
| Candidate/Decision.review_state | `current` 当前依据未被标记失效；`stale` 需复核，用户已确认的决定并不因此自动撤销 |
| ExternalFact.query_status | `result` 有结果；`partial` 部分结果；`empty` 空集但不能证明无服务；`timeout` 超时；`error` 适配器错误；`no_service` 有明确无服务证据 |
| ExternalFact.verification | `unverified` 未核验；`estimated` 有估计值；`date_specific` 指定日期证据完整；`purchasable` 已证实可购买库存，V0.1 适配器不生成 |
| ExternalFact.freshness | `current` 上次维护时未过期；`stale` 当时时效已过；读取时仍必须重新比较 expires_at |
| ExternalFact.applicability | `applicable` 与当前条件匹配；`unknown` 尚不能判断；`not_applicable` 当前条件不适用 |
| ExternalFact.value.kind | `transport` 交通服务；`cost` 分项费用；`condition` 可验证布尔条件；null 为无可用值。受限 `reservation-v0.1` 回执使用 condition，不增加业务对象类别 |
| Skeleton.purpose | `scenario` 只用于假设；`plan` 可规划／可被采用；均不等于已被采用 |
| Skeleton.assessment.status | `unchecked` 未计算；`pending` 存在未知；`verified` 仅已覆盖计算通过；`blocked` 已知硬冲突；`stale` 依据已变化 |
| Skeleton.assessment.cost_coverage | `none` 无可用分项；`partial` 只有部分已知分项；本版无完整总价状态 |
| Decision.decision_kind | `candidate_choice` 候选价值选择；`adopt_skeleton` 采用具体骨架版本 |
| Decision.value | `accept` 接受；`reject` 拒绝；`retain` 暂保留候选；不得从接受推导外部事实为真 |
| OpenIssue.issue_kind | `missing` 缺输入；`conflict` 已知冲突；`verification` 待事实核验；`dependency` 依赖变化；`unsupported` 当前计算不覆盖 |
| OpenIssue.severity | `info` 提示；`warning` 需复核；`blocking` 当前不可继续宣称满足 |
| OpenIssue.owner | `user` 用户输入／选择；`system` 程序计算；`provider` 外部来源复查 |
| OpenIssue.candidate_actions[] | `clarify` 澄清；`verify` 查询；`calculate` 确定性计算；`compare` 比较；`confirm` 请求用户确认 |
| ChangeRecord.outcome | `applied` 已提交；`pending_confirmation` 只是提案；`rejected` 用户拒绝提案，未应用拟议差异 |

条件表达 `op` 只允许 `always`、`all`、`any`、`not`、`eq`、`ne`、`lt`、`lte`、`gt`、`gte`；比较缺阈值或缺输入得到 unknown，不把 unknown 当成 false。字段类型、互斥分支和必填条件由机器契约强制执行。
