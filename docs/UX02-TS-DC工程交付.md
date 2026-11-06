# UX-02 → TS / DC 工程交付候选

本轮以 Owner 已验收 UX-02 与已同步 PRD 为行为来源，将 E01–E32 映射并落实到 TS/DC 本地包；以 PR #11 head `0078bb542fd4ac81343a602d5f0fe4e62a42620c` 为实际 TS 开发基线。原 main/E02锁定快照、AC8候选、PR #10 与 #12、既有Gate记录均保留。分支 `feat/ux02-ts-dc-handoff` 叠加于PR11；不合并、不部署、不启动DC Runtime。

## 实施成果

- [逐项规则/职责/异常/授权/测试与E03映射](../specs/ux02-2026-11-06/sources/decision-context-v0.1/03_评审与工程衔接/18_UX02行为落实与E03开发验收映射.md)：32行覆盖，无日期探索、反馈、比较、编辑、A/B/C、历史恢复、提交回执、并发与跨会话。界面/语义/真实数据与NAP责任单列，不转写成TS独有状态。
- TS参考与实际代码：`restoration_request` / `restorationRequest`输出原create+adopt原子批次；新增只读恢复预览HTTP封装，复用原鉴权、Origin、数字/体积校验、事务、幂等与确认。城市恢复只替指定停留及必要相邻连接/明确相关费用；整份恢复取旧安排；当前约束/已确认决定不回滚，当前事实消费时重查，旧评估/授权不继承。
- 采用守卫增加：已确认体验目录祖先城市不能被静默删除；原确认人撤销守卫仍适用。单城市内具体体验排程不属于当前Skeleton合同，仍需计算器与宿主检查，不假称完整保护。
- DC参考增量：历史比较只读提示、假设草稿新实际意图提示；新保存草稿绑定所有提案输入目标，旧格式1现场保留只读兼容提示。正式规格原位补充，并形成E03-01～07子任务/建议位置/依赖/测试清单；不创建DC生产模块。
- [来源锁与包文件指纹](../specs/ux02-2026-11-06/manifest.json)；[机器合同兼容检查](../specs/ux02-2026-11-06/contract-compatibility.json)。TS/DC各20份Schema逐字节不变，0.1.0与Checkpoint格式1不变。新增HTTP预览封装为可见增量，须技术审核，不用Schema未变掩盖行为差异。

## 新HTTP能力

`POST /trips/{id}/restorations/preview`只准备与预览，无提交副作用。字段：source_id、new_id、expected_revision、idempotency_key、input、reason，可选city_id、insert_at、acknowledge_unknowns；额外actor/owner字段拒绝。成功包是`{request, preview, impact, can_submit, warnings}`，输入/鉴权错误沿用原response；领域阻断以422/409同包返回can_submit=false与只读impact评估。必须展示当前差异、全程影响和未知后，将同一个request按本轮权限提交到原`/changes`；无新精确授权时只能Model提案。提交超时先查权威状态/历史并按原幂等请求重试；不能重新编译旧恢复冒充新意图。比较入口使用已有TS input.kind和真实reference，不新增枚举。

## 验证与限制

实际结果、提交和CI见同PR最终说明及后附验收证据。新增测试：TS恢复编译/边界、Python独立对照、PG恢复/重连幂等/当前硬冲突、真实HTTP身份/预览零写/两种恢复/重复与旧revision拒绝。CI固定PG17，缺配置不可跳过。

本机无PostgreSQL服务；本地集成skip不作为通过，须以PR head的真实CI/HTTP结果为准。真实LLM、数据供应商、完整成本与体验代价、UI三入口和自动保存体验仍待后续模块验收；本次后台功能不是完整旅行产品上线。

## DC与NAP后续

R6 Gate A已在PR12真实review 5795631033通过，E03-01已获准；本轮UX02增量只补审实际差异，不能沿用R6批准假定R7已接受。详见[增量评审边界](UX02-DC已通过GateA的增量评审范围.md)。八阶段权重不变。宿主E11原话保留/删除产品策略已批准，生产配置、备份/审计有限周期及真实执行验收仍依既有Gate。

[NAP本轮只读影响](UX02-NAP后续影响.md)留下一轮处理。本轮不修改NAP包/代码。任何新产品取舍仍交Owner；既有已验收行为继续实施，来源缺失的候选UI/固定阈值不自动定稿。

## PR #13 技术审核后增量（F01–F04）

此前内容对应旧head `3b1fa6f`；审核 `UX02-PR13-TECH-REVIEW-2026-11-06-01` 未签发整体 PASS。当前候选按已验收UX-02修正：恢复请求显式 `source_id + source_version`，使用旅行授权历史中已应用的变更快照或当前对象解析精确版本，不存在或同版本内容冲突时拒绝，原ChangeRecord.reason记录来源版本。新增独立[HTTP返回合同](UX02恢复预览HTTP合同.md)，区分成功与可解释阻断封装、编译前错误、鉴权和内部错误；422/409不能仅凭状态码判断响应形状。

新增目标城市有实际差异而其他城市不回滚、Model接受/拒绝、预览后并发、数据库提交故障回滚、事实争议重查测试；R6真实检查点由获准R6进程写入并由R7另一进程恢复，验证旧绑定不足只读警告、旧事件不可重放、原样保存和非法修改不覆盖最后成功点。CI新增两个包各20份Schema与已批准原件逐字节对照。工程分发快照移除仅含本机路径的LOCAL_EXPORT，本地原件保留。

R6 Gate A PASS、E03-01原授权及冻结来源不变；本修订是待技术负责人审核的新增量，非R7整体通过、非自动合并许可。详见独立HTTP合同、`scripts/test-ux02-r6-compat.py`与最新PR head的测试证据。
