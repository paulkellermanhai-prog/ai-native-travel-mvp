# UX-02 恢复预览 HTTP 合同

`POST /trips/{trip}/restorations/preview` 必须携带 `source_id` 和正整数 `source_version`、`new_id`、`expected_revision`、`idempotency_key`、`input`、`reason`；可选 `city_id`、`insert_at`、`acknowledge_unknowns`。来源版本从已授权旅行当前对象或已应用的 ChangeRecord 前后快照解析；不可用或冲突时拒绝，不降级为最新。`expected_revision` 仍是当前旅行CAS。记录 reason 包含来源 ID 和版本；不得接受客户端历史对象或伪造身份。

客户端须先按**完整形状**识别，不可只看 HTTP 状态：

- 200：严格五字段封装 `{request, preview, impact, can_submit, warnings}`，其中 preview.outcome=preview、can_submit=true；三个对象遵守原有change-request/response合同。资格不等于授权。
- 422 或 409：业务计算后的五字段封装，preview 为 rejected 或 conflict，can_submit=false，impact 是只读计算结果；冲突需刷新。来源/版本过时、编译前输入与业务错误可能返回下列基础错误，而非封装。
- 403/404/405/422/409/500：基础 TS `response` 错误，按错误码处理；403和500隐藏身份与内部细节，不返回候选。相同422或409可能有两种形状。错误不会写业务。

完整展示当前影响、已知未知和重要取舍并获得本轮具体授权后，才可将原 `request` 提交 `/changes`；Model提交仍需用户确认。历史读取与提交都使用宿主身份与旅行访问控制，不复活旧授权；提交期间 revision/CAS 再次核对。
