"""Independent original Python execution; no saved response is supplied to Store."""
import json
import sys
from pathlib import Path
from datetime import datetime
from unittest.mock import patch
from uuid import UUID

root = Path(__file__).resolve().parents[2] / "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包"
sys.path.insert(0, str(root))
from tripstate.engine import Store, Actor, digest
from tripstate.rules import validate_state, RuleError

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
else:
    counter = iter(range(payload.get("uuidStart", 1000), 100000))
    now = datetime.fromisoformat(payload.get("clock", "2030-01-01T00:00:00Z").replace("Z", "+00:00"))
    store = Store(payload["initial"], clock=lambda: now)
    steps = []
    with patch("tripstate.engine.uuid4", side_effect=lambda: UUID(int=next(counter))):
        for operation in payload["operations"]:
            response = store.submit(operation["request"], Actor(**operation["actor"]))
            steps.append(dict(response=response, state_after=store.get_state(), audit=store.get_history()))
    json.dump(steps, sys.stdout, ensure_ascii=False)
