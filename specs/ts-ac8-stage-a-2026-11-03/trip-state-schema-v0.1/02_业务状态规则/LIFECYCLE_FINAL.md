# Lifecycle Final Review｜创建、前进、退出与历史

创建时完整 JSON 必须满足同名 Schema；下表“最小业务内容”不允许省略 Schema 中的显式 null、空列表、source、scope、version 和时间字段。参考 API 创建时由程序填写 id 以外的公共元数据及派生值。各边精确 actor、前置条件、结果和审计要求见 [状态转换矩阵](STATE_TRANSITIONS_FINAL.md)。所有持久对象的状态变化留在 ChangeRecord；旧对象不物理删除。

| Object | 创建者与最小业务内容 | 正式生命周期 | 属性变化不应塞入 status | 回退、终态、重新激活 | 原因与证据 |
|---|---|---|---|---|---|
| TripGoal | 用户明确输入；purpose、success_definition、destination_ids、traveler_ids、current_task | draft → active ↔ revised → closed；draft 亦可 closed | 目的地范围、任务、人数是字段 | revised 可 activate；closed 终态，新目标新对象 | 原话 source、修正 reason、前后快照；最多一个 active/revised |
| Preference | 用户明确表达或模型 inferred；aspect、polarity、certainty、support、priority、expression、condition、evidence_refs | active → superseded / withdrawn | 明确度、支持度、优先级、方向和 scope 均不是生命周期 | 两终态不原位复活；superseded 须有同旅行、无环、可反查的后继 Preference；无后继撤回用 withdrawn | 证据至少一项；旧表达与新来源留历史，扩大范围须新证据 |
| Constraint | 用户明确条件；hardness、override_policy、typed value | proposed → active → relaxed / invalidated；proposed 可 invalidated | soft/hard、预算模式、金额、适用范围为字段 | relaxed/invalidated 终态；不能凭过期证据释放 fixed | 用户明确修正或被反证事实、原因、版本、受影响方案 |
| DestinationEntity | 系统目录适配器；entity_kind、name、parent_id、geo_identity、knowledge_refs、coverage | known ↔ retired | 知识覆盖与日期可用性分离；日期事实不进实体 status | retired 可 restore；不删除候选及历史引用 | 目录证据、原新身份和变动原因；父链不得成环 |
| Candidate | 用户／模型／系统加入探索；candidate_kind、subject_ids、reconsider_when、理由与关联引用 | exploring → retained / conditionally_excluded / excluded；退出态 → reintroduced → retained／再退出 | 用户接受在 Decision，证据支持在 Preference/ExternalFact；review_state 另列 | excluded 只有真条件重入；不能绕过；任何阶段不能粗暴删除证据 | 纳入／排除理由，触发对象，原值、关联偏好仍保留 |
| ExternalFact | 可信工具；subject_ids、query、provider、observed_at、expires_at、valid_for、query_status、missing_fields、value | active → superseded / contradicted | 查询结果、verification、freshness、applicability 四轴独立；预订回执是受限 value profile | 被替代／反证后不可原位恢复，重新查询用新 ID | 供应商／回执、查询参数、时效和前后事实；不得靠用户确认提升核验 |
| Skeleton | 用户／模型可建暂定版本；purpose、stops、connections、cost_fact_ids、tradeoffs、parent_id、overrides | active → superseded / archived；superseded 可 archived | scenario/plan 用途、是否当前采用、assessment.status 均不等于生命周期 | 已确认内容不可原位改；新版本 parent_id 指旧版；归档终态 | 取舍、输入事实、未知、确认范围、父版本与差异；旧版本保留 |
| Decision | 专用用户确认命令；subject、value、confirmation_scope、basis、confirmed_by/at、acknowledged_unknowns | 契约允许 proposed→pending_confirmation→confirmed→revised/revoked；本地正常路径直接生成 confirmed | review_state、事实核验和候选 lifecycle 另管 | revised/revoked 不恢复；新选择新 Decision、supersedes 串联 | 用户主体、精确范围、基准版本、承认的未知与旧决定 |
| OpenIssue | 用户／模型／系统发现缺口；issue_kind、question、affected_ids、severity、required_inputs、candidate_actions、owner | open→actionable/waiting→resolved/dismissed；可 reopen | severity 与 owner 为属性；dismiss 不代表已解决 | resolved/dismissed 可因新证据／输入变化重开 | 解决须有效且相关的 evidence_ids；忽略须理由，原问题保留 |
| DecisionContext | 系统按 task_id 与当前 state_revision 组装；selected IDs、全部约束、决定、未知和版本 | assembled→active→stale→released 为投影契约；本地直接生成 active 并即时检查过期 | 投影自身没有业务写入或第二份状态 | stale/released 丢弃重建，不原位修补 | 组装对象版本及到期时刻；不写持久业务历史 |

ChangeRecord 与 OperationIntent 是两类追加系统记录，没有业务对象 lifecycle。OperationIntent 保存入口、原话、主体和发生时版本；ChangeRecord 保存拟议或已应用差异、动作、原因、确认、前后旅行版本。二者必须与提交语义相符：`pending_confirmation` 的 after 是拟议值，`applied` 才是当前状态；用户拒绝提案追加 rejected 结果。中间态对象不是必要的独立真相。

## 可达性与不可逆检查

从每类对象创建态出发，用户、模型、系统、工具的角色分派可由状态表逐边验证。特意无出口的态：TripGoal.closed；Preference.superseded/withdrawn；Constraint.relaxed/invalidated；ExternalFact.superseded/contradicted；Skeleton.archived；Decision.revised/revoked。DestinationEntity.retired、Candidate 退出态、OpenIssue resolved/dismissed 有带守卫的回路。Decision.proposed/pending_confirmation 和 DecisionContext.assembled/stale/released 不由本地正常 API 持久产生，属于声明契约兼容态；运行时相应含义由提案记录和只读时效检查实现，不应被测试报告说成全部分支已执行。

通用 `transition` 不接受确认、撤销、重入、解决问题以及骨架／决定的独立 supersede；它们分别由专用业务命令执行。这样 Agent 不能通过直接提交 status、在已确认对象上任意 revise，或只更新根引用绕过用户确认。场景回归覆盖价值选择、预订事实、硬约束变化和依赖传播；所有边的主体分派有独立测试，尚不等于所有多命令组合穷举。
