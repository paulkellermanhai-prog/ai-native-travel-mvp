# 辅助脚本

从仓库根目录执行。文件保留原路径，避免破坏 package、CI 和测试引用。

| 用途 | 脚本 | 运行要求 |
|---|---|---|
| 本地网页 | `serve-prototype.py` | Python 3；静态预览，浏览器保存记录 |
| 项目管理检查 | `check-project-layout.mjs` | Node；检查当前文档链接、文件迁移与归档回执完整性 |
| 来源快照校验/授权导出 | `specs.mjs` | Node；正常使用 `npm run specs:verify` |
| TS 来源锁和契约 | `verify-ts-ac8-source.mjs`、`trip-state-contracts.mjs` | Node；生成类型需要 npm 依赖 |
| DC 契约 | `dc-contracts.mjs` | Node 与 npm 依赖 |
| TS Python 对照 | `trip-state-oracle.py` | Python Oracle 依赖；供测试调用 |
| DC 来源与参考校验 | `check-dc-calibration.py`、`check-dc-ac8-r6.py`、`audit-e03-00.py`、`e03-01-reference.py` | Python Oracle 依赖；只作来源/参考验证 |
| DC 选择及注释对照 | `e03-02-selection-oracle.py`、`e03-02-annotation-oracle.py` | 测试用 stdin 输入，不是网页 API |
| 数据库连接检查 | `db-check.mjs` | `DATABASE_URL` 与 `pg` 依赖 |
| 一次性测试库准备 | `prepare-storage-tests.mjs` | 明确测试开关、迁移身份和私有输出文件；勿指向生产库 |
| DC/NAP 候选 SQL 安装 | `e03-candidate-installer.mjs`、`e04-candidate-installer.mjs` | 按内部测试/交接范围使用，不等于正式生产迁移 |
| SQL 升降级演练 | `e03-evidence-migration-rehearsal.mjs` | 隔离测试库 |
| Next 内部网关检查 | `e03-next-start-gateway-check.ts` | 完整 Node/数据库/身份环境 |
| 操作员身份与授权 | `auth-admin.ts`、`grant-identity-runtime.mjs`、`grant-confirmation-runtime.mjs` | 显式操作员权限和私有配置；不在网页启动时自动执行 |
| Python 测试依赖 | `requirements-oracle.txt` | 在独立虚拟环境安装，不提交虚拟环境 |

普通看网页只运行第一项。后端完整验证流程见 [CI](../.github/workflows/e01-ci.yml) 和[项目 README](../README.md)。
