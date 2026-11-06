"""Resolve the current DC, TS and NAP JSON Schema references offline."""
import json
from pathlib import Path
from referencing import Registry, Resource


project = Path(__file__).resolve().parents[2]
paths = [
    *sorted((project / "decision-context-v0.1/90_可运行工程包/schemas").glob("*.schema.json")),
    *sorted((project / "trip-state-schema-v0.1/90_可运行工程包/schemas").glob("*.schema.json")),
    project / "Next-Action-Policy-V0.1/engineering/contracts.schema.json",
]
schemas = [json.loads(path.read_text()) for path in paths]
if len(paths) != 41 or len({schema["$id"] for schema in schemas}) != 41:
    raise SystemExit("Expected 41 distinct DC/TS/NAP schema resources")
registry = Registry().with_resources((schema["$id"], Resource.from_contents(schema)) for schema in schemas)
count = 0


def check(node, base):
    global count
    if isinstance(node, dict):
        base = node.get("$id", base)
        if "$ref" in node:
            count += 1
            registry.resolver(base_uri=base).lookup(node["$ref"])
        for value in node.values():
            check(value, base)
    elif isinstance(node, list):
        for value in node:
            check(value, base)


for schema in schemas:
    check(schema, schema["$id"])
print(json.dumps({"resources": len(paths), "references": count, "unresolved": 0}))
