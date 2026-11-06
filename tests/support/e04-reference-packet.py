"""Synthetic bridge only: make R6 reference Packets from TS snapshots on stdin.

The in-memory Principal and turn below are test fixtures, not authentication or
an E03 application endpoint. Frozen source files are read, never modified.
"""
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[2]
lock = json.loads((root / 'specs/e03-01-oracle-lock.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
selection_path = root / lock['dc_selection']
assert sha(selection_path) == lock['dc_selection_sha256']
for item in json.loads(selection_path.read_text())['files']:
    assert sha(selection_path.parent / item['path']) == item['sha256']
for item in lock['ts_files']:
    assert sha(root / item['path']) == item['sha256']

dc = selection_path.parent / 'sources/decision-context-v0.1/90_可运行工程包'
ts = root / 'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包'
sys.path[:0] = [str(dc), str(ts)]
from tripstate.engine import Store  # noqa: E402
from context_runtime.runtime import Runtime, Principal  # noqa: E402
from context_runtime.contracts import VERSION  # noqa: E402

now = datetime(2030, 1, 1, tzinfo=timezone.utc)
results = []
for state in json.load(sys.stdin):
    store = Store(state, clock=lambda: now)
    runtime = Runtime(store)
    user = Principal('synthetic-user', (state['trip_id'],))
    question = 'synthetic question'
    task = dict(task_key='synthetic-task', question=question, kind='explore', target_ids=[],
                branch='actual', relation='new', related_task_keys=[], certainty='explicit',
                evidence=[dict(start=0, end=len(question), quote=question)], progress='open', progress_evidence=None)
    opened = runtime.open_turn(dict(runtime_contract_version=VERSION, trip_id=state['trip_id'],
        expected_revision=state['revision'], event=dict(event_id='synthetic-event', entry='dialogue', text=question,
        reference='synthetic-event', received_at='2030-01-01T00:00:00Z'), tasks=[task], focus_keys=['synthetic-task']), user)
    packet = runtime.assemble(dict(runtime_contract_version=VERSION, turn_id=opened['turn_id'],
        task_key='synthetic-task', body_budget_bytes=1000000), user)
    results.append(dict(runtime_id=opened['runtime_id'], packet=packet))
json.dump(results, sys.stdout, ensure_ascii=False)
