# DC-AC8｜验证记录、来源摘要与跨模块交接

日期：2026-11-05。状态：本地 Decision Context **最终 Gate 复核候选**；DC-AC8-PROTOCOL-01 技术方案已裁决，宿主接口待 E03，不表示 GitHub E03 Runtime 已实施或 PR #10 Gate A 已通过。本记录与[原机制和逐规则追踪](12_DC-AC8机制融合追踪与规格变更.md)、[E03 工程能力映射](13_DC八项机制融合｜E03工程能力增量与实施映射.md)、[协议裁决](15_DC-AC8协议裁决与宿主证据接口交接.md)、[E11 独立数据契约](16_E11宿主交互证据数据契约与验收轨迹.md)共同构成交接入口。

## 1. 来源、版本与改动边界

| 来源 | 本轮核对结论 |
|---|---|
| 本地 `decision-context-v0.1/` | 原 R4 0.1.0 完整包：17 份正式索引正文、20 份 DC Schema、Python Runtime/API/Checkpoint、99 项原 DC 参考测试；原 59 项清单条目在编辑前逐项匹配。首版跨会话恢复是原 0.1.0 已纳入的能力。 |
| 本地 `trip-state-schema-v0.1/` 与 PR #11 阶段 A 来源 | TS 权威业务状态、只读 `DecisionContext`、revision、X01 原确认人撤销和 C12 争议事实消费是 DC 接口依据。阶段 A 来源选择文件 SHA-256：`2767f43c912bb8de930bde87d6406f3c8539a6f30048f590772ce6c4d9b90800`。 |
| GitHub PR #11 | 2026-11-05 核对时 open、未合并，head `0078bb542fd4ac81343a602d5f0fe4e62a42620c`；本地同 head 阶段 B 代码与验收报告显示 TS X01/C12 已实现，且相应 TS 工程验收已报告通过。该状态可能变化，E03 接入前重核。 |
| A 域 P03/P04/P05；C 域 P01/P10/P15/P16/P19 | 以问题域 C 的统一产品机制规范为完整规则真源，专题和收口记录用于追溯；该统一规范 SHA-256：`0fc6b3851ae3efa4b7e922e1060feb3b3ac9e09b1329fd1d974d069bffb3326d`。 |
| NAP 正式包、PRD V0.1、项目思考总纲 V2 | 用于跨模块边界、Packet/Event 消费和产品目标核对。本轮没有修改；PRD SHA-256：`3cb1ed7e3f4522ac4ef0e46960ab801d5a7f5c93e5528c83c2e72933767ed62d`。 |
| PR #10 E03-00 校准候选 | 2026-11-05 核对时仍为 draft/open、head `c15da4a7377c74537525bb1e37c0b375644e7862`、CI 成功，但 Gate A 待确认且无批准记录；`selection.json` 39 项精选来源并非本地当前完整包。原选择文件 SHA-256：`96b610ea25408028afbb2becfc02aaad6bf9f95045ad4eb8634bd42a5f8aac22`。主分支 `6ae8b2b66513c51ff209ce7147e8c6ff7376a39b`，不含未合并的 TS PR #11。 |

本地 R5 已修改原机制主文档、V01/V05/V06 场景、原五份工程规格、Python 注释逻辑及三项测试；本次 R6 补已裁决的宿主/证据边界、两项保存与来源反例及一项多任务形状测试、独立裁决与 E11 数据契约。20 份 DC JSON Schema、机器合同字段/枚举/URI、`runtime_contract_version=0.1.0`、Checkpoint 格式 1 均未改。历史 `LOCAL_EXPORT.json` 和旧验收报告没有被重写成新证据。原完整恢复范围、CAS、幂等、回执、最后成功点和重新读取 TS 的规则保持。

## 2. 实际验证及可复现命令

工作目录：`decision-context-v0.1/90_可运行工程包/`；Python 3.13.5，依赖为本目录 `requirements.txt` 所列已安装版本。本次使用的本地解释器为 `/private/tmp/antu-ac8-py/bin/python`，未通过网络安装依赖。

```sh
/private/tmp/antu-ac8-py/bin/python -B run_validation.py
/private/tmp/antu-ac8-py/bin/python -B check_cross_package_refs.py
python3 update_package_index.py
```

`run_validation.py` 已重新生成 `VALIDATION_REPORT.md`、`validation-results.json`、`validation-output.txt`；实际结果以这些文件为准。原 DC 单元测试 99/99；AC8 累计新增六项：C12 争议事实限制、X01 非原确认人撤销拒绝、P05 歧义只读恢复，以及本次最近事件不伪造旧轮、错误来源不覆盖最后保存点、单事件多 Task 形状。总 DC **105 项**（核心 58、持久恢复 47），继承当前本地 TS 阶段 A 126 项，合计 **231 项通过，失败 0、错误 0、跳过 0**。C12 测试曾先在原实现中复现失败，再修正 `_annotations` 使用 TS 当前 `stale_fact_ids`。新增三项使用合成输入，只测现有 DC 合同与恢复安全边界，不是宿主记录或关联联测；逐测试结果见机器报告。

机器合同检查已在验证器中对 20 份 DC Schema 进行 Draft 2020-12 检查并对照声明源导出。`check_cross_package_refs.py` 单独核对 DC 20、TS 20、NAP 1 共 **41 个机器资源、285 个跨/包内引用、0 个未解析引用**；NAP 直接引用的 DC `packet.schema.json` 和 `open-turn.schema.json#/$defs/event` 仍能解析。此项是离线引用/形状闭合，不能代替生产服务兼容性或 NAP 运行验收。包索引覆盖 22 份正文、42 个工程文件，65 项来源摘要重算匹配；当前维护正文的 97 个相对 Markdown 链接全部有效。另存的 `旧文件包/` 六份历史跳转副本内有 8 个旧相对链接失效，本轮保留原件并从当前维护正文链接 Gate 中分开报告，不宣称它们通过。

**验证分层：** 产品规格与 E11 数据契约已在本地原章节和独立记录中固定；20 份机器合同与离线引用已验证；Python/SQLite 参考运行的 R1 与部分结构边界已验证。宿主交互记录读写/授权/任务关联的 R2、GitHub E03 Runtime、真实身份/HTTP/PostgreSQL 接入、真实语义与行动连续的 R3、真实工具事实、UX 曝光/自由更正、NAP V/C/E 与时机裁决、真实用户价值均未在本轮验证。TS PR #11 的工程验收属于 TS，不计入 DC E03 成果。

## 3. PR #10 差异和后续校准

PR #10 的 39 项精选文件在 R5 编辑前与本地原文件逐字节一致；R6 更新新包索引后仍有 **8 项**源哈希失配：本地 DC `00_从这里开始.md`、`04_工程规格/01_`～`05_` 五份规格、`90_可运行工程包/README.md`、`package-index.json`。其余精选文件不应据此推断构成完整 DC 包；新追踪、E03 能力、裁决、交接文件和 Runtime 修正也未包含在原精选源中。未来 E03-00 应以技术负责人接受的**本地完整包新清单及 SHA**重新校准 PR #10，保留其历史选择与 Gate 证据，不覆盖原候选的来源声明；须先确认 Gate A/版本，再启动 E03-01。

NAP `package-index.json` 仍指向旧版外部来源摘要，当前其 69 项来源核对中 **13 项**哈希与本地文件不同：TS 正式包 7 项、DC 6 项，涉及 TS 阶段 A 后续更新与本次 DC 修订。NAP 正式包本轮没有改；NAP 更新时应独立审查这 13 项并重算来源，不把本地 DC 变化静默当作 NAP 已验收。

## 4. 跨模块交接

| 接收方 | 已可消费的 DC/TS 能力与后续责任 |
|---|---|
| E03 DC 工程 | 以本地完整包为候选基线，按 E03-01～07 固定阶段接入：TS 当前受权 state/history 与 `DecisionContext`；按 revision/TTL/事实时效重建 Packet；从 `stale_fact_ids` 生成 C12 注释；保留 Task/Focus/分页/Checkpoint；在可信 Actor/Grant 下把 X01 `PERMISSION`、C12 `HARD_CONFLICT` 原样透传。宿主 E11 另接按任务读取的未提交原话，不改 DC 机器包。见 12 项稳定能力 ID 的[实施映射](13_DC八项机制融合｜E03工程能力增量与实施映射.md)。 |
| TS | 持续作为唯一业务真值，提供当前状态、只读投影、时效/争议/Decision stale 以及写入守卫；DC 不重算争议、不改 TS 模型。PR #11 合并与接入状态需按当前 head 重核。 |
| NAP | 消费当前 Task/Focus、Packet 的有效对象/限制/未知和 TS 当前状态，独立判断行动资格、相对 V/C/E、用户累计负担、是否澄清及介入时机；失败只阻断对应行动路径。其 Packet/Event 机器引用要随 DC 新基线重新校准，不能把 `support=decision_support` 当成行动已获准。 |
| 解释器、宿主、UX、运行记录、Evals | E11 宿主记录受权交互原话/来源并有界读取；解释器据当前及已核旧原话产生可反驳的 Task/对象/范围，Evals 检验语义正确与局部纠错；UX 提供中立少量选项、跳过和自由更正；运行记录保留真实曝光、重复询问与交互劳动；Evals 检验价值、成本、时机和效果。DC 只保留合同允许的任务现场。 |
| Grounding/Execution | 核验外部事实与工具回执，并把受权结果交 TS；不能把来源同版或 DC 注释当作现实事实已核实。 |

## 5. 技术负责人验收项与产品负责人结论

**DC-AC8-PROTOCOL-01 技术方案已裁决。** 跨轮未提交原话由受信宿主记录承载，DC 按需读取；当前宿主没有 E11 能力，完整解释证据链**尚未实现**，缺证时保留未知并按原现场只读恢复。技术负责人最终 Gate 应复核 R6 来源/哈希、0.1.0 合同未变、C12 修正、宿主 E11 版本和失败保护、PR #10 新校准范围及阶段顺序。**本地包具备最终 Gate 复核材料，不能代签 Gate 通过或声称 E03 已实现。**

给非技术产品负责人的九项答复：

1. 八项机制主要融入原 Task/Focus、证据与 Packet、受控写入、持久现场；没有做八套平行功能。
2. 原有多任务、冷热启动空状态、双通道、分页、写入隔离、完整首版恢复仍足够复用。
3. 补清了暂定理解、歧义未知、局部偏好、当前证据/时效、X01/C12 失败边界，并修正争议事实注释。
4. 新 DC 机器能力为 0；已裁决 1 项宿主内部 E11 读取能力，工程仍待 E03。
5. 20 份 Schema、字段/URI、0.1.0 合同和 Checkpoint 格式未改；C12 是更严格的既有注释行为。
6. 本地 Python/SQLite 参考 Runtime 已同步，231 项总测试通过；未联测真实宿主日志。
7. 未来 GitHub E03 要做完整来源校准、TS 读取/注释、Task/Packet、可信写桥、Checkpoint、恢复与真实 HTTP/DB 验收。
8. 行动价值/成本/时机归 NAP；真实理解归解释器/Evals；呈现与曝光归 UX/宿主；事实核验归 Grounding/TS。
9. 本地候选可交技术负责人做最终 Gate 复核；协议方向已定，来源接受/Gate 与 E11 实现仍需各自完成。
