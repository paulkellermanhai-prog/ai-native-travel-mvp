"""Local contract dispatcher, not a deployed HTTP/authentication service."""
from .runtime import RuntimeFault
from .contracts import VERSION, validate


def dispatch(runtime, method, path, body, principal, grant=None):
    try:
        trip = runtime._access(principal)
        prefix = "/runtime/trips/" + trip + "/"
        if not path.startswith(prefix):
            raise RuntimeFault("NOT_FOUND", "接口不存在")
        if method != "POST":
            raise RuntimeFault("METHOD_NOT_ALLOWED", "本接口只接受 POST")
        operation = path[len(prefix):]
        if operation == "turns":
            result = runtime.open_turn(body, principal)
            validate("turn", result)
        elif operation == "assemble":
            result = runtime.assemble(body, principal)
        elif operation == "pages":
            result = runtime.page(body, principal)
            validate("page", result)
        elif operation == "changes":
            result = runtime.submit_change(body, principal, grant)
        elif operation == "confirm":
            result = runtime.confirm(body, principal)
        elif operation == "checkpoints/save":
            result = runtime.save_scene(body, principal)
        elif operation == "checkpoints/restore":
            result = runtime.restore_scene(body, principal)
        elif operation == "checkpoints/delete":
            result = runtime.delete_scene(body, principal)
        elif operation == "checkpoints/list":
            result = runtime.list_scenes(body, principal)
        elif operation == "checkpoints/status":
            result = runtime.scene_status(body, principal)
        elif operation == "checkpoints/retry":
            result = runtime.retry_scene(body, principal)
        else:
            raise RuntimeFault("NOT_FOUND", "接口不存在")
        code = {"pending_confirmation": 202, "conflict": 409, "rejected": 422}.get(result.get("outcome"), 200)
        errors = result.get("errors", [])
        if errors:
            if errors[0]["code"] == "INTERNAL_FAILURE":
                code = 500
            elif errors[0]["code"] in ("PERMISSION", "ACTOR"):
                code = 403
        return code, result
    except RuntimeFault as exc:
        code = (503 if exc.code in ("CHECKPOINT_STORAGE", "CHECKPOINT_ACK_UNKNOWN", "RECOVERY_UNAVAILABLE") else
                403 if exc.code == "ACCESS_DENIED" else 404 if exc.code in ("NOT_FOUND", "CHECKPOINT_NOT_FOUND") else
                405 if exc.code == "METHOD_NOT_ALLOWED" else 409 if exc.retryable or exc.code in ("IDEMPOTENCY_CONFLICT", "EVENT_REUSE") else 422)
        error = dict(runtime_contract_version=VERSION, code=exc.code, message=str(exc), retryable=exc.retryable)
        validate("error", error)
        return code, error
    except Exception:
        # Transport/security logs belong to the host; no raw state/input in the response.
        return 500, dict(runtime_contract_version=VERSION, code="INTERNAL_FAILURE", message="运行层内部错误，未声明成功", retryable=False)
