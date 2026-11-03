# ANTU｜Trip State 八项机制阶段 B 工程同步与验收

状态：**候选，待最新 PR head 的 GitHub CI、PostgreSQL/HTTP 结果和技术负责人 Gate Review**。本文件只记录阶段 B 的 Trip State 工程工作；不宣称八项产品机制的端到端体验完成。

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

待最新 PR head 的 GitHub CI 证明：隔离 PostgreSQL 17 下无跳过的全量 Vitest、原 Python 102、阶段 A Python 126、真实 Next.js HTTP（含新增 X01/P05）、Prisma/Typecheck/Lint/Build 和来源检查。CI 未通过时本报告不得改为 PASS。HTTP 测试使用实际账号 Cookie、旅行成员授权、数据库变化和错误响应，不以 Service 直调代替。

## 5. Gate 与后续模块

八项机制中属于 TS 的结构化状态写入、权限和事实消费部分以本 PR 的 CI 为最终工程验收依据。P03 理解分类、P04 真实曝光与个性化、P05 澄清和模糊预算跨会话证据、P01/P15/P16/P19 的行动价值、累计负担、时机与效果，仍由 E03 DC、E04 NAP、E05 UX/运行记录/Evals 以及 Grounding/Action Execution 分别验收。本 PR 不修改这些模块正式原包，不自行批准 E03 Gate，不合并。

技术负责人最终 Gate Review 前仍须核对 PR 最新 SHA、CI 全部结论、数据库/HTTP 实际执行数量、未跳过情况、20 合同一致性和本表每项残留差异。
