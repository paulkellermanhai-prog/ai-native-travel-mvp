# E03-00｜DC-AC8 R6 来源校准与 Gate A 补充证据

日期：2026-11-05；2026-11-06 恢复工作后重核并补齐 Owner 隐私裁决。状态：**独立校准候选，Gate A 未获正式批准，E03-01 未启动。** 本补充材料基于 PR #10 head `c15da4a7377c74537525bb1e37c0b375644e7862`，不改其原 39 项选择、审核记录或既有 E02 成果。新候选位于 [R6 selection.json](../../../specs/dc-ac8-r6-calibration-2026-11-05/selection.json)，独立保留原包每个文件的字节与 SHA-256。原 [E03-00 审核](E03-00%E5%9F%BA%E7%BA%BF%E5%AE%A1%E6%A0%B8%E4%B8%8E%E5%B7%A5%E7%A8%8B%E5%87%86%E5%A4%87.md)仍是历史提交状态，不再可称作最新 DC 产品规格。

## 当前代码和 Gate 事实

2026-11-05 重新核对 GitHub：`main` 为 `6ae8b2b66513c51ff209ce7147e8c6ff7376a39b`；[PR #10](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/10) 为 draft/open，CI run `40854405892` 成功，但 `docs/e03-progress.json` 的 Gate A 为 `PENDING_TECH_LEAD_REVIEW`、批准证据为空，PR 无批准 review；[PR #11](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/11) 为 open、未合并，head `0078bb542fd4ac81343a602d5f0fe4e62a42620c`，CI run `41658155206` 成功。**main 不含 PR #11 的 X01/C12 业务实现**；E03 只能把它作为未合并依赖，接入前须重核 Gate、head、CI 和合并状态。CI 成功不构成 Gate 批准。

## 新来源清单与差异

原 PR #10 的 [39 项选择](../../../specs/dc-0.1-calibration-2026-10-29/selection.json) SHA-256 为 `96b610ea25408028afbb2becfc02aaad6bf9f95045ad4eb8634bd42a5f8aac22`。它保存历史提案，未被覆盖。新快照为当前 DC R6 索引的 23 份正文、42 个工程文件、1 个包索引及 1 个独立 manifest，合计 **67 份**；其中 manifest 的 66 项摘要逐一复核。完整文件路径、长度、双份来源摘要和差异详见新 `selection.json`。它是本次**唯一最新 DC 规则候选**；未经 Gate A 接受，不称其为已批准工程基线。

旧 39 项与 R6 相比有 **8 项**摘要不同：`00_从这里开始.md`、`04_工程规格/01_运行契约与任务定位.md`、`02_读取组装与有效性规格.md`、`03_接口异常权限与兼容.md`、`04_可执行验收与交付评审.md`、`05_持久检查点与跨会话恢复规格.md`、`90_可运行工程包/README.md`、`package-index.json`。旧候选未收入的 R6 机制追踪、E03 能力表、协议裁决、E11 数据契约、修正后的 Python Runtime/测试和新报告均在新完整快照中。差异是来源变化，不静默宣称原 PR #10 已覆盖新规则。

原 NAP 包的 69 项来源摘要现有 **14 项**与当前本地文件不符：TS 7 项（五份业务规则和 `tripstate/contracts.py`、`tripstate/engine.py`），DC 6 项（入口、工程规格 01/02/03/05、`context_runtime/runtime.py`），另有本轮发现的项目 PRD 1 项。PRD 当前 SHA-256 为 `19321a8f0e459d54fcff5e54f77ea3af06235035699dcc777a3d6cff7dd2c203`，NAP 旧摘要为 `3cb1ed7e3f4522ac4ef0e46960ab801d5a7f5c93e5528c83c2e72933767ed62d`。逐项旧/新摘要列在新 `selection.json` 的 `nap_source_mismatches`。NAP 和 PRD 原包本次未改；后续 NAP 校准须逐项确认来源、PRD 变化、Packet/Event 引用、行为影响及自身批准，不能把 DC R6 的变化冒充 NAP 已验收。

## 合同、E11 与验证层级

- DC `runtime_contract_version=0.1.0`，20 份 Schema 的字节、URI、字段、枚举与旧候选一致；Checkpoint 格式 1 和原首版跨会话恢复保留。TS 20 份 Schema 与工程锁定基线一致。NAP 对 DC `packet` 和 `open-turn` Event 的引用仍解析。新快照校验覆盖 **41 个机器资源、285 个引用、0 个未解析**。这是离线合同闭合，不代表 NAP 运行或生产服务通过。
- `DC-AC8-E11` 的宿主候选合同 `host-interaction-evidence/v1` 是独立工程设施，详见快照内 [E11 契约](../../../specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/03_%E8%AF%84%E5%AE%A1%E4%B8%8E%E5%B7%A5%E7%A8%8B%E8%A1%94%E6%8E%A5/16_E11%E5%AE%BF%E4%B8%BB%E4%BA%A4%E4%BA%92%E8%AF%81%E6%8D%AE%E6%95%B0%E6%8D%AE%E5%A5%91%E7%BA%A6%E4%B8%8E%E9%AA%8C%E6%94%B6%E8%BD%A8%E8%BF%B9.md)。可信事件先于 Task 关联；受信保存、幂等回执、关联修订、有界读取、读时重验 Session/TripMembership、共享旅行隐私及失败保护均已规格化。[DC-AC8-PRIVACY-01](../../../specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/03_%E8%AF%84%E5%AE%A1%E4%B8%8E%E5%B7%A5%E7%A8%8B%E8%A1%94%E6%8E%A5/17_DC-AC8-PRIVACY-01_Owner%E8%A3%81%E5%86%B3%E4%B8%8E%E6%89%A7%E8%A1%8C%E8%BE%B9%E7%95%8C.md) 的产品策略和旅行结束 30 天、相关不活跃 180 天、单条 12 个月的期限已获 Owner 正式批准。Owner 直接指令为批准依据，随后提供的原提案截图 SHA-256 为 `aaf89450dd1aa9d6abda748c45993068642fd16380fc6a77d79d62e61e6127bd`。产品批准不表示 E11 已实现或可启用生产原话存储。
- E03-01 固定 E11 独立合同、期限与删除/审计测试底座；E03-03 实现记录、关联、读取、自动到期和主动删除；E03-06 验证恢复不复活已删证据；E03-07 做真实 HTTP/PostgreSQL/新进程、备份恢复、审计和告知联测。四个阶段沿原 8/10/15/13/10/17/14/13 权重，不新增母阶段。备份/审计的具体有限周期和超 12 个月续存新截止须在生产配置、安全合规验证前锁定。
- 本地 R6 验证：DC 105、TS 阶段 A 126，**231 项通过，0 失败/错误/跳过**；Checkpoint CAS、幂等、保存回执、新进程与故障恢复在 Python/SQLite 参考层验证。当前维护正文链接 109 项有效；旧文件包六份历史跳转副本另有 8 个失效相对链接，保留原件并单列。R1 参考恢复有证据；R2 真实宿主原话链及 R3 真实语义/行动连续性仍待工程和 Evals。
- PR #10 原 39 项、原 99 项 Python 参考和历史 E02 验证继续独立复核。新 CI 仅校验 R6 来源快照/机器合同；它无法凭旧主分支假装运行 PR #11 未合并的 TS 实现，也不把合成 Task 输入冒充真实宿主日志。

复核命令：`$TRIP_STATE_PYTHON scripts/check-dc-ac8-r6.py`，原有 `scripts/check-dc-calibration.py` 与 `scripts/audit-e03-00.py --run-reference`，以及 `npm run specs:verify`、`npm run contracts:check`、`npm run check`、`npm run db:check`。新增 CI 步骤只运行快照校验，原 CI 验证链保持。

## Gate A 待决与后续阶段

技术负责人须明确接受哪一份 DC R6 `selection.json` 摘要为工程来源、确认 PR #11 依赖的有效状态和 E11 宿主接口边界，并在仓库留下可追溯 Gate A 批准记录。当前**没有该记录**；E03-00 仍仅为提交待审，E03-01 的 10% 未执行。Gate 后的 E03-01 应建立 DC 0.1.0 正式注册/校验、独立 Runtime 边界、宿主 E11 独立合同与隔离权限测试，并保持 E03-02/05 的状态与 Checkpoint 前置依赖。不得自动合并本校准 PR、PR #10 或 PR #11。
