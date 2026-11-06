"""Read-only synthetic comparison with the pinned R6 annotation implementation."""
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parents[1]
lock = json.loads((root / 'specs/e03-01-oracle-lock.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
selection_path = root / lock['dc_selection']
assert sha(selection_path) == lock['dc_selection_sha256']
for row in json.loads(selection_path.read_text())['files']:
    assert sha(selection_path.parent / row['path']) == row['sha256'], row['path']
for row in lock['ts_files']:
    assert sha(root / row['path']) == row['sha256'], row['path']

sys.path.insert(0, str(root / 'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包'))
sys.path.insert(0, str(root / 'specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/90_可运行工程包'))
from tripstate.engine import Store
from tripstate.rules import stamp
from context_runtime.runtime import Principal, Runtime

out = []
for row in json.load(sys.stdin):
    state, targets = row['state'], row['targets']
    now = datetime.fromisoformat(row['now'].replace('Z', '+00:00'))
    seeds = set(targets)
    seeds.update(o['id'] for o in state['objects'] if
                 o['type'] == 'TripGoal' and o['status'] in ('active', 'revised') or
                 o['type'] == 'Preference' and o['status'] == 'active')
    store = Store(state, clock=lambda: now)
    context = store.context({'task_id': 'task-test', 'selected_object_ids': sorted(seeds)})
    objects = {o['id']: o for o in state['objects'] if o['id'] in context['selected_object_ids']}
    rows = Runtime(store)._annotations(objects, {'target_ids': targets}, now, set(context['stale_fact_ids']))
    result = {'context': context, 'annotations': rows}
    if 'packet_budget' in row:
        runtime = Runtime(store)
        principal = Principal('reference-test-user', (state['trip_id'],))
        task = {'task_key':'task-test','question':'查看','kind':'explore','target_ids':targets,
                'branch':'actual','relation':'new','related_task_keys':[],'certainty':'explicit',
                'evidence':[{'start':0,'end':2,'quote':'查看'}],'progress':'open','progress_evidence':None}
        turn = runtime.open_turn({'runtime_contract_version':'0.1.0','trip_id':state['trip_id'],
            'expected_revision':state['revision'],'event':{'event_id':'event-test','entry':'dialogue','text':'查看',
            'reference':'synthetic-test','received_at':stamp(now)},'tasks':[task],'focus_keys':['task-test']}, principal)
        packet = runtime.assemble({'runtime_contract_version':'0.1.0','turn_id':turn['turn_id'],
            'task_key':'task-test','body_budget_bytes':row['packet_budget']}, principal)
        result['packet'] = {'context':packet['context'],'objects':packet['objects'],
                            'deferred_ids':packet['deferred_ids'],'annotations':packet['annotations']}
    out.append(result)
print(json.dumps(out, ensure_ascii=False))
