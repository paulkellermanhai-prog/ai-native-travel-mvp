"""Read-only specification checks. This does not execute NAP or grade a model."""
import copy
import hashlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
checks = []
FORMATS = FormatChecker()


@FORMATS.checks("date-time")
def timezone_datetime(value):
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def record(name, ok, detail=None):
    checks.append(dict(name=name, pass_=bool(ok), detail=detail))


def read_json(p):
    return json.loads(p.read_text(encoding="utf-8"))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def plan_relations(plan):
    """Structural relation oracle only; not authorization or current-state proof."""
    errors = []
    bases = {b["packet_id"]: b for b in plan["basis"]}
    actions = plan["actions"]
    if len(bases) != len(plan["basis"]):
        errors.append("duplicate_basis")
    if len({a["action_id"] for a in actions}) != len(actions):
        errors.append("duplicate_action")
    if sum(a["attention"] == "primary" for a in actions) > 1:
        errors.append("multiple_primary")
    all_steps = [s for a in actions for s in a["steps"]]
    steps = {s["step_id"]: s for s in all_steps}
    if len(steps) != len(all_steps):
        errors.append("duplicate_step")
    for a in actions:
        if a["packet_id"] not in bases or bases[a["packet_id"]]["task_key"] != a["task_key"]:
            errors.append("action_basis")
    for s in all_steps:
        if any(d not in steps or d == s["step_id"] for d in s["depends_on"]):
            errors.append("step_reference")
        if s["kind"] == "change":
            if s["change_request"] is None or s["arguments"] or s["capability_id"] is not None or s["user_message"] is not None:
                errors.append("change_shape")
        elif s["change_request"] is not None:
            errors.append("unexpected_write")
        if s["kind"] in ("ask", "deliver") and (s["arguments"] or s["capability_id"] is not None or not s["user_message"]):
            errors.append("presentation_shape")
        if s["kind"] in ("read", "query", "calculate") and (not s["capability_id"] or s["user_message"] is not None):
            errors.append("capability_shape")
    visiting, visited = set(), set()

    def visit(key):
        if key in visiting:
            return False
        if key in visited or key not in steps:
            return True
        visiting.add(key)
        valid = all(visit(d) for d in steps[key]["depends_on"])
        visiting.remove(key)
        visited.add(key)
        return valid

    if not all(visit(k) for k in steps):
        errors.append("step_cycle")
    return errors


def main():
    nap = read_json(ROOT / "engineering/contracts.schema.json")
    case_schema = read_json(ROOT / "quality/cases.schema.json")
    dependency_schemas = []
    for folder in ["trip-state-schema-v0.1", "decision-context-v0.1"]:
        dependency_schemas += [read_json(p) for p in (PROJECT / folder / "90_可运行工程包/schemas").glob("*.schema.json")]
    schemas = [nap, case_schema, *dependency_schemas]
    for schema in schemas:
        Draft202012Validator.check_schema(schema)
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)

    def validator(definition):
        return Draft202012Validator({"$ref": nap["$id"] + "#/$defs/" + definition}, registry=registry, format_checker=FORMATS)

    case_validator = Draft202012Validator(case_schema, registry=registry, format_checker=FORMATS)
    lines = (ROOT / "quality/cases.jsonl").read_text(encoding="utf-8").splitlines()
    cases = [json.loads(line) for line in lines]
    for case in cases:
        case_validator.validate(case)
    record("schemas_and_73_jsonl_records", len(cases) == 73, {"schemas": len(schemas), "kinds": dict(Counter(c["kind"] for c in cases))})
    scenarios = [c for c in cases if c["kind"] == "scenario"]
    record("58_unique_scenarios", len(scenarios) == len({c["case_id"] for c in scenarios}) == 58)
    record("eight_counterfactual_pairs", all({"F%02d-A" % i, "F%02d-B" % i} <= {c["case_id"] for c in cases} for i in range(1, 9)))
    source_blocks = (PROJECT / "nap-c3-validation/03_完整测试案例.md").read_text(encoding="utf-8")
    originals = {m[1]: m[0].strip() for m in re.finditer(r"^## ((?:[SMXCN]\d{2}|F\d{2}-[AB]))｜[^\n]+\n[\s\S]*?(?=^## |\Z)", source_blocks, re.M)}
    record("58_source_blocks_lossless", all(c["source"]["full_text"] == originals[c["case_id"]] for c in scenarios))
    record("source_excerpt_digests", all(digest(c["source"]["full_text"].encode()) == c["source"]["sha256"] for c in cases))
    record("all_73_excerpts_exist_in_original_sources", all(c["source"]["full_text"] in (ROOT / "quality" / c["source"]["path"]).read_text(encoding="utf-8") for c in cases))
    record("ordered_steps_and_events", all([s["order"] for s in c["steps"]] == list(range(1, len(c["steps"]) + 1)) and len(c["steps"]) == len(c["trigger_events"]) for c in cases))
    record("variants_and_multiturn_preserved", all(len(next(c for c in cases if c["case_id"] == k)["variants"]) == n for k, n in [("S03", 2), ("S09", 2), ("N04", 3)]) and all(len(c["steps"]) > 1 for c in cases if c["case_id"].startswith(("M", "W"))))
    record("all_policy_runs_not_run", all(c["execution"] == dict(status="NOT_RUN", actual_result=None, policy_pass_rate=None) for c in cases))
    record("all_fixture_builders_explicitly_pending", all(c["materialization"]["fixture_builder_status"] == "NOT_IMPLEMENTED" for c in cases))
    record("F03_no_unrelated_budget_fixture_added", next(c for c in cases if c["case_id"] == "F03-A")["initial_state"]["fixtures"] == next(c for c in cases if c["case_id"] == "F03-B")["initial_state"]["fixtures"])

    example = read_json(PROJECT / "decision-context-v0.1/90_可运行工程包/examples/exploration.json")
    packet = example["packet"]
    basis = dict(packet_id=packet["packet_id"], turn_id=packet["turn_id"], task_key=packet["task"]["task_key"], state_revision=packet["context"]["state_revision"], snapshot_digest=packet["snapshot_digest"], expires_at=packet["context"]["expires_at"])
    request = dict(nap_contract_version="0.1.0", decision_id="decision-test", runtime_id=example["turn"]["runtime_id"], trigger=dict(kind="user_event", reference=packet["pending_input"]["event"]["event_id"]), packets=[packet])
    step = dict(step_id="step-test", kind="deliver", depends_on=[], capability_id=None, arguments={}, change_request=None, user_message="合成说明，只测试契约结构")
    action = dict(action_id="action-test", task_key=basis["task_key"], packet_id=basis["packet_id"], request_ids=[basis["task_key"]], goal="D1", attention="primary", reason="合成测试", steps=[step])
    plan = dict(nap_contract_version="0.1.0", decision_id="decision-test", runtime_id=request["runtime_id"], basis=[basis], response=dict(request_ids=[basis["task_key"]], disposition="answered", text="合成消息，不是模型输出", evidence_refs=[]), actions=[action])
    now = "2026-10-26T10:00:00+08:00"
    positives = {
        "DecisionRequest": request, "DecisionPlan": plan,
        "ToolCompletion": dict(nap_contract_version="0.1.0", completion_id="completion-test", decision_id="decision-test", action_id="action-test", step_id="step-test", query_digest="0" * 64, basis_state_revision=0, result_status="timeout", provider_ref="TEST_PROVIDER", observed_at=now, expires_at=None, raw_result_ref="test-timeout", validated_fact_ids=[], error=dict(code="timeout", message="合成超时")),
        "UIFeedback": dict(nap_contract_version="0.1.0", feedback_id="feedback-test", decision_id="decision-test", action_id="action-test", type="shown", event=packet["pending_input"]["event"]),
        "RequestObservation": dict(nap_contract_version="0.1.0", observation_id="observation-test", task_key=basis["task_key"], event_id="event-test", action_id=None, kind="delivery", scope="合成请求", basis_revision=0, source_ref="test-receipt", content_digest="0" * 64, coverage="partial", assessment="semantic_review_required", related_observation_ids=[], created_at=now),
        "ActionRecord": dict(nap_contract_version="0.1.0", decision_id="decision-test", action_id="action-test", phase="proposed", plan_digest="0" * 64, completed_step_ids=[], result_refs=[], error_ref=None, related_action_ids=[], updated_at=now),
        "Error": dict(nap_contract_version="0.1.0", code="NAP_REENTRY_UNSUPPORTED", message="合成受限错误", retryable=False, source_code="RECONSIDER_TRIGGER", decision_id="decision-test", action_id=None),
    }
    for name, value in positives.items():
        validator(name).validate(value)
    record("seven_message_positive_samples", True, {"count": len(positives), "uses_actual_DC_packet": True, "scope": "shape_only_not_live_execution"})
    negatives = []
    bad = copy.deepcopy(plan); bad["actor"] = "user"; negatives.append(("DecisionPlan", bad))
    bad = copy.deepcopy(plan); bad["actions"][0]["goal"] = "D6"; negatives.append(("DecisionPlan", bad))
    bad = copy.deepcopy(request); bad["packets"][0]["runtime_contract_version"] = "0.1.0"; negatives.append(("DecisionRequest", bad))
    bad = copy.deepcopy(request); bad["packets"][0]["context"]["budget"] = 10000; negatives.append(("DecisionRequest", bad))
    bad = copy.deepcopy(plan); bad["basis"][0]["expires_at"] = "no-time"; negatives.append(("DecisionPlan", bad))
    bad = copy.deepcopy(positives["RequestObservation"]); bad["kind"] = "confirmed_decision"; negatives.append(("RequestObservation", bad))
    record("six_message_negative_samples_rejected", all(list(validator(name).iter_errors(value)) for name, value in negatives), {"count": len(negatives)})
    record("legal_plan_relations", not plan_relations(plan))
    relation_negatives = []
    bad = copy.deepcopy(plan); bad["actions"][0]["steps"][0]["depends_on"] = ["step-test"]; relation_negatives.append(bad)
    bad = copy.deepcopy(plan); bad["actions"].append(copy.deepcopy(action)); bad["actions"][1]["action_id"] = "action-other"; relation_negatives.append(bad)
    bad = copy.deepcopy(plan); bad["actions"][0]["packet_id"] = "packet-missing"; relation_negatives.append(bad)
    bad = copy.deepcopy(plan); bad["actions"][0]["steps"][0]["capability_id"] = "not-a-display-capability"; relation_negatives.append(bad)
    record("four_relation_negative_samples_rejected", all(plan_relations(x) for x in relation_negatives), {"count": len(relation_negatives)})

    missing = []
    for doc in ROOT.rglob("*.md"):
        body = doc.read_text(encoding="utf-8")
        for raw in re.findall(r"\]\(([^)]+)\)", body):
            if re.match(r"[a-z]+:", raw):
                continue
            target, _, anchor = unquote(raw.strip("<>")).partition("#")
            resolved = (doc.parent / target).resolve() if target else doc
            if not resolved.exists():
                missing.append(dict(file=str(doc.relative_to(ROOT)), target=raw))
            elif anchor and resolved.suffix == ".md" and not re.search(r'id=["\']' + re.escape(anchor) + r'["\']', resolved.read_text(encoding="utf-8")):
                missing.append(dict(file=str(doc.relative_to(ROOT)), anchor=raw))
    record("relative_links_and_explicit_anchors", not missing, missing)
    duplicate_anchors = []
    for doc in ROOT.rglob("*.md"):
        anchors = re.findall(r'id=["\']([^"\']+)["\']', doc.read_text(encoding="utf-8"))
        duplicate_anchors.extend((str(doc.relative_to(ROOT)), key) for key, n in Counter(anchors).items() if n > 1)
    record("definition_anchors_unique_in_each_file", not duplicate_anchors, duplicate_anchors)
    index_path = ROOT / "package-index.json"
    if index_path.exists():
        index = read_json(index_path)
        missing_rules = sorted({r for c in cases for r in c["rule_refs"]} - index["rule_index"].keys())
        record("all_case_rule_refs_resolve", not missing_rules, missing_rules)
        for name, entry in index["rule_index"].items():
            file, _, anchor = entry["definition"].partition("#")
            record("definition_" + name, bool(re.search(r'id=["\']' + re.escape(anchor) + r'["\']', (ROOT / file).read_text(encoding="utf-8"))))
        record("case_index_line_binding", all(c["case_id"] == index["case_index"][c["case_id"]]["case_id"] and cases[index["case_index"][c["case_id"]]["line"] - 1]["case_id"] == c["case_id"] for c in cases))
        record("package_payload_hashes", all(digest((ROOT / e["path"]).read_bytes()) == e["sha256"] for e in index["file_inventory"]))
        record("external_dependency_hashes", all(digest((ROOT / e["path"]).read_bytes()) == e["sha256"] for e in index["sources"]))
    else:
        record("index_present", False)
    report = dict(date="2026-10-26", scope="Specification structure, source fidelity, schema and synthetic relation checks only; no Policy/model/tool Evals", all_pass=all(c["pass_"] for c in checks), scenario_count=58, walkthrough_count=3, calibration_count=12, actual_policy_runs=0, checks=checks)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
