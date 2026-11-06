# ANTU｜UX-01 Flow Coverage Matrix V0.1

**归档状态：UX-01｜Owner Approved / Archived**  
**Owner 验收日期：2026-10-28**

## 任务目标与范围

UX-01 将 PRD-001～009、A01～A09 映射到可验证的核心用户任务，核对来源版本与审核状态、任务间依赖及跨会话恢复的体验覆盖。六条 Flow 是需求覆盖与验证单元，不是固定线性旅程或六套必须独立设计的完整流程。本包不确定最终页面结构、控件或 AI 交互形态，也不改变 MVP 与已确认机制。

## 子任务完成状态

| 子任务 | 完成内容 | 状态 |
|---|---|---|
| UX-01.1 | 核对 PRD、Trip State、Decision Context、NAP 的版本、审核边界和现有 UX/UI 成果 | 完成 |
| UX-01.2 | 建立 F1–F6 覆盖矩阵，逐项核对 PRD-001～009、A01～A09 | 完成；Owner 验收 |
| UX-01.3 | 纳入 R1–R4 跨会话恢复横向检查，记录依赖并收口 Owner 判断 | 完成；Owner 验收 |

## 正式交付物

本目录仅维护以下两份正式文件：

1. [README.md](README.md)：交付入口、来源状态、Owner 裁决和后续使用说明。
2. [Flow-Coverage-Matrix-V0.1.md](Flow-Coverage-Matrix-V0.1.md)：F1–F6 覆盖矩阵及 R1–R4 横向检查。

## 来源版本与审核状态

| 来源 | 本包采用的版本与状态 |
|---|---|
| [项目思考总纲 V2](<../../AI Native旅行产品｜项目思考总纲 V2.md>)、[PRD V0.1](<../../AI Native旅行产品｜PRD V0.1.md>) | V2 为最高产品基线；PRD V0.1 标为产品需求基线，数据覆盖与用户效果仍待验证。 |
| [Trip State Schema 入口](../../trip-state-schema-v0.1/00_从这里开始.md)、[包索引](../../trip-state-schema-v0.1/package-index.json)、[开发基线确认记录](<../../MVP Engineering/specs/trip-state-development-baseline.json>) | 契约 0.1.0；原包标为 Ready for V1 Review。Owner 已明确确认其为 E02 开发基线；此确认不等于生产或全部 UX 验收。 |
| [Decision Context 入口](../../decision-context-v0.1/00_从这里开始.md)、[包索引](../../decision-context-v0.1/package-index.json)、[恢复范围决策](../../decision-context-v0.1/03_评审与工程衔接/10_首版跨会话恢复范围决策.md) | R4／运行合同 0.1.0，包含跨会话恢复；恢复范围已由 Owner 确认，完整工程候选仍待最终人工审核。 |
| [NAP 入口](../../Next-Action-Policy-V0.1/README.md)、[包索引](../../Next-Action-Policy-V0.1/package-index.json)、[验证记录](../../Next-Action-Policy-V0.1/quality/validation-report.json) | NAP 0.1.0 工程规格评审候选；有效依赖为含恢复能力的 Decision Context 0.1.0。95 项只读检查通过，Owner 最终审核仍未记录。 |

目前没有独立的 UX/UI 设计成果。PRD 中的界面示意和 MVP Engineering 启动页不作为已审核 UX/UI 设计。

## Owner 正式验收结论

Owner 已验收 UX-01《Flow Coverage Matrix V0.1》，并批准：

1. F1–F6 六条需求覆盖与验证单元，跨会话恢复以 R1–R4 横向检查覆盖，不新增 F7。
2. F1“意愿启动与探索”为首条 P0 验证任务，并验证它与推荐、比较、修改和确认等其他 Flow 的自然衔接。
3. 六条 Flow 不等于固定线性旅程；实际核心旅程数量与交互组织方式由 UX-02 继续设计。

这项验收仅适用于 UX-01 交付物，不代替 Decision Context 或 NAP 的最终规格审核。

## 遗留依赖与后续使用

[MVP Engineering 的 2026-10-27 冻结快照](<../../MVP Engineering/specs/README.md>)仍保留修复前的 DC/NAP 版本描述；后续工程消费当前机制前须另行同步并核对。UX-01 不修改该快照。

UX-02 应以[覆盖矩阵](Flow-Coverage-Matrix-V0.1.md)作为任务与验收清单，可将六个单元组织为更少的主要用户旅程，并保持跨单元返回与恢复路径。聊天、地图、时间轴和结构化工作空间如何组合，信息如何呈现，AI 何时及如何介入，以及恢复状态的具体界面表达，均留给 UX-02／UX-03 探索；本包未作定稿。
