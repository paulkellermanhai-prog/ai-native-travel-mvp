# Final Consistency Review｜交付前全局对账

本页在 0.1.0 工程规格原有 [终检](../90_可运行工程包/CONSISTENCY_REVIEW.md) 之上复核本轮新增的字段治理、关系、跨对象传播与 A–G 场景。原四份来源的指纹沿用 source-manifest.json；后期已定稿的 SPECIFICATION.md 与当前合同声明源优先于早期 Handoff 的候选枚举和旧“待完成”表述。

| 检查面 | 结果 | 证据／残余边界 |
|---|---|---|
| Object | 9 域、10 业务对象、2 系统记录保持；根容器和回执 profile 没有成为第 11 对象 | contracts.FIELDS、STATES、JSON Schema；只读预订回执复用 ExternalFact；无完整订单对象 |
| Field | 顶层字段的中文名、定义、类型、必填、来源、拥有者、权限、更新、null、历史、样例、关联已同源生成；嵌套类型另列 | FIELD_DICTIONARY_FINAL.md、SHARED_TYPES.md；机器字段字典包含各嵌套路径 |
| Naming | Candidate.retained、Decision.confirmed、根 effective_skeleton_id、ExternalFact 回执 confirmed 各有不同语义；没有同义 selected/chosen/booked 竞争字段 | 枚举词典、AUTHORITY_FINAL.md；UI 标签应派生，不回写业务状态 |
| State | lifecycle 与明确度、证据支持、事实核验、可行性和采用关系分离；终态与有条件回路明确 | LIFECYCLE_FINAL.md、STATE_TRANSITIONS_FINAL.md；兼容态的 runtime 可达性明确标注 |
| Relationship | 引用类型、基数、owner、生命周期与归档、历史和传播均明示；父链与计算边无环 | OBJECT_RELATIONSHIPS_FINAL.md、validate_state 回归 |
| Cross-object | 关键来源事件逐项定义保留、失效、有限重算与确认；Candidate 决定反转可传到同城骨架 | PROPAGATION_FINAL.md、31 步轨迹、依赖测试 |
| AI / Source | User、AI、System、Tool 的读取／推断／提案／直接写边界明确；不同真值按领域判优先级 | AUTHORITY_FINAL.md；模型不能写 hard、确认、事实核验或预订取消 |
| History | 当前状态与追加 OperationIntent/ChangeRecord 可解释来源、前后值、原因、主体、确认与版本；偏好替代须有可反查后继且无环；拒绝提案也有历史 | HISTORY_FINAL.md、C/E/G 轨迹与继任测试；普通非法请求需宿主安全日志 |
| Product | 探索与规划双向联动、跨候选偏好 B、事实与用户价值判断分离、保留关键选择权 | 原 PRD 和 Handoff；A–G 场景结果 |
| Engineering | 本地 API、Schema、样例、测试与文档可重复生成；生产接入点和未测范围已明示 | README、validation-results.json、artifact-manifest.json；真实模型／数据库／HTTP 未测 |

本轮实际发现并修复的断裂：① Candidate 反转未让含同城骨架待复核；② 已确认住宿回执原先可被单独 supersede/contradict 释放，现要求同笔可信后继；③ 回执若字段不完整不能被当作可解除旧承诺的依据；④ Preference 原可被标为 superseded 却没有可反查的后继，现要求后继 association `/status` 且谱系无环。A–G 场景还验证了弱推断不会自动成为用户硬约束、Candidate 退出不删 Preference、已知预算冲突不撤销价值决定、方案采用不核验外部事实。前述修复均有回归测试，A–G 轨迹可独立重跑。

没有发现必须重开产品方向或 9/10/2 架构的 Critical Trade-off。可执行结论受限于固定合成数据和确定性代码；跨供应商事实矛盾、住宿日期精算、用户界面与生产事务仍须后续专门验证，不能以“全局一致性通过”概括为生产可靠。
