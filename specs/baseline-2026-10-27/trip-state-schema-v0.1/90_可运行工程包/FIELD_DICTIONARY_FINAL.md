# Final Field Dictionary｜字段、权威与变更责任

此表由 `final_dictionary.py` 从 0.1.0 声明源、语义说明和已验证样例生成。每个对象顶层字段均列出；嵌套类型、enum 的完整值及含义见 [共享结构](SHARED_TYPES.md) 与 [枚举词典](ENUM_GLOSSARY.md)，精确约束见 `schemas/`。

所有当前对象字段在存储结构中 Required=是；允许 null 是字段取值，不是省略字段。输入命令的可写字段由 command Schema 白名单限定。示例皆为合成测试数据。表中‘来源’指业务信息起源；‘写入权’指允许维护状态的主体，二者不能混同。

## TripGoal

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | TripGoal | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"goal"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | TripGoal | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 TripGoal | 是 | 程序派生／当前操作来源 | TripGoal | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"TripGoal"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | TripGoal | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `1` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | draft / active / revised / closed | 是 | 程序派生／当前操作来源 | TripGoal | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `draft`；不得省略 | 追加 ChangeRecord 前后快照 | `"active"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户明确表达 | TripGoal | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | TripGoal | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"测试材料，不代表真实用户或现实交通","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | TripGoal | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | TripGoal | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `destination_ids` 目标目的地 | 目标目的地实体引用。 | array | 是 | 用户明确表达 | TripGoal | 用户明确指令 | 修正保留历史；模型提案须确认 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["egypt"]` | DestinationEntity.id |
| `purpose` 目的或用途 | 用户表达的本次旅行目标／动机；不表示骨架用途或已采用。 | string | 是 | 用户明确表达 | TripGoal | 用户明确指令 | 修正保留历史；模型提案须确认 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"测试多城市旅行骨架"` | — |
| `success_definition` 成功标准 | 本次旅行成功标准。 | string | 是 | 用户明确表达 | TripGoal | 用户明确指令 | 修正保留历史；模型提案须确认 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"理解取舍、保留核验边界"` | — |
| `traveler_ids` 参与人 | 本次旅行参与人外部标识登记，不增加参与人业务对象。 | array | 是 | 用户明确表达 | TripGoal | 用户明确指令 | 修正保留历史；模型提案须确认 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["traveler-demo"]` | — |
| `current_task` 当前任务 | 当前任务说明；不是行动策略。 | string | 是 | 用户明确表达 | TripGoal | 用户明确指令 | 修正保留历史；模型提案须确认 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"compare"` | — |

## Preference

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | Preference | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"pref-culture"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | Preference | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 Preference | 是 | 程序派生／当前操作来源 | Preference | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"Preference"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | Preference | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `1` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | active / superseded / withdrawn | 是 | 程序派生／当前操作来源 | Preference | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `active`；不得省略 | 追加 ChangeRecord 前后快照 | `"active"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户表达／模型推断／行为证据 | Preference | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | Preference | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"测试材料，不代表真实用户或现实交通","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | Preference | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | Preference | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `subject_ids` 涉及对象 | 被表达、考虑或描述的实体／对象引用，按对象类型限制目标。 | array | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["luxor"]` | DestinationEntity/Candidate/Skeleton/TripGoal.id，依对象限定 |
| `aspect` 偏好维度 | 偏好维度，如文化、节奏或转场负担。 | string | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"文化体验"` | — |
| `polarity` 偏好方向 | 正向、负向或条件取舍，不自动成为去／不去的决定。 | positive / negative / tradeoff | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"positive"` | — |
| `certainty` 表达明确度 | 表达明确程度；不代表证据真假或用户批准。 | explicit / inferred / ambiguous / unknown | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"explicit"` | — |
| `support` 证据支持 | 证据支持标签；单次行为可以为 weak，不能凭此升级 certainty。 | weak / supported | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"supported"` | — |
| `priority` 偏好优先级 | 偏好重要程度，不等于硬约束。 | ordinary / important / critical | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"important"` | — |
| `expression` 原始含义 | 保留用户表达含义。 | string | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"我喜欢文化体验；不代表必须去某座城"` | — |
| `condition` 生效条件 | 三值条件表达；value=null 或必要输入缺失时为未知。 | 联合类型（按分支严格校验） | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"op":"always"}` | — |
| `evidence_refs` 表达证据 | 输入／资料证据定位符；允许外部证据标识，不是假定数据库外键。 | array | 是 | 用户表达／模型推断／行为证据 | Preference | 明确偏好用户；推断偏好模型可提出／修正 | 扩大 scope 需独立证据；不能由行为自动升级 explicit | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["synthetic-dialogue-1"]` | — |

## Constraint

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | Constraint | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"constraint-dates"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | Constraint | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 Constraint | 是 | 程序派生／当前操作来源 | Constraint | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"Constraint"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | Constraint | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `2` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | proposed / active / relaxed / invalidated | 是 | 程序派生／当前操作来源 | Constraint | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `proposed`；不得省略 | 追加 ChangeRecord 前后快照 | `"active"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户明确条件；fixed 可由可信事实纠错 | Constraint | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | Constraint | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"修改日期导致旧交通证据不适用","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | Constraint | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | Constraint | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `hardness` 约束硬度 | soft/hard；预算意向和区间为 soft，明确硬上限为 hard。 | soft / hard | 是 | 用户明确条件；fixed 可由可信事实纠错 | Constraint | 用户明确指令；fixed 仅有依据系统失效 | 明确修改或新增版本；不得由模型放宽 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"hard"` | — |
| `override_policy` 覆盖策略 | user 表示用户可明确修改；fixed 表示现实固定条件不可普通放宽。 | user / fixed | 是 | 用户明确条件；fixed 可由可信事实纠错 | Constraint | 用户明确指令；fixed 仅有依据系统失效 | 明确修改或新增版本；不得由模型放宽 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"user"` | — |
| `value` 结构值 | 类型专属结构值；金额使用最小币种单位整数，未知显式 null。 | 联合类型（按分支严格校验） | 是 | 用户明确条件；fixed 可由可信事实纠错 | Constraint | 用户明确指令；fixed 仅有依据系统失效 | 明确修改或新增版本；不得由模型放宽 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"date_window","start":"2030-02-10","end":"2030-02-14"}` | Constraint 或 ExternalFact 专属结构 |

## DestinationEntity

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | DestinationEntity | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"egypt"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | DestinationEntity | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 DestinationEntity | 是 | 程序派生／当前操作来源 | DestinationEntity | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"DestinationEntity"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | DestinationEntity | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `1` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | known / retired | 是 | 程序派生／当前操作来源 | DestinationEntity | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `known`；不得省略 | 追加 ChangeRecord 前后快照 | `"known"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 系统目录适配器 | DestinationEntity | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | DestinationEntity | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"测试材料，不代表真实用户或现实交通","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | DestinationEntity | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | DestinationEntity | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `entity_kind` 实体种类 | 目录实体种类，与旅行选择无关。 | country / city / region / experience / transport_node | 是 | 系统目录适配器 | DestinationEntity | 系统目录适配器 | 与本次是否选择无关；日期可用性放事实 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"country"` | — |
| `name` 实体名称 | 实体显示名。 | string | 是 | 系统目录适配器 | DestinationEntity | 系统目录适配器 | 与本次是否选择无关；日期可用性放事实 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"埃及"` | — |
| `parent_id` 父版本或实体 | 父实体或父骨架引用；无父项时 null。 | 联合类型（按分支严格校验） | 是 | 系统目录适配器 | DestinationEntity | 系统目录适配器 | 与本次是否选择无关；日期可用性放事实 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `null` | DestinationEntity/Skeleton.id，依对象限定 |
| `geo_identity` 地理身份 | 地理身份外部标识；未建立则 null。 | 联合类型（按分支严格校验） | 是 | 系统目录适配器 | DestinationEntity | 系统目录适配器 | 与本次是否选择无关；日期可用性放事实 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `null` | — |
| `knowledge_refs` 知识来源 | 可追溯知识来源标识。 | array | 是 | 系统目录适配器 | DestinationEntity | 系统目录适配器 | 与本次是否选择无关；日期可用性放事实 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["synthetic-catalog"]` | — |
| `coverage` 知识覆盖 | 目录资料覆盖水平，不代表现实可用。 | unknown / partial / covered | 是 | 系统目录适配器 | DestinationEntity | 系统目录适配器 | 与本次是否选择无关；日期可用性放事实 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"partial"` | — |

## Candidate

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | Candidate | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"candidate-luxor"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | Candidate | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 Candidate | 是 | 程序派生／当前操作来源 | Candidate | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"Candidate"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | Candidate | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `3` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | exploring / retained / conditionally_excluded / excluded / reintroduced | 是 | 程序派生／当前操作来源 | Candidate | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `exploring`；不得省略 | 追加 ChangeRecord 前后快照 | `"reintroduced"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户操作／模型候选／程序影响 | Candidate | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | Candidate | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"条件性排除卢克索，保留偏好证据","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | Candidate | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | Candidate | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `subject_ids` 涉及对象 | 被表达、考虑或描述的实体／对象引用，按对象类型限制目标。 | array | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["luxor"]` | DestinationEntity/Candidate/Skeleton/TripGoal.id，依对象限定 |
| `candidate_kind` 候选类型 | 城市、体验、连接或组合候选。 | city / experience / connection / combination | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"city"` | subject_ids |
| `inclusion_reason` 纳入理由 | 纳入理由，未形成则 null。 | 联合类型（按分支严格校验） | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `"文化兴趣"` | — |
| `exclusion_reason` 排除理由 | 排除理由；进入任一排除态必须非空。 | 联合类型（按分支严格校验） | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `"条件性排除卢克索，保留偏好证据"` | — |
| `reconsider_when` 重入条件 | 重新考虑条件；须引用真实触发对象且条件成立。 | 联合类型（按分支严格校验） | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"op":"gte","object_id":"constraint-nights","path":"/value/maximum_nights","value":4}` | — |
| `preference_ids` 偏好引用 | 可复用偏好引用；不得复制为候选私有偏好真相。 | array | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["pref-culture"]` | Preference.id |
| `issue_ids` 问题引用 | 关联问题 ID；resolved/dismissed 不抹掉历史关联。 | array | 是 | 用户操作／模型候选／程序影响 | Candidate | 用户／模型／系统，按字段和状态守卫 | 退出与重入不删除偏好和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | OpenIssue.id |
| `review_state` 待复核状态 | 当前依据是否待复核；stale 不撤销原用户选择。 | current / stale | 是 | 用户操作／模型候选／程序影响 | Candidate | 程序派生 | 输入失效时标记待复核；重算后更新 | 创建为 current；依赖变化改 stale | 追加 ChangeRecord 前后快照 | `"current"` | 引用对象和条件表达的变化 |

## ExternalFact

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | ExternalFact | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"fact-cairo-luxor"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | ExternalFact | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 ExternalFact | 是 | 程序派生／当前操作来源 | ExternalFact | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"ExternalFact"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | ExternalFact | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `2` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | active / superseded / contradicted | 是 | 程序派生／当前操作来源 | ExternalFact | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `active`；不得省略 | 追加 ChangeRecord 前后快照 | `"active"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 可信外部工具回执 | ExternalFact | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | ExternalFact | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"tool","actor_id":"test-provider","reference":"synthetic-result","text":"测试材料，不代表真实用户或现实交通","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | ExternalFact | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | ExternalFact | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `subject_ids` 涉及对象 | 被表达、考虑或描述的实体／对象引用，按对象类型限制目标。 | array | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["cairo","luxor"]` | DestinationEntity/Candidate/Skeleton/TripGoal.id，依对象限定 |
| `query` 查询内容 | 查询日期与命名参数，缺日期为 null。 | object | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"date":"2030-01-12","parameters":[]}` | — |
| `provider` 外部提供者 | 外部提供方标识；真实性由宿主的可信适配器校验。 | string | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"TEST_ONLY_PROVIDER"` | — |
| `query_status` 查询结果 | 结果、部分、空集、超时、错误、证实无服务分别记录。 | result / partial / empty / timeout / error / no_service | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"result"` | — |
| `verification` 核验层级 | 证据层级；本实现最多产生 date_specific，不宣称真实库存或可购买性。 | unverified / estimated / date_specific / purchasable | 是 | 可信外部工具回执 | ExternalFact | 程序派生 | 新查询新 ID；旧事实须显式替代／反证 | 由工具输入和当前时钟派生；缺证据不可提高核验 | 追加 ChangeRecord 前后快照 | `"date_specific"` | — |
| `freshness` 事实新鲜度 | 上次维护时记录的新鲜度；消费时还必须比较 expires_at。 | current / stale | 是 | 可信外部工具回执 | ExternalFact | 程序派生 | 新查询新 ID；旧事实须显式替代／反证 | 由工具输入和当前时钟派生；缺证据不可提高核验 | 追加 ChangeRecord 前后快照 | `"current"` | — |
| `applicability` 事实适用性 | 是否适用于当前明确旅行条件，独立于事实原始观察。 | applicable / unknown / not_applicable | 是 | 可信外部工具回执 | ExternalFact | 程序派生 | 新查询新 ID；旧事实须显式替代／反证 | 由工具输入和当前时钟派生；缺证据不可提高核验 | 追加 ChangeRecord 前后快照 | `"not_applicable"` | — |
| `observed_at` 事实观察 | 事实观察时刻，不得是未来。 | string | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `expires_at` 投影或证据到期 | 事实证据失效时刻；等于当前时刻即已过期。 | string | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-02T00:00:00Z"` | — |
| `valid_for` 适用日期 | 业务适用日期闭区间。 | object | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"start":"2030-01-12","end":"2030-01-12"}` | — |
| `missing_fields` 缺失字段 | 适配器报告与程序实测缺项的并集。 | array | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | — |
| `value` 结构值 | 外部观察结果；transport/cost/condition 互斥，查询失败时可为 null，不得伪造已核验值。 | 联合类型（按分支严格校验） | 是 | 可信外部工具回执 | ExternalFact | 可信外部工具 | 新查询新 ID；旧事实须显式替代／反证 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `{"kind":"transport","from_id":"cairo","to_id":"luxor","departure":"2030-01-12T10:00:00+02:00","arrival":"2030-01-12T11:00:00+02:00","duration_minutes":60,"service_exists":true}` | Constraint 或 ExternalFact 专属结构 |

## Skeleton

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | Skeleton | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"skeleton-a"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | Skeleton | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 Skeleton | 是 | 程序派生／当前操作来源 | Skeleton | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"Skeleton"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | Skeleton | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `5` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | active / superseded / archived | 是 | 程序派生／当前操作来源 | Skeleton | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `active`；不得省略 | 追加 ChangeRecord 前后快照 | `"active"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户连续编辑／模型提出方案 | Skeleton | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | Skeleton | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"测试材料，不代表真实用户或现实交通","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | Skeleton | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[{"object_id":"constraint-budget","version":1,"paths":["/status","/value"],"relation":"input"},{"object_id":"constraint-dates","version":2,"paths":["/status","/value"],"relation":"input"},{"object_id":"constraint-nights","version":1,"paths":["/status","/value"],"relation":"input"},{"object_id":"cost-transport","version":2,"paths":["/status","/value","/freshness","/applicability","/expires_at"],"relation":"input"},{"object_id":"fact-cairo-luxor","version":2,"paths":["/status","/value","/freshness","/applicability","/expires_at"],"relation":"input"}]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | Skeleton | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `purpose` 目的或用途 | 骨架用途：scenario 仅假设，plan 可规划；是否当前采用只看根引用。 | scenario / plan | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"plan"` | — |
| `stops` 停留列表 | 有序停留项，顺序即城市顺序，避免独立 order 副本。 | array | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[{"entity_id":"cairo","nights":2},{"entity_id":"luxor","nights":2}]` | — |
| `connections` 跨城连接 | 逐项对应相邻停留，引用交通事实；不把画线当班次。 | array | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[{"from_id":"cairo","to_id":"luxor","fact_ids":["fact-cairo-luxor"]}]` | — |
| `cost_fact_ids` 费用事实 | 分项费用事实引用；按 item_key 防止重复计费。 | array | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["cost-transport"]` | ExternalFact(cost).id |
| `parent_id` 父版本或实体 | 父实体或父骨架引用；无父项时 null。 | 联合类型（按分支严格校验） | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `null` | DestinationEntity/Skeleton.id，依对象限定 |
| `overrides` 假设覆盖 | 仅假设骨架允许的约束覆盖；不改写原约束。 | array | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | — |
| `tradeoffs` 取舍说明 | 方案获得与放弃的解释。 | object | 是 | 用户连续编辑／模型提出方案 | Skeleton | 用户／模型可编辑未确认版本 | 已确认版本不可原位改；采用须用户授权 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"gains":["文化体验"],"losses":["转场时间"]}` | — |
| `assessment` 检查结果 | 程序派生：停留、交通、分组费用、未知、冲突及检查时间；客户端不可赋值。 | object | 是 | 用户连续编辑／模型提出方案 | Skeleton | 程序派生 | 输入失效时标记待复核；重算后更新 | 创建为 unchecked；未知计算量显式 null | 追加 ChangeRecord 前后快照 | `{"status":"pending","total_nights":4,"connection_minutes":[null],"cost_groups":[],"cost_coverage":"none","unknowns":["connection:0:missing_or_conflicting_evidence","cost:cost-transport","partial_budget:constraint-budget"],"violations":[],"checked_at":"2030-01-01T00:00:00Z"}` | Skeleton.stops/connections、Constraint、ExternalFact |

## Decision

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | Decision | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"decision-proposal-0000000000000000000000000000000f"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | Decision | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 Decision | 是 | 程序派生／当前操作来源 | Decision | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"Decision"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | Decision | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `2` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | proposed / pending_confirmation / confirmed / revised / revoked | 是 | 程序派生／当前操作来源 | Decision | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `proposed`；不得省略 | 追加 ChangeRecord 前后快照 | `"confirmed"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户确认或拒绝 | Decision | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | Decision | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"用户明确采用；预算缺项仍然存在","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | Decision | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | Decision | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `subject_id` 决定目标 | 用户决定针对的候选或骨架。 | string | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"skeleton-a"` | Candidate/Skeleton.id |
| `subject_version` 目标版本 | 用户确认时的目标版本。 | integer | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `3` | — |
| `decision_kind` 决定类型 | 采用骨架或候选选择。 | adopt_skeleton / candidate_choice | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"adopt_skeleton"` | — |
| `value` 结构值 | 用户对指定候选或骨架版本的接受、拒绝或保留；不代表外部事实成立。 | accept / reject / retain | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"accept"` | Constraint 或 ExternalFact 专属结构 |
| `confirmation_scope` 确认范围 | 用户确认的精确范围；骨架采用要求城市、顺序、停留、连接四项。 | array | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["cities","order","stays","connections"]` | Decision.subject_id 及被展示差异 |
| `basis_ids` 决定依据 | 选择依赖的条件与证据对象。 | array | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["constraint-budget","constraint-dates","constraint-nights","cost-transport","fact-cairo-luxor"]` | Constraint/ExternalFact 等对象 ID |
| `acknowledged_unknowns` 已承认未知 | 用户确认时已经展示且承认的未知项，不改变事实。 | array | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["partial_budget:constraint-budget"]` | — |
| `confirmed_by` 确认用户 | 经宿主鉴权后的用户标识。 | 联合类型（按分支严格校验） | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `"user-demo"` | — |
| `confirmed_at` 确认时间 | 确认时刻；与确认主体同时存在。 | 联合类型（按分支严格校验） | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `supersedes` 被替代决定 | 同范围旧决定引用，无旧决定则 null。 | 联合类型（按分支严格校验） | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `null` | 先前 Decision.id |
| `review_state` 待复核状态 | 当前依据是否待复核；stale 不撤销原用户选择。 | current / stale | 是 | 用户确认或拒绝 | Decision | 经鉴权用户＋程序原子确认 | 专用决定／撤销命令；不直接写字段 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"stale"` | 引用对象和条件表达的变化 |

## OpenIssue

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | OpenIssue | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"issue-cost"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | OpenIssue | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"trip-egypt-test"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 OpenIssue | 是 | 程序派生／当前操作来源 | OpenIssue | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"OpenIssue"` | — |
| `version` 对象版本 | 对象单调版本；成功改变该对象时加一。 | integer | 是 | 程序派生／当前操作来源 | OpenIssue | 程序派生 | 此对象成功改变时递增，不接受客户端指定 | 创建为 1；不得用 null 或 0 表未知 | 追加 ChangeRecord 前后快照 | `1` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | open / actionable / waiting / resolved / dismissed | 是 | 程序派生／当前操作来源 | OpenIssue | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `open`；不得省略 | 追加 ChangeRecord 前后快照 | `"open"` | — |
| `scope` 适用范围 | 适用范围：全程、实体、骨架、日期或参与人；不能从一次局部表达自动扩大。 | 联合类型（按分支严格校验） | 是 | 用户／模型／程序发现缺口 | OpenIssue | 创建主体提出，程序校验 | 当前命令不开放原位修改；扩大表达范围需新对象和证据 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"kind":"trip","ids":[]}` | — |
| `source` 写入来源 | 最近一次明确业务写入的原始输入或工具来源；旧来源保存在历史快照。 | object | 是 | 程序派生／当前操作来源 | OpenIssue | 程序根据经鉴权的本次操作生成 | 业务字段或状态变化时更新最新来源，旧来源留在 ChangeRecord | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `{"actor":"user","actor_id":"user-demo","reference":"synthetic-input","text":"测试材料，不代表真实用户或现实交通","at":"2030-01-01T00:00:00Z"}` | — |
| `dependencies` 对象依赖 | 引用对象版本、字段路径和关系类型；input 为计算依赖，evidence 为依据，association 仅关联。 | array | 是 | 程序派生／当前操作来源 | OpenIssue | 创建主体提出，程序校验；计算依赖由程序补齐 | 计算成功时程序登记所读字段和版本，客户端不可任意改写旧对象依赖 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 对象 ID、版本、字段路径 |
| `updated_at` 更新时间 | UTC ISO 8601 更新时间；由维护程序设置。 | string | 是 | 程序派生／当前操作来源 | OpenIssue | 程序派生 | 此对象成功改变时按宿主时钟写入 | 程序时间；不得省略或猜测 | 追加 ChangeRecord 前后快照 | `"2030-01-01T00:00:00Z"` | — |
| `issue_kind` 问题类型 | 缺失、冲突、核验、依赖变化或不支持。 | missing / conflict / verification / dependency / unsupported | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"missing"` | — |
| `question` 问题描述 | 仍需解决的具体问题。 | string | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"住宿餐饮尚未取得费用依据"` | — |
| `affected_ids` 受影响对象 | 受影响或被阻塞对象。 | array | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["skeleton-a"]` | 同旅行对象 ID |
| `severity` 严重级别 | 问题影响程度，不是自动行动授权。 | info / warning / blocking | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"warning"` | — |
| `required_inputs` 待补输入 | 缺少的输入名称。 | array | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["lodging_cost","food_cost"]` | — |
| `candidate_actions` 候选动作 | 交给下一步策略的候选动作，不在此实现排序。 | array | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `["verify"]` | — |
| `owner` 责任主体 | 用户、系统或提供方责任。 | user / system / provider | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `"provider"` | — |
| `resolution` 解决理由 | 解决／暂忽略理由；开放状态为 null。 | 联合类型（按分支严格校验） | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 追加 ChangeRecord 前后快照 | `null` | — |
| `evidence_ids` 问题证据 | 解决问题的有效关联证据。 | array | 是 | 用户／模型／程序发现缺口 | OpenIssue | 用户／模型／系统，按问题事件守卫 | 解决需关联有效证据；忽略不等于解决 | 无默认值；不得用空值猜测 | 追加 ChangeRecord 前后快照 | `[]` | 受影响对象的关联证据 |

## DecisionContext

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | DecisionContext | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `"context-00000000000000000000000000000012"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 DecisionContext | 是 | 程序派生／当前操作来源 | DecisionContext | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `"DecisionContext"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | DecisionContext | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `"trip-egypt-test"` | — |
| `task_id` 任务标识 | 消费投影的任务标识；不创建第二份旅行状态。 | string | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `"task-compare"` | — |
| `status` 生命周期 | 本对象专属生命周期；见状态转换表，不表示事实可信程度。 | assembled / active / stale / released | 是 | 程序派生／当前操作来源 | DecisionContext | 按正式转换表的 User/AI/System/Tool 守卫 | 仅通过业务事件转换，保留原因 | 创建初态 `assembled`；不得省略 | 按需重建，不独立保留真值 | `"active"` | — |
| `state_revision` 旅行版本 | 投影组装时权威旅行版本；不一致即拒绝使用。 | integer | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `4` | — |
| `assembled_at` 组装时间 | 投影组装时刻，UTC。 | string | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `"2030-01-01T00:00:00Z"` | — |
| `expires_at` 投影或证据到期 | 事实证据失效时刻；等于当前时刻即已过期。 | string | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `"2030-01-01T00:05:00Z"` | — |
| `selected_object_ids` 选中对象 | 种子对象及依赖闭包，只保存引用。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `["cairo","constraint-budget","constraint-dates","constraint-nights","cost-transport","decision-proposal-0000000000000000000000000000000f","fact-cairo-luxor","issue-cost","issue-dependency-skeleton-a","luxor","skeleton-a"]` | — |
| `must_include_constraints` 必含约束 | 所有活动硬约束的完整 ID 集合，不得按模型相关性删减。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `["constraint-dates","constraint-nights"]` | 活动 hard Constraint.id |
| `active_decisions` 当前决定 | 所有当前 confirmed 决定引用。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `["decision-proposal-0000000000000000000000000000000f"]` | confirmed Decision.id |
| `open_issues` 未解决问题 | 尚未证明已解决的问题，包括 dismissed。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `["issue-cost","issue-dependency-skeleton-a"]` | — |
| `relevant_facts` 相关事实 | 引用闭包内全部事实。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `["cost-transport","fact-cairo-luxor"]` | ExternalFact.id |
| `assembled_from_versions` 引用版本 | 每个选中对象的 ID 与组装时版本。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `[{"id":"cairo","version":1},{"id":"constraint-budget","version":1},{"id":"constraint-dates","version":1},{"id":"constraint-nights","version":1},{"id":"cost-transport","version":1},{"id":"decision-proposal-0000000000000000000000000000000f","version":1},{"id":"fact-cairo-luxor","version":1},{"id":"issue-cost","version":1},{"id":"issue-dependency-skeleton-a","version":1},{"id":"luxor","version":1},{"id":"skeleton-a","version":3}]` | 选中对象 id/version |
| `stale_fact_ids` 不可用事实 | 消费时不可用事实集合，含过期、失败和不适用；不是仅 freshness=stale。 | array | 是 | 程序读取投影 | DecisionContext | 程序只读组装 | 过期或旅行版本变化后整体重建 | 无默认值；不得用空值猜测 | 按需重建，不独立保留真值 | `[]` | — |

## OperationIntent

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | OperationIntent | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"intent-00000000000000000000000000000002"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 OperationIntent | 是 | 程序派生／当前操作来源 | OperationIntent | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"OperationIntent"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | OperationIntent | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"trip-egypt-test"` | — |
| `actor_id` 操作主体 | 宿主鉴权后注入的操作主体，不接受请求伪造。 | string | 是 | 经鉴权的原始操作 | OperationIntent | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"model-demo"` | — |
| `actor_role` 操作角色 | 主体角色，不由自然语言内容决定。 | user / model / system / tool | 是 | 经鉴权的原始操作 | OperationIntent | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"model"` | — |
| `input` 原始操作 | 入口、原始表达、来源引用与目标对象；目标按发生时状态解析。 | object | 是 | 经鉴权的原始操作 | OperationIntent | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `{"kind":"dialogue","reference":"synthetic-input","text":"探索中新增推断兴趣；不确认城市","target_ids":[]}` | — |
| `base_revision` 基准版本 | 请求或确认处理所依据的旅行版本。 | integer | 是 | 经鉴权的原始操作 | OperationIntent | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `0` | — |
| `created_at` 记录时间 | 追加记录时刻，UTC。 | string | 是 | 经鉴权的原始操作 | OperationIntent | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"2030-01-01T00:00:00Z"` | — |

## ChangeRecord

| Field / 中文名 | 定义与数据语义 | 类型 | Required | 来源 | Owner | Write Authority | 更新规则 | 默认／Null | 历史 | 示例 | 关联／派生 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `id` 对象标识 | 稳定标识，旅行内唯一；类型与身份不可原位更改。 | string | 是 | 程序派生／当前操作来源 | ChangeRecord | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"change-00000000000000000000000000000003"` | — |
| `type` 类型标记 | 业务对象判别常量。 | 常量 ChangeRecord | 是 | 程序派生／当前操作来源 | ChangeRecord | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"ChangeRecord"` | — |
| `trip_id` 旅行标识 | 所属旅行；禁止跨旅行引用。 | string | 是 | 程序派生／当前操作来源 | ChangeRecord | 创建请求指定／程序校验 | 创建后身份和所属旅行不可原位改 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"trip-egypt-test"` | — |
| `proposal_id` 提案标识 | 提案关联标识；待确认和处理结果通过此值关联。 | string | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"proposal-00000000000000000000000000000001"` | 变更提案 |
| `intent_id` 意图记录 | 同旅行 OperationIntent 引用。 | string | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"intent-00000000000000000000000000000002"` | OperationIntent.id |
| `outcome` 处理结果 | applied 已应用；pending_confirmation 拟议；rejected 为用户拒绝提案。 | applied / pending_confirmation / rejected | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"applied"` | — |
| `actions` 操作列表 | 本批次有序业务操作名称，具体字段变化见 diff。 | array | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `["create"]` | — |
| `reason` 操作原因 | 变化或拒绝理由，不得为空。 | string | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"探索中新增推断兴趣；不确认城市"` | — |
| `base_revision` 基准版本 | 请求或确认处理所依据的旅行版本。 | integer | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `0` | — |
| `result_revision` 结果版本 | 处理后的旅行版本；无业务变化时可以等于 base_revision。 | integer | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `1` | — |
| `created_at` 记录时间 | 追加记录时刻，UTC。 | string | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"2030-01-01T00:00:00Z"` | — |
| `confirmation_actor` 确认主体 | 明确授权或执行确认／拒绝的用户 ID；尚未确认时为 null。 | 联合类型（按分支严格校验） | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 本身为追加记录 | `null` | — |
| `request_digest` 请求摘要 | 绑定请求、展示差异和拟议采用引用的 SHA-256 摘要；不是权限凭证。 | string | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `"69dd4f4cb83ffab96a59e7325a65de2325eb790a3e9b50c483522f51cecbdc72"` | — |
| `affected_ids` 受影响对象 | 受影响或被阻塞对象。 | array | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `["pref-explore"]` | 同旅行对象 ID |
| `effective_before` 提交前采用 | 提交前根采用引用，无则 null。 | 联合类型（按分支严格校验） | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 本身为追加记录 | `null` | root.effective_skeleton_id |
| `effective_after` 提交后采用 | 提交后根采用引用，无则 null。 | 联合类型（按分支严格校验） | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 允许 null；必须按业务分支区分未知／未发生／不适用 | 本身为追加记录 | `null` | root.effective_skeleton_id |
| `diff` 对象差异 | 对象 before/after 快照；新增 before=null；pending 的 after 只是拟议结果。 | array | 是 | 程序追加审计 | ChangeRecord | 程序原子追加 | 不可原位修改；纠错新增记录 | 无默认值；不得用空值猜测 | 本身为追加记录 | `[{"id":"pref-explore","before":null,"after":{"id":"pref-explore","type":"Preference","trip_id":"trip-egypt-test","version":1,"status":"active","scope":{"kind":"trip","ids":[]},"dependencies":[],"source":{"actor":"model","actor_id":"model-demo","reference":"synthetic-input","text":"探索中新增推断兴趣；不确认城市","at":"2030-01-01T00:00:00Z"},"updated_at":"2030-01-01T00:00:00Z","subject_ids":["luxor"],"aspect":"文化体验","polarity":"positive","certainty":"inferred","support":"supported","priority":"important","expression":"我喜欢文化体验；不代表必须去某座城","condition":{"op":"always"},"evidence_refs":["synthetic-dialogue-1"]}}]` | — |
