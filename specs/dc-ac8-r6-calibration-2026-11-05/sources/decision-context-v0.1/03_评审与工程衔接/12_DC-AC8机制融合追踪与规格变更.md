# DC-AC8｜原机制地图、八项规则追踪与规格变更

日期：2026-11-05。状态：本地正式包最终 Gate 候选；协议技术方案已裁决，宿主实现待 E03，见 §4。本页是追踪和差异索引，正式行为定义仍在 `01_产品机制/` 与 `04_工程规格/` 的原章节。问题域 C 的唯一完整产品规则真源是其域级规范，专题只供追溯。

## 1. 来源和原有机制地图

来源顺序：本地 `decision-context-v0.1/` 完整 R4 包（17 份索引正文、20 份运行 Schema、Python Runtime/API/Checkpoint 和 99 项原参考测试）→ 当前本地阶段 A TS 包 → PR #11 的实际 TS 工程 → A 域 P03/P04/P05 与 C 域统一规范及五份专题 → NAP/PRD/V2 → PR #10 的历史校准候选。PR #10 的 39 份精选来源与本地原文件逐字节一致，但不是完整 67 文件 DC 原包。PR #11 当次核对 head 为 `0078bb542fd4ac81343a602d5f0fe4e62a42620c`，仍未合并；工程现状不代替 TS 正式语义。

| 原能力 | 原对象、字段与程序 | 协作和边界 | 原状态 |
|---|---|---|---|
| 输入定位 | `event`、Task 的 `question/kind/target_ids/branch/relation/certainty/evidence/progress`；`Runtime.open_turn` | 解释器先读 TS 基础状态，注册当前问题；语义准确性未由程序证明 | 0.1.0 机器合同和 Python 参考实现 |
| 多问题与焦点 | `task_key/related_task_keys/focus_keys`，E/Q/S 语义，暂停/恢复证据 | 同一旅行可有并行问题；焦点变化不结束或恢复其他问题 | 已有合同与局部验证 |
| 双通道 | `packet.context/objects` 与 `pending_input` | TS 提供权威状态，未提交输入保留原话和处理结果；NAP 选择行动 | 已有合同与参考实现 |
| 保护与证据 | TS 只读 `DecisionContext`、`stale_fact_ids`，DC `annotations` | TS 保证活动约束、confirmed Decision、当前骨架、未解决 Issue；DC 同版解引用并说明适用/限制；不写事实真值 | 已有合同；争议事实注释本轮修正 |
| Packet 与分页 | `state_revision/snapshot_digest/expires_at/coverage/deferred_ids/support`、`page` | 同版/时钟验证，重要采用须交付完整正文；Packet 可丢弃重建 | 已有合同与参考实现 |
| 受控写入 | `change/confirm`、宿主 Principal/WriteGrant、TS submit/confirm | 模型提案、用户授权和实际生效分离；TS 最终守卫与错误不可由 DC 覆盖 | 已有桥接；X01/C12 拒绝专项验证 |
| 持久现场 | `checkpoint-payload`、SQLite CAS/幂等/回执、`scene-*` | 保存最后成功点的任务/焦点/比较/草稿；不保存 Packet/Grant/业务真值 | 0.1.0 首版完整能力，43 项原恢复测试 |
| 恢复 | `RecoveryMixin.restore_scene` | 新 Principal、当前 TS、重新组装、旧输入只读、授权代次轮换 | 已有参考实现；跨轮解释证据缺口见 §4 |

数据拥有权：TS 九个持久业务对象和两类系统记录是权威；TS `DecisionContext` 是只读投影；DC 的 Task/Turn/Packet/Checkpoint 是暂定任务语境与现场元信息；NAP 的行动判断和运行效果记录不归 DC。原 Packet 的 `support=decision_support` 表示正文交付充分，不表示 NAP 已判断行动价值或 TS 已授权采用。

## 2. 逐规则影响矩阵

表中“覆盖”指融合前原 DC 能力；“缺口/处理”区分已修、已裁决待实现与其他模块。定位中的 `01§3.2/§5` 是机制主文档，`04-01` 至 `04-05` 是原工程规格；测试名见 `04-04`。

| Problem／正式裁决 | 原承载与已有覆盖 | 真实缺口、责任及修订方式 | 测试／工程影响／结论 |
|---|---|---|---|
| P03-1 可反驳理解、原话与范围 | Task `certainty/evidence/question/target_ids`，Turn 绑定原输入 | 在 `01§3.2`、`04-01§4` 明确暂定解释及关键替代解释只关当前任务；真实语义分类归解释器 | 原 source-span/Task 测试复用；E03-03 解释器适配；合同未变 |
| P03-2 关键不确定性只在影响后果时升级 | `ambiguous`、双通道、保护底座 | `01§3.2/§5.2`、`04-01§4` 限定对象/范围/授权后果；最终澄清价值归 NAP | P05 歧义恢复测试；E03-03 传递；NAP/Evals 后测 |
| P03-3 新反馈区分纠错、真实变化、细化与未知 | Task `continue/refine`、TS 历史和局部传播 | `04-01§4` 指定证据关系，合法业务变化交 TS；真实分类归解释器 | 原 DC-A01 与 TS 阶段 A/B 复用；语义 Evals 未测 |
| P03-4 局部校准与原证据保留 | TS 历史保留已提交改变；DC 保留最新事件 | 当前 Task 可局部重定位；被替代的**未提交**原话由宿主记录承载，当前宿主尚未实现，见 §4 | E03-03/06 宿主接口与真实联测；不能宣称已全部满足 |
| P04 起点未知、目的地即可探索 | `explore`、空目标/偏好、T0/V01 | `01§5.2`、`04-01§4` 明确不猜兴趣、不强制问卷 | 原空状态测试；E03-03 Existing；参照选择属 NAP |
| P04 弱证据局部、明确兴趣逐步深化 | TS `scope/certainty/support/source`；DC 全 active Preference 种子 | `01§5.2`、`04-02§1` 明确保留强度/范围；深化强度交 NAP | 原偏好召回/局部适用测试，TS P04 专测；E03-02 Test Only |
| P04 未展示/无反馈不成否定 | DC 无曝光记录，也不造负偏好 | `01§5.2`、V01 明确读取边界；真实曝光归 UX/运行记录 | DC 无新字段；E03-02/UX/Evals 协作 |
| P04 跳过/改道、不固定漏斗 | Task 关系/Focus 已有 | `04-01§4` 明确按新任务重定位；不把探索进度当门槛 | 原焦点/暂停测试；E03-03 Existing |
| P04 不建独立冷启动系统 | 原 `explore` Task、TS Preference、NAP 行动决策和 UX 入口已有分工 | `01§5.2` 规定零/弱信息阶段沿用原职责，不增偏好分数或推荐选择器 | E03-03 Existing；无新增 Schema/运行服务 |
| P05-R1 后果相关的歧义才澄清 | `ambiguous`、空目标、重要写入守卫 | `01§5.2`、`04-01§4-5` 保留未知；具体行动比较归 NAP | 新歧义恢复测试；E03-03 Enhancement；真实语义未测 |
| P05-R2 少量中立选项、自由更正 | Task 原话和纠错入口可承接结果 | 选项质量和控件归 UX/解释器，DC 不生成候选选项；`04-01§5` 明确澄清不授权 | E03-03/UX/Evals；DC 机器合同不变 |
| P05 跳过、未回答、重复抑制 | `open/ambiguous` 与 Checkpoint | `04-05§6` 保留未知、只读恢复；旧原话按需读取由宿主 E11 承载；等价追问抑制归 NAP/运行记录 | 新歧义恢复测试；E03-06 Existing＋E11 待实现；重复成本未测 |
| P01-G01 明确请求优先 | 当前 `event`、Task/Focus 和受控写桥已有 | `01§5.5` 明确当前请求是 DC 输入；是否打断与强制资格归 NAP/TS | E03-03 Existing；原 Turn/Focus 测试；真实打断未测 |
| P01-G02 自主行动可解释收益与候选覆盖 | Task 问题、Packet 证据/限制已有 | `04-02§3` 提供改善对象和当前依据；候选行动集合及覆盖由 NAP 检查 | E03-02 Existing；原组装测试；NAP 覆盖评测未测 |
| P01-G03 相对 V/C/E、反事实和动态比较 | DC 目标/问题/未知与最新 TS 投影已有 | `01§5.5` 规定只供应当前输入；等级、比较、后续负担归 NAP/运行记录 | E03-02 Existing；原同版/时效测试；价值 Evals 未测 |
| P01-G04 低收益与高成本降级 | Packet 限制、已知信息、当前 Task 已有 | `04-02§3` 向 NAP 暴露重复/未知的判断依据；降级、延后或不介入由 NAP 决定 | E03-02 Existing；原空状态/局部读取测试；成本 Evals 未测 |
| P01-G05 不确定性与最小澄清 | `ambiguous`、空目标、受控写和恢复已有 | `01§3.2/§5.2` 与 `04-01§5` 保留未知并隔离授权；何时澄清/低成本核验归 NAP | P05 歧义恢复专项；E03-03 Enhancement；语义 Evals 未测 |
| P01-G06 事前改善与事后效果校正 | DC 可提供任务/证据快照，但不存行动效果真值 | `01§5.5` 限定 DC 为事前上下文；效果与反事实观察归运行记录/NAP/Evals | E03-02 Existing 输入；效果闭环未测，不新增 DC 执行器 |
| P15-01 关键、低成本及不介入候选有效覆盖 | DC 提供当前问题、证据和限制 | `04-02§3` 给 NAP 比较输入；候选集合覆盖与资格仍由 NAP 判断 | E03-02 Existing；NAP 候选遗漏评测未测 |
| P15-02 TS/DC 当前情境动态适配 | revision、TTL、`_current`、重建已有 | `04-02§1/§5` 明确改道、状态/事实变化后旧包失效 | 原 stale/expiry 及新增 C12 旧包测试；E03-02 Enhancement |
| P15-03 TS/DC 只供输入、无固定最优排名 | TS 权威状态、DC 暂定 Task/Packet 已分层 | `01§5.5` 明确最终相对价值归 NAP，不写 DC 排名 | 原只读/无业务写入测试；E03-02 Existing |
| P16-C-A 当前任务级累计负担 | 有效 TS/Task/历史可读，DC 不保存完整交互流水 | `04-02§1` 供当前任务与已知信息；累计劳动和后续负担归 NAP/运行记录 | E03-02 Existing；累计成本 Evals 未测 |
| P16-C-B 合理劳动分配 | TS 已知信息与 Packet 证据/限制可读 | `04-02§1` 明确利用已有证据，系统可完成的查询整合不靠 DC 追问器 | 原读取/空状态测试；NAP/UX 劳动转嫁评测未测 |
| P16-C-C 随任务、状态和认知动态判 C | 当前 Task/Focus 与 TS revision 可读 | `01§5.5` 禁止 DC 固定 C 等级；运行记录与 NAP 根据条件重评 | 原同版/焦点测试；用户成本 Evals 未测 |
| P19-01 现在、延后、后台准备、不介入比较 | 当前 Focus、事实到期、状态变化可输入 | `01§5.5` 供当前依据；四类方式比较与授权边界属 NAP/宿主 | 原 DC-A05；E03-02 Existing；NAP 时机评测未测 |
| P19-02 明显时机价值损失门槛 | 当前 Task、保护限制和事实时效可读 | `01§5.5` 明确 DC 不判立即介入；下一合理节点和三类损失归 NAP | 原失效测试；真实打断效果未测 |
| P19-03 后台准备与前台呈现分离 | DC Packet 是当次读取，不代表已呈现或已执行 | `04-02§5` 旧包/时钟变化须重建；准备的权限/资源/呈现归宿主/NAP | 原 TTL/时钟测试；后台准备与 UX 未测 |
| P10 资格先于价值、失败只阻断具体路径 | 受控写桥、TS 错误透传、Checkpoint 旧授权隔离 | `04-03§5-6` 补 X01 `PERMISSION`、C12 `HARD_CONFLICT` 处理语义 | 新 X01 桥接测试；E03-04 Enhancement |
| P10/C12 争议事实不得直接消费 | TS `stale_fact_ids` 已包含争议；DC 原注释只查单条 `fact_usable` | `runtime.py::_annotations` 改用 TS 投影清单给 `decision_limit/fact_contested`；不重算 TS | 新 C12 正反读取测试；E03-02 Enhancement；Schema 未变 |
| P10 旧 Decision 保留且 stale、恢复不复活 | 原保护清单/Decision 注释/恢复轮换已有 | `04-02§5`、`04-05§6` 明确当前 TS 再读与旧授权隔离 | 原 DC-R02/R04、TS P10 测试；E03-06 Test Only |

## 3. 规格变更清单

| 类别 | 实际变更 | 保持 |
|---|---|---|
| 产品语义 | 在原 `01` 主文档及原 V01/V05/V06 场景中补任务假设、冷启动、歧义、争议事实和职责边界 | TS 真值、NAP 的 V/C/E 决策与 UX 控件仍由各自模块拥有 |
| 运行行为 | `runtime.py::_annotations` 尊重 TS 当前 `stale_fact_ids`；单条仍可用而被 TS 标争议时输出 `fact_contested` | 原 Context 内容、TS 争议算法、写入/确认守卫、Packet TTL/CAS/恢复边界不变 |
| 机器协议 | 无字段、枚举、接口、URI、`runtime_contract_version`、checkpoint 格式或 20 Schema 结构变更 | 严格 `additionalProperties=false`、0.1.0 与 NAP 对 Packet/Event 的引用不放宽 |
| 验证 | 原 3 项 AC8 专项外，再加最近事件不伪造旧轮、错误来源不覆盖保存点 2 项参考测试；更新实际报告与索引摘要 | 旧测试及历史报告不重写为新成就；新结果单独记载；不冒充宿主日志联测 |

## 4. 已裁决的协议方案与 E03 缺口

**DC-AC8-PROTOCOL-01｜技术方案已裁决，工程实现待 E03。** P03/P05 所需跨轮未提交原话与解释证据优先由受信宿主交互记录承载，DC 按需读取和组织当前任务。现行 `saved_task` 每个 task_key 只存最近 event；TS history 只记录已提交业务操作，不是对话流水。不能把旧原话塞入 `question`、伪装成另一个 Task/草稿，或在 0.1.0 严格合同下静默增字段。

本轮核查的真实宿主只有鉴权、TripMembership 与 TS state/history，**没有可授权的未提交交互证据读取接口**。因此完整解释证据链尚未实现；缺证时保留未知，按原 Checkpoint 恢复最新成功现场并重建当前 TS，旧授权不复活。宿主接口版本、身份/旅行/任务/来源/时间要求与 E03 正反验收见[独立裁决记录](15_DC-AC8协议裁决与宿主证据接口交接.md)；本轮不改变 20 Schema、DC 0.1.0 或 Checkpoint 格式 1。
