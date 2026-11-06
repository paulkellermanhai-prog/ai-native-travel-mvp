# Scenario Validation Report｜七条完整旅行状态链路

执行入口：`.venv/bin/python build.py` 生成 [机器轨迹](../90_可运行工程包/examples/scenario-traces.json)，`.venv/bin/python run_validation.py` 独立重跑并逐步比对。全部场景使用合成地点、日期、费用与回执；`response.diff` 是每一步的精确字段前后值，`state_after` 是权威快照，`audit` 为 OperationIntent 与 ChangeRecord。下表说明这些实际执行事件的业务意义，不把结构测试当真实供应商或用户体验验证。

| 场景 | 初始 → 最终 | 已执行步骤 | 最终检查 |
|---|---|---:|---|
| A 陌生目的地 | 空旅行 → 城市候选由用户接受，尚无有效骨架 | 7 | 推断兴趣先是 weak/inferred；用户明确纠正后才 explicit；Candidate 接受与骨架采用分离 |
| B 跨候选偏好 | 埃及探索 → 卢克索退出、偏好保留、条件满足后重入 | 3 | shared preference 仍关联阿斯旺；只针对卢克索的局部偏好没有全局化 |
| C 用户修正推断 | 埃及探索 → 明确“没那么在意步行便利” | 3 | inferred→用户明确，priority 调整；相关候选 stale，前值留审计 |
| D 新硬约束 | 已采用骨架 → 交通预算硬上限阻塞旧骨架 | 4 | 当前采用与 confirmed 决定保留但待复核；已知超限 blocked；无关偏好未删 |
| E 外部住宿回执 | 已确认住宿 → 冲突候选／骨架被拒 → 提供方确认取消 → 新骨架采用 | 6 | 回执与价值选择分离；过期不自动取消；旧回执 superseded 且可追溯 |
| F 外部交通变化 | 已采用方案 → 原路线无服务 → 新方案由用户确认 | 6 | 旧骨架 stale，新旧事实保留；无法服务版 blocked；替代方案仍有费用未知 |
| G 用户推翻决定 | 候选已接受 → 用户明确拒绝 | 2 | 旧 Decision revised、新 Decision.confirmed/supersedes；相关骨架 stale，偏好不丢失 |

## A｜陌生目的地探索

初始 State：`objects=[]`、`revision=0`、`effective_skeleton_id=null`，不把“未表达”写成拒绝。事件序列：① System 创建国家与城市目录；② User 创建 draft TripGoal；③ User 激活目标；④ AI 创建 `certainty=inferred,support=weak` 的局部 Preference；⑤ User 明确修正该 Preference 的 certainty、support、expression、evidence_refs；⑥ AI 创建 Candidate 并引用偏好；⑦ User `decide_candidate(accept)`。转移依次为目录 known、目标 draft→active、偏好 active（属性修正）、候选 exploring→retained、决定 confirmed。候选 review 在偏好变化后由程序维护；本场景没有可核验骨架，因此无路线计算。AI 可探索、推断并建立候选，不能代用户作第⑤步的 explicit 表达或第⑦步的价值决定。两次用户步骤均以明确请求授权；每次成功提交留意图及前后差异。最终没有当前有效骨架，说明“城市被接受”不等于“全旅程方案已确定”。

发现／修复：低信息旅程无需伪造预算、日期或骨架即可进入探索，既有空根结构已支持；机器轨迹证明接受候选不会改根采用引用。

在早期探索场景的验收中，应能区分实际接触到的对象、单次喜欢与没有反馈。只对已互动对象保存有来源的局部弱证据，后续动作可据此调整可逆建议。用户改道时重新评估当前请求，已有候选与确认保持各自的状态。具体展示、触达和推荐动作由上游联测。

P04-S03 的状态层专项测试 `test_P04_S03_three_likes_remain_scoped_weak_evidence` 构造六项古迹、两项自然体验，只对三项有合成互动定位符的古迹写入局部 weak/inferred Preference；不产生对自然体验的否定、全程偏好或 Decision。该测试不验证八项内容是否真实展示，也不验证后续参照选择与个性化行动；展示机会和行动质量须由 UX/运行记录/DC/NAP 联测。

## B｜跨 Candidate Preference

初始 State：卢克索与阿斯旺候选均引用共享的文化 Preference，卢克索尚未退出；原偏好 subject_ids 锚定探索来源，scope=trip 表示本次旅行范围，具体候选仍需分别判断。事件：① User 排除卢克索，Candidate retained→excluded；② User 新增仅限卢克索的 Preference（scope.entity=luxor）；③ System 在已存在的夜数触发条件为 true 后执行 reconsider，excluded→reintroduced。第①步只更改 Candidate 和相关待复核结果，未删除 Preference、evidence_refs、Entity、Constraint 或历史；第②步的局部表达不自动适用于阿斯旺；第③步不是自动接受。AI 可比较阿斯旺并根据共享偏好提出内容，但不能把局部偏好扩成全局。用户在第①、②步明确表达；之后若要作新选择仍需用户。审计记录保存排除原因、原候选状态和新偏好证据。最终卢克索 reintroduced，原共享偏好仍 active。

发现／修复：Preference.subject_ids 更接近“表达锚点”，真正作用范围还须由 scope/condition 与候选关联共同判断；不得因为一个 Candidate 的结束级联删除证据。

## C｜用户修改偏好

初始 State：原埃及状态；没有“步行便利是硬约束”的对象。① AI 由合成行为创建 weak/inferred 的步行 Preference；② AI 建立引用它的开罗 Candidate；③ User 明确说“步行便利不是这次旅行的重要条件”，修改 certainty、priority、support、expression 和证据引用。Preference 生命周期仍 active，因为这是属性纠错；程序将相关 Candidate.review_state 标为 stale，后续推荐或比较必须复核，不强行把原偏好改为 negative。AI 可继续探索和提案，不能把弱推断升级成 hard Constraint；用户第③步是明确修正而非每个推荐排序都需确认。ChangeRecord 的 before/after 可还原原推断与修正依据。最终候选仍存在、价值决定尚未自动改变。

发现／修复：不引入未经校准的数字 confidence；支持变化由 support/priority/审计表达，用户语义权威高于行为推断。真实模型能否正确识别否定和程度变化仍需单独评测。

同一输入可同时澄清对象、表达顾虑或纠正旧推断。采用变更须有单独的授权依据。对“大概两万”的原话，联测覆盖续轮、重启、撤回和补齐口径。口径未知时继续允许有条件的比较，齐备后才能形成软预算。

`test_P03_one_input_can_locally_correct_two_expressions` 验证同一合法批次可局部修正两条 Preference、保留无关约束与已确认决定，并能追溯各自旧值。它不证明模型已正确区分误解、真实变化或条件细化。`test_P05_S04_incomplete_budget_cannot_become_authoritative_constraint` 验证缺币种、人数和费用范围的金额结构被拒绝且状态、历史不变；这句未提交原话的跨会话保存与读取属于 DC/宿主联测。仅澄清“那个”指谁不构成重要变更授权，写桥不得把澄清回复翻译为删除命令；TS 无法仅由合法结构化命令反推原话授权语义。

## D｜新增 Hard Constraint

初始 State：埃及骨架尚未采用，已知交通分项为合成 CNY 120000 最小单位，原预算只是 soft intent。① User 采用初始骨架并承认已有费用未知；② User 创建明确交通预算 ceiling=CNY 100000 的 hard Constraint（初态 proposed）；③ User 激活该约束，program 标记当前骨架 stale、采用决定待复核；④ System recalculate，已知同口径交通分项超过硬上限，assessment=blocked。AI 可解释冲突并提出替代，不可自行放宽上限、撤销旧选择或称旧方案仍可行。新增与激活是用户明确指令；替代骨架时需新的用户确认。历史保存新约束来源与骨架／决定的传播差异。最终根采用引用仍指原骨架，但其可行性已明确受阻，无关文化偏好仍 active。

发现／修复：新增硬约束必须扫描全部适用骨架，即使旧骨架没有事先登记该依赖；既有传播和重算规则已覆盖。真实住宿、签证和个体细粒度计算未验证，不能从本例推断全部硬约束都已自动算完。

## E｜外部 Booking/Reservation 事实

初始 State：埃及候选与原骨架，尚无回执或订单操作。① Tool 导入严格 `reservation-v0.1` 住宿确认 ExternalFact（城市卢克索、入住／退房日期、回执引用及来源）；② User 尝试直接拒绝卢克索 Candidate，被 committed fact 守卫拒绝；③ AI 创建只含开罗的暂定骨架，不改变当前采用；④ User 尝试采用该骨架，已知住宿城市冲突返回 HARD_CONFLICT，事务无部分生效；⑤ Tool 导入合成可信取消回执并将旧确认 superseded；⑥ User 在新事实下采用开罗方案。被拒请求有响应与状态快照，但不算业务状态提交。AI 可说明影响、提出候选，不可取消住宿；第⑤步必须来自可信外部来源，第⑥步为用户价值选择。回执过期只意味着需重新核验，绝不自动等于取消。审计中旧确认与取消回执均存在，拒绝的普通非法请求不进业务历史，宿主安全日志另行保留。最终新骨架被采用，旧预订确认已被外部取消证据替代。

发现／修复：V0.1 原本没有结构化 Booking 对象。采用现有 ExternalFact 的严格只读回执 profile，不增加第 11 个业务对象，也不实现支付或改退。旅行窗口与住宿期相交时，程序可判定“不含已确认住宿城市”冲突；日期已移开时保留回执和待处理未知，允许用户重新选择城市。它不能把具体入住日期与停留夜数完全对齐，保留 `reservation_dates_not_checked` 未知。生产提供方信任链与真实取消真伪尚未验证。

## F｜行程发生变化

初始 State：原交通事实支持开罗→卢克索连接，用户尚未采用。① User 采用原骨架；② Tool 用明确 `no_service` 新事实替代旧交通观察，当前骨架先 stale、决定待复核；③ AI 创建仍走原连接的比较版本并引用新事实；④ System 重算该版本为 blocked；⑤ AI 建立开罗停留的替代骨架并去掉旧路线费用引用；⑥ User 确认替代版本及未知。AI 可建立和比较草案，不能把 Tool 空结果当 no_service、改写旧事实或直接替换根引用。用户只在初始／替代的方案价值选择处确认；事实与计算由 Tool/System 负责。审计可从被替代事实追到不通方案、替代骨架、旧 Decision.revised 与新 confirmed。最终新骨架有效但费用仍不完整；卢克索兴趣仍可供未来重审。

发现／修复：现有依赖失效与版本采用链可以闭环；Candidate 状态不应因交通不通被改写为用户明确“不喜欢”。天气或景点开放可按 ExternalFact + requirement 条件与同一传播路径接入，真实场景仍须单独验证数据覆盖。

如果另一可信来源对同范围、同日期和同查询条件报告相反的服务可用性，即使暂定骨架只引用一方，也要阻断依赖该证据的采用。已确认决定保持，相关依据待复核。验收同时覆盖过期、范围不同、其他可用班次和可独立采用的替代骨架。

## G｜用户推翻之前决定

初始 State：卢克索候选 retained，尚无 confirmed Candidate Decision。① User `decide_candidate(accept)` 创建 confirmed Decision；② User 后来明确 `decide_candidate(reject)`，旧 Decision confirmed→revised，新 Decision confirmed 且 `supersedes` 指旧记录，Candidate retained→excluded。程序把含卢克索的暂定骨架 assessment 标为 stale，等待重新计算；Preference、实体与事实不被删除。AI 可显示历史与影响、提议新比较，不能擅自复活旧已确认选择；两次用户明确操作是价值决定。ChangeRecord 可追出“谁、何时、从什么选择变成现在的拒绝”。最终当前候选决定是拒绝，原兴趣仍在，骨架若未来想采用需按当前候选决定重新校验。

发现／修复：终检发现候选状态变化对同城骨架的隐式传播原先缺失，已补上；不把 Preference 的历史证据误当成当前用户仍接受该城市。

同旅行双主体的反例应覆盖直接撤销及接受模型撤销提案。异主体请求失败时状态、历史和待确认提案保持，原确认人可以继续处理。拒绝提案仍按原入口留痕。

## Scenario → Schema Gap → Fix 总结

| Gap | 修复与验证 | 保留边界 |
|---|---|---|
| 候选反转未使同城骨架待复核 | 添加 Candidate.subject_ids→Skeleton.stops 的隐式传播；G 轨迹及回归检查 | 真实推荐排序与用户界面未测 |
| 预订事实缺少可执行的安全边界 | 严格 ExternalFact 回执 profile、同回执唯一当前版、城市冲突阻断、过期不自动释放；E 轨迹与专门回归 | 仅只读住宿城市承诺；具体入住夜数、真实身份与支付未测 |
| 字段与状态机文档难以交叉核对 | 字段字典、枚举词典、完整转换矩阵、关系与权限文件同一声明源／测试对账 | 非所有状态组合穷举 |
| 部分费用、弱推断、事实空结果易被过度解释 | 保持 unknown、支持度、事实核验与用户决定的分轴语义；A、C、D、F 多轮轨迹 | 真实 LLM 抽取、提供方真实性需独立验证 |

主要场景没有再暴露需要增加业务对象的结构性漏洞。这里“通过”只指七条合成场景的本地状态维护行为；场景 E 的住宿日期细粒度匹配及真实外部回执可信度仍是明确限制，不能据此宣称生产预订系统就绪。

P01/P15/P16/P19 的候选行动覆盖、V/C/E、连续任务成本、现在与延后比较及行动后效果，须在 DC/NAP/运行记录中以当前 TS 状态和同版证据验证；本报告的 A–G 与专项状态层测试不构成这些产品行动规则的运行结果。P10 的 TS 部分已覆盖必要状态守卫；Grounding 和 Action Execution 的事实真伪及执行结果仍各自验收。
