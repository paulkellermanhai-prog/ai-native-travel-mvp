# Cross-object Propagation｜跨对象状态传播契约

每一行遵循：输入留存 → 候选变更 → 结构、权限与关系校验 → 计算影响集合 → 标记失效／重算／待确认 → 当前状态和历史原子提交。`stale` 是需要复核，`blocked` 是当前覆盖内已知冲突；二者都不能解释为用户取消选择。普通 association 边不参与传播，input/evidence 与专用隐式引用参与。以下“程序”表示当前确定性参考实现；完整推荐排序、真实预订和供应商接入不在其覆盖内。

| Source Event | 受影响对象 | 必须保留 | 传播及重算 | 确认／新的 Decision Point |
|---|---|---|---|---|
| Candidate 加入探索 | Candidate、所指 DestinationEntity、DecisionContext | 已有其他候选、偏好、约束、历史 | 新候选只表示考虑；关联偏好按 scope/condition 判断，缺阈值为 unknown | 无自动已选；若要确认候选，使用 decide_candidate 用户授权 |
| Candidate 条件性退出／退出 | Candidate、关联评估与当前骨架 | Preference、evidence_refs、Constraint、ExternalFact、已确认决定历史、实体 | 记录原因；相关 review stale；若与有效骨架或已确认候选冲突则拒绝单独变更 | 必须先对当前已确认选择明确撤销或形成替代；旅行日期重叠的预订城市不得直接排除 |
| Candidate 重新加入 | Candidate、关联候选比较 | 原排除理由、历史、偏好和原决定 | 触发对象必须在 reconsider_when 且三值结果 true；进入 reintroduced 后重算 | 不自动成为 retained/accepted；需要新价值选择时再问用户 |
| Preference 新增 | Preference、引用它的 Candidate、相关 Skeleton／Decision | 旧偏好、无关约束和选择 | 用户明确与 AI inferred 分开；作用范围内标记 review stale；需要时重比 | 推断不得直接生成 confirmed Decision 或 hard Constraint |
| Preference 强度／优先级变化 | Preference、关联 Candidate、下游决定 | 用户原话、之前支持依据 | 支持等级和 priority 属属性而非生命周期；相关候选待重评，用户决定只待复核 | 明确偏好由用户改；AI 只能改 inferred 或提案 |
| Preference scope 扩大／缩小 | Preference、适用 Candidate、比较 | 原局部表达和证据 | 采用有证据的新 Preference；替代时新偏好以 association `/status` 引用旧偏好并将旧表达 superseded，单纯撤回用 withdrawn；重新建立候选引用与相关性；不能直接覆盖旧 scope | 扩大用户明确范围需要用户表达或具体确认，单次行为不够 |
| Constraint 新增 | Constraint、所有适用 Skeleton、依赖 Decision、DecisionContext | 原目标、偏好、候选、既有用户选择 | 即使旧骨架没有显式 dependency 也标记 stale；有限重算；硬冲突为 blocked | 若新方案替代用户已选方案，须新确认；不默默撤销旧选择 |
| Constraint 修改或 soft→hard | Constraint、适用 Skeleton、Decision、问题 | 旧值、修正理由和来源 | 预算意向→上限须同笔给明确 ceiling 金额；影响范围重算；个体／局部未覆盖则 unknown | hard 由用户明确指令；模型不能从“重要”自动升级 |
| 用户完成 Candidate Decision | Decision、Candidate；可能影响方案采用检查 | 原候选评价、事实与偏好 | 原 confirmed 同范围决定 revised；候选状态随专用命令同步；根骨架引用不因此变化 | 用户确认价值选择，不提升事实 verification |
| 用户采用 Skeleton | Decision、根 effective_skeleton_id、旧／新 Skeleton、相关事实 | 未知、历史方案、旧决定、查询失败 | 先按当前约束和事实重新 assess；已知 hard 冲突拒绝；未知须承认；原子替代 | 明确确认 cities/order/stays/connections 的具体版本和未知范围 |
| Decision 撤销／修正 | Decision、采用根引用或候选、下游依赖 | 原 Decision、依据、前后状态 | 原决定 revoked/revised，依赖它的判断待复核；撤销采用时根清空但不自动恢复旧版 | 新选择或恢复历史方案需按当前条件重新确认 |
| 外部住宿确认回执进入 | ExternalFact、同城 Candidate、所有 Skeleton、DecisionContext | 用户 Preference、历史候选和回执；不创建订单对象 | 严格 reservation profile；旅行日期相交且不含已确认城市的骨架为 blocked；日期已移开则保留回执和待处理未知；含该城仍有入住日期未知；事实到期不自动解除承诺 | AI 不能取消／擅自改变承诺；取消需要可信新回执并替代旧事实；用户决定新方案需重新确认 |
| 外部事实更新／反证／查询失败 | ExternalFact、引用它的候选／骨架／决定 | 原观察、原查询、用户价值选择 | 失败／空集不是无服务；新 ID 保存，旧事实标替代／反证；显式及隐式依赖传播；时效读时检查 | 重大选择受影响时建立问题，用户判断是否换方案；不得伪造核验 |
| 时间窗口或旅行日期变化 | Constraint、ExternalFact.applicability、Skeleton、Decision | 原始查询、偏好与历史决策 | 旧日期事实不适用；连接、停留、费用和硬日期检查局部重算；无新班次保留 unknown | 若需替换当前骨架，用户确认；程序不能自行复活过期证据 |
| 预算变化 | Constraint.value、费用汇总、Skeleton、Decision | 既有真实分项与表达证据 | 仅同币种、人数、费用类别合计；部分费用不变总价；超硬上限 blocked | 新硬上限用户明确；不悄悄放宽或换汇制造可行性 |
| 行程局部编辑 | OperationIntent、暂定 Skeleton、assessment | 当前有效 Skeleton 与其 Decision 不动 | 多次编辑累计暂定版本；输入变化标记待算；重算仅当前受影响版本 | 想采用新版时展示差异和未知并请求用户确认 |
| 冲突被发现 | OpenIssue、相关 Skeleton/Decision 的判断 | 冲突依据、被影响但无关的对象 | 产生问题、affected_ids、候选动作；已知硬冲突 blocked，无法判断为 unknown | unresolved 问题不能假装 resolved；用户可作价值选择但不能确认外部事实 |
| Candidate 与 committed fact 冲突 | Candidate、ExternalFact、Skeleton、OpenIssue | 候选兴趣和预订回执均保留 | 旅行日期重叠时拒绝单独排除／拒绝已确认住宿城市；不含该城方案 blocked；日期移开后允许重新选择但回执及未知仍保留 | 可信取消／变更回执或新方案重审；AI 无交易权 |
| 用户修正 AI 原推断 | Preference、关联 Candidate、比较、Decision.review_state | 推断原证据、原值和 ChangeRecord | 明确用户新值与来源入库；旧推断由历史/替代关系可查；候选待重评，既有确认只待复核 | 不要求每个低风险重排都再次询问；修改已确认选择仍必须用户决定 |

### 传播终止与失效优先级

同笔提交中，先校验最终引用和权限，再比较旧／新字段路径；不触及的对象不变。若适用硬约束或已确认住宿与新方案冲突，已知冲突优先于未知而显示 blocked。事实过期只使证据不可消费，不等于用户预订取消或价值决定撤销。下游重算失败时保留先前 stale 标记，不能把旧的 verified 结果重新展示成当前可靠结论。正式状态和历史必须原子提交。对 Decision Context 的读取总是包含全部活动硬约束和已确认决定，再检查当前旅行 revision 与时效。
