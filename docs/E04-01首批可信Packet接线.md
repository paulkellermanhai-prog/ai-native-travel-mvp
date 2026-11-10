# E04-01｜首批合同与可信 Packet 接线

状态：本阶段实现已交付，等待技术负责人验收；不自行记为 E04-01 ACCEPTED。

承接点：已审查提交 `384c138e80f16bf02fc7bb55cb47d6fea3f9270b`；交付位置为 Draft PR [#35](https://github.com/paulkellermanhai-prog/ai-native-travel-mvp/pull/35)，目标仍为 E03 最终归档分支。最终验收以 PR 当前 head 绑定的 CI 为准。

## 已实现

- NAP 0.1.0 七类消息使用 2026-11-06 R3 固定 Schema 做离线严格校验。
- DecisionPlan 校验唯一 Action/Step、主行动数量、Step DAG、kind 字段规则及 basis 内部引用。
- DecisionPlan 与 DecisionRequest 中的真实 DC 0.1.0 Packet 核对 decision/runtime、trip、revision、digest、turn、task、expiry 和 packet_id。
- E03 最终宿主新增一个窄的服务器内部 Packet 读取端口。调用方只能提交 Packet ID；正文来自宿主私有记录，并在返回前重新检查 Session、Trip membership、workspace/runtime 代次、原 Turn/Task/E11 来源、当前 Trip State、TTL 和本地交付状态。
- NAP `buildTrustedDecisionRequest()` 不接收 Packet JSON，只从上述端口构建请求；`user_event` 必须精确绑定宿主登记事件的 reference。
- 多 Packet 改为一次宿主批量读取。宿主复用私有交付账本，缺页或仍在末页 postflight 的 Packet 不得进入决策；批次返回前再次复验同一 Session、membership、runtime、当前 revision、共同 digest 和期限。

## 实际边界

这批代码没有执行 Action、签发 Grant、持久化 Plan 或声称用户理解 Packet。结构合法和可信读取只使 Packet 可以进入决策阶段，不构成执行许可。旧 `context-basis-preflight.ts` 没有进入本分支；Context 不能替代 Packet。

## E04-01 验收证据（待技术负责人签核）

- NAP 合同、Plan integrity、Packet consistency、可信来源单元测试：41/41 通过。
- TypeScript：通过。
- ESLint：通过。
- TS/DC 固定合同与 AC8 来源检查：通过。
- 私有 Packet socket / 交付账本回归：7/7 通过。
- 真实 Session/PostgreSQL/HTTP 回归已并入既有 E03-04 联合测试，最终证据以本次交付 head 的 PostgreSQL 17 CI 为准，不沿用旧 head 的通过记录。

| Gate | 真实覆盖 | 预期 |
| --- | --- | --- |
| 来源绑定 | 伪造 `user_event.reference`、错误 Session、无 Session | 全部拒绝 |
| 私有交付账本 | 缺页；末页响应已发出但 postflight 未完成 | 缺页拒绝；postflight 完成前等待，完成后放行 |
| 批次当前性 | 同批 Packet 的 Session、membership、runtime、revision、digest、TTL | 整批一次复验；任一不合法则整批拒绝 |
| 并发失效 | 批次候选形成后撤销 membership | 最终复验拒绝，不向决策器交付 |
| 恢复与过期 | Checkpoint 恢复换代；Session 过期 | 旧 Packet/旧 runtime 拒绝；过期 Session 拒绝 |
| 既有 revision 边界 | 业务 revision 改变后读取旧 Packet | 拒绝 |

不可变 Plan 保存、Decision 幂等及 Action Runtime 属于 E04-03，不在本次 E04-01 验收范围内。本阶段没有新增 Owner 产品裁决事项。
