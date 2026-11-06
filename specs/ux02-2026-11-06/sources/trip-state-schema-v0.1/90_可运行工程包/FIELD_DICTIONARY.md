# 字段字典与类型规范

生成源：tripstate/contracts.py。所有对象禁止额外字段；完整嵌套路径、分支条件、约束见同目录 JSON 字典与 schemas。

未提供与 null 不等价：当前持久对象列出的字段全部必填；允许未知的字段通过 nullable 显式列出。命令中的 changes 只要求本次修改字段。

金额为最小币种单位整数；人数为人，停留为夜，交通时长为分钟。时间必须带时区；旅行日期为 YYYY-MM-DD。

## 共享元数据

| 字段 | 结构 | 语义 |
|---|---|---|
| `id` | string | 稳定标识，旅行内唯一；类型与身份不可原位更改。 |
| `trip_id` | string | 所属旅行；禁止跨旅行引用。 |
| `type` | string | 业务对象判别常量。 |
| `version` | integer | 对象单调版本；成功改变该对象时加一。 |
| `status` | string | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 |
| `scope` | 联合类型（按分支严格校验） | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 |
| `source` | object | 最近一次业务写入的输入或工具来源；已提交旧来源保存在历史快照，不承诺留存未提交话语。 |
| `dependencies` | array | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 |
| `updated_at` | string | UTC ISO 8601 更新时间；由维护程序设置。 |

## TripGoal

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `destination_ids` | array | 目标目的地实体引用。 |
| `purpose` | string | 本对象的用途；具体语义依拥有对象而定。 |
| `success_definition` | string | 本次旅行成功标准。 |
| `traveler_ids` | array | 本次旅行参与人外部标识登记，不增加参与人业务对象。 |
| `current_task` | string | 当前任务说明；不等于 DC 当前任务或 NAP 行动策略。 |

## Preference

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `subject_ids` | array | 被表达、考虑或描述的实体／对象引用，按对象类型限制目标。 |
| `aspect` | string | 偏好维度，如文化、节奏或转场负担。 |
| `polarity` | positive / negative / tradeoff | 正向、负向或条件取舍，不自动成为去／不去的决定。 |
| `certainty` | explicit / inferred / ambiguous / unknown | 表达明确程度；不代表证据真假或用户批准。 |
| `support` | weak / supported | 证据支持标签；单次行为可以为 weak，不能凭此升级 certainty。 |
| `priority` | ordinary / important / critical | 偏好重要程度，不等于硬约束。 |
| `expression` | string | 保留用户表达含义。 |
| `condition` | 联合类型（按分支严格校验） | 三值条件表达；value=null 或必要输入缺失时为未知。 |
| `evidence_refs` | array | 输入、实际展示/互动或资料的证据定位符；TS 不从字符串证明曝光或推断稳定兴趣。 |

## Constraint

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `hardness` | soft / hard | soft/hard；预算意向和区间为 soft，明确硬上限为 hard。 |
| `override_policy` | user / fixed | user 表示用户可明确修改；fixed 表示现实固定条件不可普通放宽。 |
| `value` | 联合类型（按分支严格校验） | 类型专属结构值；金额使用最小币种单位整数，未知显式 null。 |

## DestinationEntity

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `entity_kind` | country / city / region / experience / transport_node | 目录实体种类，与旅行选择无关。 |
| `name` | string | 实体显示名。 |
| `parent_id` | 联合类型（按分支严格校验） | 父实体或父骨架引用；无父项时 null。 |
| `geo_identity` | 联合类型（按分支严格校验） | 地理身份外部标识；未建立则 null。 |
| `knowledge_refs` | array | 可追溯知识来源标识。 |
| `coverage` | unknown / partial / covered | 目录资料覆盖水平，不代表现实可用。 |

## Candidate

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `subject_ids` | array | 被表达、考虑或描述的实体／对象引用，按对象类型限制目标。 |
| `candidate_kind` | city / experience / connection / combination | 城市、体验、连接或组合候选。 |
| `inclusion_reason` | 联合类型（按分支严格校验） | 纳入理由，未形成则 null。 |
| `exclusion_reason` | 联合类型（按分支严格校验） | 排除理由；进入任一排除态必须非空。 |
| `reconsider_when` | 联合类型（按分支严格校验） | 重新考虑条件；须引用真实触发对象且条件成立。 |
| `preference_ids` | array | 可复用偏好引用；不得复制为候选私有偏好真相。 |
| `issue_ids` | array | 关联问题 ID；resolved/dismissed 不抹掉历史关联。 |
| `review_state` | current / stale | 当前依据是否待复核；stale 不撤销原用户选择。 |

## ExternalFact

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `subject_ids` | array | 被表达、考虑或描述的实体／对象引用，按对象类型限制目标。 |
| `query` | object | 查询日期与命名参数，缺日期为 null。 |
| `provider` | string | 外部提供方标识；真实性由宿主的可信适配器校验。 |
| `query_status` | result / partial / empty / timeout / error / no_service | 结果、部分、空集、超时、错误、证实无服务分别记录。 |
| `verification` | unverified / estimated / date_specific / purchasable | 证据层级；本实现最多产生 date_specific，不宣称真实库存或可购买性。 |
| `freshness` | current / stale | 上次维护时记录的新鲜度；消费时还必须比较 expires_at。 |
| `applicability` | applicable / unknown / not_applicable | 是否适用于当前明确旅行条件，独立于事实原始观察。 |
| `observed_at` | string | 事实观察时刻，不得是未来。 |
| `expires_at` | string | 事实证据失效时刻；等于当前时刻即已过期。 |
| `valid_for` | object | 业务适用日期闭区间。 |
| `missing_fields` | array | 适配器报告与程序实测缺项的并集。 |
| `value` | 联合类型（按分支严格校验） | 类型专属结构值；金额使用最小币种单位整数，未知显式 null。 |

## Skeleton

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `purpose` | scenario / plan | 本对象的用途；具体语义依拥有对象而定。 |
| `stops` | array | 有序停留项，顺序即城市顺序，避免独立 order 副本。 |
| `connections` | array | 逐项对应相邻停留，引用交通事实；不把画线当班次。 |
| `cost_fact_ids` | array | 分项费用事实引用；按 item_key 防止重复计费。 |
| `parent_id` | 联合类型（按分支严格校验） | 父实体或父骨架引用；无父项时 null。 |
| `overrides` | array | 仅假设骨架允许的约束覆盖；不改写原约束。 |
| `tradeoffs` | object | 方案获得与放弃的解释。 |
| `assessment` | object | 程序派生：停留、交通、分组费用、未知、冲突及检查时间；客户端不可赋值。 |

## Decision

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `subject_id` | string | 用户决定针对的候选或骨架。 |
| `subject_version` | integer | 用户确认时的目标版本。 |
| `decision_kind` | adopt_skeleton / candidate_choice | 采用骨架或候选选择。 |
| `value` | accept / reject / retain | 类型专属结构值；金额使用最小币种单位整数，未知显式 null。 |
| `confirmation_scope` | array | 用户确认的精确范围；骨架采用要求城市、顺序、停留、连接四项。 |
| `basis_ids` | array | 选择依赖的条件与证据对象。 |
| `acknowledged_unknowns` | array | 用户确认时已经展示且承认的未知项，不改变事实。 |
| `confirmed_by` | 联合类型（按分支严格校验） | 经宿主鉴权后的用户标识。 |
| `confirmed_at` | 联合类型（按分支严格校验） | 确认时刻；与确认主体同时存在。 |
| `supersedes` | 联合类型（按分支严格校验） | 同范围旧决定引用，无旧决定则 null。 |
| `review_state` | current / stale | 当前依据是否待复核；stale 不撤销原用户选择。 |

## OpenIssue

| 字段 | 结构／枚举 | 语义 |
|---|---|---|
| `issue_kind` | missing / conflict / verification / dependency / unsupported | 缺失、冲突、核验、依赖变化或不支持。 |
| `question` | string | 仍需解决的具体问题。 |
| `affected_ids` | array | 受影响或被阻塞对象。 |
| `severity` | info / warning / blocking | 问题影响程度，不是自动行动授权。 |
| `required_inputs` | array | 缺少的输入名称。 |
| `candidate_actions` | array | 问题处理的候选动作提示；不等于 NAP 候选行动或价值排序。 |
| `owner` | user / system / provider | 用户、系统或提供方责任。 |
| `resolution` | 联合类型（按分支严格校验） | 解决／暂忽略理由；开放状态为 null。 |
| `evidence_ids` | array | 解决问题的有效关联证据。 |

嵌套字段及接口封装语义见 [共享结构与接口字段](SHARED_TYPES.md)。

## DecisionContext 与系统记录

这三类采用专属结构，不强套业务对象共享字段。

### DecisionContext

| 字段 | 结构 | 语义 |
|---|---|---|
| `id` | string | 稳定标识，旅行内唯一；类型与身份不可原位更改。 |
| `type` | 常量 DecisionContext | 业务对象判别常量。 |
| `trip_id` | string | 所属旅行；禁止跨旅行引用。 |
| `task_id` | string | TS 只读投影的任务标识；不代替独立 DC 任务身份或权威旅行状态。 |
| `status` | assembled / active / stale / released | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 |
| `state_revision` | integer | 投影组装时权威旅行版本；不一致即拒绝使用。 |
| `assembled_at` | string | 投影组装时刻，UTC。 |
| `expires_at` | string | 投影到期边界；最多 5 分钟且不晚于下一事实到期点。 |
| `selected_object_ids` | array | 种子对象及依赖闭包，只保存引用。 |
| `must_include_constraints` | array | 所有活动硬约束的完整 ID 集合，不得按模型相关性删减。 |
| `active_decisions` | array | 所有当前 confirmed 决定引用。 |
| `open_issues` | array | 尚未证明已解决的问题，包括 dismissed。 |
| `relevant_facts` | array | 引用闭包内全部事实。 |
| `assembled_from_versions` | array | 每个选中对象的 ID 与组装时版本。 |
| `stale_fact_ids` | array | 消费时不可用事实集合，含过期、失败、不适用和未消歧争议；不是仅 freshness=stale。 |

### OperationIntent

| 字段 | 结构 | 语义 |
|---|---|---|
| `id` | string | 稳定标识，旅行内唯一；类型与身份不可原位更改。 |
| `type` | 常量 OperationIntent | 业务对象判别常量。 |
| `trip_id` | string | 所属旅行；禁止跨旅行引用。 |
| `actor_id` | string | 宿主鉴权后注入的操作主体，不接受请求伪造。 |
| `actor_role` | user / model / system / tool | 主体角色，不由自然语言内容决定。 |
| `input` | object | 已提交或待确认业务操作的入口、原始表达、来源引用与目标对象；未提交话语由 DC/宿主按授权留存。 |
| `base_revision` | integer | 请求或确认处理所依据的旅行版本。 |
| `created_at` | string | 追加记录时刻，UTC。 |

### ChangeRecord

| 字段 | 结构 | 语义 |
|---|---|---|
| `id` | string | 稳定标识，旅行内唯一；类型与身份不可原位更改。 |
| `type` | 常量 ChangeRecord | 业务对象判别常量。 |
| `trip_id` | string | 所属旅行；禁止跨旅行引用。 |
| `proposal_id` | string | 提案关联标识；待确认和处理结果通过此值关联。 |
| `intent_id` | string | 同旅行 OperationIntent 引用。 |
| `outcome` | applied / pending_confirmation / rejected | applied 已应用；pending_confirmation 拟议；rejected 为用户拒绝提案。 |
| `actions` | array | 本批次有序业务操作名称，具体字段变化见 diff。 |
| `reason` | string | 变化或拒绝理由，不得为空。 |
| `base_revision` | integer | 请求或确认处理所依据的旅行版本。 |
| `result_revision` | integer | 处理后的旅行版本；无业务变化时可以等于 base_revision。 |
| `created_at` | string | 追加记录时刻，UTC。 |
| `confirmation_actor` | 联合类型（按分支严格校验） | 明确授权或执行确认／拒绝的用户 ID；尚未确认时为 null。 |
| `request_digest` | string | 绑定请求、展示差异和拟议采用引用的 SHA-256 摘要；不是权限凭证。 |
| `affected_ids` | array | 受影响或被阻塞对象。 |
| `effective_before` | 联合类型（按分支严格校验） | 提交前根采用引用，无则 null。 |
| `effective_after` | 联合类型（按分支严格校验） | 提交后根采用引用，无则 null。 |
| `diff` | array | 对象 before/after 快照；新增 before=null；pending 的 after 只是拟议结果。 |

