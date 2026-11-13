"""Independent pinned AC8 Python/SQLite-free reference for synthetic selection tests."""
import hashlib,json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
lock=json.loads((root/'specs/e03-01-oracle-lock.json').read_text())
for row in lock['ts_files']:
 assert hashlib.sha256((root/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
assert hashlib.sha256((root/lock['dc_selection']).read_bytes()).hexdigest()==lock['dc_selection_sha256']
sys.path.insert(0,str(root/'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包'))
from tripstate.engine import Store
from tripstate.fixtures import NOW
out=[]
for case in json.load(sys.stdin):
 try:
  state=case['state'];seeds=set(case['targets'])
  seeds.update(o['id'] for o in state['objects'] if o['type']=='TripGoal' and o['status'] in ('active','revised') or o['type']=='Preference' and o['status']=='active')
  ctx=Store(state,clock=lambda:NOW).context({'task_id':'task-test','selected_object_ids':sorted(seeds)})
  out.append({'value':{k:ctx[k] for k in ['selected_object_ids','must_include_constraints','active_decisions','open_issues','assembled_from_versions']},'error':None})
 except Exception as e:out.append({'value':None,'error':getattr(e,'code',type(e).__name__)})
print(json.dumps(out,ensure_ascii=False))
