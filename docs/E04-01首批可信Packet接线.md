# E04-01｜首批合同与可信 Packet 接线

状态：首批实现完成，阶段仍在进行中；不记为 E04-01 ACCEPTED。

提交：代码提交 `28528d8f583654d5c86d211a9fa9cad14d5c9453`；Draft PR [#35](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/35)，目标为 E03 最终归档分支。

## 已实现

- NAP 0.1.0 七类消息使用 2026-11-06 R3 固定 Schema 做离线严格校验。
- DecisionPlan 校验唯一 Action/Step、主行动数量、Step DAG、kind 字段规则及 basis 内部引用。
- DecisionPlan 与 DecisionRequest 中的真实 DC 0.1.0 Packet 核对 decision/runtime、trip、revision、digest、turn、task、expiry 和 packet_id。
- E03 最终宿主新增一个窄的服务器内部 Packet 读取端口。调用方只能提交 Packet ID；正文来自宿主私有记录，并在返回前重新检查 Session、Trip membership、workspace/runtime 代次、原 Turn/Task/E11 来源、当前 Trip State、TTL 和本地交付状态。
- NAP `buildTrustedDecisionRequest()` 不接收 Packet JSON，只从上述端口构建请求；多 Packet 必须同 runtime、trip、revision 和 snapshot digest。

## 实际边界

这批代码没有执行 Action、签发 Grant、持久化 Plan 或声称用户理解 Packet。结构合法和可信读取只使 Packet 可以进入决策阶段，不构成执行许可。旧 `context-basis-preflight.ts` 没有进入本分支；Context 不能替代 Packet。

## 当前验证

- NAP 合同、Plan integrity、Packet consistency、可信来源单元测试：40/40 通过。
- TypeScript：通过。
- ESLint：通过。
- TS/DC 固定合同与 AC8 来源检查：通过。
- 真实 Session/PostgreSQL/HTTP 用例已加入既有 E03-04 联合测试，覆盖：当前真实 Packet 可构建请求、无 Session 被拒、业务 revision 变化后旧 Packet 被拒。该用例必须由 CI 的一次性 PostgreSQL 17 环境实际运行；本地没有 PostgreSQL，因此本地结果不冒充 PG 通过。
- 本地全量非 PG 回归：861 项通过、314 项因缺 PG 配置跳过；其中 9 个既有 Python 对照用例在 iCloud 路径超过默认 5 秒，以 20 秒上限单独复跑 110/110 通过。最终完整结论以 PR #35 同 head CI 为准。

## 尚未完成

- 多 Packet 分页完整交付与 NAP 消费策略的真实联测。
- 撤权、过期、恢复后 runtime 轮换的 E04 专项 PG 用例扩充。
- 不可变 Plan 保存、Decision 幂等及 Action Runtime（E04-03）。
