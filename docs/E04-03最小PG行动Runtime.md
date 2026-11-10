# E04-03｜最小 PostgreSQL Action Runtime

状态：本地实现与真实 PG17 验证完成，等待技术负责人签核；不自行记为 E04-03 ACCEPTED。

## 最小实现

- 选择性复用历史 #20 的 Action phase 纯转换，保留 `proposed/eligible/blocked/waiting_user/running/partial/succeeded/failed/stale/cancelled` 与终态不复活边界。
- 新增内部 MVP 专用 `e04_runtime` schema，仅存不可变 DecisionRequest/Plan、ActionRecord 和 Step 运行事实；不作为 TS 业务对象。
- Decision 主键绑定 owner、Trip、workspace 与 `decision_id`，行内保留 runtime、revision、截止时间、request digest 和 plan digest。同 ID 同请求返回首次 Plan，不同请求报 `DECISION_CONFLICT`。
- Step 认领在一个 PG 事务中锁定 Decision/Action/Step，检查依赖、当前 runtime/revision/TTL，然后以 `pending → running` 条件更新签发单次 claim token。
- `ask` 起始的 Action 记为 `waiting_user`；未完成依赖返回 `dependency_wait`；旧 runtime、旧 revision 或过期 Plan 只能进入 `stale`，不得重新认领。
- 执行回执不确定时，Action 保持 `running` 并写入 `receipt_lookup_required=true`，不把超时当失败或成功。E04-04 使用 E02 原幂等结果完成该查证。

## 真实验证

- 全新一次性 PostgreSQL 17 数据库；E03 与 E04 候选安装器从零安装。
- 真实 Session/HTTP/PG 联合回归 2/2 通过（12.40s）。
- 并发提交两次同 Step 认领，结果精确为一个 `claimed` 和一个 `already_claimed`。
- 真实 Checkpoint restore 后仍能读取已保存记录，但旧 runtime/revision 的未执行 Action 只能标记 `stale`。
- Action phase 与 E04-02 受影响定向测试 23/23、TypeScript 和 ESLint 通过。

## 边界

该 schema 是内部 MVP 候选安装，不是生产迁移、通用任务平台或多实例分布式锁。工具完成账本、用户反馈和交付记录仍按 E04-05/06 边界保留。本阶段没有新的 Owner 产品裁决点。
