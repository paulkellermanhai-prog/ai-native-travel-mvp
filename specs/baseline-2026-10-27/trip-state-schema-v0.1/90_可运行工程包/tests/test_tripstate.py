import unittest
from copy import deepcopy
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from tripstate.contracts import schemas, STATES, TRANSITIONS
from tripstate.rules import (validate_shape, validate_state, RuleError, index, condition_value,
                             assess, fact_usable, Draft202012Validator)
from tripstate.engine import Store, Actor
from tripstate.fixtures import (NOW, AT, initial_state, minimal_state, preference, fact, skeleton,
                                candidate, base, create_command, ingest_command, request, adopt)
from tripstate.api import dispatch

USER = Actor("user", "user-demo")
MODEL = Actor("model", "model-demo")
SYSTEM = Actor("system", "system-demo")
TOOL = Actor("tool", "provider-demo")


class ContractTests(unittest.TestCase):
    def test_all_schemas_are_valid_2020_12(self):
        for name, schema in schemas().items():
            with self.subTest(name=name):
                Draft202012Validator.check_schema(schema)

    def test_minimal_and_full_state(self):
        validate_state(minimal_state())
        validate_state(initial_state())

    def test_exact_ten_business_objects_two_system_records(self):
        self.assertEqual(len(STATES), 10)
        self.assertTrue({"OperationIntent", "ChangeRecord"} <= schemas().keys())

    def test_unknown_fields_rejected(self):
        state = initial_state()
        state["objects"][0]["selected"] = True
        with self.assertRaises(RuleError):
            validate_state(state)

    def test_duplicate_id(self):
        state = initial_state()
        state["objects"].append(deepcopy(state["objects"][0]))
        with self.assertRaisesRegex(RuleError, "重复"):
            validate_state(state)

    def test_cross_trip_reference(self):
        state = initial_state()
        state["objects"][0]["trip_id"] = "other-trip"
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "CROSS_TRIP")

    def test_dangling_reference(self):
        state = initial_state()
        index(state)["candidate-luxor"]["subject_ids"] = ["missing"]
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "DANGLING_REF")

    def test_wrong_reference_type(self):
        state = initial_state()
        index(state)["candidate-luxor"]["subject_ids"] = ["constraint-dates"]
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "REF_TYPE")

    def test_future_dependency_version(self):
        state = initial_state()
        index(state)["skeleton-a"]["dependencies"] = [dict(object_id="pref-culture", version=99, paths=["/priority"], relation="input")]
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "FUTURE_REF")

    def test_calculation_cycles_rejected_association_cycles_allowed(self):
        state = initial_state()
        a, b = index(state)["candidate-luxor"], index(state)["candidate-aswan"]
        a["dependencies"] = [dict(object_id=b["id"], version=1, paths=["/status"], relation="input")]
        b["dependencies"] = [dict(object_id=a["id"], version=1, paths=["/status"], relation="input")]
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "DEPENDENCY_CYCLE")
        a["dependencies"][0]["relation"] = b["dependencies"][0]["relation"] = "association"
        validate_state(state)

    def test_invalid_date_and_unknown_not_zero(self):
        state = initial_state()
        index(state)["constraint-dates"]["value"]["start"] = "2030-02-31"
        with self.assertRaises(RuleError):
            validate_state(state)
        self.assertIsNone(index(initial_state())["constraint-budget"]["value"]["minimum_minor"])

    def test_budget_range_and_hardness(self):
        state = initial_state()
        b = index(state)["constraint-budget"]
        b["hardness"] = "hard"
        with self.assertRaises(RuleError):
            validate_state(state)
        b["value"]["mode"] = "ceiling"
        b["value"]["minimum_minor"] = b["value"]["maximum_minor"] + 1
        with self.assertRaises(RuleError):
            validate_state(state)

    def test_failure_cannot_be_verified_or_no_service(self):
        state = initial_state()
        f = index(state)["fact-cairo-luxor"]
        f["query_status"] = "timeout"
        with self.assertRaises(RuleError):
            validate_state(state)
        f["query_status"] = "no_service"
        with self.assertRaises(RuleError):
            validate_state(state)

    def test_skeleton_adjacency_and_current_authority(self):
        state = initial_state()
        index(state)["skeleton-a"]["connections"][0]["to_id"] = "aswan"
        with self.assertRaises(RuleError):
            validate_state(state)
        state = initial_state()
        state["effective_skeleton_id"] = "skeleton-a"
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "ADOPTION_AUTHORITY")

    def test_no_arbitrary_patch_or_actor_field(self):
        r = request(0, dict(op="patch", id="constraint-nights", value=999))
        with self.assertRaises(RuleError):
            validate_shape("change-request", r)
        r = request(0, adopt())
        r["actor"] = "user"
        with self.assertRaises(RuleError):
            validate_shape("change-request", r)

    def test_transition_table_covers_each_object(self):
        self.assertEqual({t["object_type"] for t in TRANSITIONS}, set(STATES))
        for t in TRANSITIONS:
            self.assertIn(t["from_state"], STATES[t["object_type"]])
            self.assertIn(t["to_state"], STATES[t["object_type"]])
            self.assertTrue(t["guard"] and t["failure"] and t["actors"])

    def test_single_current_goal_authority(self):
        state = initial_state()
        goal = deepcopy(index(state)["goal"])
        goal["id"] = "second-goal"
        state["objects"].append(goal)
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "GOAL_AUTHORITY")


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.store = Store(initial_state(), clock=lambda: self.now)
        self.counter = 0

    def send(self, *commands, actor=USER):
        self.counter += 1
        return self.store.submit(request(self.store, *commands, key=f"key-{self.counter}"), actor)

    def item(self, oid):
        return index(self.store.get_state())[oid]

    def ok(self, result):
        self.assertEqual(result["outcome"], "applied", result["errors"])

    def reject(self, result, code):
        self.assertEqual(result["outcome"], "rejected", result)
        self.assertEqual(result["errors"][0]["code"], code, result)

    def confirm(self, result, accept=True, **overrides):
        body = dict(expected_revision=self.store.get_state()["revision"], idempotency_key="confirmation-" + str(self.counter),
                    proposal_digest=result["proposal_digest"], accept=accept)
        body.update(overrides)
        return self.store.confirm(result["proposal_id"], body, USER)

    def test_H01_interest_does_not_confirm_candidate(self):
        self.ok(self.send(create_command(preference("pref-new", "inferred")), actor=MODEL))
        self.assertFalse(any(o["type"] == "Decision" for o in self.store.get_state()["objects"]))
        self.assertEqual(self.item("candidate-luxor")["status"], "retained")

    def test_H01_inferred_cannot_overwrite_explicit(self):
        before = self.item("pref-culture")
        result = self.send(dict(op="revise", object_type="Preference", id="pref-culture", changes=dict(polarity="negative")), actor=MODEL)
        self.assertEqual(result["outcome"], "pending_confirmation")
        self.assertEqual(self.item("pref-culture"), before)

    def test_H01_user_can_correct_preference_with_history(self):
        self.ok(self.send(dict(op="revise", object_type="Preference", id="pref-culture", changes=dict(polarity="negative", expression="我纠正之前的文化偏好"))))
        delta = self.store.get_history()["changes"][-1]["diff"]
        old = next(d for d in delta if d["id"] == "pref-culture")
        self.assertEqual(old["before"]["polarity"], "positive")
        self.assertEqual(old["after"]["polarity"], "negative")

    def test_H02_confirmation_does_not_upgrade_facts(self):
        before = self.item("fact-cairo-luxor")
        self.ok(self.send(adopt()))
        self.assertEqual(self.item("fact-cairo-luxor"), before)
        self.assertEqual(self.item("skeleton-a")["assessment"]["status"], "pending")

    def test_H02_user_cannot_forge_fact_verification(self):
        self.reject(self.send(ingest_command(fact("new-fact"))), "PERMISSION")

    def test_H02_tool_failure_keeps_unknown(self):
        self.ok(self.send(ingest_command(fact("failed-fact", query_status="timeout", value=None)), actor=TOOL))
        self.assertEqual(self.item("failed-fact")["verification"], "unverified")
        self.assertIsNone(self.item("failed-fact")["value"])

    def test_H03_budget_intent_and_hard_ceiling_are_distinct(self):
        b = self.item("constraint-budget")
        self.assertEqual(b["hardness"], "soft")
        value = {**b["value"], "mode": "ceiling", "maximum_minor": 100000}
        self.ok(self.send(dict(op="revise", object_type="Constraint", id=b["id"], changes=dict(hardness="hard", value=value))))
        self.reject(self.send(adopt()), "HARD_CONFLICT")

    def test_H03_model_cannot_relax_limit(self):
        before = self.item("constraint-nights")
        result = self.send(dict(op="transition", id="constraint-nights", event="relax"), actor=MODEL)
        self.assertEqual(result["outcome"], "pending_confirmation")
        self.assertEqual(self.item("constraint-nights"), before)

    def test_H03_fixed_constraint_cannot_be_changed_even_by_user(self):
        state = initial_state()
        index(state)["constraint-nights"]["override_policy"] = "fixed"
        self.store = Store(state, clock=lambda: self.now)
        self.reject(self.send(dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=99)))), "FIXED_CONSTRAINT")

    def test_H04_new_preference_preserves_unrelated_values(self):
        old = {k: self.item(k) for k in ("constraint-dates", "constraint-budget", "goal")}
        self.ok(self.send(create_command(preference("pref-extra"))))
        for k, v in old.items():
            self.assertEqual(self.item(k), v)

    def test_H04_atomic_failure_no_partial_create(self):
        before, history = self.store.get_state(), self.store.get_history()
        result = self.send(create_command(preference("pref-extra")), dict(op="transition", id="candidate-luxor", event="activate"))
        self.reject(result, "ILLEGAL_TRANSITION")
        self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.store.get_history(), history)

    def test_H04_explicit_date_correction_preserves_others_and_marks_dependencies(self):
        self.ok(self.send(adopt()))
        preference_before = self.item("pref-culture")
        self.ok(self.send(dict(op="revise", object_type="Constraint", id="constraint-dates",
                               changes=dict(value=dict(kind="date_window", start="2030-02-10", end="2030-02-14")))))
        self.assertEqual(self.item("pref-culture"), preference_before)
        self.assertEqual(self.item("fact-cairo-luxor")["applicability"], "not_applicable")
        self.assertEqual(self.item("skeleton-a")["assessment"]["status"], "stale")
        self.assertEqual(self.store.get_state()["effective_skeleton_id"], "skeleton-a")

    def test_H05_exclusion_preserves_shared_preferences_evidence_entities(self):
        old = {k: self.item(k) for k in ("pref-culture", "luxor", "fact-cairo-luxor")}
        self.ok(self.send(dict(op="transition", id="candidate-luxor", event="exclude")))
        for k, v in old.items():
            self.assertEqual(self.item(k), v)
        self.assertEqual(self.item("candidate-aswan")["status"], "retained")

    def test_H05_reconsider_needs_real_condition_trigger(self):
        self.ok(self.send(dict(op="transition", id="candidate-luxor", event="exclude")))
        self.reject(self.send(dict(op="reconsider", id="candidate-luxor", trigger_id="pref-culture")), "RECONSIDER_TRIGGER")
        self.ok(self.send(dict(op="reconsider", id="candidate-luxor", trigger_id="constraint-nights"), actor=SYSTEM))
        self.assertEqual(self.item("candidate-luxor")["status"], "reintroduced")
        self.assertFalse(any(o["type"] == "Decision" for o in self.store.get_state()["objects"]))

    def test_H05_local_scope_stays_local_across_exclusion(self):
        state = initial_state()
        index(state)["pref-culture"]["scope"] = dict(kind="entity", ids=["luxor"])
        self.store = Store(state, clock=lambda: self.now)
        self.ok(self.send(dict(op="transition", id="candidate-luxor", event="exclude")))
        self.assertEqual(self.item("pref-culture")["scope"], dict(kind="entity", ids=["luxor"]))

    def test_automatic_conditional_exclusion_requires_explicit_applicable_true_tradeoff(self):
        self.reject(self.send(dict(op="transition", id="candidate-luxor", event="exclude_conditionally"), actor=MODEL), "CONDITION_UNKNOWN")
        state = initial_state()
        p = index(state)["pref-culture"]
        p["polarity"] = "tradeoff"
        p["condition"] = dict(op="gt", object_id="cost-transport", path="/value/amount_minor", value=100000)
        self.store = Store(state, clock=lambda: self.now)
        self.ok(self.send(dict(op="transition", id="candidate-luxor", event="exclude_conditionally"), actor=MODEL))

    def test_provider_omitted_fields_cannot_upgrade_schedule(self):
        f = fact("incomplete-fact")
        f["value"]["arrival"] = None
        self.ok(self.send(ingest_command(f), actor=TOOL))
        value = self.item("incomplete-fact")
        self.assertEqual(value["verification"], "estimated")
        self.assertIn("arrival", value["missing_fields"])

    def test_candidate_reject_cannot_contradict_current_skeleton(self):
        self.ok(self.send(adopt()))
        self.reject(self.send(dict(op="decide_candidate", id="candidate-luxor", value="reject")), "CONFIRMED_CANDIDATE")

    def test_adoption_cannot_override_explicit_rejected_city(self):
        self.ok(self.send(dict(op="decide_candidate", id="candidate-luxor", value="reject")))
        self.reject(self.send(adopt()), "CONFIRMED_CANDIDATE")
        decision = next(o for o in self.store.get_state()["objects"] if o["type"] == "Decision")
        self.ok(self.send(dict(op="withdraw_decision", id=decision["id"]), adopt()))

    def test_unrelated_evidence_does_not_close_issue(self):
        self.reject(self.send(dict(op="resolve_issue", id="issue-cost", reason="错误关闭", evidence_ids=["constraint-nights"])), "RESOLUTION_EVIDENCE")

    def test_known_fact_issue_can_resolve_with_related_evidence(self):
        issue = base("issue-fact", "OpenIssue", "open", issue_kind="verification", question="该测试班次是否已核验",
                     affected_ids=["fact-cairo-luxor"], severity="warning", required_inputs=["schedule"],
                     candidate_actions=["verify"], owner="provider", resolution=None, evidence_ids=[])
        self.ok(self.send(create_command(issue)))
        self.ok(self.send(dict(op="resolve_issue", id="issue-fact", reason="测试适配器提供完整日期班次", evidence_ids=["fact-cairo-luxor"])))
        self.assertEqual(self.item("issue-fact")["status"], "resolved")

    def test_scoped_constraint_preserved_and_unsupported_calculation_is_unknown(self):
        state = initial_state()
        c = base("personal-limit", "Constraint", "active", hardness="hard", override_policy="user", value=dict(kind="duration", maximum_nights=0))
        c["scope"] = dict(kind="traveler", ids=["traveler-demo"])
        state["objects"].append(c)
        self.store = Store(state, clock=lambda: self.now)
        self.ok(self.send(dict(op="recalculate", id="skeleton-a"), actor=SYSTEM))
        self.assertIn("scoped_calculation_not_implemented:personal-limit", self.item("skeleton-a")["assessment"]["unknowns"])

    def test_system_can_invalidate_fixed_evidence_constraint_without_relaxing_it(self):
        state = initial_state()
        c = index(state)["constraint-nights"]
        c["override_policy"] = "fixed"
        c["dependencies"] = [dict(object_id="fact-cairo-luxor", version=1, paths=["/status"], relation="evidence")]
        self.store = Store(state, clock=lambda: self.now)
        self.reject(self.send(dict(op="transition", id="constraint-nights", event="invalidate"), actor=SYSTEM), "FIXED_CONSTRAINT_EVIDENCE")
        self.ok(self.send(dict(op="transition", id="fact-cairo-luxor", event="contradict"), actor=SYSTEM))
        self.ok(self.send(dict(op="transition", id="constraint-nights", event="invalidate"), actor=SYSTEM))
        self.assertEqual(self.item("constraint-nights")["value"]["maximum_nights"], 4)

    def test_newly_confirmed_candidate_has_current_basis(self):
        state = initial_state()
        index(state)["candidate-luxor"]["status"] = "exploring"
        self.store = Store(state, clock=lambda: self.now)
        self.ok(self.send(dict(op="decide_candidate", id="candidate-luxor", value="accept")))
        d = next(o for o in self.store.get_state()["objects"] if o["type"] == "Decision")
        self.assertEqual(d["review_state"], "current")
        self.assertEqual(d["subject_version"], self.item("candidate-luxor")["version"])

    def test_later_input_change_keeps_superseded_history_immutable(self):
        self.ok(self.send(adopt()))
        self.ok(self.send(create_command(skeleton("skeleton-b"))))
        self.ok(self.send(adopt("skeleton-b")))
        old = self.item("skeleton-a")
        self.ok(self.send(dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))))
        self.assertEqual(self.item("skeleton-a"), old)
        self.reject(self.send(dict(op="recalculate", id="skeleton-a"), actor=SYSTEM), "IMMUTABLE_HISTORY")

    def test_H06_scenario_cannot_be_adopted(self):
        scenario = skeleton("scenario-test", "scenario")
        scenario["overrides"] = [dict(constraint_id="constraint-nights", value=dict(kind="duration", maximum_nights=2))]
        before = self.item("constraint-nights")
        self.ok(self.send(create_command(scenario)))
        self.ok(self.send(dict(op="recalculate", id="scenario-test"), actor=SYSTEM))
        self.reject(self.send(adopt("scenario-test")), "SCENARIO_ADOPTION")
        self.assertEqual(self.item("constraint-nights"), before)
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_H06_continuous_tentative_edits_do_not_replace_effective(self):
        self.ok(self.send(adopt()))
        old = self.item("skeleton-a")
        self.ok(self.send(create_command(skeleton("skeleton-b"))))
        for nights in (1, 2):
            self.ok(self.send(dict(op="revise", object_type="Skeleton", id="skeleton-b",
                                  changes=dict(stops=[dict(entity_id="cairo", nights=nights), dict(entity_id="luxor", nights=1)]))))
        self.assertEqual(self.item("skeleton-a"), old)
        self.assertEqual(self.store.get_state()["effective_skeleton_id"], "skeleton-a")

    def test_H06_effective_skeleton_is_not_mutable_in_place(self):
        self.ok(self.send(adopt()))
        self.reject(self.send(dict(op="revise", object_type="Skeleton", id="skeleton-a", changes=dict(tradeoffs=dict(gains=["new"], losses=[])))), "EFFECTIVE_IMMUTABLE")

    def test_H07_fact_expiry_propagates_not_deletes(self):
        self.ok(self.send(adopt()))
        old_preference = self.item("pref-culture")
        self.now += timedelta(days=2)
        self.ok(self.send(dict(op="check_freshness"), actor=SYSTEM))
        self.assertEqual(self.item("fact-cairo-luxor")["freshness"], "stale")
        self.assertEqual(self.item("skeleton-a")["assessment"]["status"], "stale")
        decision = next(o for o in self.store.get_state()["objects"] if o["type"] == "Decision")
        self.assertEqual(decision["status"], "confirmed")
        self.assertEqual(decision["review_state"], "stale")
        self.assertEqual(self.item("pref-culture"), old_preference)

    def test_H07_dependency_paths_do_not_invalidate_unread_fields(self):
        state = initial_state()
        b = candidate("candidate-isolated", "aswan")
        b["preference_ids"] = []
        b["dependencies"] = [dict(object_id="pref-culture", version=1, paths=["/priority"], relation="input")]
        state["objects"].append(b)
        self.store = Store(state, clock=lambda: self.now)
        before = self.item(b["id"])
        self.ok(self.send(dict(op="revise", object_type="Preference", id="pref-culture", changes=dict(expression="我重新描述同一个兴趣"))))
        self.assertEqual(self.item(b["id"]), before)

    def test_H07_multilevel_dependency_propagates(self):
        state = initial_state()
        objs = index(state)
        objs["candidate-luxor"]["dependencies"] = [dict(object_id="fact-cairo-luxor", version=1, paths=["/freshness"], relation="input")]
        objs["skeleton-a"]["dependencies"] = [dict(object_id="candidate-luxor", version=1, paths=["/review_state"], relation="input")]
        self.store = Store(state, clock=lambda: self.now)
        self.now += timedelta(days=2)
        self.ok(self.send(dict(op="check_freshness"), actor=SYSTEM))
        self.assertEqual(self.item("candidate-luxor")["review_state"], "stale")
        self.assertEqual(self.item("skeleton-a")["assessment"]["status"], "stale")

    def test_H08_context_contains_hard_constraints_and_new_constraints(self):
        context = self.store.context(dict(task_id="task-test", selected_object_ids=["candidate-luxor"]))
        self.assertTrue({"constraint-nights", "constraint-dates"} <= set(context["must_include_constraints"]))
        c = base("constraint-extra", "Constraint", "proposed", hardness="hard", override_policy="user", value=dict(kind="duration", maximum_nights=3))
        self.ok(self.send(create_command(c), dict(op="transition", id=c["id"], event="activate")))
        self.assertFalse(self.store.context_is_current(context))
        new = self.store.context(dict(task_id="task-test", selected_object_ids=[]))
        self.assertIn(c["id"], new["must_include_constraints"])

    def test_H08_context_expires_without_any_write(self):
        context = self.store.context(dict(task_id="task-test", selected_object_ids=["skeleton-a"]))
        self.assertTrue(self.store.context_is_current(context))
        self.now += timedelta(minutes=6)
        self.assertFalse(self.store.context_is_current(context))

    def test_H08_context_reads_expired_facts_without_claiming_verified(self):
        self.now += timedelta(days=2)
        context = self.store.context(dict(task_id="task-test", selected_object_ids=["skeleton-a"]))
        self.assertIn("fact-cairo-luxor", context["stale_fact_ids"])

    def test_H08_tampered_context_constraint_omission_rejected(self):
        context = self.store.context(dict(task_id="task-test", selected_object_ids=[]))
        context["must_include_constraints"] = []
        self.assertFalse(self.store.context_is_current(context))

    def test_H09_confirmed_candidate_cannot_be_silently_excluded(self):
        self.ok(self.send(dict(op="decide_candidate", id="candidate-luxor", value="accept")))
        self.reject(self.send(dict(op="transition", id="candidate-luxor", event="exclude")), "CONFIRMED_CANDIDATE")

    def test_H09_model_proposal_reject_then_confirm(self):
        before = self.store.get_state()
        pending = self.send(adopt(), actor=MODEL)
        self.assertEqual(pending["outcome"], "pending_confirmation")
        self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.confirm(pending, False)["outcome"], "rejected")
        pending = self.send(adopt(), actor=MODEL)
        self.ok(self.confirm(pending))
        self.assertEqual(self.store.get_state()["effective_skeleton_id"], "skeleton-a")

    def test_H09_incomplete_scope_or_wrong_digest_rejected(self):
        cmd = adopt()
        cmd["confirmation_scope"] = ["cities"]
        self.reject(self.send(cmd), "SCHEMA")
        pending = self.send(adopt(), actor=MODEL)
        self.reject(self.confirm(pending, proposal_digest="wrong"), "CONFIRMATION_SCOPE")

    def test_H09_old_confirmation_after_update_is_conflict(self):
        pending = self.send(adopt(), actor=MODEL)
        self.ok(self.send(create_command(preference("new-pref"))))
        result = self.confirm(pending)
        self.assertEqual(result["outcome"], "conflict")
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_H09_confirmation_time_expiry(self):
        pending = self.send(adopt(), actor=MODEL)
        self.now += timedelta(minutes=6)
        self.reject(self.confirm(pending), "CONFIRMATION_EXPIRED")

    def test_H10_unknown_cost_never_total_affordability(self):
        self.ok(self.send(dict(op="recalculate", id="skeleton-a"), actor=SYSTEM))
        a = self.item("skeleton-a")["assessment"]
        self.assertEqual(a["cost_groups"][0]["subtotal_minor"], 120000)
        self.assertEqual(a["cost_coverage"], "partial")
        self.assertIn("partial_budget:constraint-budget", a["unknowns"])

    def test_H10_unknown_ack_required_before_adoption(self):
        self.reject(self.send(adopt(acknowledge=False)), "UNKNOWN_ACK")

    def test_H10_dismiss_does_not_resolve_fact_or_feasibility(self):
        before = self.item("fact-cairo-luxor")
        self.ok(self.send(dict(op="dismiss_issue", id="issue-cost", reason="暂时不讨论")))
        self.ok(self.send(dict(op="recalculate", id="skeleton-a"), actor=SYSTEM))
        self.assertEqual(self.item("fact-cairo-luxor"), before)
        self.assertEqual(self.item("skeleton-a")["assessment"]["status"], "pending")
        self.assertIn("issue-cost", self.store.context(dict(task_id="task-test", selected_object_ids=[]))["open_issues"])

    def test_issue_resolution_rejects_remaining_unknown(self):
        self.reject(self.send(dict(op="resolve_issue", id="issue-cost", reason="假称已解决", evidence_ids=["cost-transport"])), "ISSUE_STILL_BLOCKED")

    def test_idempotent_retry_and_content_collision(self):
        r = request(self.store, create_command(preference("pref-new")))
        first = self.store.submit(r, USER)
        self.ok(first)
        self.assertEqual(self.store.submit(r, USER), first)
        self.assertEqual(len(self.store.get_history()["changes"]), 1)
        altered = deepcopy(r)
        altered["reason"] = "different"
        self.assertEqual(self.store.submit(altered, USER)["outcome"], "conflict")

    def test_two_concurrent_writers_only_one_commits(self):
        reqs = [request(0, create_command(preference("pref-" + str(i))), key="parallel-" + str(i)) for i in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda r: self.store.submit(r, USER), reqs))
        self.assertCountEqual([r["outcome"] for r in results], ["applied", "conflict"])
        self.assertEqual(self.store.get_state()["revision"], 1)

    def test_failure_before_commit_rolls_back_state_history_and_key(self):
        before = self.store.get_state()
        r = request(self.store, create_command(preference("pref-new")))
        self.store.before_commit = lambda: (_ for _ in ()).throw(RuntimeError("injected"))
        self.reject(self.store.submit(r, USER), "INTERNAL_FAILURE")
        self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.store.get_history()["changes"], [])
        self.store.before_commit = None
        self.ok(self.store.submit(r, USER))

    def test_confirmation_failure_is_retryable_and_atomic(self):
        pending = self.send(adopt(), actor=MODEL)
        before, history = self.store.get_state(), self.store.get_history()
        self.store.before_commit = lambda: (_ for _ in ()).throw(RuntimeError("injected"))
        self.reject(self.confirm(pending), "INTERNAL_FAILURE")
        self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.store.get_history(), history)
        self.store.before_commit = None
        self.ok(self.confirm(pending))

    def test_preview_does_not_write(self):
        before = self.store.get_state()
        result = self.store.preview(request(self.store, adopt()), MODEL)
        self.assertEqual(result["outcome"], "preview")
        self.assertTrue(result["confirmation_required"])
        self.assertTrue(result["diff"])
        self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.store.get_history()["changes"], [])

    def test_replacing_skeleton_is_one_atomic_authority_change(self):
        self.ok(self.send(adopt()))
        self.ok(self.send(create_command(skeleton("skeleton-b"))))
        self.ok(self.send(adopt("skeleton-b")))
        self.assertEqual(self.store.get_state()["effective_skeleton_id"], "skeleton-b")
        self.assertEqual(self.item("skeleton-a")["status"], "superseded")
        ds = [o for o in self.store.get_state()["objects"] if o["type"] == "Decision"]
        self.assertEqual(sum(o["status"] == "confirmed" for o in ds), 1)

    def test_revoke_does_not_restore_stale_historical_plan(self):
        self.ok(self.send(adopt()))
        d = next(o for o in self.store.get_state()["objects"] if o["type"] == "Decision")
        self.ok(self.send(dict(op="withdraw_decision", id=d["id"])))
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])
        self.assertEqual(self.item(d["id"])["status"], "revoked")

    def test_orphan_confirmed_adoption_cannot_pass_validation(self):
        self.ok(self.send(adopt()))
        state = self.store.get_state()
        state["effective_skeleton_id"] = None
        with self.assertRaises(RuleError) as error:
            validate_state(state)
        self.assertEqual(error.exception.code, "ADOPTION_AUTHORITY")

    def test_api_contract_read_write_preview_context_history(self):
        prefix = "/trips/trip-egypt-test/"
        code, state = dispatch(self.store, "GET", prefix + "state", actor=USER)
        self.assertEqual(code, 200)
        validate_shape("state", state)
        code, body = dispatch(self.store, "POST", prefix + "changes", request(self.store, adopt()), actor=USER)
        self.assertEqual(code, 200, body)
        code, ctx = dispatch(self.store, "POST", prefix + "decision-context", dict(task_id="task-test", selected_object_ids=[]), USER)
        self.assertEqual(code, 200)
        validate_shape("DecisionContext", ctx)
        code, history = dispatch(self.store, "GET", prefix + "changes", actor=USER)
        validate_shape("history", history)
        self.assertEqual(code, 200)
        self.assertEqual(dispatch(self.store, "GET", "/trips/wrong/state", actor=USER)[0], 404)


class CalculationTests(unittest.TestCase):
    def setUp(self):
        self.objects = index(initial_state())

    def test_condition_three_values(self):
        expr = dict(op="gt", object_id="constraint-nights", path="/value/maximum_nights", value=2)
        self.assertIs(condition_value(expr, self.objects, NOW), True)
        expr["value"] = 8
        self.assertIs(condition_value(expr, self.objects, NOW), False)
        expr["value"] = None
        self.assertIsNone(condition_value(expr, self.objects, NOW))
        self.assertIs(condition_value(dict(op="all", args=[dict(op="always"), expr]), self.objects, NOW), None)
        self.assertIs(condition_value(dict(op="any", args=[dict(op="always"), expr]), self.objects, NOW), True)

    def test_expired_fact_condition_unknown(self):
        expr = dict(op="gt", object_id="cost-transport", path="/value/amount_minor", value=1)
        self.assertIsNone(condition_value(expr, self.objects, NOW + timedelta(days=2)))

    def test_time_and_nights_arithmetic(self):
        result = assess(self.objects["skeleton-a"], self.objects, NOW)
        self.assertEqual(result["total_nights"], 4)
        self.assertEqual(result["connection_minutes"], [60])

    def test_partial_empty_timeout_error_are_distinct_unknowns(self):
        for status in ("partial", "empty", "timeout", "error"):
            with self.subTest(status=status):
                f = self.objects["fact-cairo-luxor"]
                f["query_status"] = status
                result = assess(self.objects["skeleton-a"], self.objects, NOW)
                self.assertEqual(result["connection_minutes"], [None])
                self.assertEqual(result["status"], "pending")
                self.assertFalse(any(v.startswith("no_service") for v in result["violations"]))

    def test_explicit_no_service_blocks(self):
        f = self.objects["fact-cairo-luxor"]
        f["query_status"] = "no_service"
        f["value"]["service_exists"] = False
        result = assess(self.objects["skeleton-a"], self.objects, NOW)
        self.assertEqual(result["status"], "blocked")

    def test_costs_grouped_by_currency_and_people(self):
        sk = self.objects["skeleton-a"]
        for oid, currency, people in (("usd", "USD", 2), ("solo", "CNY", 1)):
            f = fact(oid, value=dict(kind="cost", amount_minor=500, currency=currency, people=people, category="experience", item_key=oid))
            self.objects[oid] = f
            sk["cost_fact_ids"].append(oid)
        result = assess(sk, self.objects, NOW)
        self.assertEqual(len(result["cost_groups"]), 3)
        self.assertEqual(sorted(g["subtotal_minor"] for g in result["cost_groups"]), [500, 500, 120000])

    def test_duplicate_cost_item_not_double_counted(self):
        f = deepcopy(self.objects["cost-transport"])
        f["id"] = "duplicate-cost"
        self.objects[f["id"]] = f
        self.objects["skeleton-a"]["cost_fact_ids"].append(f["id"])
        result = assess(self.objects["skeleton-a"], self.objects, NOW)
        self.assertEqual(result["cost_groups"][0]["subtotal_minor"], 120000)
        self.assertTrue(any(s.startswith("duplicate_cost_item") for s in result["unknowns"]))

    def test_conflicting_schedules_and_bad_times(self):
        f = self.objects["fact-cairo-luxor"]
        f["value"]["arrival"] = "2030-01-12T09:00:00+02:00"
        self.assertEqual(assess(self.objects["skeleton-a"], self.objects, NOW)["status"], "blocked")

    def test_unknown_requirement_does_not_become_false_or_true(self):
        c = base("requirement", "Constraint", "active", hardness="hard", override_policy="user",
                 value=dict(kind="requirement", description="尚未给出阈值", condition=dict(op="lt", object_id="cost-transport", path="/value/amount_minor", value=None)))
        self.objects[c["id"]] = c
        result = assess(self.objects["skeleton-a"], self.objects, NOW)
        self.assertIn("requirement", result["unknowns"])
        self.assertNotIn("requirement", result["violations"])


if __name__ == "__main__":
    unittest.main()
