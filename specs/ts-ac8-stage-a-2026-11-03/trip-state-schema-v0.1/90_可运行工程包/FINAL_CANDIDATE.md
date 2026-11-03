# Trip State Schema V0.1｜正式 State System Final Candidate

状态：**Ready for V1 Review**，详见 [评审清单](V1_READINESS.md)。这是已定稿 V0.1 工程规格的执行级收口，不重新设计产品世界。新读者先看本页，再按职责进入字段、关系、状态、传播和 API 文件。契约版本仍为 `schema_version=0.1.0`；新增住宿回执是既有字段的受限语义 profile，没有新增 JSON 字段、枚举、业务对象或订单操作。

## 1. 信息域、对象与唯一权威

九类信息域依次为：目标与意图、偏好与顾虑、现实约束与预算、实体与体验知识、候选与取舍、外部事实与核验、骨架方案、用户决定、问题与变化影响。它们由十类业务对象承载：`TripGoal`、`Preference`、`Constraint`、`DestinationEntity`、`Candidate`、`ExternalFact`、`Skeleton`、`Decision`、`OpenIssue`、`DecisionContext`。`ChangeRecord` 与 `OperationIntent` 是两类系统记录。根容器不是业务对象，DecisionContext 是带版本的只读任务投影。

目标真值归 TripGoal；偏好表达、范围和证据归 Preference；预算、时间及其他现实约束归 Constraint；目录身份归 DestinationEntity；探索、保留和退出归 Candidate；查询及回执事实归 ExternalFact；方案内容归 Skeleton；价值确认归 Decision；问题与证据归 OpenIssue。当前采用哪版骨架只由根 `effective_skeleton_id` 表达。UI 上的 selected/committed 标签从这些权威来源派生，不可形成另一份真值。详见 [原正式规格](SPECIFICATION.md) §1–3、[对象关系规格](OBJECT_RELATIONSHIPS_FINAL.md)。

## 2. 字段与机器契约

所有顶层字段的中文业务名称、业务定义、技术类型、Required、来源、拥有对象、写入权、更新规则、默认/null、历史、合成示例及关联字段见 [Final Field Dictionary](FIELD_DICTIONARY_FINAL.md)。嵌套结构和单位见 [共享类型](SHARED_TYPES.md)，每个 enum 的业务含义见 [枚举词典](ENUM_GLOSSARY.md)。`schemas/` 为可离线解析的 JSON Schema Draft 2020-12，`rules/field-dictionary.json` 为可机器读取的全部路径。额外字段被拒绝；状态合法性还需通过 `tripstate.rules.validate_state` 的跨对象守卫。

未知、尚未发生、用户未表达、不适用、系统无法判断与明确 false/0 分开。`null` 只出现在契约允许的可空字段；时间、金额、人数与费用口径不能靠猜测补齐。单次浏览或喜欢可作为局部、可逆探索的弱证据。尚未展示或没有反馈的内容仍是未知。推断保留来源、范围和条件，用户价值选择须走明确确认。根的 `revision` 是旅行乐观并发版本，对象的 `version` 是该对象版本，互不替代。

## 3. 生命周期与正式转换

每个对象的创建者、最小业务内容、状态、回退与终态、原因和证据见 [Lifecycle Final Review](LIFECYCLE_FINAL.md)。完整 `Object / From / Trigger / Actor / Preconditions / To / Side Effects / Reversible / Audit Required` 矩阵见 [State Transition Matrix](STATE_TRANSITIONS_FINAL.md)，与 `rules/transitions.json` 同源。Candidate 的退出／重入只是候选判断；Decision.confirmed 才是用户价值决定；Skeleton.purpose 与根采用关系、assessment.status 相互独立。事实的 query_status、verification、freshness、applicability 四轴独立于 ExternalFact 生命周期。

`Decision.proposed/pending_confirmation` 和部分 DecisionContext 状态保留为契约兼容态；本地正常流程使用待确认提案记录和按需只读投影，直接形成 confirmed Decision 或 active Context。此运行时边界已标注，不声称所有声明态都有生产入口。未经授权的直接 status 写入、独立骨架/决定替代、模型自我确认和已确认对象原位改写均被禁止。

## 4. 三类维护机制与跨对象传播

机制一：输入与 OperationIntent 留存 → 业务命令提案 → 结构/关系/权限/版本校验 → 预览影响 → 已应用或待确认 → 原子写入 ChangeRecord。用户明确修改指令就是该范围的授权；模型推断不是授权。提案绑定差异摘要与旅行版本，旧版本和过期确认被拒绝。

机制二：当前状态与追加历史并存。纠错产生前后差异，旧证据与用户原话可追溯；连续编辑只改变暂定骨架，当前采用仍由根引用决定。V0.1 不实现完整事件溯源。

机制三：字段级、条件表达及专用隐式依赖传播。变化只影响相关候选、骨架和决定；先标记 stale/blocked，再有限确定性重算，重算失败保留未知。新增硬约束也参与所有适用骨架检查。完整 `Source Event → Affected Objects → Preserve/Invalidate/Recompute → Confirmation` 表见 [跨对象传播规则](PROPAGATION_FINAL.md)。Candidate 退出不得级联删除跨候选 Preference 和 Evidence；预订回执与候选冲突时不得让 AI 擅自排除已承诺城市。

## 5. Human × AI 与 Source Precedence

字段级 User、AI、System、External Source 读写与确认权见 [Write Authority](AUTHORITY_FINAL.md)。用户对自己想要什么和价值取舍有最终表达权；外部提供方对可核验的服务与回执提供证据；程序负责确定性计算与守卫。领域不同不能用“用户优先”或“最后写入者优先”一条规则粗暴覆盖。用户纠正优于 AI 推断；用户确认不提升外部事实；真实预订确认不能因用户偏好被假装取消。事实冲突时保留双方来源、标记问题并重新核验。正式采用重新检查所依赖的证据，当前争议只阻断依赖它的方案。撤销已确认决定时，执行人的可信身份必须匹配原确认人。

AI 可读取 DecisionContext、形成弱推断、提出候选和暂定方案、解释取舍；不能确认 hard Constraint、用户 Decision、外部核验、当前骨架采用或取消预订。System 可重算 assessment、标记 review_state/freshness，不能替用户做价值决定。DecisionContext 提供任务相关证据和未知项，Next Action Policy 根据当前目标、替代方案、用户负担和时机选择下一步。触发、推迟、后台准备和用户效果在相应消费层验证。Tool 只通过可信适配器写观察或严格住宿回执。住宿 profile 只覆盖城市承诺；具体入住夜数匹配仍明确为未知。

A 域的理解校准、冷启动兴趣及歧义澄清共用这条状态入口：有来源且对象/范围明确的表达才进入现有 Preference、Constraint、Candidate 或 Decision；未确定的解释、未展示的内容和未齐口径预算不因模型推断成为业务真值。C 域的行动资格、相对价值及效果闭环读取 TS 的当前状态、证据、保护集合和失败结果；候选行动、V/C/E、任务负担、介入时机和效果记录由 DC/NAP/宿主承接。TS 包中可运行的是状态守卫与有限计算，八项完整产品行为仍需跨模块验收。逐项承载与工程实施边界见 [八项机制交接](TS八项机制融合与工程同步交接包.md)。

## 6. 历史、API 与不变量

`ChangeRecord` 保存 reason、操作列表、提案摘要、确认主体、旅行版本、受影响对象及前后快照；`OperationIntent` 保存入口、原话、目标和发生时基准版本。Preference 的支持程度或明确度变化可以从 diff 还原；Decision.supersedes、Skeleton.parent_id 与 Preference 后继 association 构成可反查的替代谱系；ExternalFact 重新查询用新 ID 并保留旧观察。对象创建时间、确认、覆盖与推断纠错的解释规则见 [历史与审计契约](HISTORY_FINAL.md)。系统记录与状态同笔原子提交。本地 API 提供读取状态、只读上下文、预览、提交、确认及历史查询，契约和错误见 [正式规格](SPECIFICATION.md) §8；参考实现是内存事务，不是生产数据库或 HTTP 服务。

系统不可破坏的 22 条规则见 [Schema Invariants](INVARIANTS_FINAL.md)。其中最关键的是：Candidate 退出不删跨候选证据；AI inference 不能升为用户 hard/confirmed；外部承诺与用户价值判断分离；预算与事实各有唯一权威；硬冲突阻止新骨架生效；未知不得冒充零或已核验；影响传播不得全量清空；审计必须能回答“为什么现在是这样”。

## 7. 场景与全局检查

[Scenario Validation Report](SCENARIO_VALIDATION.md) 覆盖 A–G 七条完整状态链，机器轨迹位于 `examples/scenario-traces.json`。初始状态、每步请求/响应、受影响字段、状态快照和审计记录可独立重跑。尤其验证陌生目的地探索、跨候选偏好、用户修正推断、硬约束突增、只读外部住宿确认、交通事实变化和用户反转决定。方案中已知硬冲突与真实数据真实性区分清楚，详情见 [全局对账](FINAL_CONSISTENCY_REVIEW.md)。

**No unresolved product-level trade-offs.** [Open Trade-offs](OPEN_TRADEOFFS.md) 只列后续接入与未测边界。评审通过不代表真实 LLM、供应商数据、生产身份/数据库、HTTP、UI、性能或用户效果已验证；最后实际测试数、失败数和依赖版本一律以 [验证报告](VALIDATION_REPORT.md) 为准。
