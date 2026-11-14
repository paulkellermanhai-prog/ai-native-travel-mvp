# 产品、合同与参考快照

这里保存冻结来源和机器契约。TypeScript 源码、合同生成器、Python 对照、测试与 CI 直接引用这些文件；看起来重复的历史版本承担不同的来源/对照职责，不能按文件名去重。

| 目录 | 当前用途 |
|---|---|
| [baseline-2026-10-27/](baseline-2026-10-27/) | 155 份原始来源、PRD、TS 契约/转换规则、历史 DC/NAP 来源；部分为运行直接依赖 |
| [ts-ac8-stage-a-2026-11-03/](ts-ac8-stage-a-2026-11-03/) | TS AC8 参考实现、测试及来源包；ZIP 摘要也被检查 |
| [dc-0.1-calibration-2026-10-29/](dc-0.1-calibration-2026-10-29/) | 历史 DC 校准，仍用于逐版本来源验证 |
| [e03-00-reference-2026-10-29/](e03-00-reference-2026-10-29/) | E03 补充参考来源与可用性清单 |
| [dc-ac8-r6-calibration-2026-11-05/](dc-ac8-r6-calibration-2026-11-05/) | 当前 R6 DC 合同、参考实现及对照依赖 |
| [nap-r3-2026-11-06/](nap-r3-2026-11-06/) | NAP 运行 Schema 与固定来源 |
| [nap-candidate-2026-11-06/](nap-candidate-2026-11-06/) | 早期 NAP Schema 对照，仍由测试读取 |
| [trip-state-development-baseline.json](trip-state-development-baseline.json) | Owner 开发基线记录及快照摘要绑定 |
| [e03-01-oracle-lock.json](e03-01-oracle-lock.json) | 参考文件与选择的固定来源锁 |

产品目标先读 [PRD](baseline-2026-10-27/AI%20Native旅行产品｜PRD%20V0.1.md)。当前实现与生产边界见[工程交接](../handoff/README.md)；不要用冻结快照当年的待审文字覆盖后续工程状态，也不能因为源码已经实现就改写旧快照中的审批元数据。

```sh
npm run specs:verify
npm run specs:ac8
npm run contracts:check
npm run dc:check
```

`specs:verify` 核对 155 来源文件及开发基线摘要，不证明全部业务完成。Python 参考只供独立对照，不是本地网页或应用的服务端入口。原目录和文件字节在本次整理中保持不变；本 README 是可维护导航，不属于冻结正文。
