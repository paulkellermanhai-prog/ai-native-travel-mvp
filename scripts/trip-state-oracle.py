"""Read-only contract oracle using the byte-preserved Python source, never the TS implementation."""
import json
import sys
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包"
sys.path.insert(0, str(source))
from tripstate.contracts import schemas  # noqa: E402
from tripstate.rules import validate_shape, validate_state, RuleError, FormatChecker  # noqa: E402

if "date-time" not in FormatChecker().checkers:
    raise RuntimeError("Install scripts/requirements-oracle.txt; date-time validation must not silently skip")

cases = json.load(sys.stdin)
results = []
for case in cases:
    try:
        if case["mode"] == "state":
            validate_state(case["value"])
        else:
            validate_shape(case["schema"], case["value"])
        code = None
    except RuleError as error:
        code = error.code
    results.append({"name": case["name"], "code": code})
json.dump({"schema_ids": sorted(s["$id"] for s in schemas().values()), "results": results}, sys.stdout)
