# State Transition Matrix｜正式状态转换矩阵

从 `tripstate/contracts.py` 的 TRANSITIONS 同源生成。前置条件还包括对象引用、旅行版本、专用命令、权限和确认摘要校验；不满足任何条件均拒绝整笔业务提交。`Reversible` 指能否通过新事件重新进入判断，不代表删除历史或恢复旧快照。

Decision 的 proposed/pending_confirmation 与 DecisionContext 的 assembled/stale/released 保留为契约／外部导入兼容态；本地正常流程分别以待确认提案记录和按需只读投影承载，直接生成 confirmed Decision 或 active Context。这是有意的 runtime 可达性边界，不应伪称所有契约状态都由当前 API 产出。终态无出口为有意设计；需要恢复时创建新版本或按表重开。

| Object | From | Trigger | Actor | Preconditions / Confirmation | To | Side Effects | Reversible | Audit Required |
|---|---|---|---|---|---|---|---|---|
| TripGoal | draft | activate | User | 目标范围明确；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | active | 传播输入变化 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| TripGoal | revised | activate | User | 目标范围明确；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | active | 传播输入变化 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| TripGoal | active | revise | User | 明确修正；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | revised | 保留历史并传播 | 可经 activate 继续；旧值不原位恢复 | 是，OperationIntent + ChangeRecord |
| TripGoal | draft | close | User | 明确结束；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | closed | 保留历史 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| TripGoal | active | close | User | 明确结束；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | closed | 保留历史 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| TripGoal | revised | close | User | 明确结束；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | closed | 保留历史 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Preference | active | supersede | User | 明确替代；同笔最终状态存在无环的后继 Preference association /status；仅用户明确替代／撤回；推断偏好可另行修正字段 | superseded | 传播输入变化 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Preference | active | withdraw | User | 明确撤回；仅用户明确替代／撤回；推断偏好可另行修正字段 | withdrawn | 保留证据 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Constraint | proposed | activate | User | 硬约束不得缺关键值；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | active | 影响范围重新校验 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Constraint | active | relax | User | override_policy=user；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | relaxed | 不改写原值 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Constraint | active | invalidate | User, System | 用户约束须确认；固定约束仅系统凭被反证／替代证据纠错；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | invalidated | 影响范围重新校验 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Constraint | proposed | invalidate | User, System | 用户约束须确认；固定约束仅系统凭被反证／替代证据纠错；用户明确指令；非用户提案待确认（仅 fixed 的有依据系统失效例外） | invalidated | 影响范围重新校验 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| DestinationEntity | known | retire | System | 知识目录维护；不增加用户确认；仍执行权限与证据守卫 | retired | 不删除引用 | 可经 restore 重激活 | 是，OperationIntent + ChangeRecord |
| DestinationEntity | retired | restore | System | 知识目录维护；不增加用户确认；仍执行权限与证据守卫 | known | 恢复目录可见性 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Candidate | exploring | retain | User, AI, System | 不意味着确认；不增加用户确认；仍执行权限与证据守卫 | retained | 仅候选判断 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Candidate | reintroduced | retain | User, AI, System | 不意味着确认；不增加用户确认；仍执行权限与证据守卫 | retained | 仅候选判断 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Candidate | exploring | exclude_conditionally | User, AI, System | 排除理由明确且不覆盖确认决定；不增加用户确认；仍执行权限与证据守卫 | conditionally_excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | retained | exclude_conditionally | User, AI, System | 排除理由明确且不覆盖确认决定；不增加用户确认；仍执行权限与证据守卫 | conditionally_excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | reintroduced | exclude_conditionally | User, AI, System | 排除理由明确且不覆盖确认决定；不增加用户确认；仍执行权限与证据守卫 | conditionally_excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | exploring | exclude | User | 不覆盖确认决定；用户明确授权；模型提案须先确认 | excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | retained | exclude | User | 不覆盖确认决定；用户明确授权；模型提案须先确认 | excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | reintroduced | exclude | User | 不覆盖确认决定；用户明确授权；模型提案须先确认 | excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | conditionally_excluded | exclude | User | 不覆盖确认决定；用户明确授权；模型提案须先确认 | excluded | 保留偏好与证据 | 可经有条件 reconsider 重入 | 是，OperationIntent + ChangeRecord |
| Candidate | excluded | reconsider | User, System | 触发引用存在且条件成立；不增加用户确认；仍执行权限与证据守卫 | reintroduced | 不自动成为已选 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Candidate | conditionally_excluded | reconsider | User, System | 触发引用存在且条件成立；不增加用户确认；仍执行权限与证据守卫 | reintroduced | 不自动成为已选 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| ExternalFact | active | supersede | External Source, System | 证据可追溯；不增加用户确认；仍执行权限与证据守卫 | superseded | 依赖失效 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| ExternalFact | active | contradict | External Source, System | 反证有来源；不增加用户确认；仍执行权限与证据守卫 | contradicted | 依赖失效 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Skeleton | active | supersede | System | 采用另一版本且原版本不再当前；仅由已授权的采用／选择命令原子触发，不开放单独替代 | superseded | 保留旧骨架 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Skeleton | active | archive | User | 不是当前有效骨架；用户明确授权；模型提案须先确认 | archived | 保留旧版本 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Skeleton | superseded | archive | User | 不是当前有效骨架；用户明确授权；模型提案须先确认 | archived | 保留旧版本 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | proposed | request_confirmation | User, AI, System | 具体范围明确；不增加用户确认；仍执行权限与证据守卫 | pending_confirmation | 不应用选择 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | proposed | confirm | User | 专用确认命令；版本、范围、权限与约束通过；用户明确授权；模型提案须先确认 | confirmed | 原子应用选择 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | pending_confirmation | confirm | User | 专用确认命令；版本、范围、权限与约束通过；用户明确授权；模型提案须先确认 | confirmed | 原子应用选择 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | confirmed | supersede | System | 新决定替代同范围旧决定；仅由已授权的采用／选择命令原子触发，不开放单独替代 | revised | 保留历史 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | proposed | revoke | User | 专用撤销命令；用户明确授权；模型提案须先确认 | revoked | 必要时清空当前采用引用 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | pending_confirmation | revoke | User | 专用撤销命令；用户明确授权；模型提案须先确认 | revoked | 必要时清空当前采用引用 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| Decision | confirmed | revoke | User | 专用撤销命令；用户明确授权；模型提案须先确认 | revoked | 必要时清空当前采用引用 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| OpenIssue | open | make_actionable | System, User | 至少有可尝试的候选动作；不增加用户确认；仍执行权限与证据守卫 | actionable | 不等于缺口已补齐或解决 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| OpenIssue | waiting | make_actionable | System, User | 至少有可尝试的候选动作；不增加用户确认；仍执行权限与证据守卫 | actionable | 不等于缺口已补齐或解决 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| OpenIssue | open | wait | System, User | 等待输入或工具；不增加用户确认；仍执行权限与证据守卫 | waiting | 保持未知 | 有动作后可 make_actionable | 是，OperationIntent + ChangeRecord |
| OpenIssue | actionable | wait | System, User | 等待输入或工具；不增加用户确认；仍执行权限与证据守卫 | waiting | 保持未知 | 有动作后可 make_actionable | 是，OperationIntent + ChangeRecord |
| OpenIssue | open | resolve | System, User | 证据有效且原阻塞已消除；不增加用户确认；仍执行权限与证据守卫 | resolved | 保留解决依据 | 新证据可 reopen | 是，OperationIntent + ChangeRecord |
| OpenIssue | actionable | resolve | System, User | 证据有效且原阻塞已消除；不增加用户确认；仍执行权限与证据守卫 | resolved | 保留解决依据 | 新证据可 reopen | 是，OperationIntent + ChangeRecord |
| OpenIssue | waiting | resolve | System, User | 证据有效且原阻塞已消除；不增加用户确认；仍执行权限与证据守卫 | resolved | 保留解决依据 | 新证据可 reopen | 是，OperationIntent + ChangeRecord |
| OpenIssue | open | dismiss | User | 理由非空；用户明确授权；模型提案须先确认 | dismissed | 不改变事实或可行性 | 输入变化可 reopen | 是，OperationIntent + ChangeRecord |
| OpenIssue | actionable | dismiss | User | 理由非空；用户明确授权；模型提案须先确认 | dismissed | 不改变事实或可行性 | 输入变化可 reopen | 是，OperationIntent + ChangeRecord |
| OpenIssue | waiting | dismiss | User | 理由非空；用户明确授权；模型提案须先确认 | dismissed | 不改变事实或可行性 | 输入变化可 reopen | 是，OperationIntent + ChangeRecord |
| OpenIssue | resolved | reopen | System, User | 问题再次出现；不增加用户确认；仍执行权限与证据守卫 | open | 恢复可见问题 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| OpenIssue | dismissed | reopen | System, User | 问题再次出现；不增加用户确认；仍执行权限与证据守卫 | open | 恢复可见问题 | 无原位回退；新命令／版本 | 是，OperationIntent + ChangeRecord |
| DecisionContext | assembled | activate | System | 版本与时效检查通过；不增加用户确认；仍执行权限与证据守卫 | active | 只读投影 | 无原位回退；新命令／版本 | 否，短期只读投影 |
| DecisionContext | assembled | invalidate | System | 旅行版本变化或时间过期；不增加用户确认；仍执行权限与证据守卫 | stale | 禁止用于新提交 | 无原位回退；新命令／版本 | 否，短期只读投影 |
| DecisionContext | active | invalidate | System | 旅行版本变化或时间过期；不增加用户确认；仍执行权限与证据守卫 | stale | 禁止用于新提交 | 无原位回退；新命令／版本 | 否，短期只读投影 |
| DecisionContext | assembled | release | System | 任务结束；不增加用户确认；仍执行权限与证据守卫 | released | 可重建 | 无原位回退；新命令／版本 | 否，短期只读投影 |
| DecisionContext | active | release | System | 任务结束；不增加用户确认；仍执行权限与证据守卫 | released | 可重建 | 无原位回退；新命令／版本 | 否，短期只读投影 |
| DecisionContext | stale | release | System | 任务结束；不增加用户确认；仍执行权限与证据守卫 | released | 可重建 | 无原位回退；新命令／版本 | 否，短期只读投影 |

所有业务态失败结果：拒绝该原子批次、状态不部分生效、返回稳定错误码；用户拒绝待确认提案单独追加 rejected 记录。完整业务守卫及跨对象影响见 [传播规则](PROPAGATION_FINAL.md)。
