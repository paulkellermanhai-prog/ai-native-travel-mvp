# UX-02／PRD → TS／DC 工程影响与实施核查 V0.1

日期：2026-11-05。依据：已验收 UX-02 V0.1、同步修订的 PRD V0.1、TS 0.1.0 A/C 阶段 A 候选、DC-AC8 最终 Gate 本地候选、NAP 0.1.0 只读、GitHub main 与 PR #10/#11。此文是核查与后续实施映射；“规格覆盖”不等于 GitHub 已实现。

## 基线与 Gate

- PRD 已原位补充 PRD-001/002/003/005/006/007/008、§2.2/3/5/7 与 A01–A08；PRD-004/009 原行为足够，仅在追踪中保留。全量类别映射见 PRD §7.5.1。
- TS 机器合同 0.1.0；本地八项机制修订 `2026-11-03-ac8-stage-a-candidate`，参考能力不是线上实现。GitHub main `6ae8b2b66513c51ff209ce7147e8c6ff7376a39b`；PR #11 head `0078bb542fd4ac81343a602d5f0fe4e62a42620c`，open、未合并，已有 [E01 CI #29](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/actions/runs/41658155206) success。PR #11 的 X01/C12 及 P03/P04/P05 增量不等于 UX-02 全链路已上线。
- DC 当前运行合同 **0.1.0**，20 Schema、Checkpoint 格式 1 与首版持久恢复保留。DC-AC8 最终 Gate 为本地候选；E11 受信宿主原话证据接口未实现。PR #10 head `c15da4a7377c74537525bb1e37c0b375644e7862`，draft/open、未合并；其 [E01 CI #26](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/actions/runs/40854405892) success 只证明该提交 CI，不是 E03-01 Gate PASS。 PR #12 head `bba93c935cd2e7ee2ddaadea565183865dab8163`，draft/open、base 为 PR #10 head，未合并；其 [E01 CI #30](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/actions/runs/41943704970) success，保存 DC-AC8 R6 完整来源与 E11 Gate A 证据，仍未获 E03-01 开发 Gate。
- 本轮未修改 GitHub 代码、TS/DC 机器合同或原测试；PR #10/#11/#12 原 head 未覆盖。历史冻结包保持原样。

## 跨模块一致性矩阵

| UX-02／新版 PRD | 责任与正式规格 | 参考／GitHub 现状 | 差异及处理 | 验证出口 |
|---|---|---|---|---|
| F1 兴趣≠采用；PRD-001/002 A01/A02 | TS Preference/Candidate/Decision；DC Task evidence；NAP P05 | TS 阶段 A 与 PR #11 覆盖弱兴趣保护；DC 参考为合成解释 | 复用 TS；真实浏览/滑动语义、宿主证据与 UI 未实施 | 弱反馈不能确认城市，跨轮纠错保原意 |
| F2 缺口、行动价值、改道；PRD-003 A03 | DC Task/Focus/Packet；NAP G01–G05/P01/P03/P04 | DC 参考组装；NAP 无产品 Runtime | 不向 TS/DC 写 V/C/E；NAP 后续独立同步及评测 | 跳过后改道，历史问题不过度重推 |
| F3 有意义骨架比较；PRD-004 A04 | TS Candidate/Skeleton/assessment；NAP R06；比较计算 | TS 结构与有限计算有基础；真实比较 UI/数据未核实 | 复用 TS，不凑第二候选；计算与 UI 另验 | 真实差异、费用口径及未知可解释 |
| F3/F6 选择即确认；PRD-008 A08 | TS OperationIntent/Decision、当前版本/确认主体；NAP P02 | TS 有授权、Proposal、X01 守卫；PR #11 待合并 | 现有规则允许明确用户指令；具体“已展示影响”须受信宿主证据，不能模型自报 | 已展示合法范围免重复泛化确认；新牺牲另获授权 |
| F4 地图/时间轴/对话同一草稿；PRD-005 A05 | TS 暂定 Skeleton/版本；DC Focus/Checkpoint；前端 | TS/DC 规格有基础；当前 GitHub 无完整工作空间 | 产品集成缺口，不预设新 TS Schema；E03/UX-04 承接 | 三入口同步，过时结果不能覆盖新草稿 |
| F5 A/B/C 假设与纠错；PRD-002/006 A02/A06 | TS scenario/plan 与历史；DC Task/Focus；语义/编排 | TS 有隔离及局部重算；DC 合成解释；真实模型未验 | 复用合同，真实解释与异步取消待 E03/编排 | 假设不采用，纠错不重复叠加 |
| F6 无日期概念骨架；PRD-008 A08 | TS pending/unknown、事实层级；DC Packet；NAP P02 | TS 可保留未知后合法采用；真实数据未核实 | 复用合同；日期后影响传播与 UI 另验 | 规划确认不提高班次核验层级 |
| F6 事实失败/冲突；PRD-007 A07 | TS ExternalFact/Issue/C12；DC 有效性；前端 | TS 阶段 A 与 PR #11 有争议事实拒绝；待真实数据 | 复用 X01/C12；对外证据与多入口提示未实施 | 空集、失败、无服务、已知冲突分开 |
| 整份历史恢复；PRD-008 A08 | TS HISTORY_FINAL 新版创建/采用，当前约束重验；DC 任务续接 | TS 有版本/历史/preview/提交原语；GitHub 无专用恢复入口 | **MVP 产品能力待实现**：可编排现有命令，先验证差异/权限/幂等；不先增 Schema | 旧版只读，预览后新版本，失败保留当前有效版 |
| 城市级历史恢复；PRD-008 A08 | TS Skeleton stops/parent_id/影响；DC 焦点；计算/前端 | 有对象/版本原语；未见对象级恢复命令或端到端计算/HTTP 证据 | **MVP 产品能力待实现**：核查组合现有创建/重算/采用命令能否满足；若不足再提交最小合同修正 | 仅指定城市及必要连锁变化；硬约束/重要牺牲守卫 |
| 跨会话最后成功点；PRD-002 A02 | DC 0.1.0 Checkpoint、CAS、恢复重读 TS | 本地 Python 参考与进程测试有证据；GitHub E03 尚未实施 | 保留 DC 0.1.0 原恢复，E03 Gate 后接真实身份/存储/UI | 重启后任务/焦点/草稿续接，旧 Grant 无效 |
| E11 旧原话证据；PRD-002/003 A02/A03 | DC-AC8 协议裁决、受信宿主内部接口 | 现有宿主无可信交互证据写读；PR #10 未实施 | E03-01 锁定合同，E03-03/06/07 实现；生产原话保留/删除规则待 Owner 隐私裁决 | 真实会话、权限、任务关联与分页联测 |
| UX-02.5-C 保存/提交异常；PRD-008 A08 | TS 原子状态/历史/幂等；DC Checkpoint ACK/CAS；NAP 结果 | TS PR #11 有 PG/HTTP 验证；DC 仅本地参考 | 复用合同；跨模块回执语义和 UI 尚未验 | 超时查权威结果、重试不双写、旧草稿不覆盖新有效版 |
| 预算、MVP 边界；PRD-009 A09 | TS Constraint/费用口径；NAP R02；计算 | PRD/TS 原有规则足够 | 保持原需求；不扩展全程总价或交易 | 缺项可见，hard 不静默放宽 |

## 修正判定

TS 的 Preference/Candidate/Decision、历史版本、原子提交、X01/C12 与有限重算已有权威规则；DC 的 Task/Focus/Packet、受控写入、Checkpoint 与 0.1.0 恢复已有权威合同。本轮未定位到必须立即破坏机器合同才能表达 UX-02 的问题，因此没有修改 TS/DC 原包或参考程序。整份及城市级恢复仍是**产品实现缺口**：要先用当前命令与真实运行试验证明能否满足对象级预览及连锁影响，不能把“规格基础存在”写成已交付。E11 是已裁决的宿主能力与未实施 Gate 工作，不应以 UX-02 同步为由越过 E03 Gate。

## 实际验证与未完成工作

- PRD 原文件经 SHA-256 核对，PRD-001～009 与 A01～A09 各保留唯一编号；§7.5.1 建 14 类 UX-02 映射。文档检查不等于运行测试。
- GitHub 本轮只读：main、PR #10/#11/#12 的 head、合并状态及对应 E01 CI 成功记录已查询。没有本轮新增提交或 CI，也没有真实 PostgreSQL/HTTP 新验收。
- TS/DC 后续工程应在获准基线上为整份/城市级恢复、跨模块回执、真实宿主证据补正反测试；真实代码差异须在当时 head 重查，独立 PR 不覆盖 #10/#11/#12。

## 本轮隔离复跑记录

- TS 参考包复制到 `/private/tmp/antu-ts-reference-check` 后运行 `python3 -B run_validation.py`：**未进入有效回归**，因当前 Python 环境缺少锁定的 `jsonschema==4.23.0`；尝试安装依赖时网络域名解析失败。不可记为测试失败的业务回归，也不可记为通过。
- DC 参考包首次隔离复跑因未按原相邻 TS 包结构放置依赖而在启动前停止；未获得有效测试结论。本轮没有修改 DC 参考代码，不以此结果推断合同缺陷。
- PRD 静态核查：原文件保留 PRD-001～009、A01～A09；14 类映射存在，4 条本地相对链接全部可解析；同步后 SHA-256 为 `19321a8f0e459d54fcff5e54f77ea3af06235035699dcc777a3d6cff7dd2c203`。
