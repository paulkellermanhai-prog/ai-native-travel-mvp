# Object Relationship Spec｜对象关系最终版

本规格的 owning side 指保存引用及维护它的对象，不指数据库外键。所有引用须同旅行解析；0..N 可为空。`Evidence` 是来源定位符或 ExternalFact，并非第 11 个业务对象。软删除不是当前命令；状态退役／替代仍保留对象、来源和历史。涉及已确认选择的关系变更须重新检查权限与旅行版本。

| Source → Target | 关系语义与基数 | Owning side；Required | 生命周期依赖、删除／归档 | 历史与传播 |
|---|---|---|---|---|
| TripGoal → DestinationEntity | `destination_ids`：一个目标对应 0..N 个实体；实体可被 N 个目标引用 | TripGoal；可空 | 目标关闭不删目录；实体退役不抹用户原意 | 目标／目录变化保留前后值，相关骨架复核 |
| TripGoal → traveler 外部 ID | `traveler_ids`：0..N 个已知同行人标识 | TripGoal；可空 | 无独立 Traveler 对象；未登记不是零人 | 人数相关约束及骨架判断复核 |
| DestinationEntity → DestinationEntity | `parent_id`：每个实体 0..1 父节点；父节点 0..N 子节点 | 子实体；可空 | 父链不得成环；retired 不级联删除子节点或候选 | 目录修正保留 ChangeRecord；影响身份判断时复核引用 |
| Candidate → DestinationEntity | `subject_ids`：city/experience 恰一同类实体；connection 两个有序端点；combination 1..N | Candidate；必有 | 候选排除／退回不删实体 | 候选差异保留；受相关事实与偏好影响时 review_state=stale |
| Candidate → Preference | `preference_ids`：0..N 对 0..N；候选采用偏好作评估依据，不拥有偏好真值 | Candidate 保存引用；可空 | 候选退出不终止 Preference；偏好撤回不删除候选 | 来源和旧引用保留；偏好变化标记候选待复核，不自动改用户决定 |
| Candidate → OpenIssue | `issue_ids`：0..N 个问题，可关联 N 个候选 | Candidate 保存正向关联；可空 | 问题 resolved/dismissed 不删候选；dismissed 仍可能限制行动 | 问题变动须重新组装上下文，不能伪造问题已解决 |
| Preference → DestinationEntity / Candidate / Skeleton / TripGoal | `subject_ids`：一个偏好 0..N 个主体，主体可被 N 个偏好描述 | Preference；可空，业务范围由 scope+condition 共同限定 | 不能因某 Candidate 结束而清除；scope 扩张须新证据 | 旧表达、原始证据和修正来源保留；相关候选／骨架复核 |
| Preference → 表达证据 | `evidence_refs`：1..N 个输入／行为／资料定位符；可关联实际展示与互动，但定位符本身不证明曝光、稳定兴趣或已核验 | Preference；必有 | 对象 superseded/withdrawn 也不删证据；完整曝光流水由可信交互记录保存 | 已提交旧证据留在对象和 ChangeRecord；支持等级变化可追溯，未展示／无反馈不生成排斥证据 |
| Preference → ExternalFact / Constraint | `condition` 或 dependencies：0..N 个受限字段引用 | Preference 保存条件；可空 | 事实过期使条件 unknown，不自动把偏好改成相反意见 | 条件引用变化传播到 Candidate；推断证据不升级用户硬约束 |
| Preference(后继) → Preference(原表达) | `dependencies(relation=association, paths 包含 /status)`：后继可指 0..N 旧表达；被 superseded 的旧表达须有至少 1 个后继 | 后继 Preference；普通 active 偏好可无此边 | 替代谱系无环；原表达与证据不删除；单纯撤回用 withdrawn | 由后继反查 `superseded_by` 只读结果；关联边不触发普通计算传播，相关 Candidate 仍按偏好状态变化复核 |
| Constraint → TripGoal | 人数、日期等约束适用于目标；不复制 TripGoal 字段值 | Constraint 保存独立条件；0..N | 目标变化可使约束需复核；Constraint 仍是日期／预算唯一权威 | 目标与约束分别留变更记录；骨架计算使用当前 active 约束 |
| Constraint → DestinationEntity / Skeleton / traveler | `scope.ids`：按类型 0..N；trip/date 无 ID | Constraint；局部范围须非空 | 目标版本归档不删除原约束；必要时建立新适用范围 | 适用性变化传播；局部计算不支持时返回未知 |
| Constraint → ExternalFact | `dependencies(relation=evidence)`：0..N；固定约束的外部依据 | Constraint；固定现实条件失效须可追溯证据 | 事实过期不自动取消约束；被反证／替代才可系统失效 | 新旧值、依据和受影响骨架留 ChangeRecord |
| Skeleton → DestinationEntity | `stops[]`：1..N 个有序城市，允许重复城市停留；顺序由数组唯一表达 | Skeleton；必有 | 骨架 superseded/archived 不删城市；目录退役不抹历史版本 | 编辑暂定骨架标记 assessment=stale；有效骨架须新建版本 |
| Skeleton → ExternalFact(transport) | `connections[].fact_ids`：每相邻停留对应一连接；每连接 0..N 个事实 | Skeleton；连接 N−1 必有，证据可空 | 事实失效仅使相关检查待核验，不能删除连接或用户决定 | 传播到 assessment，再到依赖的 Decision.review_state |
| Skeleton → ExternalFact(cost) | `cost_fact_ids`：0..N 个分项费用事实 | Skeleton；可空 | 事实过期保留引用但不得继续用于当前合计 | 按币种、人数、类别汇总已知分项；未知保留 |
| Skeleton → Constraint | `dependencies(input)` 与 `overrides`：0..N；override 仅 scenario | Skeleton；适用 active 约束隐式必检查 | 新硬约束也进入检查；不得靠旧依赖列表漏掉；scenario 不改原约束 | 日期、预算、人数变化局部失效；先 stale 再计算 |
| Skeleton → Skeleton | `parent_id`：一个新版本 0..1 父；旧版本 0..N 后继 | 新 Skeleton；可空 | 不得成环；旧 adopted 版本不可原位改，采用新版本时旧版 superseded | 旧内容与确认历史保留；新版本按当前事实重新检查 |
| Decision → Candidate / Skeleton | `subject_id`：每个决定恰一个目标；同候选至多一个 confirmed 选择；全旅行至多一个 confirmed 骨架采用 | Decision；必有；根 effective_skeleton_id 是当前采用唯一权威 | 目标归档／事实变化不自动撤销确认；版本不再可用时 review_state=stale | 采用关系与确认记录原子提交；撤销／替代留新记录 |
| Decision → Constraint / ExternalFact / Preference | `basis_ids` 及 subject 的 dependencies：0..N 个解释依据 | Decision；可空但骨架采用程序填入计算依据 | 依据失效不改用户价值判断；禁止因此提升事实核验 | 决定待复核并生成问题；冲突或新选择需用户重新判断 |
| Decision → Decision | `supersedes`：0..1 旧决定；一个旧决定可有多个历史候选但当前只能一条有效链 | 新 Decision；可空 | 不能跨决定种类或不同候选替代；禁止成环 | 新确认后旧 confirmed→revised；旧确认范围保留 |
| OpenIssue → 任意业务对象 | `affected_ids`：0..N 个受影响对象；一个对象可有 N 个问题 | OpenIssue；可空 | dismiss 不解决事实；对象归档仍保留问题及理由 | 相关输入变化时重开／复核；阻塞级问题不能被忽略后宣称可行 |
| OpenIssue → 解决证据 | `evidence_ids`：0..N 个有关的事实、约束、决定或骨架引用 | OpenIssue；解决时必须非空 | 证据过期后可重开问题，原解决依据仍可审计 | 解决守卫检查关联性与当前有效性 |
| ExternalFact(预订回执 profile) → DestinationEntity | `subject_ids` 和严格参数 `city_id`：一个住宿确认锚定一个城市，可有 N 条历史回执 | ExternalFact；profile 下必有 | 候选退出不能删除回执；旧确认只有可信取消／替代回执才能释放承诺 | 旅行日期相交且不含该城骨架为 blocked；旅行日期移开则保留回执与未知；过期不等于取消；不实现订单操作 |
| DecisionContext → 业务对象 | `selected_object_ids` + `assembled_from_versions`：每份任务投影引用 0..N 对象版本 | DecisionContext；必有 | 投影到期丢弃重建，不拥有业务值 | 必含所有活动硬约束与当前确认决定；消费前验证 revision 和时效 |
| ChangeRecord → OperationIntent | `intent_id`：每条变更恰一操作意图；一个意图通常一笔提案及其处理记录 | ChangeRecord；必有 | 历史只追加，不因业务对象归档删除 | 原因、动作、确认、前后快照及旅行版本可联合解释状态 |
| OperationIntent → 业务对象 | `input.target_ids`：0..N 个发生时目标；仅对已提交或待确认的业务操作建记录 | OperationIntent；可空 | 操作意图不自动成为确认事实或有效骨架；未提交的澄清／预算原话不保证出现在 TS 历史 | 基准 revision 与原话保留；未提交任务证据由 DC/宿主授权保留，失败传输需宿主安全日志 |
| ChangeRecord → 业务对象 | `affected_ids`、`diff`：0..N 个实际或拟议变化 | ChangeRecord；可空；applied 与 pending 语义不同 | 业务对象无删除命令；变更记录不可改写 | before/after、reason、actor 与 request_digest 解释为何变成现在这样 |

`Candidate ↔ Evidence` 没有第二个独立证据权威：Candidate 通过 Preference.evidence_refs、相关 ExternalFact 与 OperationIntent/ChangeRecord 追溯。`Booking` 在 V0.1 中是受限 ExternalFact 回执 profile；其存在不是用户的价值选择，也不表示程序具有预订、支付、改退权限。关系语义在跨对象传播表中落到具体事件与守卫。
