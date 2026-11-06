"""Local HTTP-contract adapter: no socket, server or authentication implementation."""
import re
from .rules import RuleError, require
from .restoration import restoration_request, restoration_impact


def dispatch(store, method, path, body=None, actor=None):
    try:
        store._actor(actor)  # trusted host must authenticate and authorize this trip first
        match = re.fullmatch(r"/trips/([A-Za-z][A-Za-z0-9_-]*)/(state|decision-context|restorations/preview|changes(?:/preview|/([A-Za-z][A-Za-z0-9_-]*)/confirm)?)", path)
        require(match is not None, "NOT_FOUND", "接口不存在")
        trip, resource, proposal = match.groups()
        require(trip == store.get_state()["trip_id"], "NOT_FOUND", "旅行不存在")
        if method == "GET" and resource == "state":
            return 200, store.get_state()
        if method == "GET" and resource == "changes":
            return 200, store.get_history()
        if method == "POST" and resource == "decision-context":
            return 200, store.context(body)
        if method == "POST" and resource == "restorations/preview":
            required = {"source_id", "source_version", "new_id", "expected_revision", "idempotency_key", "input", "reason"}
            optional = {"city_id", "insert_at", "acknowledge_unknowns"}
            require(isinstance(body, dict) and required <= body.keys() and body.keys() <= required | optional,
                    "SCHEMA", "恢复输入字段不合法")
            require(all(isinstance(body[k], str) and body[k] for k in ("source_id", "new_id", "idempotency_key", "reason")) and
                    isinstance(body["input"], dict) and {"kind", "reference", "text", "target_ids"} == body["input"].keys() and
                    isinstance(body["input"]["target_ids"], list) and all(isinstance(x, str) for x in body["input"]["target_ids"]),
                    "SCHEMA", "恢复输入类型不合法")
            request = restoration_request(store.get_state(), history=store.get_history(), **body)
            preview = store.preview(request, actor)
            status = {"preview": 200, "conflict": 409, "rejected": 422}[preview["outcome"]]
            return status, dict(request=request, preview=preview, impact=restoration_impact(store.get_state(), request, store.clock),
                can_submit=preview["outcome"] == "preview", warnings=["historical_content_not_current_verification",
                    "present_current_impacts_before_authorization", "cost_coverage_is_partial"])
        if method == "POST" and resource == "changes/preview":
            result = store.preview(body, actor)
        elif method == "POST" and resource == "changes":
            result = store.submit(body, actor)
        elif method == "POST" and proposal:
            result = store.confirm(proposal, body, actor)
        else:
            raise RuleError("METHOD_NOT_ALLOWED", "方法不适用于该接口")
        code = {"applied": 200, "preview": 200, "pending_confirmation": 202, "conflict": 409, "rejected": 422}[result["outcome"]]
        if result["errors"] and result["errors"][0]["code"] in ("PERMISSION", "ACTOR"):
            code = 403
        if result["errors"] and result["errors"][0]["code"] == "INTERNAL_FAILURE":
            code = 500
        return code, result
    except RuleError as exc:
        code = 409 if exc.code in ("VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT") else 404 if exc.code == "NOT_FOUND" else 405 if exc.code == "METHOD_NOT_ALLOWED" else 403 if exc.code == "ACTOR" else 422
        return code, store._response("conflict" if code == 409 else "rejected", error=exc)
