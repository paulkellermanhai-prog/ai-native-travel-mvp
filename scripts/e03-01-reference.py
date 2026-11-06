"""Pinned R6 + AC8 TS reference, isolated from original packages and application code."""
import hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
lock=json.loads((ROOT/'specs/e03-01-oracle-lock.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(ROOT/lock['dc_selection'])==lock['dc_selection_sha256']
selection=json.loads((ROOT/lock['dc_selection']).read_text())
for row in selection['files']: assert sha(ROOT/Path(lock['dc_selection']).parent/row['path'])==row['sha256']
for row in lock['ts_files']: assert sha(ROOT/row['path'])==row['sha256']
with tempfile.TemporaryDirectory(prefix='antu-e03-01-') as d:
 root=Path(d);dc=root/'decision-context-v0.1/90_可运行工程包';ts=root/'trip-state-schema-v0.1/90_可运行工程包'
 shutil.copytree(ROOT/'specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/90_可运行工程包',dc)
 shutil.copytree(ROOT/'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1',ts.parent)
 env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':os.pathsep.join([str(dc),str(ts)])}
 if '--capture-fixtures' in sys.argv:
  child="""import json,unittest,sys,copy
import context_runtime.contracts as c,context_runtime.runtime as rt,context_runtime.api as api
original=c.validate; samples={}
def capture(name,value):
 original(name,value)
 if name not in samples:samples[name]=copy.deepcopy(value)
c.validate=rt.validate=api.validate=capture
suite=unittest.defaultTestLoader.loadTestsFromNames(['tests.test_runtime','tests.test_recovery']);result=unittest.TextTestRunner(stream=sys.stderr).run(suite)
if not result.wasSuccessful():sys.exit(1)
print(json.dumps([dict(schema=k,value=v) for k,v in sorted(samples.items())],ensure_ascii=False))"""
  result=subprocess.run([sys.executable,'-B','-c',child],text=True,capture_output=True,cwd=dc,env=env,check=True,timeout=180)
  print(result.stdout,end='');sys.exit(0)
 if '--shape' in sys.argv:
  child="""import json,sys
from context_runtime.contracts import validate,SCHEMAS
rows=json.load(sys.stdin);out=[]
for row in rows:
 try: validate(row['schema'],row['value']);out.append(True)
 except Exception:out.append(False)
print(json.dumps(dict(ids=sorted(s['$id'] for s in SCHEMAS.values()),valid=out)))"""
  result=subprocess.run([sys.executable,'-B','-c',child],input=sys.stdin.read(),text=True,capture_output=True,cwd=dc,env=env,check=True)
  print(result.stdout,end='');sys.exit(0)
 child="""import json,unittest,sys
suite=unittest.defaultTestLoader.loadTestsFromNames(sys.argv[1:]);r=unittest.TextTestRunner(stream=sys.stderr).run(suite)
print(json.dumps(dict(tests=r.testsRun,failures=len(r.failures),errors=len(r.errors),skipped=len(r.skipped))))
sys.exit(not r.wasSuccessful() or bool(r.skipped))"""
 summary={}
 for label,cwd,modules,count in [('dc_r6',dc,['tests.test_runtime','tests.test_recovery'],105),('ts_ac8',ts,['tests.test_tripstate','tests.test_global_consistency','tests.test_reservation_profile','tests.test_artifacts','tests.test_package'],126)]:
  result=subprocess.run([sys.executable,'-B','-c',child,*modules],cwd=cwd,env=env,text=True,capture_output=True,timeout=180)
  if result.returncode:print(result.stderr,file=sys.stderr);raise RuntimeError(label+' failed')
  summary[label]=json.loads(result.stdout.strip());assert summary[label]==dict(tests=count,failures=0,errors=0,skipped=0),summary
 print(json.dumps(summary))
 if os.environ.get('E03_01_REFERENCE_EVIDENCE_PATH'):Path(os.environ['E03_01_REFERENCE_EVIDENCE_PATH']).write_text(json.dumps(summary,indent=2)+'\n')
