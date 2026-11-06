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
