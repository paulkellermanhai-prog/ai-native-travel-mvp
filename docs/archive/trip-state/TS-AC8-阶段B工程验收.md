# ANTU｜Trip State 八项机制阶段 B 工程同步与验收

状态：**阶段 B 工程候选已通过实际 PostgreSQL/HTTP CI；待技术负责人 Gate Review**。本文件只记录阶段 B 的 Trip State 工程工作；不宣称八项产品机制的端到端体验完成。PR 最新 head 的状态以 GitHub Checks 为准。

## 1. 来源与批准

阶段 A 正式输入保存在 `specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/`，原交付 ZIP 同目录逐字节保存，SHA-256 为 `d2825ae51a0feb64fc4afd7d9514d0b615ae80f300fe4293bdef4f9a187340ad`。`selection.json` 记录修订号 `2026-11-03-ac8-stage-a-candidate`、原包索引待验收状态、用户本任务中以技术负责人身份明确批准的回复及 E02 main 基线 `6ae8b2b66513c51ff209ce7147e8c6ff7376a39b`。原包索引的历史状态没有被改写；本仓库的选择记录是批准依据。

新增 `npm run specs:ac8` 检查 ZIP、包索引、来源 manifest 的已批准摘要、108 个 canonical 文件摘要、20 份机器 Schema 与 E02 锁定源逐字节相同，以及 A–G 7 场景 31 步轨迹不变。原 `specs:verify` 的 155 份锁定源及 `contracts:check` 的 20 份合同仍独立执行。阶段 A ZIP 已在隔离目录以锁定 Python 依赖重跑 126/126、0 失败/错误/跳过；原 E02 Python 语义/预订 102/102 重跑通过。CI 在临时目录重新执行阶段 A 参考测试，避免覆盖版本化输入。

## 2. 八项机制逐项落地

| Problem | 阶段 A 正式 TS 规则 | E02 代码覆盖与阶段 B 变化 | 本轮测试与剩余责任 | 当前结论 |
|---|---|---|---|---|
| P03 | `SPECIFICATION.md` §4–5、`HISTORY_FINAL.md`：结构化输入的局部纠错、同输入多对象、旧证据与无关状态保留 | E02 `commands.ts` 原有批量命令、逐对象 revision、diff/history 和传播；业务代码无需新增对象或命令 | `tests/trip-state/ac8.test.ts` 两对象纠错、`ac8.integration.test.ts` 一笔 PG 历史与无关约束；真实原话分类仍归语义理解/DC/Evals | **补专项测试，PG 待 CI** |
| P04 | `SPECIFICATION.md` §4：具体互动形成局部弱证据，未展示/无反馈不成拒绝 | E02 Preference 的 scope/support/certainty/evidence_refs、Candidate/Decision 分轴继续使用；无自动全局排他规则 | `ac8.test.ts` 6 古迹/2 自然中 3 项局部弱兴趣、未互动自然不产生负证据；真实曝光集、推荐深化属 UX/运行记录/DC | **补专项测试；产品效果未验证** |
| P05 | `SPECIFICATION.md` §5.1/§5.3：澄清不授权重要变更；口径不完整预算不能写硬约束 | E02 命令结构、权限、确认及预算语义校验继续使用；无 Schema 新字段 | `ac8.test.ts`、`ac8.integration.test.ts`、真实 HTTP 增加不完整预算拒绝及零写入检查；“那个”的理解和未提交原话跨会话恢复归语义理解/DC/宿主/UX | **补专项测试，PG/HTTP 待 CI** |
| P01 | `SPECIFICATION.md` §7：TS 提供当前状态、未知与保护集合 | 原 `state/history` 授权读取、assessment 未知继续复用；无 TS 行动价值代码 | 原 E02 读取/权限回归；V/C/E、反事实及用户效果归 NAP/运行记录/Evals | **原能力复用，CI 待回归** |
| P10 | `SPECIFICATION.md` §5–8、`AUTHORITY_FINAL.md`、`INVARIANTS_FINAL.md`：确认人撤销、争议事实采用、原权限/事务守卫 | `commands.ts` 原位加已确认 Decision 的 `confirmed_by` 与可信 User actor 匹配；`conditions.ts` 识别同范围相反交通与未解决 conflict Issue；`assessment.ts` 在事实消费时阻断争议；传播让旧采用待复核 | `ac8.test.ts` 对照阶段 A Python；`ac8.integration.test.ts` 真实 PG 双用户、提案、重连、争议事实与原子回滚；HTTP 双账号身份正反例待 CI。Grounding 仍负责外部事实可信与可比性 | **业务代码补强，PG/HTTP 待 CI** |
| P15 | `SPECIFICATION.md` §7：提供同版有效 TS 输入 | 原 revision、状态与受权读取复用；未增行动候选 | 原 E02 同版读取回归；动态替代比较与 DC 失效重建归 DC/NAP/Evals | **原能力复用，后续模块待验收** |
| P16 | `SPECIFICATION.md` §7、`HISTORY_FINAL.md`：有效状态和已提交业务历史 | 原追加历史和 GET changes 复用，无打扰流水或成本评分 | 原 E02 历史回归；任务级负担、重复索取与劳动分配归 NAP/运行记录/UX | **原能力复用，后续模块待验收** |
| P19 | `SPECIFICATION.md` §6–7：事实时效供消费，不等于通知触发 | 原 `factUsable` 与重算/采用的时效检查复用 | 原 E02 到期/未知回归；立即、延后、后台准备或不介入归 NAP/执行宿主 | **原能力复用，后续模块待验收** |

上述相对路径中的 `SPECIFICATION.md` 等均指新增正式输入下的 `90_可运行工程包/`。TS 参考 `POST decision-context` 不是已部署的 E02 HTTP 路由，本轮不创建 E03 Runtime 接口。

## 3. 代码差异及兼容性

- 实际业务代码仅修改 `src/server/trip-state/commands.ts`、`conditions.ts`、`assessment.ts`。X01 的主体判断只在真实应用时执行；Model 提案预览中的 `pending-user` 不冒充确认人，接受时按受信 User ID 重验。跨成员拒绝、代为确认、委托授权边界没有扩张。
- C12 先从仍可用、同查询日期/方向/参数/对象范围的交通观察检测相反服务存在结论，并尊重未解决的 conflict OpenIssue。受争议的交通、费用或硬要求不能支撑新骨架采用；已确认旧决定保留但依赖标 stale。事实被明确替代/反证或不具可比性时不误阻断无关方案。Provider 可靠性仍须 Grounding 验收。
- 20 份机器 Schema、生成类型、请求/响应形状、Prisma 模型/迁移、HTTP 路由均不变，仍为 TS `0.1.0`。行为收紧会让旧实现中可能放行的跨主体撤销返回 `PERMISSION`，争议事实采用返回 `HARD_CONFLICT`；调用方必须处理拒绝，不可将“结构兼容”误说成“行为完全无变化”。
- 旧状态若没有合法 `Decision.confirmed_by`，现有 `validateStateSemantics` 即失败关闭，不猜测确认人或静默迁移。生产旧事实在消费时重新计算争议；迁移需求需按只读审计结果另行决定，本 PR 无迁移。
- `tests/support/command-oracle.py` 仅增加可选阶段 A 来源根，原 E02 测试默认仍读取锁定源。与新规则冲突的事实对照测试改为读取已批准阶段 A 包，其余 E02 原场景/轨迹及断言保留。

## 4. 本轮实际验证与待完成验收

已执行（独立工作树，Node 24.22.1、npm 11.19.1）：`npm ci`、`npm run specs:verify`（155/155）、`npm run specs:ac8`（108 摘要、20 Schema、7/31 轨迹）、`npm run contracts:check`（20）、`npm run db:validate`、`npm run db:generate`、`npm run typecheck`、`npm run lint`、`npm run build`，均成功。锁定 Python 环境原 E02 102/102、阶段 A 126/126 均成功。新 TypeScript 专项 9/9；本地完整 Vitest 为 **617 通过、209 因未配置隔离 PostgreSQL 而跳过、0 失败**，不能作为完整阶段 B Gate 通过证据。`npm ci` 提示 16 项 moderate 依赖公告，未改锁文件或进行与 TS 同步无关的强制升级；须随 CI/安全复核记录。

独立 [PR #11](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/11) 的代码提交 `04d2d29d74e41507946f8481eb8c296017d4f529` 已在 [E01 CI #28](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/actions/runs/41656763890) 完整通过（PostgreSQL 17）。来源：原 E02 155 个锁定文件，阶段 A 14 个来源摘要记录、108 个 canonical 摘要、20 Schema 与 E02 同字节、A–G 7 场景 31 步不变；合同 20。Prisma validate/generate、隔离数据库迁移、Typecheck、Lint、生产 Build、数据库连通性均通过。全量 Vitest **24 文件，826 通过、0 失败、0 跳过**（含新增 9 项单测和 3 项 PostgreSQL 集成测试）；原 E02 Python **102/102**，阶段 A Python **126/126**；真实 Next.js HTTP **21 通过、0 失败、0 跳过**，其中新增 P05 预算拒绝与 X01 双账号/Model 提案/重连验收。CI 留存 E02 Scenario A、确认生命周期、BCG、ExternalFact、DEF/Issue 和 HTTP 原始证据 artifact（14 天）。

[CI #27](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/actions/runs/41655744187) 首次执行为 Vitest 824 通过、2 失败：新增数据库测试复用了夹具固定幂等键，命中了原有 `IDEMPOTENCY_CONFLICT`。已仅修正测试请求键并在 #28 全量重跑通过；未削弱幂等校验或修改正式来源。HTTP 测试使用实际账号 Cookie、旅行成员授权、数据库变化和错误响应，不以 Service 直调代替。最终 PR head 若有后续提交，须以该 head 的新 CI 通过为准。

## 5. Gate 与后续模块

八项机制中属于 TS 的结构化状态写入、权限和事实消费部分以本 PR 的 CI 为最终工程验收依据。P03 理解分类、P04 真实曝光与个性化、P05 澄清和模糊预算跨会话证据、P01/P15/P16/P19 的行动价值、累计负担、时机与效果，仍由 E03 DC、E04 NAP、E05 UX/运行记录/Evals 以及 Grounding/Action Execution 分别验收。本 PR 不修改这些模块正式原包，不自行批准 E03 Gate，不合并。

技术负责人最终 Gate Review 前仍须核对 PR 最新 SHA、CI 全部结论、数据库/HTTP 实际执行数量、未跳过情况、20 合同一致性和本表每项残留差异。

## 6. 技术交接与产品负责人结论

实际变更文件分为：业务逻辑 `src/server/trip-state/{commands,conditions,assessment}.ts`；专项与回归 `tests/trip-state/{ac8.test,ac8.integration.test,facts.test}.ts`、`tests/http/http.e2e.ts`、`tests/support/{command-oracle.py,command-fixtures.ts}`；来源固定与 CI `specs/ts-ac8-stage-a-2026-11-03/`、`scripts/verify-ts-ac8-source.mjs`、`package.json`、`.github/workflows/e01-ci.yml`；本记录。数据库结构、20 份 TS Schema、生成合同类型、HTTP 路由均无改动，故保持 TS `0.1.0` 的结构契约；权限和事实消费存在明确的收紧行为。原 E02 的 814 项 Vitest 及 102 项 Python 回归由本轮全量测试继续覆盖。

产品侧可按以下边界验收：GitHub 实际新增的是 X01 撤销主体校验、C12 争议事实消费阻断及传播；P03/P04/P05 复用原有对象、命令、确认与历史能力，只增加专项测试。八项机制中确属 TS 的已批准规则已完成工程承接并通过真实运行测试；尚未完成的是 P03/P05 的语义与跨会话原话证据、P04 的真实曝光和个性化效果，以及 P01/P15/P16/P19 的 DC/NAP 行动价值、累计负担、时机选择与 UX/Evals 效果。DC 后续应只读同版 TS，面对权限拒绝、争议事实未知及旧决定 stale 重建上下文；NAP 不可把被阻断的事实当作可执行依据；UX/运行记录负责模糊预算原话与曝光反馈的持续证据。上述后续责任不是本 PR 的 TS Gate 失败，也未在本 PR 假冒完成。

截至 CI #28，阶段 B 已具备提交技术负责人最终验收的工程证据；**这不等于技术负责人已批准 Gate**。PR #11 保持未合并，E03 PR #10 未修改，未自行启动 E03-01/NAP/UX 开发。
