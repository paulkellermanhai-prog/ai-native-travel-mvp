# E04-01｜首批合同与可信 Packet 接线

状态：本阶段实现已交付，等待技术负责人验收；不自行记为 E04-01 ACCEPTED。

承接点：已审查提交 `384c138e80f16bf02fc7bb55cb47d6fea3f9270b`；交付位置为 Draft PR [#35](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/35)，目标仍为 E03 最终归档分支。最终验收以 PR 当前 head 绑定的 CI 为准。

## 已实现

- NAP 0.1.0 七类消息使用 2026-11-06 R3 固定 Schema 做离线严格校验。
- DecisionPlan 校验唯一 Action/Step、主行动数量、Step DAG、kind 字段规则及 basis 内部引用。
- DecisionPlan 与 DecisionRequest 中的真实 DC 0.1.0 Packet 核对 decision/runtime、trip、revision、digest、turn、task、expiry 和 packet_id。
- E03 最终宿主新增一个窄的服务器内部 Packet 读取端口。调用方只能提交 Packet ID；正文来自宿主私有记录，并在返回前重新检查 Session、Trip membership、workspace/runtime 代次、原 Turn/Task/E11 来源、当前 Trip State、TTL 和本地交付状态。
- NAP `buildTrustedDecisionRequest()` 不接收 Packet JSON，只从上述端口构建请求；`user_event` 必须精确绑定宿主登记事件的 reference。
- 多 Packet 改为一次宿主批量读取。宿主复用私有交付账本，缺页或仍在末页 postflight 的 Packet 不得进入决策；postflight 完成后从同一候选快照物化完整正文，保留原 Packet、身份、basis、来源时间与事实截止时间。
- 批次返回前再次复验同一 Session、membership、workspace/runtime、当前 revision 和每包期限。不强制不同 Task 的 Packet 共用 snapshot digest；每包保留自己的可信 digest 和 Context 截止时间。
- `DecisionRequest` 暂时只接受与同一真实 Turn 登记事件精确绑定的 `user_event`；未有可信宿主登记的其他 trigger 类型全部关闭。

## 实际边界

这批代码没有执行 Action、签发 Grant、持久化 Plan 或声称用户理解 Packet。结构合法和可信读取只使 Packet 可以进入决策阶段，不构成执行许可。旧 `context-basis-preflight.ts` 没有进入本分支；Context 不能替代 Packet。

## E04-01 验收证据（待技术负责人签核）

- 本轮受影响的 Packet core 与可信来源定向单元测试：22/22 通过。
- TypeScript：通过。
- ESLint：通过。
- DC 固定合同检查：通过。
- 真实 Session/PostgreSQL 17/HTTP 联合回归：2/2 通过（12.83s）；使用本轮新建的一次性隔离数据库，不沿用旧 head 的通过记录。
- GitHub 按本轮授权保持只读；因此本地证据不写成远程 CI 通过，E04-01 仍留给技术负责人签核。

| Gate | 真实覆盖 | 预期 |
| --- | --- | --- |
| 来源绑定 | 伪造 `user_event.reference`、错误 Session、无 Session | 全部拒绝 |
| 私有交付账本 | 缺页；末页响应已发出但 postflight 未完成 | 缺页拒绝；postflight 完成前等待，完成后放行 |
| 批次当前性 | 同一真实 Turn 下两个 Task/Packet；Session、membership、workspace/runtime、revision、每包 digest/TTL | 两包精确身份与完整正文一次交付；任一失败时无部分返回 |
| 并发失效 | 显式暂停最终复验，控制 membership 删除提交后再放行 | 最终复验拒绝，不向决策器交付 |
| 锁语义 | Trip State 写锁下的正常等待；500ms 测试 lock timeout | 锁释放后正常读取；超时记为 `EVIDENCE_UNAVAILABLE`，不冒充撤权 `EVIDENCE_ACCESS_DENIED` |
| 恢复与过期 | Checkpoint 恢复换代；Session 过期 | 旧 Packet/旧 runtime 拒绝；过期 Session 拒绝 |
| 既有 revision 边界 | 业务 revision 改变后读取旧 Packet | 拒绝 |

不可变 Plan 保存、Decision 幂等及 Action Runtime 属于 E04-03，不在本次 E04-01 验收范围内。本阶段没有新增 Owner 产品裁决事项。
