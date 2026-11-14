# ANTU 工程工作规则

用户已于 2026-11-14 授权清理和组织仓库，并保留本地网页启动与聊天保存修复。原 2026-11-13 工作规则保存在 [历史规则](docs/archive/governance/AGENTS-2026-11-13.md)，其中阶段性限制属于当时记录；当前工作以用户最新指令和本文件为准。

## 入口和范围

- 先读 `README.md`、`docs/project-map.md`、`docs/file-management.md`。
- `prototypes/egypt-trip/` 是本地网页；`scripts/serve-prototype.py` 只提供静态预览服务，数据保存在浏览器。
- `src/server/` 是 TypeScript 业务后端；原型、模型和数据库尚未完整接线，不能把页面演示描述为后端联合验收或生产上线。
- `specs/` 中 Python 是冻结参考与测试对照；不要将其误认成网页服务。
- 当前状态看 `handoff/README.md`、`docs/E03最终工程交接索引.md` 和 E04 看板。历史文件只证明其指定提交和范围，不自动代表当前实现。

## 修改和文件管理

- 开始修改前说明假设与取舍，使用工作分支，小范围修改并保留其他人的工作。
- 冻结来源、Schema URI、版本、Oracle 和包字节保持不变。`specs/` 被源代码、测试和 CI 引用，未经依赖核查不能移动或删除。
- 历史验收与 Gate 回执保留在 `docs/archive/`；JSON 回执的内容保持原样。唯一进度源 `docs/e03-progress.json` 与 `docs/e04-progress.json` 不重复维护；E03 看板用原脚本生成。
- `handoff/candidates/experience-query-local.patch` 和远端 UX02/R7 候选仍有独立差异，未经审阅不得覆盖主线或删除。
- 文档和文件迁移后更新当前入口、链接和 `docs/project-cleanup.json`。不要批量修改冻结快照中的历史文本。
- 目录位置遵守 `docs/file-management.md`，不在根目录堆放报告、截图、压缩包或重复工程。
- 不提交 `.env`、凭证、数据库、依赖树、缓存、生成客户端或本机运行工具。
- 使用分支与 PR；未获相应技术验收，不自行合并或部署。不改变仓库安全设置。

## 验证和事实边界

- 后端使用 Node.js 24.22.1、npm 11.19.1、PostgreSQL 17；执行 `npm ci`、`npm run check`、`npm run db:check`。
- 目录整理执行 `npm run project:check`、`npm run specs:verify`、`npm run specs:ac8`；网页记录修改执行 `npm run test:prototype` 并做浏览器刷新验证。
- 后端合同修改执行 `npm run contracts:check`、`npm run dc:check`；需要 Python Oracle 时按 `scripts/requirements-oracle.txt` 安装独立环境。
- 真正的 PG 测试需要专用一次性测试库和私有 `E02_STORAGE_ENV_FILE`；缺数据库而跳过不能记为完整通过，CI 不允许跳过。
- `/api/health` 只证明进程存活。原型记录、合成交通、内部 MVP、真实供应商与生产验证分别报告。
- 报告实际执行结果和环境限制，不能以旧 CI、重跑成功或文档进度代替当前验证。
