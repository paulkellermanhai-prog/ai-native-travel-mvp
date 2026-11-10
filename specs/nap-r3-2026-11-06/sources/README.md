# ANTU｜Next Action Policy V0.1

NAP帮助ANTU判断“此刻最值得怎样帮助用户”。旅行状态记住已知条件与选择，决策上下文把当前判断需要的资料整理出来，NAP据此选择探索、核验、比较、必要提问或关键确认；工具与原状态系统受控执行，用户保留重要取舍权。

**交付状态：0.1.0工程规格评审候选。** 产品规则、工程接口和测试数据已经按职责整合；实现待开发，真实模型/工具、UI、生产与用户效果未实测。C3仍为有条件通过、待Owner审核，本包没有代签批准。完整收口判断和阻断项见[DEC-10](DECISIONS.md#dec-10)。

## Owner先读这个例子

用户说“阿斯旺值得加吗？怕转场累”：系统先理解顾虑与当前条件，准备合格的交通核验，再解释加入/不加入的收益、代价与未知；不让用户自己反复搜索，也不因查完交通就替用户把城市加进有效方案。用户改日期时，旧查询不当新日期依据；用户拒绝时按范围尊重，只有符合已确认边界才允许一次有限遗漏价值提示。[完整业务实例](policy/action-policy.md#business-example)。

## 文件与按任务导航

```text
Next-Action-Policy-V0.1/
├── README.md
├── policy/
│   ├── behavior-spec.md
│   └── action-policy.md
├── engineering/
│   ├── contracts.md
│   ├── contracts.schema.json
│   └── runtime.md
├── quality/
│   ├── evaluation.md
│   ├── cases.jsonl
│   ├── cases.schema.json
│   ├── check_package.py
│   └── validation-report.json
├── DECISIONS.md
└── package-index.json
```

| 想查什么 | 打开哪里 |
|---|---|
| AI主动到什么程度、谁决定、何时澄清、预算和MVP边界 | [产品行为规范](policy/behavior-spec.md) |
| 为什么选这一步、G规则如何协同、主次与历史需求 | [通用行动机制](policy/action-policy.md) |
| 输入输出、原模块字段、工具与UI、交付日志 | [工程契约](engineering/contracts.md)及[机器Schema](engineering/contracts.schema.json) |
| 执行、生命周期、过期/失败、并发与权限守卫 | [运行机制](engineering/runtime.md) |
| 某项INV如何挡住错误，怎样测 | [INV权威表](engineering/runtime.md#invariants)→[评测方法](quality/evaluation.md)→Case ID |
| PRD验收覆盖、58例、逐轮状态要求 | [验收与追踪](quality/evaluation.md)、[案例JSONL](quality/cases.jsonl) |
| 过去为什么这样定、哪些旧方案失效、当前开发阻断 | [决策与状态](DECISIONS.md) |
| AI按编号/问题定位，不通读全部文档 | [机器索引](package-index.json)，先查rule_index/case_index/task_index |
| 本轮究竟跑了什么、没跑什么 | [验证记录](quality/validation-report.json) |

额外Schema分别约束工程消息与案例封装；索引提供定位、依赖版本与内容摘要；验证记录保存本轮真实检查；只读检查器让后续修改可重新核验。它们不增加新的产品规则权威，也不引入历史阶段目录。

## 一个语义，一个权威位置

| 编号/内容 | 唯一当前定义 |
|---|---|
| NAP-P01～P05、NAP-R01～R06、最高原则 | [behavior-spec](policy/behavior-spec.md)的同名稳定锚点 |
| G01～G05、D1～D5、竞争与RC应用裁决 | [action-policy](policy/action-policy.md) |
| CT-01～CT-06字段含义、接口责任/信任边界 | [contracts](engineering/contracts.md)；字段结构/值域仅以相邻Schema声明 |
| RT-01～RT-06执行规则、K01～K06、INV-01～10 | [runtime](engineering/runtime.md) |
| Case ID的执行语义、顺序、预期与来源文本 | [cases.jsonl](quality/cases.jsonl)，以case_id检索；评测文档只提供导航/判定方法 |
| 评测口径及PRD A01～A09到工程/案例的映射 | [evaluation](quality/evaluation.md)，PRD要求本身仍以外部PRD为准 |
| 历史取舍与版本效力 | [DECISIONS](DECISIONS.md)；摘要不重定义规则 |

外部依赖：[PRD V0.1](../AI%20Native旅行产品｜PRD%20V0.1.md)、[Trip State 0.1.0](../trip-state-schema-v0.1/00_从这里开始.md)、[Decision Context V0.1.0（含跨会话恢复）](../decision-context-v0.1/00_从这里开始.md)。C3行为/案例来源锁定[C3-R2](nap-c3-validation/00_从这里开始.md)，旧Handoff仅作追溯。包内`nap-c3-validation/`为2026-10-26历史证据快照，其中旧DC版本描述不再作为有效依赖；当时的source-manifest仅保留来源历史，当前版本和路径以本包package-index为准。本次基线修复日期为2026-10-28，NAP自身契约仍为0.1.0。复制本包离开项目时须保留这些同级依赖或按索引重新绑定，不能将断链视为依赖已消失。

本地原包已对齐当前DC，修复与实际回归见[基线审计](quality/baseline-repair-2026-10-28.json)。MVP Engineering仓库的10月27日冻结快照及旧依赖登记不会随本包自动更新；使用该快照的工程任务须另外审核并同步版本锁，不能覆盖既有不可变来源或把本次修复误当已完成MVP接入。

## 开发最小起点与阅读顺序

1. Owner：README→behavior-spec→完整业务实例→DEC-10。只需判断重要产品/权限取舍和当前保留项，不必逐字段审代码。
2. 开发/Codex：behavior-spec→action-policy→contracts与Schema→runtime→evaluation与案例→DECISIONS。优先按CT-01真实版本映射，不照旧交接猜字段。
3. 最小实现：宿主复用TS/DC读取与授权，先做无副作用`decide`和Schema/资格校验；再实现CT-05运行日志、交付回执和UI反馈；最后接可信工具、原状态修改/确认链路和多轮驱动。首个集成目标S01/S02/X10，随后F06/X02/S08/N02/N08；无正式Policy实现随本包交付。
4. 测试：JSONL为58个scenario＋3个walkthrough＋12个calibration记录，共73行，kind必须分开统计。Case初态为产品语义夹具，不伪装成TS合法快照；真实执行先构建并通过原TS/DC验证。C3源文本、反事实变量、工具分支与步骤已保留，不要只测试一段期望文案。

## 关键术语

| 术语 | 含义 |
|---|---|
| Trip State | 旅行业务真值和依据，不是全部聊天日志 |
| Decision Context / Packet | 当前问题的只读资料引用/正文包，不能另改有效预算或决定 |
| Action / Step | 有决策目标的行为与内部操作；一次行为可有多个步骤 |
| 授权 / 确认 | 对当前具体影响和范围的真实允许，不是模型说“用户同意” |
| 假设 / 暂定 / 有效 | 讨论可能、尚未采用的编辑、用户当前采用；三者不混写 |
| RequestObservation | 本包新增运行交互证据，不是第二份旅行状态 |
| 规格验收 / Evals | 前者检查规则与契约是否清楚一致，后者记录真实系统实际运行表现 |

下一步开发可以从受限、可核验的路径开始；最终发布仍需完成基线审核、实现与实际评测。文件存在及Schema通过不证明系统已实现。


## 2026-11-06 八项机制及 UX-02 修订

已在原行为、机制、合同和运行章节落实已确认的恢复、选择、证据、授权和失败语义；[逐项追溯与状态](engineering/ac8-ux02-integration.md)记录八项机制、E01–E32、14 项来源差异及真实依赖。`quality/eligibility_reference.py` 与测试仅为合成守卫参考。本包仍为工程规格评审候选，C3／新合同 Owner 最终审核未记录，不因本轮修订或上游 Gate 自动获批；历史 C3 和冻结快照不改。

## 独立审核后的 R2 修订

P05 的都不是、自由输入及无合理备选时开放问句已明确；E01–E32 的逐项责任与断言见 [UX 验收详表](engineering/ux02-e01-e32-acceptance.md)，14 项完整旧新 diff 及处理见 [来源差异审核](engineering/source-drift-review.md)。旧源快照与 diff 随包保存。合成参考测试仍不是真实策略或 UI 测试。本轮增量仍待独立复审。
