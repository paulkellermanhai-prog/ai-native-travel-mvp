# Schema Invariants｜永远不能被破坏的规则

违反任一强不变量时，拒绝整笔业务提交并保持当前状态与历史不变；已确认价值选择与现实条件发生冲突时，保留选择历史、标记待复核或阻塞，不能暗中补造事实。编号用于工程与 Agent 回归引用，不替代字段级 Schema 校验。

| ID | 不变量 | 权威／执行点 | 验证或边界 |
|---|---|---|---|
| I01 | 旅行内业务对象 ID 唯一，类型与 trip_id 不原位改变；引用不可悬空、跨旅行或指错类型 | 根 state + validate_state | 重复、跨旅行、错误类型测试 |
| I02 | 九信息域、十业务对象、两系统记录保持固定；DecisionContext 是只读投影，根容器不是第 11 对象 | 契约声明 | schemas 自检、对象清单测试 |
| I03 | 同一业务真值仅有一个拥有者：预算/日期在 Constraint，外部观察在 ExternalFact，用户选择在 Decision，当前采用在根引用 | 权威来源表 | 关系规格与跨对象验证 |
| I04 | Candidate 退出、重入或生命周期结束不得级联删除跨候选 Preference、Evidence、Constraint、ExternalFact、Decision 历史和实体 | Candidate 事件与历史 | B、G 场景及 H05 测试 |
| I05 | Preference 可以从 Candidate 或行为形成证据，但其生命周期不能被该 Candidate 单独决定；局部证据不自动扩大 scope；`superseded` 必有同旅行可追溯、无环的后继表达 | Preference.scope/condition、独立 id、后继 association `/status` | B、C 场景及继任正反测试 |
| I06 | AI 推断、浏览、点赞或模型生成解释不能自动变成用户 confirmed Preference、hard Constraint 或 Decision；未展示与无反馈不能变成排斥证据 | certainty/source/权限守卫 | A、C 场景与权限反例 |
| I07 | lifecycle status 不替代支持度、明确度、核验层级、用户选择、预订状态、现实可行性或当前采用关系 | 独立字段与根引用 | 字段与枚举词典、状态测试 |
| I08 | 只有当前旅行版本、具体提案摘要和经鉴权用户授权匹配时，模型提案才能应用到受保护范围 | Store.confirm | 版本冲突、过期确认、范围不足及幂等测试 |
| I09 | 用户确认价值选择不能提升 ExternalFact.verification，也不能作为提供方确认或支付授权 | Decision 与 ExternalFact 分离 | H02 与 E 场景 |
| I10 | budget intent/range 不等于 hard ceiling；金额不得跨币种、人数、类别直接求总价；部分成本不等于全程总价 | Constraint.value、assessment.cost_groups | H03/H10 与计算测试 |
| I11 | 未知、未发生、未表达、不适用、系统无法判断与明确 false/0/none 不混用；缺阈值和过期事实的条件结果为 unknown | nullable、三值条件、OpenIssue | A/D 与 null/条件测试 |
| I12 | scenario 不改 plan，暂定骨架不替换当前采用；已确认骨架须新版本，当前采用与唯一 confirmed adoption Decision 原子一致 | Skeleton.purpose、根引用、Decision | H06/H09、多轮轨迹 |
| I13 | 新骨架有已知硬约束冲突、所依赖的关键事实尚有争议，或旅行日期相交且与未取消的住宿城市冲突时不得生效；旅行日期已移开则保留回执及待处理未知；用户承认未知也不能宣称全程可行 | assess、adopt_skeleton | D/E/F 场景与阻塞测试 |
| I14 | 事实过期、超时、空结果、partial 与证实 no_service 必须区分；空集／超时不能证明无服务 | ExternalFact 四轴、受限 value | H02、交通事实测试 |
| I15 | 已确认住宿回执不能被单独 supersede/contradict 或因时间到期自动释放；同一回执只有一个 active 版本，可信同回执后继须同笔提交 | reservation profile + Store 守卫 | E 场景和预订正反测试 |
| I16 | 对象字段变化仅按实际依赖字段及隐式业务关系传播；无关对象保留原值，相关结果立即 stale 或 blocked，失败计算不能复活旧 verified | dependencies、_propagate、assess | D/F/G 与 H07 测试 |
| I17 | 用户已确认的价值选择因事实失效只变 review_state，不自动 revoked；替代或撤销仍须用户授权，撤销已确认决定须核对原确认人 | Decision.status、review_state | D/F/G、事实失效测试 |
| I18 | TS 只读 DecisionContext 投影消费前必须检查旅行 revision、到期和事实有效性，包含全部活动硬约束、确认决定与相关未知；独立 DC/NAP 不得复制业务真值或据旧投影执行 | context + context_is_current | H08 及上下文测试 |
| I19 | input 计算依赖无环；普通 association 可回路；实体父链、骨架父版本和决定替代谱系不得成环 | validate_state | 依赖与谱系测试 |
| I20 | 已解决 OpenIssue 必须有有效相关证据且阻塞消失；dismiss 只表示暂不处理，不能使外部事实或骨架变已核验 | OpenIssue 守卫 | H10 与问题测试 |
| I21 | 状态、依赖失效、当前采用、审计记录和幂等结果同笔原子提交；失败不能留下半应用状态 | Store 锁与 copy-on-write；生产事务契约 | 失败注入／确认失败／并发测试；生产崩溃恢复未测 |
| I22 | 每笔已提交或待确认业务操作的原始表达、查询条件、修改原因、前后值、执行主体与版本必须可从当前对象和追加历史追溯；未提交话语不伪称已在 TS 留存，也不得伪造旧值为未发生 | source、OperationIntent、ChangeRecord | C/E/G 场景及多轮历史测试 |

以上可执行验证是本地参考实现与合成样例的证据。真实模型抽取、供应商真实性、生产身份与数据库事务需要独立验收；不能因为 I01–I22 在本地通过就称这些外部能力已验证。

## UX-02 增量不变量

UX02-I01：历史恢复不原位覆盖；新骨架+当前parent+追加历史同事务。UX02-I02：城市恢复不得回滚其他城市停留；相邻影响与全程约束仍重新预览。UX02-I03：旧事实/旧授权不继承；硬冲突、并发或提交失败不改变当前有效版。UX02-I04：浏览/假设/未提交草稿不等于采用；幂等重试不双写。UX02-I05：已确认体验所在目录城市不能被新采用静默删除。
