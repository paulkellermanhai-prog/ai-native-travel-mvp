"""E03-00 audit and original-reference validation, never application runtime implementation."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CANDIDATE = ROOT / "specs/dc-0.1-calibration-2026-10-29"
AVAILABILITY = ROOT / "specs/e03-00-reference-2026-10-29/availability.json"
EXPECTED = [("E03-00", "基线审核与可迭代性准备", 8), ("E03-01", "契约与工程底座", 10),
            ("E03-02", "权威状态读取与 Context 组装", 15), ("E03-03", "Turn / Task / Focus / 分页", 13),
            ("E03-04", "Trip State 写入与确认桥接", 10), ("E03-05", "Checkpoint 持久化", 17),
            ("E03-06", "跨会话恢复", 14), ("E03-07", "HTTP 与完整工程验收", 13)]
load = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def board_text(board):
    text = "# E03 固定阶段看板\n\n唯一维护源：[e03-progress.json](e03-progress.json)；本页由 `python scripts/audit-e03-00.py --write-board` 生成。\n\n"
    text += f"累计已验收 **{board['accepted_weight_percent']}%**；已提交待审 **{board['submitted_weight_percent']}%**。E03-00 的 8% 是固定工作量权重，提交不等于 Gate A 通过。\n\n"
    text += "| 阶段 | 固定权重 | 状态 |\n| --- | ---: | --- |\n"
    for s in board["stages"]:
        text += f"| {s['id']} {s['name']} | {s['weight_percent']}% | {s['status']} |\n"
    for s in board["stages"]:
        text += f"\n## {s['id']} {s['name']}\n\n"
        text += "子任务：\n\n" + "".join(f"- {t['id']}：{t['description']}（{t['status']}）。\n" for t in s["subtasks"])
        for key, label in [("execution_location", "执行位置"), ("responsibilities", "分工"), ("owner_participation", "Owner 参与")]:
            text += f"\n{label}：{s[key]}。\n"
        text += "\n完成证据：" + ("；".join(f"[{v}]({v if v.startswith('https://') else os.path.relpath(ROOT / v, ROOT / 'docs')})" for v in s["evidence"]) if s["evidence"] else "尚无执行证据，不能登记通过") + "。\n"
        text += "\n阻塞项：" + "；".join(s["blockers"]) + "。\n"
    return text + "\n## 变更登记\n\n" + board["change_policy"] + "。当前无新增已批准工程变更登记。\n"

def run_reference(files):
    with tempfile.TemporaryDirectory(prefix="antu-e03-00-reference-") as folder:
        root = Path(folder)
        dc = root / "decision-context-v0.1/90_可运行工程包"
        for row in files:
            relative = Path(row["source_path"]).relative_to("decision-context-v0.1/90_可运行工程包")
            target = dc / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / row["repository_path"], target)
        trip = root / "trip-state-schema-v0.1/90_可运行工程包"
        shutil.copytree(ROOT / "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包", trip,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        child = '''import json,unittest,sys
suite=unittest.defaultTestLoader.discover("tests")
def ids(s):
 for x in s:
  if isinstance(x,unittest.TestSuite): yield from ids(x)
  else: yield x.id()
names=list(ids(suite))
r=unittest.TextTestRunner(stream=sys.stderr,verbosity=2).run(suite)
print(json.dumps(dict(tests_run=r.testsRun,core=sum(n.startswith("test_runtime.") for n in names),recovery=sum(n.startswith("test_recovery.") for n in names),failures=len(r.failures),errors=len(r.errors),skipped=len(r.skipped),successful=r.wasSuccessful())))
sys.exit(not r.wasSuccessful())'''
        env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(dc), str(trip)]), "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run([sys.executable, "-B", "-c", child], cwd=dc, env=env, capture_output=True, text=True, timeout=180)
        if result.returncode:
            # This is a private temporary source copy; never edit the originals to make them pass.
            print(result.stderr[-10000:], file=sys.stderr)
            raise RuntimeError("Original reference validation failed")
        summary = json.loads(result.stdout.strip())
        assert summary == dict(tests_run=99, core=56, recovery=43, failures=0, errors=0, skipped=0, successful=True)
        return {**summary, "scope": "original Python reference only; synthetic Principal/tasks, real temporary SQLite/process/CAS/SIGKILL; no new TS/HTTP implementation"}

parser = argparse.ArgumentParser()
parser.add_argument("--run-reference", action="store_true")
parser.add_argument("--write-board", action="store_true")
args = parser.parse_args()
receipt = load(AVAILABILITY)
selection = load(CANDIDATE / "selection.json")
assert sha(CANDIDATE / "selection.json") == receipt["candidate_selection_sha256"]
assert receipt["candidate_head"] == "db9290d931ac044a0bc64f2aceb2fe81209b093b"
assert selection["status"] == "PROPOSED_PENDING_TECH_LEAD_CONFIRMATION"
assert len(selection["files"]) == 39 and receipt["candidate_39_is_complete_runtime_package"] is False
for row in selection["files"]:
    assert sha(CANDIDATE / row["path"]) == row["sha256"]
for row in receipt["supplemental_sources"]:
    p = ROOT / row["path"]
    assert p.resolve().is_relative_to(ROOT) and not p.is_symlink()
    assert sha(p) == row["sha256"] and p.stat().st_size == row["bytes"]
files = receipt["runtime_directory_files"]
assert len(files) == len({r["source_path"] for r in files}) == 42
index = load(CANDIDATE / "sources/decision-context-v0.1/package-index.json")
expected = {"decision-context-v0.1/" + x["path"] for x in index["engineering_files"]} | {"decision-context-v0.1/90_可运行工程包/artifact-manifest.json"}
assert {x["source_path"] for x in files} == expected
by_source = {x["source_path"]: x for x in files}
for row in index["engineering_files"]:
    assert by_source["decision-context-v0.1/" + row["path"]]["sha256"] == row["sha256"]
for row in files:
    p = ROOT / row["repository_path"]
    assert sha(p) == row["sha256"]
    if "test_methods" in row:
        actual = [n.name for n in ast.walk(ast.parse(p.read_text())) if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")]
        assert actual == row["test_methods"]
api_relative = "decision-context-v0.1/90_可运行工程包/context_runtime/api.py"
artifact_row = by_source["decision-context-v0.1/90_可运行工程包/artifact-manifest.json"]
artifact = load(ROOT / artifact_row["repository_path"])
assert artifact["90_可运行工程包/context_runtime/api.py"] == by_source[api_relative]["sha256"]
board = load(ROOT / "docs/e03-progress.json")
assert [(s["id"], s["name"], s["weight_percent"]) for s in board["stages"]] == EXPECTED
assert sum(s["weight_percent"] for s in board["stages"]) == 100
assert board["accepted_weight_percent"] == sum(s["weight_percent"] for s in board["stages"] if s["accepted"]) 
assert board["submitted_weight_percent"] == sum(s["weight_percent"] for s in board["stages"] if s["status"] in ["READY_FOR_GATE_A", "READY_FOR_REVIEW"])
assert board["gate_a"]["status"] in ["PENDING_TECH_LEAD_REVIEW", "APPROVED", "REJECTED"]
if board["gate_a"]["status"] == "APPROVED":
    assert board["gate_a"]["approval_evidence"], "Record explicit technical lead approval"
else:
    assert all(s["status"] in ["NOT_STARTED", "WAITING_GATE_A"] for s in board["stages"][1:]), "Later stages require Gate A"
for s in board["stages"]:
    assert all(s[k] for k in ["subtasks", "execution_location", "responsibilities", "owner_participation", "blockers"])
    assert s["status"] in ["READY_FOR_GATE_A", "WAITING_GATE_A", "NOT_STARTED", "IN_PROGRESS", "READY_FOR_REVIEW", "ACCEPTED", "BLOCKED"]
    assert s["accepted"] == (s["status"] == "ACCEPTED")
rendered = board_text(board)
view = ROOT / "docs/E03阶段看板.md"
if args.write_board:
    view.write_text(rendered)
else:
    assert view.read_text() == rendered, "Generate the board from its single maintenance source"
summary = dict(scope="E03-00 baseline/reference/engineering boundaries only; no product iteration review",
               candidate_head=receipt["candidate_head"],candidate_sources_verified=39,supplemental_sources_verified=len(receipt["supplemental_sources"]),
               complete_reference_directory_files=42,reference=run_reference(files) if args.run_reference else "NOT_RUN_THIS_INVOCATION",
               artifact_manifest_digest_verified=True,stage_weights=[s["weight_percent"] for s in board["stages"]],accepted_progress_percent=board["accepted_weight_percent"],gate_a=board["gate_a"]["status"])
if os.environ.get("E03_00_EVIDENCE_PATH"):
    Path(os.environ["E03_00_EVIDENCE_PATH"]).write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(summary,ensure_ascii=False))
