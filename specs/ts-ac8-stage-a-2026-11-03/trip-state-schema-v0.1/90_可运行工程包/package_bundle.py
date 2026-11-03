"""Build a reader-friendly ZIP while preserving the runnable source layout."""
import hashlib
import json
import os
import posixpath
import re
import tempfile
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED


PREFIX = "trip-state-schema-v0.1/"
KIT = "90_可运行工程包"
GROUPS = {
    "01_产品总览": (
        "FINAL_CANDIDATE.md", "V1_READINESS.md", "OPEN_TRADEOFFS.md",
    ),
    "02_业务状态规则": (
        "SPECIFICATION.md", "FIELD_DICTIONARY_FINAL.md", "ENUM_GLOSSARY.md",
        "OBJECT_RELATIONSHIPS_FINAL.md", "LIFECYCLE_FINAL.md", "STATE_TRANSITIONS_FINAL.md",
        "PROPAGATION_FINAL.md", "AUTHORITY_FINAL.md", "HISTORY_FINAL.md",
        "INVARIANTS_FINAL.md", "SHARED_TYPES.md",
    ),
    "03_场景与验收": (
        "SCENARIO_VALIDATION.md", "FINAL_CONSISTENCY_REVIEW.md",
        "VALIDATION_REPORT.md", "TRACEABILITY.md",
    ),
}
READING = {name: f"{group}/{name}" for group, names in GROUPS.items() for name in names}
READING_GROUP = {name: group for group, names in GROUPS.items() for name in names}
LINK = re.compile(r"\]\(([^)]+)\)")


def source_files(root):
    return sorted(p for p in root.rglob("*") if p.is_file()
                  and not any(part in (".venv", "__pycache__") for part in p.relative_to(root).parts)
                  and p.suffix not in (".zip", ".pyc")
                  and p.name != ".DS_Store"
                  and not p.name.startswith(".package-temp-"))


def rebased_markdown(data, source_name, destination, known):
    """Keep readable mirrors navigable without altering their canonical source files."""
    def replace(match):
        target = match.group(1)
        if target.startswith(("https:", "http:", "#", "mailto:")):
            return match.group(0)
        path, sep, anchor = target.partition("#")
        if not path:
            return match.group(0)
        source_target = posixpath.normpath(posixpath.join(posixpath.dirname(source_name), path))
        if source_target not in known:
            raise ValueError(f"unresolved source link {source_name}: {target}")
        bundle_target = READING.get(source_target, f"{KIT}/{source_target}")
        relative = posixpath.relpath(bundle_target, posixpath.dirname(destination) or ".")
        return "](" + relative + ("#" + anchor if sep else "") + ")"

    return LINK.sub(replace, data.decode("utf-8")).encode("utf-8")


def make_contents(root):
    root = Path(root)
    originals = {p.relative_to(root).as_posix(): p.read_bytes() for p in source_files(root)}
    missing = sorted((set(READING) | {"PACKAGE_GUIDE.md"}) - originals.keys())
    if missing:
        raise ValueError(f"missing curated source: {missing}")
    files = {f"{KIT}/{path}": data for path, data in originals.items()}
    files["00_从这里开始.md"] = rebased_markdown(originals["PACKAGE_GUIDE.md"],
                                            "PACKAGE_GUIDE.md", "00_从这里开始.md", originals)
    for source, destination in READING.items():
        files[destination] = rebased_markdown(originals[source], source, destination, originals)
    index = {
        "format": "trip-state-delivery-index/v1",
        "schema_version": "0.1.0",
        "package_revision": "2026-11-03-ac8-stage-a-candidate",
        "approval_status": "PENDING_TECH_LEAD_ACCEPTANCE",
        "entrypoint": "00_从这里开始.md",
        "authoritative_runtime_root": KIT,
        "reading_groups": {group: list(names) for group, names in GROUPS.items()},
        "routes": {
            "overview": READING["FINAL_CANDIDATE.md"],
            "fields": READING["FIELD_DICTIONARY_FINAL.md"],
            "relationships": READING["OBJECT_RELATIONSHIPS_FINAL.md"],
            "lifecycle": READING["LIFECYCLE_FINAL.md"],
            "transitions": READING["STATE_TRANSITIONS_FINAL.md"],
            "propagation": READING["PROPAGATION_FINAL.md"],
            "write_authority": READING["AUTHORITY_FINAL.md"],
            "audit": READING["HISTORY_FINAL.md"],
            "invariants": READING["INVARIANTS_FINAL.md"],
            "scenarios": READING["SCENARIO_VALIDATION.md"],
            "readiness": READING["V1_READINESS.md"],
            "validation": READING["VALIDATION_REPORT.md"],
            "engineering_handoff": f"{KIT}/TS八项机制融合与工程同步交接包.md",
            "api_specification": f"{KIT}/SPECIFICATION.md",
            "state_schema": f"{KIT}/schemas/state.schema.json",
            "command_schema": f"{KIT}/schemas/command.schema.json",
            "change_request_schema": f"{KIT}/schemas/change-request.schema.json",
            "confirm_request_schema": f"{KIT}/schemas/confirm-request.schema.json",
            "context_request_schema": f"{KIT}/schemas/context-request.schema.json",
            "response_schema": f"{KIT}/schemas/response.schema.json",
            "field_dictionary_machine": f"{KIT}/rules/field-dictionary.json",
            "transitions_machine": f"{KIT}/rules/transitions.json",
            "scenario_trace": f"{KIT}/examples/scenario-traces.json",
            "schemas": f"{KIT}/schemas/",
            "examples": f"{KIT}/examples/",
            "implementation": f"{KIT}/tripstate/",
            "tests": f"{KIT}/tests/",
            "run_validation": f"{KIT}/run_validation.py",
        },
        "files": [{
            "source_path": path,
            "canonical_path": f"{KIT}/{path}",
            "reading_path": READING.get(path),
            "group": READING_GROUP.get(path, "90_可运行工程包"),
            "sha256": hashlib.sha256(data).hexdigest(),
        } for path, data in sorted(originals.items())],
        "mirror_rule": "Reading copies differ from canonical Markdown only in rebased local links; edit canonical files and regenerate.",
    }
    files["package-index.json"] = (json.dumps(index, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    validate_contents(files, index)
    return files, index


def validate_contents(files, index):
    for item in index["files"]:
        assert hashlib.sha256(files[item["canonical_path"]]).hexdigest() == item["sha256"]
    for path, data in files.items():
        if not path.endswith(".md"):
            continue
        for target in LINK.findall(data.decode("utf-8")):
            if target.startswith(("https:", "http:", "#", "mailto:")):
                continue
            target_path = target.split("#", 1)[0]
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target_path))
            if resolved not in files:
                raise ValueError(f"broken bundled link {path} -> {target}")
    for source, destination in READING.items():
        if destination not in files or f"{KIT}/{source}" not in files:
            raise ValueError(f"missing reading or canonical file: {source}")


def write_bundle(root, destination):
    files, index = make_contents(root)
    destination = Path(destination)
    with tempfile.NamedTemporaryFile(prefix=".package-temp-", suffix=".zip", dir=destination.parent,
                                     delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with ZipFile(temporary, "w", ZIP_DEFLATED) as archive:
            for path, data in sorted(files.items()):
                archive.writestr(PREFIX + path, data)
        with ZipFile(temporary) as archive:
            if archive.testzip() is not None or len(archive.namelist()) != len(files):
                raise ValueError("bundle integrity verification failed")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return index


def write_reading_copies(root, package_root):
    files, index = make_contents(root)
    package_root = Path(package_root)
    for path, data in files.items():
        if path.startswith(KIT + "/"):
            continue
        target = package_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return index
