# 来源—规则—测试追踪与增量边界

本表的“覆盖”指给定合成输入下的本地规则测试，不表示 PRD 的界面、模型与真实数据验收全部通过。H01–H10 是本交付包的不变量编号，不替代 PRD 中的历史 H 编号。完整运行的测试名与结果见 `validation-results.json`。

## 核心高风险规则：正例、反例、多轮

| 规则 | 来源 | 正例 | 反例 | 多轮变化 |
|---|---|---|---|---|
| H01 兴趣、明确程度、候选、确认独立 | Handoff §5–6；PRD-001/002 | `test_H01_interest_does_not_confirm_candidate` | `test_H01_inferred_cannot_overwrite_explicit` | `test_H01_user_can_correct_preference_with_history` |
| H02 用户确认不提升事实核验 | Handoff §7/9；PRD-007/008 | `test_H02_confirmation_does_not_upgrade_facts` | `test_H02_user_cannot_forge_fact_verification` | `test_H02_tool_failure_keeps_unknown`、`test_H07_fact_expiry_propagates_not_deletes` |
| H03 预算意向非硬上限、硬约束不可擅改 | PRD-009/§5.3 | `test_H03_budget_intent_and_hard_ceiling_are_distinct` | `test_H03_model_cannot_relax_limit`、`test_H03_fixed_constraint_cannot_be_changed_even_by_user` | `test_H04_explicit_date_correction_preserves_others_and_marks_dependencies` |
| H04 局部修改原子提交、历史和无关状态保留 | Handoff §7.1–7.2；PRD-002/006 | `test_H04_new_preference_preserves_unrelated_values` | `test_H04_atomic_failure_no_partial_create` | `test_H04_explicit_date_correction_preserves_others_and_marks_dependencies` |
| H05 城市退出不删偏好、不扩大范围 | Handoff §6 | `test_H05_exclusion_preserves_shared_preferences_evidence_entities` | `test_automatic_conditional_exclusion_requires_explicit_applicable_true_tradeoff` | `test_H05_reconsider_needs_real_condition_trigger`、`test_H05_local_scope_stays_local_across_exclusion` |
| H06 假设、暂定、当前有效骨架隔离 | Handoff §8；PRD-005/006 | `test_H06_continuous_tentative_edits_do_not_replace_effective` | `test_H06_scenario_cannot_be_adopted`、`test_H06_effective_skeleton_is_not_mutable_in_place` | `test_replacing_skeleton_is_one_atomic_authority_change` |
| H07 失效仅传播受影响结果、选择不自动撤销 | Handoff §7.3；PRD-006/007 | `test_H07_dependency_paths_do_not_invalidate_unread_fields` | `test_calculation_cycles_rejected_association_cycles_allowed` | `test_H07_fact_expiry_propagates_not_deletes`、`test_H07_multilevel_dependency_propagates` |
| H08 上下文含硬约束且不沿用旧版本 | Handoff §9；PRD-002/003 | `test_H08_context_contains_hard_constraints_and_new_constraints` | `test_H08_tampered_context_constraint_omission_rejected` | `test_H08_context_expires_without_any_write`、`test_H08_context_reads_expired_facts_without_claiming_verified` |
| H09 确认必须具体、当前、可拒绝 | Handoff §8–9；PRD-008 | `test_H09_model_proposal_reject_then_confirm` | `test_H09_incomplete_scope_or_wrong_digest_rejected` | `test_H09_old_confirmation_after_update_is_conflict`、`test_H09_confirmation_time_expiry` |
| H10 未知保留、部分成本不能变总价 | Handoff §5/9；PRD-004/007/009 | `test_H10_unknown_cost_never_total_affordability` | `test_H10_unknown_ack_required_before_adoption` | `test_H10_dismiss_does_not_resolve_fact_or_feasibility` |

## A/C 域已裁决机制的 TS 承载与验证

此表只登记八项机制中属于 TS 的行为；C 域完整规则以统一机制规范为准。测试名表示合成状态层证据，不代表语义理解、策略选择或真实用户效果通过。

| 问题 | 原有 TS 正式位置及本轮完善 | 本地可运行证据 | 下游验收 |
|---|---|---|---|
| P03 | Preference 范围/来源、§5.2 历史、局部传播与 I16/I22；明确同一输入可有多项合法局部变化 | A/C 场景；`test_P03_one_input_can_locally_correct_two_expressions` | 解释器区分支持、纠错、真实变化与条件细化；DC/NAP 重评 |
| P04 | §4 低信息/弱兴趣，Preference.evidence_refs 与关系规格；补明展示定位符不证明曝光、无反馈不形成排斥 | A 场景；`test_P04_S03_three_likes_remain_scoped_weak_evidence` | UX/运行记录核验真实展示集；DC/NAP 个性化强度与改道 |
| P05 | §5.1 授权、§5.3 预算、I08/I10/I12；补明澄清对象不授权删除、未提交原话不保证在 TS 历史 | C/D 场景；`test_P05_S04_incomplete_budget_cannot_become_authoritative_constraint`、H03/H06/H09 | 语义理解/写桥处理歧义；DC 恢复预算原话；UX/NAP 澄清 |
| P01 | §7 只读当前状态/证据/未知、I18；只作为行动判断输入 | `test_H08_context_contains_hard_constraints_and_new_constraints`、`test_H08_context_expires_without_any_write` | NAP 的资格、V/C/E、反事实与效果闭环 |
| P10 | §5/§6/§8 状态、权限、事实与原子失败；不把调用成功当结果可用 | `test_only_original_confirmer_can_withdraw_confirmed_decision`、`test_contested_transport_cannot_be_adopted_through_single_reference`、`test_declared_cost_conflict_blocks_only_reliant_skeleton` | Grounding/Action Execution/NAP 的跨层校验及真实 HTTP |
| P15 | §7 当前版本、保护集合、事实时效；不保存 NAP 行动集合 | H08 上下文有效性测试；无 P15 策略运行测试 | DC 同版任务，NAP 关键替代及动态比较 |
| P16 | 现有状态/业务历史仅提供可复用事实，不记录全部提示或任务劳动 | H04/H08 为状态/历史读面回归；无用户成本运行测试 | NAP/运行记录按连续任务判断累计负担 |
| P19 | ExternalFact.expires_at、§7 时效和 I18 只提供时机输入，不自动推送 | `test_H08_context_expires_without_any_write`；无介入时机运行测试 | NAP 比较现在/延后/后台准备/不介入，执行宿主核验授权 |


## 对象与机制覆盖

| 对象／机制 | 已执行范围 | 增量或外部验证边界 |
|---|---|---|
| TripGoal | 身份、字段、状态表、写入权限、历史与关联 | 自然语言目标提取未测 |
| Preference | 明确／推断、条件三值、跨候选、局部范围、纠错 | 模型语义准确率、自动泛化未测 |
| Constraint | 预算语义、日期、夜数、入离境、范围、硬约束保护 | 个体／局部细粒度计算输出未知；真实体力模型未实现 |
| DestinationEntity | 目录身份、父引用、覆盖；与候选隔离 | 地图坐标、真实目录准确性未测 |
| Candidate | 保留／排除／重入、证据保留、确认冲突 | 自动排序、通用价值判断未实现 |
| ExternalFact | 适配器字段缺失、失败、证据层级、日期、时效 | 真实服务覆盖、许可、库存与可购买性未测 |
| Skeleton | 三类用途区分、版本、采用、有限重算 | 完整路线优化、疲劳、换乘保障、逐日排程未实现 |
| Decision | 用户确认、范围、拒绝、替代、撤销、事实独立 | 真实身份系统与多用户授权由宿主实现 |
| OpenIssue | 生成／重开、关联证据、保守解决、dismiss | 部分问题的精细关闭策略待增量 |
| DecisionContext | 只读引用、约束全集、版本、时间、依赖闭包 | 上下文压缩、模型 token 效率未测 |
| ChangeRecord | 前后差异、原因、来源、原子保存、拒绝留痕 | 跨进程数据库事务、历史归档和崩溃恢复未测 |
| OperationIntent | 来源入口、原话、操作目标与基准版本 | 真实地图／时间轴事件接入未测 |
| 更新 API | 本地路由、结构、错误体、幂等、确认 | 未部署 HTTP 服务；网关安全与端到端网络未测 |
| 并发与失败 | 两线程旧版本冲突、提交前故障、确认故障重试 | 分布式事务、宕机恢复、压力测试未测 |

状态转换表每条边有主体、守卫与效果；本包并不声称对所有状态边组合做了穷举测试。测试覆盖重点是高风险不变量和组合路径，完整用例清单与统计由运行器产生。

全局终检新增回归见 [CONSISTENCY_REVIEW.md](../90_可运行工程包/CONSISTENCY_REVIEW.md)：额外检查用户约束失效权限、事实工具替代、排除态绕过、时钟引起的输出传播、条件隐式依赖、深层字段引用与谱系、假设覆盖、人数和未知夜数、事实未知值以及工件同步。`test_every_declared_lifecycle_edge_and_actor_gate` 覆盖声明表中每一条边的角色分派，不替代业务守卫组合的穷举。`test_generated_dictionaries_and_transition_documents_are_exact` 检查生成 Markdown 与 JSON 的一致性。

本轮追加的 [A–G 场景报告](SCENARIO_VALIDATION.md) 对应 `test_all_seven_scenarios_reexecute_to_saved_trace`，将初始状态、31 次请求／响应、每步快照、终态和审计记录与独立重跑逐项比较。受限外部住宿回执的正反例见 `test_committed_city_blocks_conflicting_adoption_and_candidate_rejection`、`test_expired_receipt_does_not_silently_release_commitment`、`test_verified_cancellation_releases_city_without_erasing_history`、`test_receipt_cannot_be_dropped_without_successor_evidence`；这仅验证合成工具输入下的规则，不验证真实供应商。

偏好替代可追溯性由 `test_preference_supersession_has_traceable_successor` 验证无后继拒绝、有后继同笔接受及旧证据保留；关系与审计解释见 [最终关系规格](../02_业务状态规则/OBJECT_RELATIONSHIPS_FINAL.md) 和 [历史契约](../02_业务状态规则/HISTORY_FINAL.md)。

## PRD 验收映射

| PRD 验收 | 本包承担 | 不在本次通过结论内 |
|---|---|---|
| A01 探索与条件兴趣 | 低信息状态、偏好和顾虑可表达，不确认候选 | 内容展示、模型理解、真实用户 |
| A02 纠错与假设 | 原子纠错、来源历史、假设隔离、重入 | 自然语言端到端抽取 |
| A03 下一步建议 | Decision Context 和问题提供策略输入 | Next Action Policy 的推荐质量与 UI 改道 |
| A04 骨架比较 | 版本、取舍、分项费用与未知结构 | 完整方案优化及用户理解效果 |
| A05 连续编辑 | 操作意图和暂定版本维护 | 地图／时间轴交互与渲染 |
| A06 局部修改 | 依赖传播与有限计算 | 覆盖所有交通方式的重规划 |
| A07 现实核验 | 接口结果分类、时效、条件和来源 | 实际交通与开放条件真实性 |
| A08 确认保存 | 原子采用、拒绝、范围、版本和未知 | 生产存储持久性 |
| A09 预算 | 意向／区间／硬上限、同口径分组、部分覆盖 | 全程成本估算和真实价格 |

## 开发默认值

Python 3.13 + jsonschema 4.23.0 + 标准库 unittest；依赖全部固定在 requirements.txt。参考数据库为内存，确认窗口默认 5 分钟；上下文最大生命周期 5 分钟且不越过下一事实到期点；并发策略为旅行聚合版本冲突后显式重试；没有自动合并、自动交易或全量事件重放。

## UX-02 本轮增量

E01–E32完整分类及DC后续子任务见[UX02逐项矩阵](../90_可运行工程包/UX02工程落实与DC开发映射.md)。`tests/test_ux02.py`覆盖整份/城市恢复只读预览、新版本、当前硬约束拒绝、事实过期、Model确认、旧基准、幂等、故障回滚、缺城市位置与体验城市保护。真实TS对应`tests/trip-state/ux02.test.ts`、PG专项和HTTP专项；本参考报告不证明GitHub/前端/LLM/真实交通通过。

### PR #13 版本定位与接口合同修订候选

恢复请求必须指定 source_id 与 source_version；从当前旅行授权历史的已应用快照或当前对象解析该精确版本，不可用时拒绝。当前旅行revision仍单独保护并发；查看历史不等于授权。HTTP成功、阻断、版本冲突及鉴权错误的形状见 UX02 工程映射，旧领域Schema不变。
