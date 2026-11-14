# 2026-11-14 项目整理记录

## 本次处理

- 保留本地一键启动、原型素材和模板，以及聊天刷新恢复修复。
- 将旧阶段报告、机器证据和验收回执分类归档；每个迁移位置及来源摘要见 [project-cleanup.json](project-cleanup.json)。
- 删除仅适用于 E01 的 `docs/工程目录与保留说明.md`，以当前 [项目地图](project-map.md) 和 [文件管理规则](file-management.md) 替代。
- 删除本机生成的 `scripts/__pycache__/`；补充虚拟环境、日志和交付目录忽略规则。
- 重写根 README、当前 AGENTS、规格和宿主模块入口，明确网页原型、TypeScript 后端和 Python 参考的区别；原 AGENTS 与宿主早期记录已归档。
- 当前 E03/E04 进度只更新文档位置，不改变状态、权重或验收结论。E03 看板按原脚本重新生成。

## 有依据地保留

`src/`、`prisma/`、全部业务测试、工具脚本和 `specs/` 冻结文件保持原路径。看似重复的规格版本及 Python 文件由源码、合同生成、测试和 CI 引用。素材中的宽幅地图、世界地图等也由运行代码动态选用，没有因首页未显示而删除。

独立体验查询补丁和 UX02/R7 仍存在未整合差异，本次未将其当作重复代码删除。历史 JSON 回执按原字节保留，旧路径通过迁移清单对应新位置。

## 验证

已实际通过：

- `npm run project:check`：68 个迁移位置、13 份归档 JSON 回执、15 份当前文档和 112 个本地链接。
- `npm run test:prototype`：5/5，覆盖聊天刷新恢复、旧记录、未启动探索时的对话、无效记录和存储失败。
- `npm run specs:verify`：155 份原始来源及开发基线摘要。
- `npm run specs:ac8`：108 个规范来源摘要、20 个 Schema、7 场景/31 步及来源 ZIP 摘要。
- Python DC 历史校准、R6 来源校验及 E03 参考审计通过；原参考测试 99/99，R6 105/105，TS AC8 126/126，无失败、错误或跳过。
- 与整理前逐文件对照：436 个冻结规格文件内容未变；232 个业务源码、测试、原型、候选及锁文件内容未变。
- E03/E04 进度 JSON 的差异仅为路径；验收状态和权重保持原值。

完整工程检查由 [PR #40 的 GitHub CI](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/40/checks) 在锁定 Node/npm、一次性 PostgreSQL 17 和隔离身份环境中执行，包含类型、Lint、真实 PG 测试、生产构建与实际 HTTP 验收。状态以该 PR 当前 head 的检查为准；上述本地通过项不能替代这部分联合验证。

## GitHub 同步

本地工作分支为 `chore/project-organization`。此前未接受邀请时连接没有写权限；用户已接受协作邀请，本轮重新核验 GitHub 连接 `push: true`，并确认 CLI 登录有效。整理结果已推送到独立分支并提交 [PR #40](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/40)，主分支仍需审阅后决定合入；本记录不表示已经合并或部署。
