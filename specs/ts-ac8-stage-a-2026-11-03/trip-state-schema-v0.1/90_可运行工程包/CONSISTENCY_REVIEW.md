# 全局一致性终检记录

## 恢复点与检查方法

额度中断后的可靠完成点是已生成的 0.1.0 交付包及 88 项通过的本地测试。中断时尚未完成跨文档、Schema、状态转换表与参考实现的全局终检。本轮保留原定稿的九类信息域、十个业务对象、两类系统记录、跨候选偏好机制 B、模块化对象架构和三类维护机制，仅修复与它们冲突的细节，并增补回归验证。

检查链路：四份原始资料指纹 → 声明源 → 20 份离线 Schema → 字段字典、嵌套类型规范与状态转换表 → 正反样例及埃及多轮轨迹 → 状态维护程序 → 自动化测试与打包清单。四份来源重新计算 SHA-256，均与 source-manifest.json 一致，原件未修改。交付内容均在本目录。

## 冻结结构对账

| 检查项 | 定稿位置 | 可执行核对 |
|---|---|---|
| 九类信息域 | SPECIFICATION.md §1 | 信息域逐项映射到下列对象；追踪表与 PRD A01–A09 对账 |
| TripGoal、Preference、Constraint | schemas 同名文件；FIELD_DICTIONARY.md | 目标权威、跨候选证据、预算及硬约束权限／范围测试 |
| DestinationEntity、Candidate、ExternalFact | 同上 | 实体种类、候选退出／重入、查询失败与核验独立测试 |
| Skeleton、Decision、OpenIssue | 同上 | 暂定／有效分离、确认原子性、问题关闭与历史测试 |
| DecisionContext | 独立只读 Schema | 当前版本、所有活动硬约束、确认决定、事实时效与过期拒用测试 |
| ChangeRecord、OperationIntent | 两份系统记录 Schema | 意图与前后差异、确认拒绝留痕、失败回滚测试 |
| 偏好机制 B | SPECIFICATION.md §4 | 城市退出仍保留兴趣／顾虑／证据；局部不全局化；条件三值与重入不已选 |
| 维护机制一 | SPECIFICATION.md §5.1 | 提案、预览、权限、确认绑定、乐观并发、幂等、原子提交 |
| 维护机制二 | SPECIFICATION.md §5.2 | 当前与追加历史并存，纠错不抹旧证据；暂定骨架不替换当前 |
| 维护机制三 | SPECIFICATION.md §5.3 | 字段级与隐式条件依赖、事实时效、有限重算、下游决定待复核 |

## 终检发现与收敛规则

| 原冲突／半成品风险 | 最终规则与兼容处理 | 回归证据 |
|---|---|---|
| 系统可能直接使用户硬约束失效 | 用户约束由明确用户指令或确认处理；仅 fixed 现实约束可由系统凭被反证／替代的事实依据失效 | `test_system_cannot_silently_invalidate_user_constraint`、`test_system_can_invalidate_fixed_evidence_constraint_without_relaxing_it` |
| 工具事实替代在表内允许，入口却拒绝 | 可信工具仅可导入事实及将已有事实 supersede/contradict；仍禁止工具改候选或用户值 | `test_tool_fact_contradiction_obeys_declared_transition` |
| 被排除候选经 retain 绕过重入；骨架可独立替代 | 候选先满足 reconsider 的条件，再 retain/accept；骨架／决定替代仅由专用确认命令原子触发 | `test_excluded_candidate_cannot_skip_reconsider_via_retain`、`test_replacement_only_transitions_reject_standalone_command` |
| 仅时间变化导致重算结论改变，下游决定未失效 | 重算结果也作为依赖输出传播；保留确认和当前采用，决定 review_state=stale，刚算出的骨架不再标回 stale | `test_recalculation_propagates_time_change_without_revoking_choice` |
| 条件表达引用事实，但偏好或约束本身未写入时传播中断 | 隐式条件边参与影响计算，只传递待复核信号，不改写原表达 | `test_condition_dependencies_propagate_without_rewriting_preference` |
| 深层依赖路径只检第一段，谱系可成环 | 逐层检查字段／数组位置；父实体、父骨架和决定替代谱系不得成环；普通 association 仍可回路 | `test_nested_dependency_paths_are_validated`、`test_entity_and_skeleton_lineage_cannot_cycle`、`test_calculation_cycles_rejected_association_cycles_allowed` |
| 假设覆盖可重复或改种类；伪造确认范围 | 每个约束最多一项、同种类且满足原约束结构语义；已确认决定核对完整范围与目标 | `test_scenario_overrides_preserve_kind_and_unique_authority`、`test_imported_confirmation_requires_complete_scope` |
| 人数约束与未知夜数可能被忽略或当零 | 参与人数对登记目标核对；未登记为未知；任一 nights=null 则总夜数为 null，采用必须承认未知 | `test_traveler_count_cannot_be_silently_treated_as_satisfied`、`test_unknown_stay_is_not_zero_and_can_be_explicitly_acknowledged` |
| 未知条件事实可能被升级为日期核验 | condition.value=null 加入缺失字段，最高保留 estimated；失败／空结果仍为 unverified | `test_unknown_condition_fact_never_becomes_verified` |
| 任意实体／事实类型可填入城市与费用关系 | 城市／体验候选核对实体种类；骨架停留为城市；连接与费用引用核对事实值类型，失败无值记录仍可保留 | `test_typed_entity_and_fact_relationships` |
| 生成表与实际声明可能分叉 | 字段字典、状态表及离线 JSON 均由声明源生成并逐字节核对；每个顶层字段都有语义说明，嵌套结构见 SHARED_TYPES.md | `test_generated_dictionaries_and_transition_documents_are_exact`、`test_all_top_level_object_fields_have_semantic_notes` |

原交接中把明确程度放进偏好状态、把日期可用性放进实体状态、把用途／采用／可行性混在骨架状态，仍按 SPECIFICATION.md §11 的兼容映射处理。原始方案不是已发布的持久 JSON，无可无损迁移的真实旧记录；未知的旧值不能靠猜测转换。

## 检查结论与限制

正式字段、状态和接口以本包 0.1.0 同版工件为准。测试覆盖高风险正反例、多轮埃及轨迹、声明转换边的角色分派、离线引用及生成一致性。仅证明本地合成输入下的结构、语义和内存提交；真实模型抽取、供应商数据真实性、生产事务／崩溃恢复、HTTP 部署、UI、性能与用户效果分别留给后续验证。实际运行数量及任何失败／跳过均以 [验证报告](VALIDATION_REPORT.md) 为准。
