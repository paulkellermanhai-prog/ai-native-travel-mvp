"""Offline candidate/lineage checks only; no Decision Context runtime is instantiated."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from referencing import Registry, Resource

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "specs/dc-0.1-calibration-2026-10-29"
OLD = ROOT / "specs/baseline-2026-10-27"
DC = "decision-context-v0.1/90_可运行工程包"
NAP = "Next-Action-Policy-V0.1"
load = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
selection = load(BUNDLE / "selection.json")
assert selection["status"] == "PROPOSED_PENDING_TECH_LEAD_CONFIRMATION"
assert selection["version"] == "0.1.0" and selection["runtime_implementation_authorized"] is False
assert sha(OLD / "manifest.json") == selection["historical_manifest_sha256"]
assert len(selection["files"]) == len({r["path"] for r in selection["files"]}) == 39
for row in selection["files"]:
    p = BUNDLE / row["path"]
    assert p.resolve().is_relative_to(BUNDLE) and not p.is_symlink()
    assert sha(p) == row["sha256"] and p.stat().st_size == row["bytes"], row["path"]

trip_dir = ROOT / selection["trip_state_schema_directory"]
trip = {p.name.removesuffix(".schema.json"): load(p) for p in trip_dir.glob("*.json")}
dc = {p.name.removesuffix(".schema.json"): load(p) for p in (BUNDLE / "sources" / DC / "schemas").glob("*.json")}
old_dc = {p.name.removesuffix(".schema.json"): load(p) for p in (OLD / DC / "schemas").glob("*.json")}
nap = load(BUNDLE / "sources" / NAP / "engineering/contracts.schema.json")
assert len(trip) == len(dc) == len(old_dc) == 20
assert set(dc) == set(old_dc)
assert all(s["$id"] == f"https://decision-context.example/runtime/0.1/{name}.schema.json" for name, s in dc.items())

# Execute only the original pure schema declaration, using the immutable Trip State declaration.
sys.path.insert(0, str(trip_dir.parent))
spec = importlib.util.spec_from_file_location("dc_candidate_declaration", BUNDLE / "sources" / DC / "context_runtime/contracts.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.VERSION == "0.1.0" and module.SCHEMAS == dc

schemas = [*trip.values(), *dc.values(), nap]
registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)
old_registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in [*trip.values(), *old_dc.values()])

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

refs = 0
for schema in schemas:
    Draft202012Validator.check_schema(schema)
    for node in walk(schema):
        if "$ref" in node:
            registry.resolver(schema["$id"]).lookup(node["$ref"])
            refs += 1

# Recompute exact structural differences. Only version bindings or bijective sample IDs are allowed.
def difference(a, b, pointer=""):
    if type(a) is not type(b):
        return [(pointer, a, b)]
    if isinstance(a, dict):
        assert set(a) == set(b), pointer
        return sum((difference(a[k], b[k], pointer + "/" + k.replace("~", "~0").replace("/", "~1")) for k in sorted(a)), [])
    if isinstance(a, list):
        assert len(a) == len(b), pointer
        return sum((difference(x, y, pointer + "/" + str(i)) for i, (x, y) in enumerate(zip(a, b))), [])
    return [] if a == b else [(pointer, a, b)]

changes = load(BUNDLE / "machine-differences.json")["comparisons"]
expected_comparisons = {f"{DC}/schemas/{name}.schema.json" for name in dc} | {f"{DC}/examples/exploration.json", f"{DC}/examples/recovery.json", f"{NAP}/engineering/contracts.schema.json"}
assert len(changes) == 23 and {row["path"] for row in changes} == expected_comparisons
version_changes = sample_id_changes = 0
for row in changes:
    a = load(OLD / row["path"])
    b = load(BUNDLE / "sources" / row["path"])
    actual = difference(a, b)
    assert actual == [(c["pointer"], c["before"], c["after"]) for c in row["changes"]]
    mapping, reverse = {}, {}
    for pointer, before, after in actual:
        if isinstance(before, str) and before.replace("/runtime/0.2/", "/runtime/0.1/").replace("0.2.0", "0.1.0") == after:
            assert pointer.endswith(("/$id", "/$ref")) or "/runtime_contract_version" in pointer
            version_changes += 1
        else:
            assert "/examples/" in row["path"]
            assert re.fullmatch(r"(?:turn|packet|runtime|context)-[0-9a-f]{32}", before)
            assert re.fullmatch(r"(?:turn|packet|runtime|context)-[0-9a-f]{32}", after)
            assert before.split("-")[0] == after.split("-")[0]
            assert mapping.get(before, after) == after and reverse.get(after, before) == before
            mapping[before], reverse[after] = after, before
            sample_id_changes += 1
    assert row["non_version_contract_differences"] == 0 and mapping == row["generated_id_mapping"]

formatter = FormatChecker()
def validate(name, value, historical=False):
    schemas_by_name, resources = (old_dc, old_registry) if historical else (dc, registry)
    Draft202012Validator(schemas_by_name[name], registry=resources, format_checker=formatter).validate(value)

def rejected(action):
    try:
        action()
    except ValidationError:
        return
    raise AssertionError("Expected contract rejection")

example_count = negative_count = 0
key_to_schema = {"open_turn": "open-turn", "turn": "turn", "assemble": "assemble", "packet": "packet", "scene_save": "scene-save", "scene_ack": "scene-ack", "scene_restore": "scene-restore", "scene_restored": "scene-restored"}
for filename in ["exploration.json", "recovery.json"]:
    current = load(BUNDLE / "sources" / DC / "examples" / filename)
    historical = load(OLD / DC / "examples" / filename)
    for key, value in current.items():
        if key == "disclaimer":
            continue
        name = key_to_schema[key]
        validate(name, value)
        validate(name, historical[key], historical=True)
        # Cross-version requests must not be silently accepted by either URI namespace.
        rejected(lambda: validate(name, historical[key]))
        rejected(lambda: validate(name, value, historical=True))
        example_count += 1
        negative_count += 2
    turn = copy.deepcopy(current["turn"])
    for required in ["runtime_id", "checkpoint_ack"]:
        bad = copy.deepcopy(turn)
        del bad[required]
        rejected(lambda: validate("turn", bad))
        negative_count += 1

nap_index = load(BUNDLE / "sources" / NAP / "package-index.json")
assert nap_index["dependencies"]["decision_context_runtime"] == "0.1.0"
assert nap_index["owner_approval"] == "NOT_RECORDED"
assert set(nap_index["external_schema_registry"]) == {s["$id"] for s in [*trip.values(), *dc.values()]}
assert set(selection["offline_uri_registry"]) == {s["$id"] for s in schemas}
for uri, relative in selection["offline_uri_registry"].items():
    assert load(ROOT / relative)["$id"] == uri
for uri, source_relative in nap_index["external_schema_registry"].items():
    parts = Path(source_relative).parts
    assert parts[0] == ".." and ".." not in parts[1:]
    relative = Path(*parts[1:])
    bound = OLD / relative if parts[1] == "trip-state-schema-v0.1" else BUNDLE / "sources" / relative
    assert load(bound)["$id"] == uri
    assert (ROOT / selection["offline_uri_registry"][uri]).resolve() == bound.resolve()
assert "/runtime/0.2/" not in json.dumps(nap)
nap_validator = Draft202012Validator({"$ref": nap["$id"] + "#/$defs/DecisionRequest"}, registry=registry, format_checker=formatter)
for filename, packet_key in [("exploration.json", "packet"), ("recovery.json", "scene_restored")]:
    sample = load(BUNDLE / "sources" / DC / "examples" / filename)
    packets = [sample["packet"]] if packet_key == "packet" else sample["scene_restored"]["packets"]
    runtime = sample["turn"]["runtime_id"] if packet_key == "packet" else sample["scene_restored"]["runtime_id"]
    request = dict(nap_contract_version="0.1.0", decision_id="decision-calibration", runtime_id=runtime,
                   trigger=dict(kind="user_event", reference=packets[0]["pending_input"]["event"]["event_id"]), packets=packets)
    nap_validator.validate(request)
    bad = copy.deepcopy(request)
    bad["packets"][0]["runtime_contract_version"] = "0.2.0"
    rejected(lambda: nap_validator.validate(bad))
    negative_count += 1

print(json.dumps(dict(scope="offline proposed contract calibration; no DC or NAP runtime execution", status=selection["status"],
                     source_files_verified=len(selection["files"]), dc_schemas=20, declaration_matches=True,
                     registry_schemas=len(schemas), resolved_references=refs, machine_version_bindings=version_changes,
                     generated_sample_id_differences=sample_id_changes, business_contract_differences=0,
                     example_parts_validated=example_count, negative_contract_checks=negative_count,
                     nap_request_shapes_validated=2), ensure_ascii=False))
