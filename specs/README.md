# ANTU E02 规格交接入口

版本化快照：[`baseline-2026-10-27/`](baseline-2026-10-27/)。这里是从已授权的本地产品工作区逐字节复制的权威正文、机器契约与必要样例；原规格未被修改。应用不从这里直接导入 Python 参考实现，也没有因此实现 Trip State、Decision Context 或 NAP。

**Owner 已于 2026-10-27 明确确认 Trip State 0.1.0 为 E02 正式开发基线。** 确认原话、适用范围和快照哈希绑定见 [开发基线记录](trip-state-development-baseline.json)。原始快照里的待确认状态保留为交接当时的历史记录，不改写来源元数据。当前只授权 E02-01 编码，完成后由技术负责人审核；DC R4 和 NAP 的原审核状态保留。

| 阅读顺序 | 入口 | 用途 |
| --- | --- | --- |
| 1 | [PRD V0.1](baseline-2026-10-27/AI%20Native旅行产品｜PRD%20V0.1.md) | PRD-002/003/007/008/009 等需求、控制权与持久状态边界 |
| 2 | [TS SPECIFICATION](baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/SPECIFICATION.md) | E02 唯一业务状态契约；正文第 2–8、10 节与相邻 Final 文件共同约束实现 |
| 3 | [TS schemas](baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/schemas/) / [rules](baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/rules/) | 原始 Draft 2020-12 `$id`、字段、枚举与状态转换，不改名、不补字段 |
| 4 | [七场景](baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/SCENARIO_VALIDATION.md) / [机器轨迹](baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/examples/scenario-traces.json) | A 为首条闭环；B/C/G 和反例约束偏好、淘汰、纠错与决定历史 |
| 5 | [DC 工程契约](baseline-2026-10-27/decision-context-v0.1/04_工程规格/01_运行契约与任务定位.md) | R4 / Runtime 0.2.0 的依赖边界；本轮不实现其运行模块 |
| 6 | [NAP README](baseline-2026-10-27/Next-Action-Policy-V0.1/README.md) / [DECISIONS](baseline-2026-10-27/Next-Action-Policy-V0.1/DECISIONS.md) | 0.1.0 行为/权限约束与未批准事项；本轮不实现 Policy |
| 7 | [E02 编码任务](../docs/E02最小编码任务.md) | 对上述来源的实现范围、数据库基础设施设计及通过标准 |

## 溯源与读取校验

[`manifest.json`](baseline-2026-10-27/manifest.json) 逐文件保存原工作区相对路径、字节数、SHA-256，以及版本、状态、未决事项和未交接内容。快照共 155 个来源文件（约 5.1 MB 原始字节），不包含重复阅读镜像、完整旧 Handoff 讨论、依赖缓存、环境文件或生产数据。

```sh
npm run specs:verify
```

该命令在本地、GitHub Actions 和云端任务中都可执行，不依赖 Mac 的上级目录；它校验字节完整，并核对独立开发确认记录的快照绑定，不代表业务规则已实现或 E02 已验收。`scripts/specs.mjs export <已授权的产品目录>` 是来源复制工具，已存在的版本化清单禁止覆盖。

TS `tripstate/` 和四份语义测试文件仅作原有参考运行逻辑与移植对照；分发打包工具和只验证阅读镜像的 `test_package.py` 没有交接。DC 交接当前机器契约、两份样例、声明源和五份工程规格，没有交接其运行模块实现及 legacy 契约。历史验证报告只作原来源状态记录，不能算作本次新执行结果。

## 必须保留的未决事项

1. **审核范围：** TS 0.1.0 开发基线已获 Owner 明确确认；E02 后续切片按技术负责人审核逐步实施。DC 仍为最终审核候选；NAP `owner_approval=NOT_RECORDED`、C3-R2 有条件通过。
2. **DC 版本：** 运行索引、代码和机器 Schema 为 `0.2.0`，原工程正文第 3 节表格仍写 `0.1.0`。正文照原样复制，未偷偷修正；正式 DC/NAP 接入前需规格负责人处理。E02 不实现该模块。
3. **NAP 路径：** 原文指向同级 `../nap-c3-validation`，实际来源在 NAP 内部的 [nap-c3-validation](baseline-2026-10-27/Next-Action-Policy-V0.1/nap-c3-validation/)。10 份来源均已复制且哈希与原索引匹配；没有修改原链接或宣称原包检查器可直接运行。
4. **未复制的个人路径元数据：** V2 总纲原文和 C3 `source-manifest.json` 含本机个人路径，未作为正文上传。保留原摘要和源关联于本次 manifest 的 `related_sources_not_copied`；E02 以已完整交接的 PRD 和 TS 契约实施，不凭摘要补写 V2 内容。
5. 原交付 `package-index.json` 保留作来源指纹；其中指向被排除的阅读镜像或打包内容的路径不作为本交接包完整性断言。本页是云端阅读入口，实际交接集以本次 manifest 为准。

任何原始规格的字段或规则变更都需原模块按版本流程另行处理，不在本 PR 中编辑这些来源文件。
