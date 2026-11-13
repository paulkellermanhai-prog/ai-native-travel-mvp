# DC-AC8-PROTOCOL-01｜技术裁决、宿主核查与 E03 接口交接

日期：2026-11-05。状态：**技术方案已裁决；DC-AC8-PRIVACY-01 产品策略已获 Owner 批准；宿主证据接口与真实联测待 E03；供最终 Gate 复核。** 本记录只处理跨轮未提交原话和解释证据，不重开八项机制。技术裁决是优先由受信宿主交互记录承载，DC 按需读取并组织当前任务；TS 和 DC Checkpoint 都不保存完整对话流水。DC 0.1.0、20 份 Schema、Checkpoint 格式 1 和已实现的首版现场恢复合同保持。Owner 裁决来源与期限见[独立记录](17_DC-AC8-PRIVACY-01_Owner裁决与执行边界.md)。

## 1. 当前宿主能力核查

核对本地 `MVP Engineering TS Stage B` commit `0078bb542fd4ac81343a602d5f0fe4e62a42620c`，与 2026-11-05 查询的 GitHub PR #11 head 一致，PR 仍 open、未合并；PR #10 仍 draft/open、head `c15da4a7377c74537525bb1e37c0b375644e7862`、Gate A 候选未合并。代码范围为 `prisma/schema.prisma`、`src/server/auth/`、`src/server/http/`、`src/server/trip-state/internal/persistence.ts` 与 `src/app/trips/[id]/[...resource]/route.ts`。

| 代码位置 | 已有能力 | 对本协议的真实限制 |
|---|---|---|
| `src/server/auth/authorization.ts::sessionHost` | Cookie 会话经鉴权库核验，按 `tripId/userId` 查 TripMembership；写入前可在事务内重查会话/成员资格 | 可复用身份与旅行保护原则，但没有交互记录读取器或 task 绑定校验 |
| `src/server/auth/internal-service.ts` | 受信内部 Model/System/Tool 授权通道 | 不等于用户原话记录来源；服务身份不能自行声明用户说过什么 |
| `src/server/http/trips.ts::handleTripHttp`、`src/app/trips/[id]/[...resource]/route.ts` | 只暴露受权 TS `state`、`changes` history、preview/submit/confirm；资源不存在时拒绝 | 无交互事件写入或按主体/旅行/任务查询历史原话的路由 |
| `src/server/trip-state/internal/persistence.ts`、`prisma/schema.prisma` | TripStateDocument/History/Proposal/Idempotency 及 Auth/TripMembership 表；history 由业务 intent/change 组成 | 只保存已提交业务操作和守卫记录；无独立 Conversation/Interaction/Event 记录表或未提交原话检索索引 |
| `src/app/page.tsx` 与现有 `src/app/` 路由 | 当前应用入口和上述 TS HTTP 路由 | 未见真实对话入口、事件捕获或可授权的交互记录 API |

因此当前宿主**不具备**经身份、旅行、任务与来源核验的跨轮未提交证据读取能力。TS history 和 DC Checkpoint 的最近 event 均不能冒充完整交互记录；这是一项待实现的宿主能力，不是现行 DC 机器合同缺字段的理由。以上是指定代码树的核查，E03 落地前须按当时 head 再核。

## 2. 提议的宿主内部接口与版本

工程能力 ID **DC-AC8-E11**，分类 **New / Host Adapter（宿主能力，供 DC/解释器消费）**。接口名暂定 `HostInteractionEvidenceReader`，内部契约标识暂定 `host-interaction-evidence/v1`，**仅为 E03-01 待锁定的宿主接口版本，不是 DC 0.1.0 的 HTTP 路由、Schema、URI 或迁移版本**。可信 `event_id` 必须在任务解释前由宿主生成，`event_id → task_key` 在任务注册后关联；原始记录不随解释调整而覆盖。完整字段、事务和失败规则见[独立数据契约](16_E11宿主交互证据数据契约与验收轨迹.md)。实现位置由 E03 工程在现有认证与存储边界内确定，不在本地参考包伪建生产模块或新 TS 业务表。

| 项目 | 最小要求 |
|---|---|
| 调用与范围 | E03-03 先以当前认证会话保存原话并返回可信 event_id，任务尚可未知；注册 Task 后再关联。E03-06 恢复现场后按已验证 task_key 有界读取旧证据；不做无限对话转储。 |
| 返回证据 | 每条具稳定记录 ID、原文、来源/入口引用、事件发生时间、记录时间、受信主体/旅行/任务绑定和可核对顺序；必要时给明确的不可得/删除/过期结果。原话和元数据由受信记录生成，不接受模型补写。 |
| 授权与追溯 | 查询时重验当前 Session、TripMembership、任务归属和记录 owner；共享旅行不意味着可读他人未提交表达。服务凭证不能冒充用户原话。按 Owner 已批准的 30 天/180 天/12 个月最早截止与主动删除执行，访问审计最小化；工程落实见 E11 数据契约。 |
| DC 使用 | 解释器仅以核过的相关片段校准当前 `Task.question/certainty/evidence`；当轮 `evidence` 仍精确指向本轮 event 文本。旧记录在宿主侧保留来源关联，不塞入 `packet.objects`、TS ExternalFact 或 Checkpoint。未验证的旧语境不产生 `explicit`、授权或已生效状态。 |
| 失败保护 | 缺记录、拒绝、跨旅行/任务、来源或时间不符、乱序/重复、记录过期与服务失败均不能被合成摘要填补；保留当前输入和已保存 Task 的未知，按现有恢复合同重建 TS/Packet，重要动作仍需当前用户输入与 Grant。不能因日志故障报 Checkpoint 已损坏或回放旧授权。 |

本接口是**宿主内部读取能力**，不要求在本轮修改 DC 20 Schema 或 Checkpoint 格式。若 E03 未来决定公开新 API 或向 Packet 增字段，必须另行评审 DC 版本、NAP Packet/Event 引用和迁移；本裁决没有预先批准这种扩展。

## 3. 实施阶段与验收

1. **E03-00/01：**将本地最新包、20 Schema 和新索引作为待批准候选校准 PR #10；保留旧选择和 Gate 记录。锁定宿主接口版本、来源、读取上限、权限、Owner 已批准的期限优先级与删除合同；备份/审计的具体有限周期和超 12 个月续存截止仍须在生产配置前锁定，当前可用隔离测试数据验证。
2. **E03-03：**实现先记录、后关联的受信写入与按主体/旅行/任务的有界读取，同时实现到期阻断、主动删除和可重试清理；不写 TS/Checkpoint 的完整对话流水。正例：同任务跨轮纠错/跳过后可溯源；反例：伪造 owner/task/source、跨旅行/成员、乱序/缺页、过期/删除记录均不能提升解释确定性。
3. **E03-06：**恢复最后成功保存的 Task/Focus/草稿和当前 TS 后可选读取旧交互证据；失败时保留未知、旧事件只读、runtime_id 轮换，当前业务守卫不变。测进程重启、权限撤回、缺日志、旧授权拒绝及已删/到期证据不复活。
4. **E03-07：**用真实会话、持久记录、HTTP/内部调用和生产等价数据库做跨轮正反联测，并测自动清理、删除竞争、备份恢复先重放删除标记、最小审计和用户告知；单独报告来源完整性、授权、保留、任务关联与失败降级。Python 合成输入测试只证明现有结构/恢复边界，不能替代此项。

## 4. 本地参考范围与 Gate 判定

本轮新增三项参考测试：同一任务较新事件持久化后只恢复该事件、旧未提交原话不被伪造；新事件来源区段错误时不能覆盖最后成功保存点；一个已提供事件可在现有 DC 合同内登记多个 Task。原有歧义只读、跨账号拒绝、旧 event/Grant 不可重放、状态更新后重建等测试继续跑。**这些测试使用合成输入，不调用真实宿主日志，也不证明可信记录或关联接口已实现。**

DC-AC8-PROTOCOL-01 的**技术方案已裁决**，但 E11 宿主实现与真实联测仍待 E03。最终 Gate 可复核本地规范、0.1.0 合同、来源摘要和参考测试；不得把“方案通过”写成“完整解释证据恢复已上线”。PR #10 39 项精选来源中有 8 项与本地新包失配，须按新清单重选并保留历史；NAP 69 项来源当前 14 项失配（此前 13 项加本轮发现的 PRD 1 项），归后续 NAP 独立校准，本轮不改 NAP 原包。
