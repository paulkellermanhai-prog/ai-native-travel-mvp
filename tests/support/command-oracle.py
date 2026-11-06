"""Independent original Python execution; no saved response is supplied to Store."""
import json
import os
import sys
from pathlib import Path
from datetime import datetime
from unittest.mock import patch
from uuid import UUID

root = Path(os.environ["TRIP_STATE_SOURCE_ROOT"]) if "TRIP_STATE_SOURCE_ROOT" in os.environ else Path(__file__).resolve().parents[2] / "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包"
sys.path.insert(0, str(root))
from tripstate.engine import Store, Actor, digest
from tripstate.rules import validate_state, RuleError, condition_value, index

payload = json.load(sys.stdin)
if payload.get("mode") == "states":
    results = []
    for state in payload["states"]:
        try:
            validate_state(state)
            results.append(None)
        except RuleError as error:
            results.append(error.code)
    json.dump(results, sys.stdout)
elif payload.get("mode") == "digests":
    json.dump([digest(value) for value in payload["values"]], sys.stdout)
elif payload.get("mode") == "conditions":
    validate_state(payload["state"])
    now = datetime.fromisoformat(payload.get("clock", "2030-01-01T00:00:00Z").replace("Z", "+00:00"))
    json.dump([condition_value(c, index(payload["state"]), now) for c in payload["conditions"]], sys.stdout)
else:
    counter = iter(range(payload.get("uuidStart", 1000), 100000))
    now = datetime.fromisoformat(payload.get("clock", "2030-01-01T00:00:00Z").replace("Z", "+00:00"))
    store = Store(payload["initial"], clock=lambda: now)
    steps = []
    with patch("tripstate.engine.uuid4", side_effect=lambda: UUID(int=next(counter))):
        for operation in payload["operations"]:
            if "clock" in operation:
                now = datetime.fromisoformat(operation["clock"].replace("Z", "+00:00"))
            method = operation.get("method", "submit")
            request = dict(operation["request"])
            actor = Actor(**operation["actor"])
            if method == "confirm":
                prior = steps[operation["proposalIndex"]]["response"]
                proposal = operation.get("proposalId", prior["proposal_id"])
                if request["proposal_digest"] == "@digest":
                    request["proposal_digest"] = prior["proposal_digest"]
                response = store.confirm(proposal, request, actor)
            else:
                response = getattr(store, method)(request, actor)
            result = dict(response=response, state_after=store.get_state(), audit=store.get_history())
            if payload.get("mode") == "lifecycle":
                result["pending"] = {key: dict(request=p["request"], actor=dict(role=p["actor"].role, id=p["actor"].id),
                    digest=p["digest"], expires=p["expires"].isoformat(), cache_key=p["cache_key"]) for key, p in store._pending.items()}
            steps.append(result)
    json.dump(steps, sys.stdout, ensure_ascii=False)
