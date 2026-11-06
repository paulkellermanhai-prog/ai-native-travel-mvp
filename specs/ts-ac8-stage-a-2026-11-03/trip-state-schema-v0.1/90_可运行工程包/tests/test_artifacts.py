import json
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch
from pathlib import Path
from tripstate.contracts import schemas, TRANSITIONS
from tripstate.rules import validate_shape, validate_state, RuleError, index
from tripstate.engine import Store, Actor
from tripstate.fixtures import initial_state, NOW

ROOT = Path(__file__).resolve().parents[1]


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


class DeliveredArtifactTests(unittest.TestCase):
    def test_generated_dictionaries_and_transition_documents_are_exact(self):
        import build
        with TemporaryDirectory() as temporary:
            destination = Path(temporary)
            with patch.object(build, "ROOT", destination):
                build.generate_contracts()
            for relative in ("FIELD_DICTIONARY.md", "STATE_TRANSITIONS.md", "rules/field-dictionary.json", "rules/transitions.json"):
                with self.subTest(file=relative):
                    self.assertEqual((ROOT / relative).read_bytes(), (destination / relative).read_bytes())

    def test_final_dictionary_and_transition_matrix_equal_generator(self):
        import final_dictionary
        with TemporaryDirectory() as temporary:
            with patch.object(final_dictionary, "ROOT", Path(temporary)):
                # The final dictionary reads validated object examples from ROOT.
                for path in (ROOT / "examples" / "objects").glob("*.json"):
                    target = Path(temporary) / "examples" / "objects" / path.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(path.read_bytes())
                final_dictionary.make()
                final_dictionary.make_transitions()
            for name in ("FIELD_DICTIONARY_FINAL.md", "STATE_TRANSITIONS_FINAL.md"):
                self.assertEqual((ROOT / name).read_bytes(), (Path(temporary) / name).read_bytes())

    def test_all_seven_scenarios_reexecute_to_saved_trace(self):
        import scenario_runner
        saved = load(ROOT / "examples" / "scenario-traces.json")
        actual = scenario_runner.run_scenarios()
        self.assertEqual(len(saved), 7)
        self.assertEqual(sum(len(s["steps"]) for s in saved), 31)
        for previous, current in zip(saved, actual):
            with self.subTest(scenario=previous["scenario"]):
                self.assertEqual(previous, current)
                validate_state(current["initial_state"])
                validate_state(current["final_state"])
                validate_shape("history", current["audit"])

    def test_all_top_level_object_fields_have_semantic_notes(self):
        from build import NOTES
        from tripstate.contracts import FIELDS
        for kind in list(FIELDS) + ["DecisionContext", "ChangeRecord", "OperationIntent"]:
            self.assertTrue(set(schemas()[kind]["properties"]) <= NOTES.keys(), kind)

    def test_markdown_local_links_resolve(self):
        import re
        for path in ROOT.glob("*.md"):
            for target in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
                if not target.startswith(("https:", "http:", "#")):
                    self.assertTrue((path.parent / target.split("#")[0]).exists(), (path.name, target))

    def test_delivered_json_schemas_equal_declaration_source(self):
        actual = {p.name.removesuffix(".schema.json"): load(p) for p in (ROOT / "schemas").glob("*.json")}
        self.assertEqual(actual, schemas())

    def test_transition_json_equal_declaration_source(self):
        self.assertEqual(load(ROOT / "rules" / "transitions.json"), TRANSITIONS)

    def test_every_reference_has_an_offline_target(self):
        resources = {s["$id"]: s for s in schemas().values()}

        def walk(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    url, _, fragment = value["$ref"].partition("#")
                    self.assertIn(url, resources)
                    target = resources[url]
                    for part in fragment.strip("/").split("/") if fragment else []:
                        self.assertIn(part, target)
                        target = target[part]
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        for schema in schemas().values():
            walk(schema)

    def test_all_twelve_object_record_examples(self):
        paths = list((ROOT / "examples" / "objects").glob("*.json"))
        self.assertEqual(len(paths), 12)
        for path in paths:
            with self.subTest(path=path.name):
                validate_shape(path.stem, load(path))

    def test_all_state_examples_pass_structure_and_semantics(self):
        paths = list((ROOT / "examples").glob("*state.json"))
        self.assertGreaterEqual(len(paths), 4)
        for path in paths:
            with self.subTest(path=path.name):
                validate_state(load(path))

    def test_negative_examples_fail_for_documented_reason(self):
        for case in load(ROOT / "examples" / "invalid-cases.json"):
            with self.subTest(case=case["name"]):
                with self.assertRaises(RuleError) as error:
                    if case["schema"] == "state":
                        validate_state(case["value"])
                    else:
                        validate_shape(case["schema"], case["value"])
                self.assertEqual(error.exception.code, case["expected_error"])

    def test_saved_api_examples_match_request_and_response_contracts(self):
        for path in (ROOT / "examples" / "api").glob("*.json"):
            body = load(path)
            schema = "response" if "response" in path.name else "confirm-request" if "proposal_digest" in body else "change-request"
            validate_shape(schema, body)

    def test_multiturn_saved_snapshots_and_independent_reexecution(self):
        store = Store(initial_state(), clock=lambda: NOW)
        proposals = {}
        trace = load(ROOT / "examples" / "multi-turn-trace.json")
        for turn in trace:
            validate_state(turn["after"])
            body = turn["request"]
            if "confirm_proposal" in turn:
                proposal = proposals[turn["confirm_proposal"]]
                body = {**body, "proposal_digest": proposal["proposal_digest"]}
                result = store.confirm(proposal["proposal_id"], body, Actor("user", "user-demo"))
            else:
                result = store.submit(body, Actor(**turn["actor"]))
                if result["outcome"] == "pending_confirmation":
                    proposals[turn["response"]["proposal_id"]] = result
            self.assertEqual(result["outcome"], turn["expected_outcome"], result)
        final = store.get_state()
        objects = index(final)
        self.assertEqual(final["effective_skeleton_id"], "skeleton-a")
        self.assertEqual(objects["pref-culture"]["expression"], index(initial_state())["pref-culture"]["expression"])
        self.assertEqual(objects["candidate-luxor"]["status"], "reintroduced")
        self.assertEqual(objects["fact-cairo-luxor"]["applicability"], "not_applicable")
        self.assertEqual(objects["skeleton-a"]["assessment"]["connection_minutes"], [None])
        self.assertEqual(objects["skeleton-a"]["assessment"]["status"], "pending")
        self.assertNotEqual(objects["skeleton-b"]["stops"], objects["skeleton-a"]["stops"])
        validate_shape("history", store.get_history())

    def test_traceability_test_references_exist(self):
        text = (ROOT / "TRACEABILITY.md").read_text(encoding="utf-8")
        import re
        named = re.findall(r"`(test_[A-Za-z0-9_]+)`", text)
        source = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "tests").glob("test_*.py"))
        self.assertGreater(len(named), 10)
        for name in named:
            self.assertIn("def " + name + "(", source)


if __name__ == "__main__":
    unittest.main()
