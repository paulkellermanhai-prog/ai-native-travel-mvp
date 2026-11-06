# History & Auditability｜当前状态的解释契约

V0.1 使用当前聚合快照加追加式 `OperationIntent` / `ChangeRecord`，不要求由事件流重建全部状态。两类记录属于系统记录，不是新增业务对象。只在业务提交成功、提案待确认或用户拒绝提案时形成业务历史；形状、权限或守卫失败的请求只返回错误，宿主需另行保存安全／传输日志，不能伪装成已提交变更。

同一句输入可由上游解释为支持、纠错、真实变化、条件细化，或暂无法区分；这些标签不能由 TS 历史自动推导。TS 只为实际提交的合法业务操作保存原话与差异。仅用于澄清、尚未形成完整预算口径或被用户跳过的话语，应由获授权的 DC/宿主任务证据按其恢复契约保留；没有保存回执时不能声称跨会话可恢复，也不能把恢复的旧原话伪装成本轮新授权。

| 要回答的问题 | 权威位置与解释规则 | 不得误读为 |
|---|---|---|
| 对象何时创建 | 首条 `outcome=applied` 且 `diff.before=null, diff.after.id=该 ID` 的 `ChangeRecord.created_at`；对象 `source.at` 是来源发生时刻 | 来源时刻不一定等于入库时刻。无完整导入历史的初始快照，创建提交时间为 unknown，不补造 |
| 最近何时改动 | 对象 `updated_at` 与 `version`；同一旅行 `revision` 用于并发 | `revision` 不等于对象版本；旧更新时间不证明外部事实目前有效 |
| 谁提出／谁确认 | `OperationIntent.actor_id/actor_role` 记录发起者；`ChangeRecord.confirmation_actor` 记录明确确认者；对象 `source` 记录最新业务表达／观察依据 | 模型发起的意图不是用户授权；Tool 回执不是用户价值决定 |
| 原因与原话 | `OperationIntent.input` 保存入口、reference、text、target_ids、发生时基准版本；`ChangeRecord.reason/actions` 保存提交原因和业务动作 | `reason` 不能替代原始输入定位符或外部证据 |
| 具体改了什么 | `ChangeRecord.diff[]` 的 before/after 完整对象快照，`affected_ids` 与根 `effective_before/after`；同一事务写入 | `pending_confirmation.diff` 是拟议结果，不是当前状态；只有 `applied` 表示已生效 |
| 置信／明确度为什么变 | Preference 的 `certainty/support/priority` 及 `evidence_refs`；两次快照比较可还原变化 | 没有数字 confidence；不能把弱推断的支持度误写成用户确认 |
| 状态为何迁移 | 前后 `status`、`actions`、`reason`、输入、主体及状态转换矩阵共同解释；失败迁移不留业务变更 | 不能仅凭最新 `status` 推断操作者或前置条件 |
| 哪条记录替代了它 | Decision 由后继 `supersedes` 反查；Skeleton 由后继 `parent_id` 反查；Preference 由后继 `dependencies(relation=association, paths 包含 /status)` 反查；住宿回执按同 `confirmation_ref` 的同笔可信后继及历史追溯 | 终态不能随意原位恢复；Preference 单纯撤回应 `withdrawn`，不能无后继标 `superseded` |
| 用户曾否推翻 AI | 当前对象 `source.actor=user` 加旧推断的 before/after、原 `OperationIntent` 和新用户明确表达；若改动涉及已确认选择，还须相应 Decision 记录 | 用户纠正偏好不等于自动撤销选择或外部预订 |

`created_at` 不机械复制到每个业务对象；当前对象的 `updated_at` 与 `version` 足够支持读时版本检查，完整原因从历史查。`superseded_by` 不建立第二份可竞争的持久指针，而由上述后继关系反查；产品界面可缓存这个只读结果，缓存失效后重算。ExternalFact 的 `observed_at`、`expires_at`、`valid_for` 负责事实观察和时效，不等于提交时间。

确认严格绑定 `proposal_id`、摘要、旅行版本、确认主体和有效期；待确认、接受／拒绝各有可区分的记录。纠错与撤销追加新版本，不抹掉旧输入、旧外部观察、候选退出前证据或 Decision History。恢复旧方案须新建版本并按当前约束、事实和未知重新校验，旧 verified 结论不继承。生产存储必须把当前状态、根采用关系、失效标记、历史与幂等结果放在同一事务；当前实现仅验证进程内语义，未验证数据库崩溃恢复。

### UX-02 恢复编译与只读历史

查看旧版不调用submit或改effective。恢复是新OperationIntent与原子create+adopt；input.target_ids/reason保留源骨架与当前基准，parent_id指向当前有效版。原历史和旧事实快照只读；只复制历史安排内容，不复制旧授权、已核验判断或约束。新提交的原幂等回执应保留用于结果未知的核实，不能因当前版本变了就盲目重建旧请求。实现与验收见[UX02工程映射](../90_可运行工程包/UX02工程落实与DC开发映射.md)。

### PR #13 版本定位与接口合同修订候选

恢复请求必须指定 source_id 与 source_version；从当前旅行授权历史的已应用快照或当前对象解析该精确版本，不可用时拒绝。当前旅行revision仍单独保护并发；查看历史不等于授权。HTTP成功、阻断、版本冲突及鉴权错误的形状见 UX02 工程映射，旧领域Schema不变。
