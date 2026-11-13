# 技术接手入口｜2026-11-13

本次按 Owner 要求把本地可用工程集中合并到原仓库，供后续配置和开发。代码交接不等于生产上线或补记历史技术验收。

## 从哪里开始

- `src/`、`prisma/`、`scripts/`、`tests/`：E02 Trip State、E03 Decision Context 与 E04 NAP/工具运行主线。基于 PR #38 的 `84f1220cfba33d6a9cda5ce65f72966707d41d9d`，保留其完整历史和修复。
- `prototypes/egypt-trip/`：本地 F1–F2 网页原型及所需素材。运行 `python3 -m http.server 8080 --directory prototypes/egypt-trip`，访问 http://localhost:8080 。这是独立交互原型，尚未连接真实后端；交通及体验内容不能作为真实供应商服务承诺。素材来源见同目录《地图与照片来源.md》。
- `handoff/candidates/experience-query-local.patch`：本地未提交源码和测试差异。其源码基线为 `fc22c1991031bea099c79ee6c75916766d21a8d3`（本地 c6f2cc2 的后续差异只在文档）。该候选增加体验适用性查询，同时移除独立费用小计能力，与主线后续修复重叠，故保留为待审补丁，未直接覆盖运行代码。请在独立分支以 `git apply --check` 检查后审阅、整合、重新回归。
- [PR #13](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/13)：已在原仓库的 UX02/R7 独立候选，含恢复预览等功能；与当前 R6 主线存在规格及接口差异，保留原分支供后续整合，未当成重复代码丢弃。早期 E03/E04 候选分支也仍在远端，主线采用后续集成版本。

## 环境与验证

使用 `.nvmrc` 的 Node 24.22.1、npm 11.19.1、PostgreSQL 17。根目录执行 `npm ci`，以 `.env.example` 为模板配置本机私有环境。数据库迁移身份、应用运行身份、认证身份分开；真实密码和密钥只保存在环境中。

最完整的可复现配置与验证顺序见 `.github/workflows/e01-ci.yml`：安装 Python Oracle 依赖、生成 Prisma Client、创建隔离测试数据库身份、执行合同/来源校验、类型检查、Lint、真实 PG 测试、build 和真实 HTTP 测试。`npm run check` 和 `npm run db:check` 需要对应环境；没有数据库的跳过测试不代表完整通过。生产环境请按 `docs/cloud-environment.md`、`docs/E03最终工程交接索引.md` 及各模块文档配置。

## 仍需技术人员完成

真实供应商、真实埃及数据、完整行程求解/重算、模型及网页与后端接线、生产 E11 配置和部署仍需后续工程与验证。PR #38 的工具实现包含合成查询和有限已知项目费用小计，不能代表完整旅行总价。历史验收状态以对应记录为准，本次合并不追认未完成验收。

本次不上传本机 `.env`、凭证、数据库数据、依赖树、构建缓存、iCloud 重复文件、截图和无关产品研究资料。仓库已有合同快照及测试依赖保留以便复现。
