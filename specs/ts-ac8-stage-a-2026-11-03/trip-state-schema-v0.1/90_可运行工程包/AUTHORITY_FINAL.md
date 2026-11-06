# Write Authority、事实权威与冲突裁决

此表是应用层权限契约；身份先由宿主认证并校验该旅行访问权，再注入 `Actor(role,id)`。请求 JSON 不能自称 User/System/Tool。`Read` 表示可在被授权旅行内读取；`Infer` 表示形成带来源的推断；`Propose` 只形成候选变更；`Direct Write` 也必须通过结构、业务和版本守卫；`Confirm/Reject` 为用户对具体提案的行为。AI 不能通过重复 Propose、模型自报“用户说过”或编辑来源字段获得更高权限。

| 字段组／动作 | User | AI/model | System | External Source/tool | 唯一权威及闸门 |
|---|---|---|---|---|---|
| TripGoal 目标、目的地、同行人、当前任务 | 明确写入／纠错／结束 | 读取、理解、提案；不能将推断当用户明确目标 | 校验引用、传播影响 | 不写 | TripGoal 当前 active/revised 值；用户明确指令；改动留历史 |
| Preference.expression、polarity、priority、condition、scope | 明确表达、修正、撤回 | 可建立／修正 `certainty=inferred` 的低风险探索线索；明确表达的改动只能提案 | 校验三值条件和适用范围，标记受影响候选 | 行为或内容仅作为证据输入，不确认用户偏好 | Preference 为唯一表达真值；scope 扩大须新证据；旧表达留存 |
| Preference.certainty、support、evidence_refs | 用户可澄清真实意图和证据 | Infer；按证据对 inferred 更新 support；不能自己写 explicit | 校验来源和保留历史 | 可提供来源定位符，不升为 explicit | 明确程度与证据支持不同；单次收藏不升级用户确认；展示机会须由可信交互记录核对，未展示/无反馈不作为否定 |
| Constraint.value、hardness、override_policy | 明确写入／放宽用户可改条件 | 读取／提案；不能直接把推断转 hard、改预算上限或固定现实条件 | 确定性校验；fixed 仅凭被反证／替代证据失效 | 外部回执可作为 fixed 依据，不直接写用户预算 | Constraint.value 唯一预算、日期等权威；soft→hard 要明确额度及用户授权 |
| DestinationEntity 身份、父层级、知识覆盖 | 可提供纠错线索，不直接改目录权威 | 读取／提案 | 目录适配器维护、校验父链 | 提供来源知识，由系统适配后写 | 实体身份在 DestinationEntity；日期开放与服务在 ExternalFact |
| Candidate.subject_ids、inclusion/exclusion、reconsider_when、preference_ids | 加入、排除、重入和纠正；确认选择走 Decision | 可提出、建立低风险探索候选；条件性排除必须有明确适用取舍条件 | 状态机、事实冲突、影响传播 | 仅供事实判断，不决定候选价值 | Candidate 只拥有探索判断；不能凭状态冒充 confirmed Decision |
| ExternalFact.query、provider、observed_at、valid_for、value | 可报告线索／上传回执；不直接写已核验事实 | 读取、提出需要核验的问题；不能写结论 | 验证工具结构、推导 verification/freshness/applicability | 可信适配器写观察与回执；不写用户选择 | ExternalFact 拥有外部观察；query 成功不代表证据完整，用户同意不升核验 |
| ExternalFact `reservation-v0.1` profile | 可报告已有预订及决定是否另作安排；不能把取消声明当已核验取消 | 读取、提醒冲突、提出可行替代；无预订／取消／改退权 | 严格参数校验、城市冲突阻断、过期后要求复查 | 可信回执提供住宿确认或取消；历史版本保留 | 外部预订承诺是外部事实，不是 Candidate 态度；日期／具体夜数匹配尚未自动核对 |
| Skeleton.stops、connections、tradeoffs、purpose | 编辑暂定版本；采用需明确范围 | 可提出／编辑未确认版本，解释取舍；不能自行改当前采用 | 按当前约束事实计算并隔离 scenario | 只提供有关事实，不选择路线 | 版本内容在 Skeleton，当前采用仅根 effective_skeleton_id；有效不等于全部已核验 |
| Skeleton.assessment、Candidate/Decision.review_state | 读取、可要求重新核验 | 读取和提出重算；不能直接赋 `verified/current` | 确定性计算、时效与依赖传播 | 提供输入事实，不直接写计算结论 | Derived；必须可从权威输入重算，stale 不删除用户原决定 |
| Decision.value、scope、confirmed_by、confirmed_at | 确认／拒绝具体候选和骨架范围，通过可信 User ID 匹配 confirmed_by 后撤销自己的已确认选择 | 只能提议或解释，不能代用户确认 | 校验版本、确认范围、硬冲突；原子写确认与当前采用 | 不写 | Decision 拥有用户价值判断；不能当外部事实验证、订单授权或硬约束豁免 |
| OpenIssue.question、severity、resolution | 报告、补证、暂忽略；解决需有效证据 | 可报告缺口和候选动作，不能编造解决 | 自动产生依赖问题、核验关联证据 | 可提供解决事实，不能决定用户价值 | OpenIssue 记录仍需处理什么；dismiss 不等于 resolved |
| DecisionContext 与系统记录 | 读取授权范围内结果 | 读取受限投影；不能编辑投影或审计 | 组装只读投影、追加 ChangeRecord/OperationIntent | 不写 | 投影是引用缓存；历史追加且随业务提交原子落地；DC/NAP 的临时解释、行动比较和交付回执不成为 TS 真值 |

语义理解与写桥须先确定输入对应的对象、范围、表达性质及授权边界，再形成 TS 命令。对象或授权尚不明确时，TS 只能保护收到的命令，不能从请求原话自行证明上游解释正确；澄清对象不等于授权重要变更。实际展示和用户反馈证据由交互宿主提供，TS 的 evidence_refs 只是定位符。

## 字段类别与冲突优先级

| 类别 | Source of Truth | 派生／缓存 | 冲突处理 |
|---|---|---|---|
| 用户表达 | TripGoal、Preference（`certainty=explicit`）、用户可改 Constraint | Candidate 比较与 DecisionContext 只引用 | 用户明确纠错优于 AI 推断和历史行为；不得覆写旧证据，需新变更记录 |
| AI 推断 | Preference（`certainty=inferred`）及模型提出的候选 | `support` 与 review_state 仅表达支持和待复核，不是概率保证 | 用户明确表达与推断矛盾时，明确表达用于下一判断；推断保留历史／撤回，不相互平均成“事实” |
| 用户价值决定 | Decision；骨架当前采用关系唯一在根引用 | UI 的 selected/committed/active 标签必须从根和 Decision 派生 | 新旧决定冲突，只有用户授权的替代／撤销可改变；模型不能以优化为由覆盖 |
| 外部观察 | ExternalFact 的受限观察、来源、有效期及核验轴 | Skeleton.assessment、候选判断和上下文只消费其当前适用结论 | 同一事实的提供方相互矛盾时保留两份来源并记录 OpenIssue。未消歧的关键事实不能支撑依赖它的方案采用 |
| 外部已确认住宿 | 严格回执 profile 的活动 ExternalFact | 城市冲突是从回执与 Skeleton.stops 派生 | 用户偏好不能取消回执；到期也不自动解除；可信取消／变更回执才使旧事实 superseded |
| 确定性程序结论 | 约束、事实、骨架与受限计算规则 | assessment、review_state、DecisionContext 为可重算派生或短期投影 | 已知 hard 冲突优先 blocked；未知保留 pending，用户可承认未知但不能宣布事实已核验 |

没有一条跨所有对象的简单优先级。用户对“喜欢什么”有最终权威，但对航班班次和酒店是否确已取消没有核验权；提供方对回执有事实来源权，但不能替用户决定去哪里。模型的推断可改善探索，却不能升级为硬约束或 confirmed 决定。来源冲突时保留各自原始证据、标记涉及对象待复核；若影响当前骨架，则生成问题或阻止新方案生效。

## Null / Unknown / Not Applicable 规范

| 情况 | 正式表达 | Agent 行为 |
|---|---|---|
| 尚未知值 | nullable 数值／时刻为 null，或 OpenIssue(required_inputs)；如 nights=null | 不补零，不声称已满足，必要时澄清或核验 |
| 尚未发生的事件 | 无 Decision/回执对象；未采用时 root.effective_skeleton_id=null | 不把“无记录”解释为用户明确拒绝或外部取消 |
| 用户未表达 | 无 explicit Preference/Constraint；可有 inferred 且附来源 | 继续探索或提案，不提升 certainty |
| 明确不适用 | ExternalFact.applicability=not_applicable；scope 与对象不相交 | 保留原观察，不参与当前日期／对象计算 |
| 系统无法判断 | 三值 condition=unknown、assessment.unknowns、review_state=stale 或 OpenIssue | 不等同 false；产生澄清／查询／重算动作 |
| 明确否定／没有服务 | condition.value=false 或有可追溯 `no_service` 事实 | 按确认的真假与来源处理，不由 empty/timeout 推断 |
| 明确零或空集 | 0 夜、0 费用或空候选集，但必须来自合法已知输入 | 与 null 和查询 empty 分别展示 |

本版没有数值概率型 confidence。证据支持变化由 Preference.support 的 weak/supported、certainty 的明确程度与 ChangeRecord 前后值说明；事实可靠性由 verification、freshness、applicability 三轴说明；下游可用性由 review_state/assessment 表示。Agent 不得把这几者揉成一个自造“置信分数”。
