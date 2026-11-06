# E03-05／06 本地并行实现交接

本切片遵循 `E03-03-07-PARALLEL-TECH-RELEASE-2026-11-06-01`，基于治理提交 `16b5d21673a41013c5130ac21f30102771cc400b`（父 `450f9949cae3fb48db869daed6e69ecf757dd331`），冻结 R6 及既有 TS/C12；E03-02 接受 head 不变。只修改本任务独占目录，不修改共享接口、Prisma、CI、既有源包或看板；不是阶段 PASS、远端发布、合并或部署。

## 实际候选

| 位置 | 实现 | 限制 |
| --- | --- | --- |
| `checkpoint-core/index.ts` | 复用原 contract 检查格式、版本、主体旅行字段、任务/焦点关系、Unicode 原话范围、草稿和 2MB 边界；摘要复用既有 canonical JSON | 没有真实授权，不采集真实现场；R6 的任务和上下文其他规则仍需主任务连接。 |
| `checkpoint-core/retry.ts` | 本实例失败的原保存请求快照与串行仅保存重试，不重放业务命令 | 需主宿主安全绑定实例、生命周期和真实权限；进程重启无待重试内容。 |
| `checkpoint-store/migration.sql`、`repository.ts` | 专属 SQL 候选：按 owner/trip/workspace 的头与幂等回执；事务锁/CAS；事务提交后 ACK、不确定提交处理；加载、列举、版本、到期、删除墓碑 | **未经真实 PG 执行或审核。SQL 函数是内部原语，接受范围字符串且未在数据库事务内验证真实 Session／成员／workspace；任何获得 EXECUTE 的角色可操作任意范围。必须先由主集成人补闭合权限边界、运行时最小授权及专项审查，不能挂到生产或公开路由。** 此目录中的 SQL 不属于正式迁移链。 |
| `recovery-core/index.ts`、`generation.ts` | 基于当前 TS 计算版本落后拒绝、缺失、比较/草稿陈旧、已暂缓和重开问题；本地代次轮换原语 | 没有恢复或安装真实 Turn/Task；代次未接真实 Grant/Packet 缓存，不能称旧授权在实际宿主已失效。 |
| `recovery-service/inspection.ts` | 内部只读检查：以现有 Session 与 TS 服务取当前状态，按用户/旅行/固定宿主工作区读取保存点，检查前后用户、状态及保存点；只返回分类摘要 | 未接 E11 屏障，不返回原话、草稿内容、任务或 `scene-restored`；未开放路由。workspace 只能由可信宿主固定；最后一次复验之后与撤权/删除不保证严格原子。未联测真实 Session/PG。 |

R6 `datetime` 支持微秒，当前仓储传入 JS `Date` 只有毫秒精度；UTC 文本输出对齐 Python `isoformat` 的秒/六位微秒格式，但微秒级边界尚须明确共享时钟接口及同输入 R6 对照，不能宣称精确等价。R6 和 E11 各自保留政策不同：当前仓储可接受宿主指定的保存期限；检查服务只读时使用 null，不建立生产保留配置。

## 验证与测试入口

- 先前冻结 R6 SQLite：原恢复 47 项＋专用 5 项 **52 通过**，包含独立进程、CAS、SIGKILL 和旧授权参考测试；与本 TypeScript / PG 应用不是同一验收。
- 当前新增纯测试覆盖原合同形状、非法字段、旧状态、引用和 Unicode 证据、2MB 拒绝、陈旧/缺失、仅保存重试与本地代次；本地执行 **8 通过、6 项 PG 跳过**。本候选 typecheck 和专属目录 lint 通过。
- `tests/decision-context/checkpoint-store/postgres.test.ts` 含隔离库重复迁移、受限角色、独立连接和独立进程 CAS、提交前故障、提交后丢回执的故障注入、删除防复活、隔离与到期。**这些测试目前未运行**。本机 PATH 未发现 PG 或 Docker，`npm run db:check` 因未配置 `DATABASE_URL` 失败。需要 PostgreSQL 17 的本机专用测试库，名称以 `antu_e03_test_` 开头，并显式设置 `E03_CHECKPOINT_TEST_ADMIN_URL`；其管理员需有创建角色和数据库连接授权能力。CI 若无该变量会失败而不会将真实 PG 项算通过。测试只检查测试角色无表/DDL 直接权限；这不证明数据库内对调用函数的用户级授权。
- 当前测试故障点是应用层模拟提交前/后，而非真实数据库网络中断或生产故障；未来需补真实数据库终止连接、后端进程终止、响应不确定、已有 E02 库增量迁移、备份恢复及清理失败。不可把 SQLite 的 SIGKILL 证据换成 PostgreSQL 证据。
- Node `24.22.1`、npm `11.19.1`；依赖从本机已有工作区复制，不是一次新的 `npm ci`。本机首次 `npm run check` 因 Prisma 尝试写工作区外的缓存被拒；使用 `/tmp/e03-05-06-tools/schema-engine` 的本地副本配置 `PRISMA_SCHEMA_ENGINE_BINARY` 后，来源、合同、Prisma 验证/生成、typecheck 和全项目 lint 通过。全量并行 Vitest 运行时已出现 5 个既有测试失败，执行未结束便中断；这些失败的 5 个测试以 `--maxWorkers=1` 分别重跑全部通过，但原因尚未确证。另一次 `--maxWorkers=2` 全量复跑在完成前中断，**全量 check 未通过，完整回归和 build 未完成**。不能把无 PG 的跳过记为通过。

## 实际连接点和下一步

主集成人应先评审 SQL 的事务语义和所有权/授权机制，建立拥有明确迁移角色及受限运行角色的隔离 PG、真实授权 guard 和可信 workspace 绑定；不同连接/进程、提交边界、删除/到期、迁移、权限与锁源对照全部通过后才能选择精确提交接线。05 不依赖完整 Packet；06 可在实际存储和真实 Task/Session 接口就绪时接入，而不等待 04 或整个 05 母阶段 PASS。恢复原话必须先接 E11 删除/到期屏障；真实旧 Packet/Grant/提案/写缓存失效以及跨进程恢复须在实际宿主存在后验，不得用本地代次原语或测试桩冒充。涉及 E11 备份恢复先重放删除标记、保留/审计具体生产配置的事项仍单列真实验收和既有决策门槛。
