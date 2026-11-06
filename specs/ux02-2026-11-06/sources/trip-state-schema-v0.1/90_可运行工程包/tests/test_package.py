"""Package navigation and extractability checks."""
import hashlib
import json
import unittest
from pathlib import Path
from package_bundle import KIT, READING, make_contents


ROOT = Path(__file__).resolve().parents[1]


class PackageNavigationTests(unittest.TestCase):
    def test_reader_and_machine_entries_resolve(self):
        files, index = make_contents(ROOT)
        self.assertIn("00_从这里开始.md", files)
        self.assertIn("package-index.json", files)
        self.assertEqual(json.loads(files["package-index.json"]), index)
        self.assertEqual(index["entrypoint"], "00_从这里开始.md")
        self.assertEqual(index["schema_version"], "0.1.0")
        self.assertEqual(index["package_revision"], "2026-11-06-ux02-candidate")
        self.assertEqual(index["approval_status"], "PENDING_TECH_LEAD_ACCEPTANCE")
        self.assertTrue(all(route in files or route.endswith("/") and
                            any(path.startswith(route) for path in files)
                            for route in index["routes"].values()))
        self.assertTrue(all(item["canonical_path"] in files and
                            hashlib.sha256(files[item["canonical_path"]]).hexdigest() == item["sha256"]
                            for item in index["files"]))
        self.assertEqual(set(READING.values()), {item["reading_path"] for item in index["files"]
                                                 if item["reading_path"]})
        self.assertIn(f"{KIT}/run_validation.py", files)
        self.assertIn(f"{KIT}/schemas/state.schema.json", files)
        self.assertIn(f"{KIT}/examples/scenario-traces.json", files)
        self.assertIn(index["routes"]["engineering_handoff"], files)

    def test_bundle_has_no_environment_or_compiled_files(self):
        files, _ = make_contents(ROOT)
        self.assertFalse(any(".venv" in path or "__pycache__" in path or path.endswith(".pyc")
                             for path in files))
        self.assertFalse(any(path.endswith("/.DS_Store") for path in files))
