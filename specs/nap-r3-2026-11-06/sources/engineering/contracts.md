# NAP｜工程契约与跨模块映射

NAP契约版本0.1.0；本文定义字段语义、职责与交互，机器结构唯一声明见[contracts.schema.json](contracts.schema.json)。它是本包新增契约，不是既有TS/DC字段。全部接口为待实现的逻辑边界，未部署HTTP服务；不预先决定语言、数据库或模型供应商。

<a id="ct-01"></a>
## CT-01｜依赖版本、真实字段和权威

| 依赖 | 实际正式路径/字段 | NAP消费与禁止 |
|---|---|---|
| Trip State 0.1.0 | [SPECIFICATION](../../trip-state-schema-v0.1/02_业务状态规则/SPECIFICATION.md)、[schemas](../../trip-state-schema-v0.1/90_可运行工程包/schemas/state.schema.json)；`trip_id/revision/effective_skeleton_id/objects` | 当前业务真值，先授权读取；不复制另一个有效旅行对象集 |
| Constraint | `value/hardness/override_policy/scope/status` | 预算/日期权威，不用NAP摘要覆盖 |
| Candidate / Preference | `status/reconsider_when`；`certainty/support/scope/condition` | 候选/偏好独立，状态层级不混用；缺值三值unknown |
| Skeleton / Decision | `purpose/parent_id/assessment`；`confirmation_scope/review_state`；根采用引用 | plan/scenario与当前采用分开；confirmed不等现实全核验 |
| ExternalFact | `query/provider/observed_at/expires_at/valid_for/query_status/value/verification/freshness/applicability` | 源观察、时效、核验层级分开；不能凭用户确认写核验 |
| DC运行0.1.0 / R4（含恢复） | [当前声明](../../decision-context-v0.1/90_可运行工程包/context_runtime/contracts.py)、[读取规格](../../decision-context-v0.1/04_工程规格/02_读取组装与有效性规格.md) | 与TS版本独立；恢复接口已正式归入同一首版合同，不删除恢复字段 |
| Task | `task_key/question/kind/target_ids/branch/relation/related_task_keys/certainty/evidence/progress/progress_evidence` | 消费任务解释，不当业务写授权；进度证据规则不改 |
| Packet | `packet_id/turn_id/task/context/pending_input/objects/deferred_ids/coverage/evidence_checked_at/snapshot_digest/annotations/support/warnings` | 固定快照阅读包；pending_input不是已生效值；不扩展原schema |
| Context | `state_revision/expires_at/selected_object_ids/must_include_constraints/active_decisions/open_issues/assembled_from_versions/stale_fact_ids` | 全部活动hard、confirmed及相关未知不能被模型相关性裁掉 |

跨文件字段拥有权以[TS权限](../../trip-state-schema-v0.1/02_业务状态规则/AUTHORITY_FINAL.md)和[DC运行合同](../../decision-context-v0.1/04_工程规格/01_运行契约与任务定位.md)为准。本表是字段到职责的映射，不重定义其值域；DC首版版本归并及历史标记按[DEC-08](../DECISIONS.md#dec-08)留痕。依赖内容摘要和规范定位见[机器索引](../package-index.json)。

<a id="ct-02"></a>
## CT-02｜逻辑接口与消息

鉴权Principal、可信能力注册表、时钟、State/DC适配器和持久运行日志由宿主注入，不从模型JSON取actor、权限或Grant。Schema只能证明结构，不证明这些来源真实。

DecisionRequest是宿主内部构建的消息。packets只能来自该主体的真实DC组装/分页结果；来自客户端或模型的同形JSON不得直接进入决策读取，即使其中自报的snapshot_digest相同。宿主适配器对原保存的包内容、所有权和当前有效性核对，必要时重新assemble。摘要是完整性线索，不是鉴权签名。

| 新逻辑接口 | 输入→输出 | 执行责任 |
|---|---|---|
| `decide(request, host)` | DecisionRequest→DecisionPlan或Error | 读取有效包、G协作提出计划；无业务写和工具副作用 |
| `dispatch(decision_id, action_id, host)` | 服务端已保存计划引用→动作记录/原错误 | 从原计划读取，重做资格检查，再执行步骤；不能执行客户端改过的Plan |
| `complete(completion, host)` | ToolCompletion→记录回执，并触发新decide | 仅可信工具适配器能提交；去重、校验条件和可用性 |
| `feedback(feedback, host)` | UIFeedback→记录回执，并按需要新decide | 校验显示的Action与原始事件；confirm另走原确认链路 |
| `observe(observation, host)` | RequestObservation→记录回执 | 宿主记录交付/撤回/提示事实；只追加、不改State/DC |

`dispatch`是引用式接口，不要求一次性把所有steps同步跑完。等待用户或工具时返回可恢复运行状态。`observe`是宿主内部端口，不开放给模型任意提交。未实现生产服务、队列、计费或鉴权，不把逻辑函数名当现存SDK。

工具完成/时钟事件由trigger.reference引用真实完成/时钟记录，对仍有效任务重新assemble即可；不要求伪造用户原话再open_turn。新用户或UI输入才按原事件协议定位新轮次。DC event.entry只有dialogue/map/timeline/comparison，不能擅加tool/system枚举，也不能从工具回调生成用户WriteGrant。

### 消息字段语义

| 消息/字段组 | 归属、约束 |
|---|---|
| DecisionRequest | `nap_contract_version/decision_id/runtime_id/trigger/packets`；runtime_id取当前宿主运行代次，每包按原DC packet schema校验，跨包必须同trip、同runtime代次及当前revision；Trigger只引用已注册真实事件/完成记录/时钟事件 |
| DecisionPlan.basis | Plan还绑定`nap_contract_version/decision_id/runtime_id`；每个`packet_id/turn_id/task_key/state_revision/snapshot_digest/expires_at`必须由宿主从对应包复制并核验，不能信任模型自报；不延长期限 |
| DecisionPlan.response | `request_ids/disposition/text/evidence_refs`；实际直接回应不等额外推荐；有当前请求须合理处理。纯后台时钟事件可`no_current_request`且text为null |
| DecisionPlan.actions | `action_id/task_key/packet_id/request_ids/goal/attention/reason/steps`；goal引用D1～D5，attention为prepare/primary/secondary；可为空表示只有直接回应；不授执行权 |
| Step | `step_id/kind/depends_on/capability_id/arguments/change_request/user_message`；kind为read/query/calculate/change/ask/deliver；横向步骤不是第六目标；依赖必须同计划且无环 |
| Step.arguments | 仅read/query/calculate使用，按宿主能力注册的输入Schema再验证，禁止任意代码、未注册URL或用户自报权限；其余步骤须空对象 |
| Step.change_request | 只有change步骤非null，直接引用原TS change-request；无任意patch。其余步骤null；ask/deliver用user_message，不能携带业务写 |
| ToolCompletion | `completion_id/decision_id/action_id/step_id/query_digest/basis_state_revision/result_status/provider_ref/observed_at/expires_at/raw_result_ref/validated_fact_ids/error`；成功状态不证明内容完整；记录实际原始结果位置而非模型重构值 |
| UIFeedback | `feedback_id/decision_id/action_id/type/event`；event是原DC事件结构；shown/clicked/skipped/rejected/stop/reopen/confirmed不相互等同；confirmed事件不能充当Grant |
| RequestObservation | CT-05新增运行日志记录；不可混进TS objects或DC task字段 |
| Error | `nap_contract_version/code/message/retryable/source_code/decision_id/action_id`；原模块码保留在source_code，不偷换成功 |

所有字段必填；无值用Schema允许的null/空列表。ID使用可解析稳定标识；时间带时区且须由宿主日期解析器实际验证，不能把JSON Schema的format注解当自动保护；币种/金额留在原TS字段，不在Plan新增预算副本。未知字段拒绝；消息结构见机器Schema，跨记录关系由运行语义验证，不能只验JSON。

### 一次无新增Action的合法输出

用户明确只要整理已有比较时，actions可以为空，response为`answered`并附真实交付内容和证据引用。这里answered是本轮响应类型，不代表DC handled，也不代表用户选择。触发为纯时钟维护且无当前请求时可以无用户文案；普通请求不能借此沉默。

<a id="ct-03"></a>
## CT-03｜工具与事实返回映射

宿主能力注册表至少提供能力ID、只读/副作用类别、输入Schema、支持的事实级别、必需参数、超时和允许的提供方。该表是实际接入配置，不由模型增加供应商。首版Policy自主工具只允许已注册低风险准备；交易能力即便系统有接口也不进入本包范围。

ToolCompletion的`result_status`精确保留result/partial/empty/timeout/error/no_service。可信适配器对原始回执验证来源、日期、起止节点、必需字段、时效后，按原TS `ingest_fact`写观察；TS自行派生verification/freshness/applicability。真实字段格式直接用[ExternalFact schema](../../trip-state-schema-v0.1/90_可运行工程包/schemas/ExternalFact.schema.json)与[command schema](../../trip-state-schema-v0.1/90_可运行工程包/schemas/command.schema.json)。

**主体通道必须分开：** Runtime.submit_change无Grant时使用model主体，而且绑定用户原话；不能把工具观察伪装为用户输入塞进该通道。事实由可信Tool/System适配器以真实工具来源走原Store受控命令；变更当前revision后重组DC，才形成下一份Plan。NAP不自写verified字段。

旧条件结果可留原始日志/历史证据，但不支持当前结论；适配器不得为了入库更改查询日期。新失败不覆盖尚可用旧观察；旧观察是否适用另按原守卫判断。原始结果持久位置不授事实真实性，`validated_fact_ids`只能引用真正已成功入库的观察，超时/空集不能填无服务事实ID。

<a id="ct-04"></a>
## CT-04｜状态修改、授权、确认与候选重入

读取→解释器interpret→原`open_turn`→`assemble`/`page`→NAP选择→原`submit_change`/`confirm`。实际绑定字段来自[DC当前合同](../../decision-context-v0.1/90_可运行工程包/context_runtime/contracts.py)与[TS命令](../../trip-state-schema-v0.1/90_可运行工程包/schemas/change-request.schema.json)。

| 调用 | 保持的原字段与守卫 |
|---|---|
| open_turn | runtime_contract_version=0.1.0、trip_id、expected_revision、event、tasks、focus_keys；先任务定位，不依赖NAP候选 |
| assemble/page | turn_id/task_key/body_budget_bytes；packet_id/object_ids；完整正文交付、revision/TTL每次重验 |
| submit_change | turn_id、packet_id、request；request含expected_revision/idempotency_key/reason/input/commands；input.text/reference与真实event一致 |
| 宿主授权 | 原WriteGrant绑定principal/event/request_digest/revision/expires_at，持久恢复模式还绑定runtime_id；模型不可签发 |
| confirm | turn_id/proposal_id及原request(expected_revision/idempotency_key/proposal_digest/accept)；宿主核验真实确认，旧revision/过期/摘要不符不重放 |

重要adopt_skeleton/decide_candidate/withdraw_decision须完整正文交付；仅服务器交付并不证明理解。模型提案触保护范围进入pending_confirmation，拒绝原状态不变；确认成功后才认applied。低风险允许写和有精确合法Grant的操作仍走原守卫。假设分支仅可创建隔离scenario；已确认骨架新版本、根采用和Decision同笔一致。

**E01工程收口：** 新主动请求可只读探索已有DestinationEntity并引用旧Candidate历史；不新增同义Candidate绕拒绝，不直接retain退出态。真正重入只发原`reconsider{id,trigger_id}`，检查trigger_id实际出现在reconsider_when且三值条件为true；否则返回`NAP_REENTRY_UNSUPPORTED`，仍可交付探索内容。需要用户明确纠正排除条件时，只能按原权限提出有真实来源的Candidate条件修订，再按合法守卫重入；本版不自动构造该条件。要求“任何一句重开必改候选状态”属于模块变更，见DEC-07。该明确边界使受限MVP可开发，并非证明原系统已支持任意重入。

<a id="ct-05"></a>
## CT-05｜请求交付与拒绝/提示运行记录（新增NAP契约）

E02采用追加`RequestObservation`，按经鉴权主体/旅行/工作区隔离，引用已有`task_key`，不新增业务请求对象、不另设Pending Request Policy、不复制预算/日期/用户选择。记录的是交互已经发生的事实及其来源；当前业务适用性每次仍从State/DC求得。

| 字段 | 精确定义 |
|---|---|
| observation_id/task_key/event_id/action_id | 运行记录唯一ID、已有任务ID、真实触发事件、相关Action或null；不能跨主体/旅行读写 |
| kind | delivery/withdrawal/defer/reopen/stop/opportunity_hint；均是运行事件类别，不是TS/DC状态 |
| scope | 请求/拒绝的对象范围说明，含原话依据；不替代业务scope |
| basis_revision/source_ref/content_digest | 当时业务版本、真实原话或交付回执位置、内容SHA-256或null；交付/提示必须有可复核内容摘要 |
| coverage | none/partial/full/not_applicable；描述已交付内容对请求的覆盖判断，不是事实verification或用户认可 |
| assessment | host_confirmed/semantic_review_required；接收或展示回执只证交付，内容是否充分由语义评审结合原请求/实际内容判断 |
| related_observation_ids/created_at | 前序相关记录及宿主时间；只追加，纠错写新记录，不删旧依据 |

**证据及消费者：** delivery仅在宿主取得实际交付/呈现回执后追加，不能因Plan写好了就当已交付。coverage=full必须有实际内容与请求范围的判断证据；不确定标partial或semantic_review_required。G01/G05结合最新请求及记录，已充分交付不无端重复召回，部分仅保留剩余需求；判断错误可由新事件重新评估，不能永久关题。

withdrawal/stop/defer/reopen须引用经鉴权真实用户事件并按对象范围解释；模型推断不能伪造原话或自行终止用户请求。opportunity_hint记录实际呈现信息的语义键/内容摘要，换文案同理由由语义去重判为同提示；哈希只证明字节相同，不能代替语义判断。

**不改DC进度：** 即使宿主确认回答覆盖full，没有当前用户明确进度证据也不强写handled；DC仍可open，但G05不按open机械提醒。暂停/handled按原progress_evidence规则更新；撤回不冒充resolved。TS OpenIssue关闭仍需要真实有效证据和阻塞消除。

**持久性与恢复：** 新日志是NAP自身宿主存储，按(主体,trip,workspace,observation_id)幂等追加，回执成功才宣称已保存；失败不自动再次呈现提示/重复执行业务。恢复时加载该日志再读取当前State/DC，不把观察记录塞进DC checkpoint未知字段。若日志不可用且无法证明提示历史，不主动再提示，仍响应明确请求；若无法证明交付/撤回，保留不确定并避免催问，由当前意图决定帮助。日志保留/删除跟随宿主工作区政策，权限撤回不可继续访问。该方案待开发，未谎称DC已实现它。

<a id="ct-06"></a>
## CT-06｜UI引用与错误契约

Action入口仅保存服务器decision_id/action_id及显示快照标识；客户端不能带一份改过Plan让服务器执行。点击/跳过/拒绝/停止/确认均带真实事件，重新读取当前资格；UI常驻入口不必对应某个Action。确认具体方案必须展示原系统的当前差异、范围、未知与摘要，不能仅把clicked改名confirmed。

| NAP码 | 语义/重试边界 |
|---|---|
| NAP_CONTRACT_INVALID | 字段/版本/跨记录引用非法，不执行；修正输入后新请求 |
| NAP_DEPENDENCY_STALE | 包、版本、摘要、时效或runtime代次不符；只允许重读和新决策，不自动重放业务 |
| NAP_ACTION_INELIGIBLE | 权限/hard/拒绝/能力不符；解释或合法替代，不按原动作重试 |
| NAP_REENTRY_UNSUPPORTED | 缺合法Candidate重入触发；可继续只读探索，不伪造状态 |
| NAP_SOURCE_UNTRUSTED | 工具/回执来源不在宿主可信范围；无已核验结论 |
| NAP_IDEMPOTENCY_CONFLICT | 同键异内容；不换键绕过，不执行第二次 |
| NAP_EXECUTION_UNKNOWN | 执行或提交回执不确定；读原幂等结果/日志，不盲重试 |
| NAP_OBSERVATION_UNAVAILABLE | 请求/提示历史未确认保存或无法读取；按CT-05降级，不虚报保存 |

`retryable`仅说明可否重新读取/诊断，不能授权重试副作用。原状态/运行错误如HARD_CONFLICT、PACKET_EXPIRED、WRITE_GRANT、RESTORED_INPUT_READ_ONLY等不改名为成功；保留原source_code和原响应引用。Schema不验证异常是否真实；错误由宿主程序生成，模型不可自报已通过守卫。


## AC8／UX-02 的跨模块消费约束

不修改本包机器 Schema。历史版本由受权 TS 读面解析真实 source_id/source_version；恢复预览是只读、基于当前 TS 的候选影响和未知，不生成 Grant。具体当前范围经可信呈现与当轮授权后，原 change-request 走 TS 提交及确认守卫；不得由 NAP 声明已确认体验可删除。PR #13 固定 head 的预览 HTTP 包装及数字解码已获限定工程技术验收，尚待合并和集成，不当作当前已可调用接口。DC 当前 Packet/分页、Task 与编辑目标以实际合同读取，历史焦点不隐式改目标；E11 记录需当前授权且未被删除或过期。操作结果、交付、Checkpoint ACK、实际采用与效果分开。合成适配前置检查及接口依赖见 [增量追溯](ac8-ux02-integration.md)。
