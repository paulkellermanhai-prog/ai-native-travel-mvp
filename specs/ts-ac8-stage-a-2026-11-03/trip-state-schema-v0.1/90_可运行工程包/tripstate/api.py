"""Local HTTP-contract adapter: no socket, server or authentication implementation."""
import re
from .rules import RuleError, require


def dispatch(store, method, path, body=None, actor=None):
    try:
        store._actor(actor)  # trusted host must authenticate and authorize this trip first
        match = re.fullmatch(r"/trips/([A-Za-z][A-Za-z0-9_-]*)/(state|decision-context|changes(?:/preview|/([A-Za-z][A-Za-z0-9_-]*)/confirm)?)", path)
        require(match is not None, "NOT_FOUND", "接口不存在")
        trip, resource, proposal = match.groups()
        require(trip == store.get_state()["trip_id"], "NOT_FOUND", "旅行不存在")
        if method == "GET" and resource == "state":
            return 200, store.get_state()
        if method == "GET" and resource == "changes":
            return 200, store.get_history()
        if method == "POST" and resource == "decision-context":
            return 200, store.context(body)
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
        code = 404 if exc.code == "NOT_FOUND" else 405 if exc.code == "METHOD_NOT_ALLOWED" else 403 if exc.code == "ACTOR" else 422
        return code, store._response("rejected", error=exc)
