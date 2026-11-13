# 14 项来源漂移：旧新逐段证据与 NAP 处置

旧文件以原 NAP 索引 SHA-256 在 E02/E03 已冻结工程快照中逐一找到；新文件是本次本地 TS/DC/PRD 快照。14 份完整 unified diff（含旧新行号、全部增删和上下文）、各自旧新 SHA 与旧快照路径见 `quality/source-diffs-2026-11-06/manifest.json` 和同目录 `01.diff`–`14.diff`。这些是来源语义审查候选，不等于上游应用已批准或任何 NAP 测试通过。下表案例是拟回归位置，**除明确注明的合成检查外均 NOT_RUN**；原 C3 58 场景不可因本次映射改写历史预期。新场景须按合法 TS/DC 状态构造，尤其恢复与三入口不能假称原 C3 已有完整覆盖。

| #／文件及完整对照 | 旧 → 新的实质差异／行段 | NAP 规则、案例与处理结论 |
|---|---|---|
| 01 PRD | [16 处差异](../quality/source-diffs-2026-11-06/01.diff)：版本/来源、MVP 恢复、三入口与具体授权；PRD-001/002/003；PRD-005/006/007/008；历史预览；跨会话；A02/A03/A05–A08；P0/阶段出口；UX 全量追踪；技术附件。PRD-004/009 的原语义和 MVP 非目标不变 | P02/P05/R02–R06、G01–05、CT-04/05；S05/S06/S08、M03/N03/N07/N08 与新增 UX E01–E32 场景分别核验；P05 现补自由输入/开放问句。PRD 文末 E11 “仍需裁决”是较早文本，后续 Owner 隐私决定以 DC 17 号记录为准，不修改 PRD 或扩大批准 |
| 02 TS SPECIFICATION | [9 处](../quality/source-diffs-2026-11-06/02.diff)：来源导航、偏好和事实限制、确定性评估、保护规则及 UX 恢复章节；以 diff 全段为准 | G01/G02/G05、CT-01；S02/S03/F08/N03 和 E11–E22。保留 TS 真值与弱兴趣作用域；P10/C12、恢复由 TS 最终判定；真实联测 NOT_RUN |
| 03 TS AUTHORITY | [4 处](../quality/source-diffs-2026-11-06/03.diff)：confirmed 的原确认人、工具事实与跨轮记录责任、UX 恢复／当前授权 | P02/G02/CT-04；S08/N03/N07、新 X01 两主体与体验保护；不让模型或 NAP 自授 User，真实认证回归待集成 |
| 04 TS TRANSITIONS | [1 处](../quality/source-diffs-2026-11-06/04.diff)：confirmed revoke 增加匹配 `confirmed_by` | G02/CT-04；X01 实际 actor 两主体及提案确认路径。批准阶段 A 不等 #11 应用已合入 |
| 05 TS PROPAGATION | [1 处](../quality/source-diffs-2026-11-06/05.diff)：未提交原话、曝光及负担不归 TS 传播真值 | G01/G05/CT-05；M02/N02，E11 删除、重启及缺证。交受信宿主，NAP 日志不重建业务值 |
| 06 TS INVARIANTS | [1 处](../quality/source-diffs-2026-11-06/06.diff)：I14–I18 等增加主体、事实争议、弱兴趣、保护投影及 UX 恢复不变量 | G02/RT-03/INV-01–10；F08/N03/N08、X01/C12 与 UX 恢复。完整联合回归 NOT_RUN |
| 07 DC 入口 | [2 处](../quality/source-diffs-2026-11-06/07.diff)：增加 AC8/R6、UX R7 导航及其来源状态 | CT-01；版本/来源验收。R6 Gate A 与 R7 限定参考层接受分开；不推导生产或 NAP 批准 |
| 08 DC 运行契约 | [3 处](../quality/source-diffs-2026-11-06/08.diff)：当前可反驳解释及跨轮受信原话、澄清非授权、UX 草稿/焦点/A-B-C | G01/P05/CT-02/04；S03/F04/M03、UX E14/E17；无证据未知，拒绝自造当前事件；语义和 UI 未验 |
| 09 DC 组装 | [4 处](../quality/source-diffs-2026-11-06/09.diff)：作用域内偏好、跨轮证据不塞 Packet、TS `stale_fact_ids`/C12 注释、历史比较与异步版本 | G01/G02/G05；F08/X02/N03/N08、C12 争议/非争议及 TTL；仍需实际包来源、完整分页和实时权限验证 |
| 10 DC 错误及兼容 | [3 处](../quality/source-diffs-2026-11-06/10.diff)：PERMISSION/HARD_CONFLICT 原码、宿主证据接口独立版本、UX 当前授权与未知回执 | CT-04/06、RT-05；X01/N03/N08/UX E10/E27；真实响应不能冒充成功，机器合同未扩字段 |
| 11 DC 检查点 | [3 处](../quality/source-diffs-2026-11-06/11.diff)：宿主跨轮原话、歧义和删除、E11 生命周期、UX 草稿/历史只读与旧绑定警告 | CT-05/RT-05；M02/N08、UX E23–28；只对 ACK 作保存声明、旧 Grant 不复活，删除/撤权联测未运行 |
| 12 DC runtime.py | [3 处](../quality/source-diffs-2026-11-06/12.diff)：`_annotations` 接收 TS `stale_fact_ids`，含争议的单条事实输出 `fact_contested` / decision_limit，并在组包传入 | G02/R02、F08/X02/N03、C12 单条仍可用但争议及非争议对照；不改 TS 算法，参考 107 项通过不等生产实现 |
| 13 TS contracts.py | [1 处](../quality/source-diffs-2026-11-06/13.diff)：拆 proposed/pending revoke 与 confirmed revoke；后者须 User 匹配 confirmed_by | P02/G02/CT-04、X01，两主体与模型确认；生产接口依 #11 集成审核 |
| 14 TS engine.py | [10 处完整对照](../quality/source-diffs-2026-11-06/14.diff)：引入 conflicting_fact_ids；模型需确认时模拟执行标记与签名；实际 confirmed 撤销校验 actor；解决冲突时可用事实数量及争议证据限制；已反证/替代事实例外；已确认体验向上定位城市保护；争议集合变化传播；组装时标记 contested/stale | G02/CT-03/04/RT-03；X01 实际确认主体与模型模拟分开、C12 多条冲突/解决/旧决定 stale、UX E13/E19 体验城市保护。仅消费 TS 返回、保留原错误，不另造规则；PR #11/#13 不自动合入；本轮 NAP 合成守卫覆盖部分旧 Grant、争议与体验证据，真实 TS/PG/HTTP 联测 NOT_RUN |

## PRD 的全部 16 处变化范围

`01.diff` 的 16 个 hunk 依次对应：1 文档状态和证据，2 MVP 恢复，3 多入口/确认，4 PRD-001，5 PRD-002，6 PRD-003，7 PRD-005，8 PRD-006，9 PRD-007，10 PRD-008，11 §4.2 恢复，12 §5.4 跨会话，13 A02/A03/A05–A08，14 §7.2 P0 门槛，15 §7.4 开发出口，16 §7.5 UX 映射及 §7.6 DC/E11 边界。PRD-004 和 PRD-009 未在这些 hunk 中发生实质修改；不要把 16 个 hunk 缩成仅“历史恢复”。每项行为与可观察断言见 [UX E01–E32](ux02-e01-e32-acceptance.md)。

## 评审和回归边界

旧/新快照的摘要及逐行差异已核实，表格给出了 NAP 规则和预期测试路径；产品语义逐项整理不等于独立技术审批。既有 C3 场景实际仍为 NOT_RUN；当前新增 Python 测试只检查受信证据布尔输入及澄清交互夹具，不运行真实 Policy、模型、工具、用户授权或前端。TS/DC 参考套件另列实测，不能替代真实集成头验收。
