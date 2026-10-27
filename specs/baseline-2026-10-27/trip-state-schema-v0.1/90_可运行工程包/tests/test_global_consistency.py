"""Regression checks from the final cross-document/engine consistency review."""
import unittest
from copy import deepcopy
from datetime import timedelta
from tripstate.engine import Store, Actor
from tripstate.fixtures import NOW, initial_state, request, adopt, base, fact, ingest_command, preference, create_command
from tripstate.rules import index, validate_state, RuleError, assess
from tripstate.contracts import TRANSITIONS

USER = Actor("user", "review-user")
SYSTEM = Actor("system", "review-system")
TOOL = Actor("tool", "review-provider")


class GlobalConsistencyTests(unittest.TestCase):
    def store(self):
        return Store(initial_state(), clock=lambda: NOW)

    def test_excluded_candidate_cannot_skip_reconsider_via_retain(self):
        store = self.store()
        self.assertEqual(store.submit(request(store, dict(op="decide_candidate", id="candidate-luxor", value="reject")), USER)["outcome"], "applied")
        before = store.get_state()
        result = store.submit(request(store, dict(op="decide_candidate", id="candidate-luxor", value="retain"), key="retain-again"), USER)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(store.get_state(), before)

    def test_system_cannot_silently_invalidate_user_constraint(self):
        store = self.store()
        before = store.get_state()
        result = store.submit(request(store, dict(op="transition", id="constraint-dates", event="invalidate")), SYSTEM)
        self.assertEqual(result["outcome"], "pending_confirmation")
        self.assertEqual(store.get_state(), before)

    def test_tool_fact_contradiction_obeys_declared_transition(self):
        store = self.store()
        fid = next(o["id"] for o in store.get_state()["objects"] if o["type"] == "ExternalFact")
        result = store.submit(request(store, dict(op="transition", id=fid, event="contradict")), TOOL)
        self.assertEqual(result["outcome"], "applied", result)
        self.assertEqual(index(store.get_state())[fid]["status"], "contradicted")
        self.assertEqual(store.submit(request(store, dict(op="transition", id="candidate-luxor", event="retain"), key="invalid-tool"), TOOL)["outcome"], "rejected")

    def test_recalculation_propagates_time_change_without_revoking_choice(self):
        store = self.store()
        self.assertEqual(store.submit(request(store, adopt()), USER)["outcome"], "applied")
        before = store.get_state()
        store.clock = lambda: NOW + timedelta(days=2)
        result = store.submit(request(store, dict(op="recalculate", id="skeleton-a")), SYSTEM)
        self.assertEqual(result["outcome"], "applied", result)
        objects = index(store.get_state())
        decision = next(o for o in objects.values() if o["type"] == "Decision" and o["status"] == "confirmed")
        self.assertEqual(decision["review_state"], "stale")
        self.assertEqual(objects["skeleton-a"]["assessment"]["status"], "pending")
        self.assertEqual(store.get_state()["effective_skeleton_id"], "skeleton-a")
        self.assertEqual(objects["pref-culture"], index(before)["pref-culture"])

    def test_replacement_only_transitions_reject_standalone_command(self):
        store = self.store()
        before = store.get_state()
        result = store.submit(request(store, dict(op="transition", id="skeleton-a", event="supersede")), SYSTEM)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(store.get_state(), before)

    def test_nested_dependency_paths_are_validated(self):
        state = initial_state()
        obj = index(state)["skeleton-a"]
        obj["dependencies"] = [dict(object_id="constraint-dates", version=1, paths=["/value/start"], relation="input")]
        validate_state(state)
        obj["dependencies"][0]["paths"] = ["/value/typo"]
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "DEPENDENCY_PATH")

    def test_entity_and_skeleton_lineage_cannot_cycle(self):
        for oid in ("cairo", "skeleton-a"):
            state = initial_state()
            index(state)[oid]["parent_id"] = oid
            with self.subTest(oid=oid):
                with self.assertRaises(RuleError) as error:
                    validate_state(state)
                self.assertEqual(error.exception.code, "LINEAGE_CYCLE")

    def test_scenario_overrides_preserve_kind_and_unique_authority(self):
        state = initial_state()
        obj = index(state)["skeleton-a"]
        obj["purpose"] = "scenario"
        override = dict(constraint_id="constraint-nights", value=deepcopy(index(state)["constraint-nights"]["value"]))
        obj["overrides"] = [override]
        validate_state(state)
        obj["overrides"].append(deepcopy(override))
        with self.assertRaises(RuleError):
            validate_state(state)
        obj["overrides"] = [dict(constraint_id="constraint-nights", value=deepcopy(index(state)["constraint-dates"]["value"]))]
        with self.assertRaises(RuleError):
            validate_state(state)
        obj["overrides"] = [dict(constraint_id="constraint-dates", value=dict(kind="date_window", start="2030-02-10", end="2030-01-10"))]
        with self.assertRaises(RuleError):
            validate_state(state)

    def test_condition_dependencies_propagate_without_rewriting_preference(self):
        state = initial_state()
        pref = index(state)["pref-culture"]
        pref["condition"] = dict(op="gt", object_id="cost-transport", path="/value/amount_minor", value=0)
        store = Store(state, clock=lambda: NOW)
        result = store.submit(request(store, dict(op="transition", id="cost-transport", event="contradict")), TOOL)
        self.assertEqual(result["outcome"], "applied", result)
        self.assertEqual(index(store.get_state())["pref-culture"], pref)
        self.assertEqual(index(store.get_state())["candidate-luxor"]["review_state"], "stale")

    def test_traveler_count_cannot_be_silently_treated_as_satisfied(self):
        state = initial_state()
        limit = base("constraint-party", "Constraint", "active", hardness="hard", override_policy="user",
                     value=dict(kind="travelers", count=99))
        state["objects"].append(limit)
        objects = index(state)
        result = assess(objects["skeleton-a"], objects, NOW)
        self.assertIn("constraint-party", result["violations"])
        goal = next(o for o in objects.values() if o["type"] == "TripGoal")
        limit["value"]["count"] = len(goal["traveler_ids"])
        self.assertNotIn("constraint-party", assess(objects["skeleton-a"], objects, NOW)["violations"])
        goal["traveler_ids"] = []
        self.assertIn("constraint-party:travelers_unknown", assess(objects["skeleton-a"], objects, NOW)["unknowns"])

    def test_unknown_condition_fact_never_becomes_verified(self):
        store = self.store()
        item = fact("fact-condition-unknown", value=dict(kind="condition", value=None, description="测试未知条件"))
        result = store.submit(request(store, ingest_command(item)), TOOL)
        self.assertEqual(result["outcome"], "applied", result)
        current = index(store.get_state())[item["id"]]
        self.assertEqual(current["verification"], "estimated")
        self.assertIn("value", current["missing_fields"])

    def test_typed_entity_and_fact_relationships(self):
        for object_id, field, value in (("candidate-luxor", "subject_ids", ["egypt"]),
                                       ("skeleton-a", "cost_fact_ids", ["fact-cairo-luxor"])):
            state = initial_state()
            index(state)[object_id][field] = value
            with self.subTest(field=field), self.assertRaises(RuleError):
                validate_state(state)

    def test_every_declared_lifecycle_edge_and_actor_gate(self):
        # Dispatcher only: business guards and cross-command compositions have separate tests.
        for edge in TRANSITIONS:
            for role in ("user", "model", "system", "tool"):
                item = dict(type=edge["object_type"], status=edge["from_state"])
                with self.subTest(edge=edge, role=role):
                    if role in edge["actors"]:
                        Store._transition(item, edge["event"], Actor(role, "test-actor"))
                        self.assertEqual(item["status"], edge["to_state"])
                    else:
                        with self.assertRaises(RuleError):
                            Store._transition(item, edge["event"], Actor(role, "test-actor"))
                        self.assertEqual(item["status"], edge["from_state"])

    def test_unknown_stay_is_not_zero_and_can_be_explicitly_acknowledged(self):
        state = initial_state()
        index(state)["skeleton-a"]["stops"][0]["nights"] = None
        validate_state(state)
        store = Store(state, clock=lambda: NOW)
        self.assertEqual(store.submit(request(store, adopt()), USER)["outcome"], "applied")
        assessment = index(store.get_state())["skeleton-a"]["assessment"]
        self.assertIsNone(assessment["total_nights"])
        self.assertIn("stay_nights_missing", assessment["unknowns"])
        self.assertEqual(assessment["status"], "pending")

    def test_imported_confirmation_requires_complete_scope(self):
        store = self.store()
        self.assertEqual(store.submit(request(store, adopt()), USER)["outcome"], "applied")
        state = store.get_state()
        decision = next(o for o in state["objects"] if o["type"] == "Decision")
        decision["confirmation_scope"] = ["cities"]
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "CONFIRMATION_SCOPE")

    def test_preference_supersession_has_traceable_successor(self):
        store = self.store()
        before = store.get_state()
        missing = store.submit(request(store, dict(op="transition", id="pref-culture", event="supersede"),
                                       key="missing-successor"), USER)
        self.assertEqual(missing["outcome"], "rejected")
        self.assertEqual(store.get_state(), before)
        successor = preference("pref-culture-corrected")
        successor["dependencies"] = [dict(object_id="pref-culture", version=1, paths=["/status"], relation="association")]
        result = store.submit(request(store, create_command(successor),
                                      dict(op="transition", id="pref-culture", event="supersede"),
                                      key="replace-preference"), USER)
        self.assertEqual(result["outcome"], "applied", result)
        objects = index(store.get_state())
        self.assertEqual(objects["pref-culture"]["status"], "superseded")
        self.assertEqual(objects["pref-culture-corrected"]["status"], "active")
        self.assertTrue(any(d["object_id"] == "pref-culture" for d in objects["pref-culture-corrected"]["dependencies"]))
        self.assertEqual(objects["pref-culture"]["evidence_refs"], index(before)["pref-culture"]["evidence_refs"])
        objects["pref-culture"]["dependencies"] = [dict(object_id="pref-culture-corrected", version=1,
                                                      paths=["/status"], relation="association")]
        with self.assertRaises(RuleError) as error:
            validate_state(store.get_state() | {"objects": list(objects.values())})
        self.assertEqual(error.exception.code, "LINEAGE_CYCLE")
