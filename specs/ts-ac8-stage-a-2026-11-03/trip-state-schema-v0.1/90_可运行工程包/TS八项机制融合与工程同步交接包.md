# ANTU｜TS 八项机制融合与工程同步交接包

包修订：2026-11-03-ac8-stage-a-candidate。机器合同：Trip State 0.1.0。状态：本地阶段 A 候选，待技术负责人核验；GitHub 阶段 B 尚未实施。本文件说明八项已裁决机制如何进入原 TS 体系，不另设八套状态功能。正式规则仍以 A 域三个专题及 C 域统一规范为准，来源与 SHA-256 见 [来源清单](source-manifest.json)。

## 1. 总体吸收结论与逐项交付

Trip State 的职责是保存有来源、有适用范围的旅行业务状态与必要证据，保护确认、事实和未知，并提供当前可读状态。八项机制的完整产品体验横跨语义理解、DC、NAP、Grounding、UX、运行记录和 Evals；本包只把真正属于 TS 的部分融入现有对象、守卫与读取契约。C 域五项以统一规范的 A 行动资格、B 相对价值、C 效果验证为单一机制，不在 TS 内重建 V/C/E。

| Problem / 已裁决规则 | 原 TS 承载位置 | 本地包实际完善与正式位置 | 可运行证据及未验证边界 |
|---|---|---|---|
| P03｜可反驳理解、证据关系和局部持续校准 | Preference.scope/condition/certainty/support/evidence_refs；OperationIntent/ChangeRecord；依赖传播 | [规格 §2/§5.2](SPECIFICATION.md)、[关系](OBJECT_RELATIONSHIPS_FINAL.md)、[历史](HISTORY_FINAL.md)、[传播](PROPAGATION_FINAL.md)、I16/I22 明确已提交原话、同输入多变更、局部保留及未提交证据边界 | A/C 场景和 `test_P03_one_input_can_locally_correct_two_expressions` 仅证明结构化命令后的状态；解释正确性及误解/真实变化分类由语义理解、DC、Evals 验收 |
| P04｜低信息起步、展示机会、弱证据和渐进个性化 | 空根/TripGoal；Preference 局部证据；Candidate/Decision 分轴 | [总览](FINAL_CANDIDATE.md)、[规格 §4](SPECIFICATION.md)、[字段字典](FIELD_DICTIONARY_FINAL.md)、[关系](OBJECT_RELATIONSHIPS_FINAL.md)、I06 明确实际互动才形成局部弱证据，定位符不证明曝光，未展示/无反馈不等于否定 | A 场景和 `test_P04_S03_three_likes_remain_scoped_weak_evidence` 测试六古迹/两自然中的三项局部喜欢；真实展示集、差异化参照、深化和改道由 UX/运行记录/DC/NAP 验收 |
| P05｜按后果处理歧义、最小澄清、未知预算和失败恢复 | 命令形状/引用/权限、scenario 隔离、Constraint 预算、确认提案 | [规格 §5.1/§5.3](SPECIFICATION.md)、[权限](AUTHORITY_FINAL.md)、[历史](HISTORY_FINAL.md)、I08/I10/I12 明确对象澄清不授权重要变更、口径不全不写正式预算、未提交原话非 TS 历史 | C/D 场景和 `test_P05_S04_incomplete_budget_cannot_become_authoritative_constraint`；“那个”的语义判定、选项质量、跳过与原话跨会话恢复由语义理解/写桥/DC/NAP/UX 验收 |
| P01｜行动资格、V/C/E、反事实和效果闭环 | TS 当前状态、保护集合、事实与未知供读取 | [规格 §7](SPECIFICATION.md)、[总览](FINAL_CANDIDATE.md)、I18 明确 TS 只提供权威输入，业务回执不等于用户效果 | H08 上下文有效性及保护集合回归；行动价值和效果由 NAP/运行记录/Evals 验收 |
| P10｜L0–L3 强制校验，资格先于价值 | 既有状态、权限、确认、事实和原子命令 | [规格 §5/§6/§8](SPECIFICATION.md)、[权限](AUTHORITY_FINAL.md)、[不变量](INVARIANTS_FINAL.md)、[状态转换](STATE_TRANSITIONS_FINAL.md)；已确认决定撤销主体与争议证据采用守卫按原对象实现 | `test_only_original_confirmer_can_withdraw_confirmed_decision`、`test_contested_transport_cannot_be_adopted_through_single_reference`、`test_declared_cost_conflict_blocks_only_reliant_skeleton`；真实身份、供应商和执行回执待工程联测 |
| P15｜关键替代覆盖、随 TS/DC 变化动态比较 | TS revision、保护集合、事实状态和只读投影 | [规格 §7](SPECIFICATION.md)、I18 明确旧快照不可继续作当前依据；不创建 NAP 候选业务对象 | H08 时效/版本测试仅验证 TS 输入；候选遗漏和动态 V/C/E 比较由 DC/NAP/Evals 验收 |
| P16｜任务级累计负担、劳动分配、动态 C | TS 有效业务状态和已提交业务历史可被消费 | [规格 §7](SPECIFICATION.md)、[历史](HISTORY_FINAL.md) 明确历史不是完整提示/曝光/交付流水，不保存 C0/C1/C2 | H04/H08 仅验证状态/历史可读；任务级成本、重复索取和用户负担由 NAP/运行记录/UX 验收 |
| P19｜现在/延后/后台准备/不介入的时机比较 | 事实 expires_at、当前状态、只读投影到期与失效 | [规格 §7](SPECIFICATION.md)、I18 明确时效是输入而非通知触发器；TS 不保存介入策略 | `test_H08_context_expires_without_any_write` 验证时钟失效；时机价值与授权后台准备由 NAP/执行宿主验收 |

对 P03/P04/P05，TS 对**结构化且经授权进入业务命令的输入**负责；不能用字符串证据定位符证明模型正确理解原话或用户实际看到内容。对 P01/P15/P16/P19，TS 的当前状态与历史可作为输入，不承担候选行动生成、成本评分、时机调度或用户价值评测。P10 的事实可信、工具执行和权限宿主仍各有独立检查；TS 只保护自己的写入和采用入口。

## 2. 原体系修订清单与唯一正式定义

- 复用：九信息域、十业务对象、两系统记录；Preference/Constraint/Candidate/ExternalFact/Skeleton/Decision/OpenIssue 的既有权威；source/scope/condition/dependencies；当前采用根引用；三值未知；原子提交与追加历史。
- 完善：Preference 的实际互动证据使用边界在 [规格 §4](SPECIFICATION.md) 定义，字段和关系只解释定位符含义；未提交原话不由 TS 历史保证在 [历史](HISTORY_FINAL.md) 定义；命令授权与事实采用由 [规格 §5–6](SPECIFICATION.md)、[权限](AUTHORITY_FINAL.md) 和 [不变量](INVARIANTS_FINAL.md) 定义；状态读/跨模块责任由 [规格 §7](SPECIFICATION.md) 定义。其他位置仅给引用和测试定位。
- 本地参考程序中原有 X01/P10 主体守卫与 C12/P10 争议事实守卫继续作为本包现行语义；本轮新增 P03/P04/P05 专项状态测试与 [场景说明](SCENARIO_VALIDATION.md)。这些不是新增顶层对象或策略引擎。
- 机器合同：20 份 `schemas/*.json`、字段集合、枚举、`schema_version=0.1.0`、`$id`、命令和响应形状不变。字段字典的语义说明及来源追踪更新后重新生成；声明源结构及 A–G 七条 31 步机器轨迹保持原值。没有为八项机制建立新字段、对象、状态或命令。
- 包装与来源：`source-manifest.json` 指向当前正式本地资料，C 域统一规范为规则真源，五个专题和收口记录只供追溯。`package-index.json` 增加候选修订标识和交接入口，阅读镜像由 `90_可运行工程包` 生成。

本轮相对修订前本地包的**文件级清单**：新增本交接文件；直接修改 `AUTHORITY_FINAL.md`、`FINAL_CANDIDATE.md`、`HISTORY_FINAL.md`、`INVARIANTS_FINAL.md`、`OBJECT_RELATIONSHIPS_FINAL.md`、`PACKAGE_GUIDE.md`、`PROPAGATION_FINAL.md`、`README.md`、`SCENARIO_VALIDATION.md`、`SPECIFICATION.md`、`TRACEABILITY.md`、`V1_READINESS.md`、`build.py`、`package_bundle.py`、`run_validation.py`、`source-manifest.json`、`tests/test_package.py`、`tests/test_tripstate.py`；由声明源/验证重新生成 `FIELD_DICTIONARY.md`、`FIELD_DICTIONARY_FINAL.md`、`VALIDATION_REPORT.md`、`artifact-manifest.json`、`validation-results.json`，以及包根目录阅读镜像、`package-index.json` 和交付 ZIP。复用且本轮未改 `tripstate/contracts.py`、`tripstate/engine.py`、`tripstate/rules.py`、`rules/*.json`、20 份 Schema 与原 A–G 机器轨迹；其他未列的旧文件保持原值。历史 E02 锁定快照完全不写。

## 3. 机器合同、运行语义与兼容

| 项目 | 最终差异 | 兼容判断 |
|---|---|---|
| 对象/字段/类型/Schema/命令/HTTP 形状 | 无结构变化；无新业务对象、状态、存储列或迁移脚本 | 仍为机器合同 0.1.0；E02 已锁定来源不修改 |
| 证据/范围/历史 | evidence_refs 只定位来源；已提交操作留 TS 历史，未提交原话由 DC/宿主保留 | 语义澄清，不改变合法 JSON；不能据此承诺所有旧对话可恢复 |
| 已确认 Decision 撤销 | 实际经鉴权 User 必须匹配 confirmed_by；直接提交和接受 Model 提案同守卫 | 原本越权可通过的请求改为 PERMISSION 拒绝；旧数据主体缺失须审计并失败关闭，不猜测代确认 |
| 争议 ExternalFact 消费 | 当前可比交通相反观察及明确关联的未解决冲突事实不可支撑依赖它的新骨架采用；原决定保留但待复核 | 原本可能错误采用的请求改为 HARD_CONFLICT；旧事实需在消费时重新检查，不改写原观察 |
| DC 读取 | 只读投影保留硬约束/确认决定/未知和同版时效；独立 DC 0.1.0 负责任务解释与恢复 | 不改变 TS 投影 Schema；不能把 TS 参考 POST decision-context 误认为 E02 已部署的 HTTP 路由 |
| NAP/UX/运行记录 | 读取 TS 结果并各自判断 V/C/E、展示、澄清、累计负担、时机和效果 | 无 TS 数据迁移；其他模块必须验收自己的行为 |

没有证据要求为八项机制新建评分、心理、曝光或行动状态系统。结构上没有版本升级需求；行为上两类原本放行的危险提交会收紧，不能用“兼容”掩盖调用方可见的拒绝。生产旧状态的 `confirmed_by`、争议事实与旧投影应做只读审计并在读取/采用时重验；如发现不合合同的历史数据，另提迁移方案，不在本包静默补值。

## 4. 验证记录、已知限制与复现

以 [正式验证报告](VALIDATION_REPORT.md) 和 `validation-results.json` 的最后一次实际运行结果为准。本轮使用 Python 3.13 及 `requirements.txt` 精确锁定依赖完成 126/126 项测试，失败/错误/跳过均为 0，依赖匹配。20/20 份机器 Schema 与 E02 历史锁定原件逐字节相同，原 A–G 七场景 31 步轨迹逐字节相同；14/14 份正式输入来源 SHA-256 与当前本地文件相符。验证包括字段/转换生成一致性、机器轨迹独立重跑、Python 状态规则与新增专项正反例。专项测试只构造合成输入，不调用真实模型、供应商、身份服务、PostgreSQL 或 HTTP。

本包验证通过不证明 P03 理解分类、P04 实际曝光/个性化、P05 语义澄清和跨会话预算、P01/P15/P16/P19 NAP 行动价值与效果已运行。模糊预算的原话恢复必须在 DC/宿主读取链单独实测；未保存/账号切换/撤回时保持未知。C 域 V/C/E 的三级定义及反事实规则以正式域级规范为唯一执行口径，不能从 TS 测试反推出 NAP 已完成。

## 5. GitHub 阶段 B 工程实施清单（待技术验收后）

工程目标是当前 E02 TypeScript 命令服务；不修改 `MVP Engineering/specs/baseline-2026-10-27/` 的历史快照，不复用 PR #10 作 TS 实现分支。

| 类型 | 仓库位置 | 获批后最小动作与验收 |
|---|---|---|
| 需编码 | `src/server/trip-state/commands.ts`；可能涉及 `assessment.ts`、`conditions.ts`、`semantics.ts` | 移植原确认人撤销守卫和争议事实消费/传播语义；预览、直接提交、提案接受一致；无关替代方案仍可采用 |
| 需核验 | `src/server/trip-state/internal/persistence.ts`、`src/server/http/trips.ts`、认证/旅行授权入口 | 使用宿主可信 User ID；持久提案与恢复后重验主体、revision、事实时效；无第二写通道 |
| 需补测 | `tests/trip-state/`、`tests/http/` 的命令、事实、确认、数据库与真实 HTTP 套件 | P03/P04/P05 的合法状态变更及失败原子性；P10 双账号/争议事实正反例；保留 E02 回归 |
| 无需结构修改 | `src/server/trip-state/contracts.generated.ts`、`schema-resources.generated.ts`、Prisma schema/migrations | 20 份合同与数据库 JSON 载体保持；合同检查应证明无差异，若实际实现发现结构要求须先回修本包再审 |
| 后续模块 | E03 DC/语义理解/写桥、E04 NAP、E05 UX/运行记录/Evals；Grounding/Action Execution | 按 [追踪表](TRACEABILITY.md) 逐项完成跨会话、展示机会、澄清、候选行动、累计负担、介入时机及效果的真实联测；不登记成 TS 新功能 |

阶段 B 须在独立分支提交独立 PR，附版本与来源摘要、生产/测试入口、真实 PG/HTTP 正反例、CI 和旧 E02 回归。不得自动合并、修改 PR #10 或自行批准 E03 Gate。技术负责人应先核验本地候选包的规则闭合、版本/兼容与本交接清单；本文件本身不是 Gate 批准记录。

## 6. 待技术负责人核验

1. 八项机制的 TS 适用部分是否均有唯一正式定义，是否同意其余部分按现有 DC/NAP/UX 等职责接入。
2. 0.1.0 机器合同不变、但 X01/C12 行为收紧的兼容判断和旧数据失败关闭边界。
3. 本地测试、来源指纹、生成镜像与压缩包是否一致；历史 E02 基线是否保持不变。
4. 独立 TS 实施分支与阶段 B 测试范围。新增产品取舍：无；跨成员代为确认、拒绝或委托授权不在本轮扩张。
