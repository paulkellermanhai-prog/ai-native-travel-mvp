"""Verify UX02 source integrity and execute the updated TS/DC reference packages."""
import hashlib, json, os, subprocess, sys
from pathlib import Path
repo = Path(__file__).resolve().parents[1]
root = repo / 'specs/ux02-2026-11-06'
manifest = json.loads((root/'manifest.json').read_text())
expected = {row['path']: row['sha256'] for row in manifest['files']}
actual = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in (root/'sources').rglob('*') if p.is_file() and '__pycache__' not in p.parts}
assert actual == expected, 'UX02 source snapshot drift'
for package in ['trip-state-schema-v0.1', 'decision-context-v0.1']:
    schemas = list((root/'sources'/package/'90_可运行工程包/schemas').glob('*.json'))
    assert len(schemas) == 20
# Compare byte-for-byte against the actual approved baselines; the metadata flag is not proof.
r6_selection = root / 'approved-r6-selection.json'
assert hashlib.sha256(r6_selection.read_bytes()).hexdigest() == 'eaff06a085946c3a55ddd395169a534b12d8b896e7c4f5dd2b4bde08a46bca77', 'R6 approved selection mismatch'
r6 = json.loads(r6_selection.read_text())
dc_rows = {Path(row['source_path']).name: row['sha256'] for row in r6['files'] if '/schemas/' in row['source_path']}
dc_dir = root/'sources/decision-context-v0.1/90_可运行工程包/schemas'
assert len(dc_rows) == 20 and set(dc_rows) == {p.name for p in dc_dir.glob('*.json')}
for filename, approved_hash in dc_rows.items():
    assert hashlib.sha256((dc_dir/filename).read_bytes()).hexdigest() == approved_hash, f'DC approved schema changed: {filename}'
ts_dir = root/'sources/trip-state-schema-v0.1/90_可运行工程包/schemas'
ts_baseline = repo/'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包/schemas'
assert {p.name for p in ts_dir.glob('*.json')} == {p.name for p in ts_baseline.glob('*.json')}
for schema in ts_dir.glob('*.json'):
    assert schema.read_bytes() == (ts_baseline/schema.name).read_bytes(), f'TS approved schema changed: {schema.name}'
# These are source snapshots, never imported by the Next application.
if '--run-reference' in sys.argv:
    subprocess.run([sys.executable, '-B', 'check_cross_package_refs.py'], cwd=root/'sources/decision-context-v0.1/90_可运行工程包', check=True)
    import tempfile, shutil
    with tempfile.TemporaryDirectory(prefix='antu-ux02-') as tmp:
        for package in ['trip-state-schema-v0.1', 'decision-context-v0.1']:
            shutil.copytree(root/'sources'/package, Path(tmp)/package)
        result = subprocess.run([sys.executable, '-B', 'run_validation.py'], cwd=Path(tmp)/'decision-context-v0.1/90_可运行工程包',
                                env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, check=False)
        if result.returncode: raise SystemExit(result.returncode)
print(json.dumps({'ux02_files_verified': len(actual), 'TS_schemas': 20, 'DC_schemas': 20, 'checkpoint_format': 1}))
