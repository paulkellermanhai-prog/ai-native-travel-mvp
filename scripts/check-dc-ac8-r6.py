"""Verify the separate AC8 R6 source snapshot without changing the old Gate A candidate."""
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "specs/dc-ac8-r6-calibration-2026-11-05"
OLD = ROOT / "specs/dc-0.1-calibration-2026-10-29"
BASE = ROOT / "specs/baseline-2026-10-27"


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


selection = load(BUNDLE / "selection.json")
assert selection["status"] == "PROPOSED_PENDING_TECH_LEAD_GATE_A"
assert selection["dc_runtime_contract_version"] == "0.1.0"
assert selection["checkpoint_payload_format_version"] == 1
assert selection["runtime_implementation_authorized"] is False
assert selection["gate_a_approval_evidence"] is None
assert sha(OLD / "selection.json") == selection["previous_selection_sha256"]
rows = selection["files"]
assert len(rows) == len({row["path"] for row in rows}) == 66
for row in rows:
    path = BUNDLE / row["path"]
    assert path.resolve().is_relative_to(BUNDLE) and not path.is_symlink()
    assert sha(path) == row["sha256"] and path.stat().st_size == row["bytes"], row["path"]

package = BUNDLE / "sources/decision-context-v0.1"
index = load(package / "package-index.json")
manifest_path = package / "90_可运行工程包/artifact-manifest.json"
manifest = load(manifest_path)
assert sha(manifest_path) == selection["dc_package_manifest_sha256"]
assert len(index["documents"]) == 22 and len(index["engineering_files"]) == 42
assert len(manifest) == 65
assert {row["source_path"] for row in rows} == {
    "decision-context-v0.1/" + path for path in [*manifest, "90_可运行工程包/artifact-manifest.json"]
}
for relative, digest in manifest.items():
    assert sha(package / relative) == digest, relative
for row in [*index["documents"], *index["engineering_files"]]:
    assert sha(package / row["path"]) == row["sha256"], row["path"]

dc_dir = package / "90_可运行工程包/schemas"
old_dir = OLD / "sources/decision-context-v0.1/90_可运行工程包/schemas"
ts_dir = BASE / "trip-state-schema-v0.1/90_可运行工程包/schemas"
dc = {path.name: load(path) for path in dc_dir.glob("*.json")}
ts = {path.name: load(path) for path in ts_dir.glob("*.json")}
nap = load(OLD / "sources/Next-Action-Policy-V0.1/engineering/contracts.schema.json")
assert len(dc) == len(ts) == 20
assert all((old_dir / name).read_bytes() == (dc_dir / name).read_bytes() for name in dc)
for name, schema in dc.items():
    assert schema["$id"] == f"https://decision-context.example/runtime/0.1/{name}"
schemas = [*ts.values(), *dc.values(), nap]
registry = Registry().with_resources((schema["$id"], Resource.from_contents(schema)) for schema in schemas)


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


references = 0
for schema in schemas:
    Draft202012Validator.check_schema(schema)
    for node in walk(schema):
        if "$ref" in node:
            registry.resolver(schema["$id"]).lookup(node["$ref"])
            references += 1
assert references == 285
assert len(selection["previous_selection_mismatches"]) == 8
assert len(selection["nap_source_mismatches"]) == 13
old_rows = {row["source_path"]: row for row in load(OLD / "selection.json")["files"]}
new_rows = {row["source_path"]: row for row in rows}
for mismatch in selection["previous_selection_mismatches"]:
    source = mismatch["source_path"]
    assert old_rows[source]["sha256"] == mismatch["previous_sha256"]
    assert new_rows[source]["sha256"] == mismatch["current_sha256"]
assert all(row["source_path"].startswith("../trip-state-schema-v0.1/") or
           row["source_path"].startswith("../decision-context-v0.1/")
           for row in selection["nap_source_mismatches"])

print(json.dumps(dict(status=selection["status"], source_files=len(rows), manifest_entries=len(manifest),
                      dc_schemas=len(dc), resources=len(schemas), references=references,
                      pr10_source_mismatches=8, nap_source_mismatches_recorded=13,
                      scope="offline source/contract checks; NAP drift recorded from local workspace, not reverified by CI"),
                 ensure_ascii=False))
