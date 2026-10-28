"""Produce synthetic storage batches with the original Python engine, not a TS command mock."""
import json
import sys
from copy import deepcopy
from pathlib import Path
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from uuid import UUID

root = Path(__file__).resolve().parents[2] / "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包"
sys.path.insert(0, str(root))
from tripstate.engine import Store, Actor, digest
from tripstate.fixtures import initial_state, NOW

trip, kind = sys.argv[1:3]
counter = iter(range(1000, 10000))
with patch("tripstate.engine.uuid4", side_effect=lambda: UUID(int=next(counter))):
    if kind == "applied":
        scenario = json.loads((root / "examples/scenario-traces.json").read_text())[0]
        state = scenario["initial_state"]
        state["trip_id"] = trip
        store = Store(state, clock=lambda: NOW)
        operations = [(step["request"], Actor(**step["actor"])) for step in scenario["steps"]]
    else:
        state = initial_state()
        state["trip_id"] = trip
        now = datetime.now(timezone.utc)
        for obj in state["objects"]:
            obj["trip_id"] = trip
            if kind == "fact-expiry" and obj["type"] == "ExternalFact":
                obj["observed_at"] = (now - timedelta(days=1)).isoformat()
                obj["expires_at"] = (now + timedelta(seconds=10)).isoformat()
        store = Store(state, clock=lambda: now)
        request = dict(expected_revision=0, idempotency_key="synthetic-pending", reason="合成模型偏好提案",
            input=dict(kind="dialogue", reference="synthetic-input", text="合成模型偏好提案", target_ids=[]),
            commands=[dict(op="revise", object_type="Preference", id="pref-culture", changes=dict(expression="合成提案，等待明确确认"))])
        operations = [(request, Actor("model", "synthetic-model"))]
    initial = store.get_state()
    batches = []
    for request, actor in operations:
        response = store.submit(request, actor)
        if response["outcome"] not in ("applied", "pending_confirmation"):
            raise RuntimeError(response)
        history = store.get_history()
        batch = dict(tripId=trip, request=request, snapshot=store.get_state(), intent=history["intents"][-1],
            change=history["changes"][-1], response=response,
            key=dict(actorId=actor.id, operationDomain=actor.role, key=request["idempotency_key"], requestDigest=digest(request)))
        if response["outcome"] == "pending_confirmation":
            batch["proposalExpiresAt"] = store._pending[response["proposal_id"]]["expires"].isoformat()
        batches.append(batch)
    advance = None
    if kind != "applied":
        request = deepcopy(operations[0][0])
        request["idempotency_key"] = "synthetic-user-advance"
        request["commands"][0]["changes"]["expression"] = "用户明确修正的合成测试输入"
        actor = Actor("user", "synthetic-user")
        response = store.submit(request, actor)
        if response["outcome"] != "applied": raise RuntimeError(response)
        history = store.get_history()
        advance = dict(tripId=trip, request=request, snapshot=store.get_state(), intent=history["intents"][-1],
            change=history["changes"][-1], response=response,
            key=dict(actorId=actor.id, operationDomain=actor.role, key=request["idempotency_key"], requestDigest=digest(request)))
    json.dump(dict(initial=initial, batches=batches, advance=advance), sys.stdout, ensure_ascii=False)
