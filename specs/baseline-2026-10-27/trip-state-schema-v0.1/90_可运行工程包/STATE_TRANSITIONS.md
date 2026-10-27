# 正式状态转换表

未列出的转换均非法。所有转换还需通过规格中的引用、版本、权限和业务守卫；命令不可直接写 status。

部分中间态用于契约／导入兼容；参考实现新建 Decision 时直接经专用命令产生 confirmed，不独立持久化待确认 Decision。待确认提案由 ChangeRecord 和 OperationIntent 留痕。

| 对象 | 起点 | 事件 | 终点 | 主体 | 确认要求 | 守卫 | 关联影响 |
|---|---|---|---|---|---|---|---|
| TripGoal | draft | activate | active | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 目标范围明确 | 传播输入变化 |
| TripGoal | revised | activate | active | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 目标范围明确 | 传播输入变化 |
| TripGoal | active | revise | revised | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 明确修正 | 保留历史并传播 |
| TripGoal | draft | close | closed | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 明确结束 | 保留历史 |
| TripGoal | active | close | closed | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 明确结束 | 保留历史 |
| TripGoal | revised | close | closed | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 明确结束 | 保留历史 |
| Preference | active | supersede | superseded | user | 仅用户明确替代／撤回；推断偏好可另行修正字段 | 明确替代；同笔最终状态存在无环的后继 Preference association /status | 传播输入变化 |
| Preference | active | withdraw | withdrawn | user | 仅用户明确替代／撤回；推断偏好可另行修正字段 | 明确撤回 | 保留证据 |
| Constraint | proposed | activate | active | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 硬约束不得缺关键值 | 影响范围重新校验 |
| Constraint | active | relax | relaxed | user | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | override_policy=user | 不改写原值 |
| Constraint | active | invalidate | invalidated | user, system | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 用户约束须确认；固定约束仅系统凭被反证／替代证据纠错 | 影响范围重新校验 |
| Constraint | proposed | invalidate | invalidated | user, system | 用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | 用户约束须确认；固定约束仅系统凭被反证／替代证据纠错 | 影响范围重新校验 |
| DestinationEntity | known | retire | retired | system | 不增加用户确认；仍执行权限与证据守卫 | 知识目录维护 | 不删除引用 |
| DestinationEntity | retired | restore | known | system | 不增加用户确认；仍执行权限与证据守卫 | 知识目录维护 | 恢复目录可见性 |
| Candidate | exploring | retain | retained | user, model, system | 不增加用户确认；仍执行权限与证据守卫 | 不意味着确认 | 仅候选判断 |
| Candidate | reintroduced | retain | retained | user, model, system | 不增加用户确认；仍执行权限与证据守卫 | 不意味着确认 | 仅候选判断 |
| Candidate | exploring | exclude_conditionally | conditionally_excluded | user, model, system | 不增加用户确认；仍执行权限与证据守卫 | 排除理由明确且不覆盖确认决定 | 保留偏好与证据 |
| Candidate | retained | exclude_conditionally | conditionally_excluded | user, model, system | 不增加用户确认；仍执行权限与证据守卫 | 排除理由明确且不覆盖确认决定 | 保留偏好与证据 |
| Candidate | reintroduced | exclude_conditionally | conditionally_excluded | user, model, system | 不增加用户确认；仍执行权限与证据守卫 | 排除理由明确且不覆盖确认决定 | 保留偏好与证据 |
| Candidate | exploring | exclude | excluded | user | 用户明确授权；模型提案须先确认 | 不覆盖确认决定 | 保留偏好与证据 |
| Candidate | retained | exclude | excluded | user | 用户明确授权；模型提案须先确认 | 不覆盖确认决定 | 保留偏好与证据 |
| Candidate | reintroduced | exclude | excluded | user | 用户明确授权；模型提案须先确认 | 不覆盖确认决定 | 保留偏好与证据 |
| Candidate | conditionally_excluded | exclude | excluded | user | 用户明确授权；模型提案须先确认 | 不覆盖确认决定 | 保留偏好与证据 |
| Candidate | excluded | reconsider | reintroduced | user, system | 不增加用户确认；仍执行权限与证据守卫 | 触发引用存在且条件成立 | 不自动成为已选 |
| Candidate | conditionally_excluded | reconsider | reintroduced | user, system | 不增加用户确认；仍执行权限与证据守卫 | 触发引用存在且条件成立 | 不自动成为已选 |
| ExternalFact | active | supersede | superseded | tool, system | 不增加用户确认；仍执行权限与证据守卫 | 证据可追溯 | 依赖失效 |
| ExternalFact | active | contradict | contradicted | tool, system | 不增加用户确认；仍执行权限与证据守卫 | 反证有来源 | 依赖失效 |
| Skeleton | active | supersede | superseded | system | 仅由已授权的采用／选择命令原子触发，不开放单独替代 | 采用另一版本且原版本不再当前 | 保留旧骨架 |
| Skeleton | active | archive | archived | user | 用户明确授权；模型提案须先确认 | 不是当前有效骨架 | 保留旧版本 |
| Skeleton | superseded | archive | archived | user | 用户明确授权；模型提案须先确认 | 不是当前有效骨架 | 保留旧版本 |
| Decision | proposed | request_confirmation | pending_confirmation | user, model, system | 不增加用户确认；仍执行权限与证据守卫 | 具体范围明确 | 不应用选择 |
| Decision | proposed | confirm | confirmed | user | 用户明确授权；模型提案须先确认 | 专用确认命令；版本、范围、权限与约束通过 | 原子应用选择 |
| Decision | pending_confirmation | confirm | confirmed | user | 用户明确授权；模型提案须先确认 | 专用确认命令；版本、范围、权限与约束通过 | 原子应用选择 |
| Decision | confirmed | supersede | revised | system | 仅由已授权的采用／选择命令原子触发，不开放单独替代 | 新决定替代同范围旧决定 | 保留历史 |
| Decision | proposed | revoke | revoked | user | 用户明确授权；模型提案须先确认 | 专用撤销命令 | 必要时清空当前采用引用 |
| Decision | pending_confirmation | revoke | revoked | user | 用户明确授权；模型提案须先确认 | 专用撤销命令 | 必要时清空当前采用引用 |
| Decision | confirmed | revoke | revoked | user | 用户明确授权；模型提案须先确认 | 专用撤销命令 | 必要时清空当前采用引用 |
| OpenIssue | open | make_actionable | actionable | system, user | 不增加用户确认；仍执行权限与证据守卫 | 至少有可尝试的候选动作 | 不等于缺口已补齐或解决 |
| OpenIssue | waiting | make_actionable | actionable | system, user | 不增加用户确认；仍执行权限与证据守卫 | 至少有可尝试的候选动作 | 不等于缺口已补齐或解决 |
| OpenIssue | open | wait | waiting | system, user | 不增加用户确认；仍执行权限与证据守卫 | 等待输入或工具 | 保持未知 |
| OpenIssue | actionable | wait | waiting | system, user | 不增加用户确认；仍执行权限与证据守卫 | 等待输入或工具 | 保持未知 |
| OpenIssue | open | resolve | resolved | system, user | 不增加用户确认；仍执行权限与证据守卫 | 证据有效且原阻塞已消除 | 保留解决依据 |
| OpenIssue | actionable | resolve | resolved | system, user | 不增加用户确认；仍执行权限与证据守卫 | 证据有效且原阻塞已消除 | 保留解决依据 |
| OpenIssue | waiting | resolve | resolved | system, user | 不增加用户确认；仍执行权限与证据守卫 | 证据有效且原阻塞已消除 | 保留解决依据 |
| OpenIssue | open | dismiss | dismissed | user | 用户明确授权；模型提案须先确认 | 理由非空 | 不改变事实或可行性 |
| OpenIssue | actionable | dismiss | dismissed | user | 用户明确授权；模型提案须先确认 | 理由非空 | 不改变事实或可行性 |
| OpenIssue | waiting | dismiss | dismissed | user | 用户明确授权；模型提案须先确认 | 理由非空 | 不改变事实或可行性 |
| OpenIssue | resolved | reopen | open | system, user | 不增加用户确认；仍执行权限与证据守卫 | 问题再次出现 | 恢复可见问题 |
| OpenIssue | dismissed | reopen | open | system, user | 不增加用户确认；仍执行权限与证据守卫 | 问题再次出现 | 恢复可见问题 |
| DecisionContext | assembled | activate | active | system | 不增加用户确认；仍执行权限与证据守卫 | 版本与时效检查通过 | 只读投影 |
| DecisionContext | assembled | invalidate | stale | system | 不增加用户确认；仍执行权限与证据守卫 | 旅行版本变化或时间过期 | 禁止用于新提交 |
| DecisionContext | active | invalidate | stale | system | 不增加用户确认；仍执行权限与证据守卫 | 旅行版本变化或时间过期 | 禁止用于新提交 |
| DecisionContext | assembled | release | released | system | 不增加用户确认；仍执行权限与证据守卫 | 任务结束 | 可重建 |
| DecisionContext | active | release | released | system | 不增加用户确认；仍执行权限与证据守卫 | 任务结束 | 可重建 |
| DecisionContext | stale | release | released | system | 不增加用户确认；仍执行权限与证据守卫 | 任务结束 | 可重建 |

所有失败统一拒绝整笔业务提交，返回规则错误，原有效状态保持。用户拒绝待确认提案会另外留下 rejected 变更记录。

## 正交维度维护

| 维度 | 触发 | 维护规则 |
|---|---|---|
| Preference.certainty/support | 明确用户纠错或模型提出候选解释 | 明确值只有用户能修改；模型覆盖进入待确认，不直接生效 |
| ExternalFact.freshness | 时效检查 / 消费时钟 | 到期即不可消费；重新查询创建新事实，不直接把 stale 改回 current |
| ExternalFact.applicability | 旅行日期变化 | 原观察保留；不适用事实不能支撑新日期结论 |
| Skeleton.assessment | 输入变化 / 确定性重算 | 先 stale，再计算 pending / verified / blocked；无法计算保持未知 |
| Candidate/Decision.review_state | 所依赖字段变化 | 变 stale；用户决定 status 不因此被撤销；新确认建立当前依据 |
| 根 effective_skeleton_id | adopt_skeleton / withdraw_decision | 与确认记录及旧版本替代关系原子更新 |
| DecisionContext 生命周期 | 组装、版本变化、时间到期、释放 | 只读派生；context_is_current 在消费前验证，过期对象应丢弃重建 |
