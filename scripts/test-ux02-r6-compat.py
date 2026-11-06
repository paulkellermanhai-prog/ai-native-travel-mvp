"""Produce a real format-1 checkpoint with approved R6, then reopen with R7 in another process."""
import hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
base=repo/'specs/ux02-2026-11-06'; selected=json.loads((base/'approved-r6-selection.json').read_text())
old=base/'approved-r6'; oldkit=old/'decision-context-v0.1/90_可运行工程包'
for row in selected['files']:
 if row['source_path'].startswith('decision-context-v0.1/90_可运行工程包/'):
  assert hashlib.sha256((old/row['source_path']).read_bytes()).hexdigest()==row['sha256'], row['source_path']
old_program=r'''
import json,sys
from pathlib import Path
from test_recovery import RecoveryTests
from context_runtime.checkpoints import CheckpointRepository
from context_runtime.runtime import Runtime
from tripstate.fixtures import request,adopt
t=RecoveryTests('test_DC_R01_open_turn_auto_saves_and_fresh_instance_recovers_identity');t.setUp()
t.path=Path(sys.argv[1]);t.repo=CheckpointRepository(t.path);t.runtime=Runtime(t.store,t.repo)
event=t.event();t.runtime.open_turn(event,t.user)
draft=t.draft();proposal=request(t.store,adopt(),reason=draft['text']);proposal['input']['reference']=draft['source_reference'];proposal['input']['target_ids']=['skeleton-a'];draft['proposal']=proposal
scene=t.scene(drafts=[draft]);t.runtime.save_scene(scene,t.user)
Path(sys.argv[2]).write_text(json.dumps({'state':t.store.get_state(),'scene':scene,'event':event,'draft':draft}))
'''
new_program=r'''
import json,sys
from pathlib import Path
from context_runtime.checkpoints import CheckpointRepository
from context_runtime.runtime import Runtime,Principal,RuntimeFault
from context_runtime.contracts import VERSION
from tripstate.engine import Store
from tripstate.fixtures import NOW
p=json.loads(Path(sys.argv[2]).read_text());store=Store(p['state'],clock=lambda:NOW);principal=Principal('user-demo',(p['state']['trip_id'],));r=Runtime(store,CheckpointRepository(sys.argv[1]));before=store.get_state()
body=dict(runtime_contract_version=VERSION,workspace_key='workspace',body_budget_bytes=1000000)
restored=r.restore_scene(body,principal)
assert restored['drafts']==[p['draft']] and restored['recovery_requires_new_authorization']
assert 'legacy_draft_target_binding_requires_review' in restored['warnings']
assert 'hypothetical_draft_requires_new_actual_intent' in restored['warnings']
assert store.get_state()==before and store.get_history()['changes']==[]
try:r.open_turn(p['event'],principal);raise AssertionError('old event was replayed')
except RuntimeFault as e:assert e.code=='RECOVERED_EVENT_REPLAY',e.code
scene=p['scene'];scene['expected_checkpoint_revision']=restored['checkpoint_revision'];scene['idempotency_key']='unchanged-r7'
ack=r.save_scene(scene,principal)['ack'];assert ack['durable']
scene['expected_checkpoint_revision']=ack['checkpoint_revision'];scene['idempotency_key']='bad-new-r7';scene['drafts'][0]['text']='改动后的假设';scene['drafts'][0]['proposal']['input']['text']='改动后的假设'
try:r.save_scene(scene,principal);raise AssertionError('invalid target accepted')
except RuntimeFault as e:assert e.code=='INPUT_BINDING',e.code
again=Runtime(store,CheckpointRepository(sys.argv[1])).restore_scene(body,principal)
assert again['checkpoint_revision']==ack['checkpoint_revision'] and again['drafts']==[p['draft']]
assert store.get_state()==before and store.get_history()['changes']==[]
print('R6→R7 separate-process legacy checkpoint compatibility passed')
'''
with tempfile.TemporaryDirectory(prefix='ux02-r6-') as td:
 tmp=Path(td);shutil.copytree(old/'decision-context-v0.1',tmp/'decision-context-v0.1')
 shutil.copytree(repo/'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1',tmp/'trip-state-schema-v0.1',ignore=shutil.ignore_patterns('*.zip'))
 kit=tmp/'decision-context-v0.1/90_可运行工程包';ts=tmp/'trip-state-schema-v0.1/90_可运行工程包';db=tmp/'scene.sqlite';payload=tmp/'saved.json'
 env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':os.pathsep.join([str(kit),str(kit/'tests'),str(ts)])}
 subprocess.run([sys.executable,'-B','-c',old_program,str(db),str(payload)],env=env,check=True)
 r7=base/'sources/decision-context-v0.1/90_可运行工程包';ts7=base/'sources/trip-state-schema-v0.1/90_可运行工程包'
 env['PYTHONPATH']=os.pathsep.join([str(r7),str(ts7)])
 subprocess.run([sys.executable,'-B','-c',new_program,str(db),str(payload)],env=env,check=True)
