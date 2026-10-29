import json
import unittest
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from jsonschema import Draft202012Validator
from tripstate.engine import Store, Actor, digest
from tripstate.fixtures import NOW, initial_state, minimal_state, request, adopt, preference, create_command, skeleton
from tripstate.rules import index, stamp
from context_runtime.runtime import Runtime, RuntimeFault, Principal, WriteGrant
from context_runtime.contracts import VERSION, SCHEMAS, validate
from context_runtime.api import dispatch


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.store = Store(initial_state(), clock=lambda: self.now)
        self.runtime = Runtime(self.store)
        self.user = Principal("user-demo", (self.store.get_state()["trip_id"],))
        self.sequence = 0

    def body(self, text="继续看看", key=None, kind="explore", targets=None, relation="new", **changes):
        self.sequence += 1
        task = dict(task_key=key or "task-" + str(self.sequence), question=text, kind=kind,
                    target_ids=targets or [], branch="actual", relation=relation, related_task_keys=[],
                    certainty="explicit", evidence=[dict(start=0, end=len(text), quote=text)],
                    progress="open", progress_evidence=None)
        task.update(changes)
        return dict(runtime_contract_version=VERSION, trip_id=self.store.get_state()["trip_id"],
                    expected_revision=self.store.get_state()["revision"],
                    event=dict(event_id="event-" + str(self.sequence), entry="dialogue", text=text,
                               reference="synthetic-event-" + str(self.sequence), received_at=stamp(self.now)),
                    tasks=[task], focus_keys=[task["task_key"]])

    def turn(self, **kw):
        return self.runtime.open_turn(self.body(**kw), self.user)["turn_id"]

    def packet(self, turn_id, budget=1000000, key=None):
        task_key = key or self.runtime.turns[turn_id]["body"]["tasks"][0]["task_key"]
        return self.runtime.assemble(dict(runtime_contract_version=VERSION, turn_id=turn_id,
                                          task_key=task_key, body_budget_bytes=budget), self.user)

    def change(self, turn_id, packet, *commands, grant=True, key=None):
        event = self.runtime.turns[turn_id]["pending"]["event"]
        r = request(packet["context"]["state_revision"], *commands, key=key or event["event_id"], reason=event["text"])
        r["input"]["text"], r["input"]["reference"] = event["text"], event["reference"]
        body = dict(runtime_contract_version=VERSION, turn_id=turn_id, packet_id=packet["packet_id"], request=r)
        permit = WriteGrant(self.user.id, event["event_id"], digest(r), r["expected_revision"], stamp(self.now + timedelta(minutes=5))) if grant else None
        return body, permit

    def send(self, turn_id, packet, *commands, grant=True):
        b, g = self.change(turn_id, packet, *commands, grant=grant)
        return self.runtime.submit_change(b, self.user, g)

    def fault(self, code, call):
        with self.assertRaises(RuntimeFault) as caught:
            call()
        self.assertEqual(caught.exception.code, code)

    def test_contracts_are_valid_and_exported(self):
        root = Path(__file__).resolve().parents[1]
        for name, schema in SCHEMAS.items():
            Draft202012Validator.check_schema(schema)
            self.assertEqual(json.loads((root / "schemas" / (name + ".schema.json")).read_text()), schema)

    def test_delivered_example_follows_each_contract(self):
        root = Path(__file__).resolve().parents[1]
        example = json.loads((root / "examples" / "exploration.json").read_text())
        for key, schema in [("open_turn", "open-turn"), ("turn", "turn"), ("assemble", "assemble"), ("packet", "packet")]:
            validate(schema, example[key])

    def test_exploration_without_goal_or_decision_is_legal(self):
        self.store = Store(minimal_state(), clock=lambda: self.now)
        self.runtime = Runtime(self.store)
        t = self.turn(text="想去埃及先了解下", certainty="ambiguous")
        p = self.packet(t)
        self.assertEqual(p["context"]["active_decisions"], [])
        self.assertEqual(self.store.get_state()["objects"], [])
        self.assertEqual(self.store.get_history(), dict(intents=[], changes=[]))

    def test_DC_A01_exploration_preference_update_reaches_next_context(self):
        t = self.turn(text="刚才只是好奇，这次文化不是重点", targets=["candidate-luxor"])
        p = self.packet(t)
        r = self.send(t, p, dict(op="revise", object_type="Preference", id="pref-culture",
            changes=dict(expression="刚才只是好奇，这次文化不是重点", priority="ordinary")))
        self.assertEqual(r["outcome"], "applied")
        p2 = self.packet(t)
        obj = next(o for o in p2["objects"] if o["id"] == "pref-culture")
        self.assertEqual(obj["expression"], "刚才只是好奇，这次文化不是重点")
        self.assertEqual(obj["scope"]["kind"], "trip")
        self.assertEqual(p2["pending_input"]["processing_status"], "applied")
        self.assertTrue(self.store.get_history()["changes"][-1]["diff"])

    def test_DC_A02_multiple_questions_share_protection_not_identity(self):
        b = self.body(text="卢克索先不去，阿斯旺怎么样？预算能再低吗", key="exit", kind="candidate_tradeoff", targets=["candidate-luxor"])
        other = deepcopy(b["tasks"][0]); other.update(task_key="explore", kind="explore", target_ids=["candidate-aswan"])
        budget = deepcopy(other); budget.update(task_key="budget", kind="constraint_adjustment", target_ids=["constraint-budget"])
        b["tasks"] += [other, budget]; b["focus_keys"] = ["exit", "explore", "budget"]
        before = self.store.get_state()
        t = self.runtime.open_turn(b, self.user)["turn_id"]
        packets = [self.packet(t, key=k) for k in b["focus_keys"]]
        self.assertEqual(len({p["context"]["task_id"] for p in packets}), 3)
        self.assertTrue(all("constraint-nights" in p["context"]["must_include_constraints"] for p in packets))
        self.assertEqual(self.store.get_state(), before)

    def test_DC_A03_dismissed_is_retained_without_repeated_reminder_eligibility(self):
        r = self.store.submit(request(self.store, dict(op="dismiss_issue", id="issue-cost", reason="用户暂不处理")), Actor("user", "user-demo"))
        self.assertEqual(r["outcome"], "applied")
        for _ in range(3):
            p = self.packet(self.turn(targets=["candidate-aswan"]))
            self.assertIn("issue-cost", p["context"]["open_issues"])
            row = next(a for a in p["annotations"] if a["id"] == "issue-cost")
            self.assertEqual(row["presentation"], "suppressed_unchanged")
            self.assertEqual(row["restriction"], "decision_limit")

    def test_DC_A04_pending_input_is_not_effective_then_rebuild_after_apply(self):
        t = self.turn(text="预算改成一万元", targets=["constraint-budget"], kind="constraint_adjustment")
        p = self.packet(t)
        self.assertEqual(index(self.store.get_state())["constraint-budget"]["value"]["maximum_minor"], 2000000)
        value = deepcopy(index(self.store.get_state())["constraint-budget"]["value"]); value["maximum_minor"] = 1000000
        r = self.send(t, p, dict(op="revise", object_type="Constraint", id="constraint-budget", changes=dict(value=value)))
        self.assertEqual(r["outcome"], "applied")
        self.assertFalse(r["confirmation_required"])
        p2 = self.packet(t)
        self.assertGreater(p2["context"]["state_revision"], p["context"]["state_revision"])
        self.assertEqual(p2["pending_input"]["processing_status"], "applied")

    def test_DC_A05_expiry_without_revision_rejects_old_packet(self):
        t = self.turn(targets=["skeleton-a"]); p = self.packet(t)
        revision = self.store.get_state()["revision"]
        self.now += timedelta(days=2)
        self.fault("PACKET_EXPIRED", lambda: self.runtime.page(dict(runtime_contract_version=VERSION, packet_id=p["packet_id"], object_ids=["fact-cairo-luxor"]), self.user))
        self.assertEqual(self.store.get_state()["revision"], revision)
        fresh = self.packet(t)
        self.assertIn("fact-cairo-luxor", fresh["context"]["stale_fact_ids"])
        row = next(a for a in fresh["annotations"] if a["id"] == "fact-cairo-luxor")
        self.assertEqual(row["applicability"], "applicable")
        self.assertEqual(row["restriction"], "decision_limit")

    def test_foreign_trip_and_principal_are_denied(self):
        self.fault("ACCESS_DENIED", lambda: self.runtime.open_turn(self.body(), Principal("bad", ("other",))))
        b = self.body(); b["trip_id"] = "other"
        self.fault("TRIP_MISMATCH", lambda: self.runtime.open_turn(b, self.user))
        t = self.turn()
        self.fault("NOT_FOUND", lambda: self.runtime.assemble(dict(runtime_contract_version=VERSION, turn_id=t, task_key="task-3", body_budget_bytes=100), Principal("other", self.user.allowed_trip_ids)))

    def test_unrecognized_fields_and_forged_actor_rejected(self):
        b = self.body(); b["actor"] = "user"
        self.fault("CONTRACT_INVALID", lambda: self.runtime.open_turn(b, self.user))
        b = self.body(); b["runtime_contract_version"] = "9.0"
        self.fault("CONTRACT_INVALID", lambda: self.runtime.open_turn(b, self.user))

    def test_source_quote_is_exact_but_semantics_are_not_claimed_validated(self):
        b = self.body(); b["tasks"][0]["evidence"][0]["quote"] = "伪造原话"
        self.fault("SOURCE_SPAN", lambda: self.runtime.open_turn(b, self.user))
        self.assertEqual(self.runtime.tasks, {})

    def test_missing_targets_never_silently_substituted(self):
        self.fault("TARGET_NOT_FOUND", lambda: self.turn(targets=["osaka-not-in-state"]))

    def test_focus_does_not_mark_original_problem_handled(self):
        self.turn(key="E")
        self.turn(key="Q", kind="candidate_tradeoff", relation="refine", related_task_keys=["E"], targets=["candidate-luxor"])
        self.assertEqual(self.runtime.tasks[(self.user.id, "E")]["progress"], "open")
        self.assertNotEqual(self.runtime.tasks[(self.user.id, "E")]["kind"], self.runtime.tasks[(self.user.id, "Q")]["kind"])

    def test_identity_cannot_change_kind_or_branch(self):
        self.turn(key="E")
        self.fault("TASK_IDENTITY", lambda: self.turn(key="E", relation="continue", kind="skeleton_choice"))
        self.fault("TASK_IDENTITY", lambda: self.turn(key="E", relation="continue", branch="hypothetical"))

    def test_pause_and_completion_require_explicit_evidence(self):
        self.fault("PROGRESS_EVIDENCE", lambda: self.turn(progress="handled"))
        b = self.body(text="先暂停", key="E", progress="paused")
        b["tasks"][0]["progress_evidence"] = deepcopy(b["tasks"][0]["evidence"][0])
        self.runtime.open_turn(b, self.user)
        self.turn(key="E", relation="resume")
        self.assertEqual(self.runtime.tasks[(self.user.id, "E")]["progress"], "open")

    def test_focus_cannot_silently_resume_a_paused_problem(self):
        b = self.body(text="先暂停", key="E", progress="paused")
        b["tasks"][0]["progress_evidence"] = deepcopy(b["tasks"][0]["evidence"][0])
        self.runtime.open_turn(b, self.user)
        self.fault("TASK_PAUSED", lambda: self.turn(key="E", relation="focus"))

    def test_process_restart_does_not_promise_precise_task_recovery(self):
        self.turn(key="E")
        self.runtime = Runtime(self.store)
        self.fault("TASK_NOT_RECOVERABLE", lambda: self.turn(key="E", relation="resume"))

    def test_event_retry_is_idempotent_and_reuse_is_rejected(self):
        b = self.body()
        first = self.runtime.open_turn(b, self.user)
        self.assertEqual(first, self.runtime.open_turn(b, self.user))
        b["tasks"][0]["question"] = "changed"
        self.fault("EVENT_REUSE", lambda: self.runtime.open_turn(b, self.user))

    def test_invalid_task_batch_does_not_half_register(self):
        b = self.body(key="good"); bad = deepcopy(b["tasks"][0]); bad.update(task_key="bad", related_task_keys=["missing"])
        b["tasks"].append(bad)
        self.fault("TASK_RELATION", lambda: self.runtime.open_turn(b, self.user))
        self.assertEqual(self.runtime.tasks, {})

    def test_preference_recall_does_not_depend_on_candidate_link(self):
        state = initial_state(); p = preference("new-pref"); state["objects"].append(p)
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        packet = self.packet(self.turn(targets=["candidate-aswan"]))
        self.assertIn("new-pref", packet["context"]["selected_object_ids"])
        self.assertIn("goal", packet["context"]["selected_object_ids"])

    def test_local_preference_retained_but_not_generalized(self):
        state = initial_state(); p = preference("local-pref"); p["scope"] = dict(kind="entity", ids=["luxor"]); state["objects"].append(p)
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        packet = self.packet(self.turn(targets=["candidate-aswan"]))
        row = next(a for a in packet["annotations"] if a["id"] == "local-pref")
        self.assertTrue(row["retained"]); self.assertEqual(row["applicability"], "not_applicable")
        self.assertEqual(index(self.store.get_state())["local-pref"]["scope"]["ids"], ["luxor"])

    def test_unknown_preference_condition_is_not_false(self):
        state = initial_state(); index(state)["pref-culture"]["condition"] = dict(op="lt", object_id="constraint-budget", path="/value/minimum_minor", value=100)
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        row = next(a for a in self.packet(self.turn())["annotations"] if a["id"] == "pref-culture")
        self.assertEqual(row["applicability"], "unknown")

    def test_hydration_exact_versions_and_no_read_history(self):
        before, history = self.store.get_state(), self.store.get_history()
        p = self.packet(self.turn(targets=["skeleton-a"]))
        self.assertEqual({o["id"]: o["version"] for o in p["objects"]}, {v["id"]: v["version"] for v in p["context"]["assembled_from_versions"]})
        self.assertEqual(self.store.get_state(), before); self.assertEqual(self.store.get_history(), history)

    def test_layered_and_limited_preserve_complete_protected_manifest(self):
        t = self.turn(targets=["skeleton-a"])
        full, limited = self.packet(t), self.packet(t, 2)
        self.assertEqual(limited["coverage"], "limited")
        self.assertEqual(limited["support"], "information_only")
        self.assertEqual(limited["objects"], [])
        self.assertEqual(limited["context"]["must_include_constraints"], full["context"]["must_include_constraints"])
        self.assertEqual(set(limited["deferred_ids"]), set(full["context"]["selected_object_ids"]))

    def test_pages_are_bound_and_do_not_claim_model_comprehension(self):
        p = self.packet(self.turn(targets=["skeleton-a"]), 2)
        body = dict(runtime_contract_version=VERSION, packet_id=p["packet_id"], object_ids=["constraint-nights"])
        page = self.runtime.page(body, self.user); validate("page", page)
        self.assertTrue(page["delivery_only_not_model_comprehension"])
        body["object_ids"] = ["not-in-packet"]
        self.fault("PAGE_SCOPE", lambda: self.runtime.page(body, self.user))

    def test_page_rejects_revision_change_and_new_constraint(self):
        p = self.packet(self.turn(), 2)
        self.store.submit(request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))), Actor("user", "user-demo"))
        self.fault("PACKET_STALE", lambda: self.runtime.page(dict(runtime_contract_version=VERSION, packet_id=p["packet_id"], object_ids=["constraint-nights"]), self.user))

    def test_snapshot_race_is_retried_before_hydration(self):
        original = self.store.context; calls = []
        def racing(body):
            result = original(body)
            if not calls:
                calls.append(True)
                self.store.submit(request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))), Actor("user", "user-demo"))
            return result
        with patch.object(self.store, "context", racing):
            p = self.packet(self.turn())
        self.assertEqual(p["context"]["state_revision"], self.store.get_state()["revision"])
        self.assertEqual(next(o for o in p["objects"] if o["id"] == "constraint-nights")["value"]["maximum_nights"], 3)

    def test_snapshot_race_exhaustion_is_explicit(self):
        original = self.store.context; count = [0]
        def racing(body):
            result = original(body); count[0] += 1
            self.store.submit(request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=4+count[0]))), key="race-"+str(count[0])), Actor("user", "user-demo"))
            return result
        with patch.object(self.store, "context", racing):
            self.fault("SNAPSHOT_BUSY", lambda: self.packet(self.turn()))
        self.assertEqual(count[0], 3)

    def test_caller_mutation_cannot_change_saved_packet(self):
        p = self.packet(self.turn(), 2); p["context"]["must_include_constraints"] = []
        saved = self.runtime.packets[p["packet_id"]]["packet"]
        self.assertTrue(saved["context"]["must_include_constraints"])

    def test_model_proposal_waits_and_explicit_user_grant_does_not_reconfirm(self):
        t = self.turn(text="把上限改成三晚", targets=["constraint-nights"], kind="constraint_adjustment"); p = self.packet(t)
        cmd = dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))
        r = self.send(t, p, cmd, grant=False)
        self.assertEqual(r["outcome"], "pending_confirmation")
        self.assertEqual(index(self.store.get_state())["constraint-nights"]["value"]["maximum_nights"], 4)
        self.assertEqual(self.packet(t)["pending_input"]["processing_status"], "pending_confirmation")

    def test_confirmation_retries_and_submit_retries_return_final_result(self):
        t = self.turn(text="采用这个方案", kind="skeleton_choice", targets=["skeleton-a"]); p = self.packet(t)
        b, _ = self.change(t, p, adopt(), grant=False)
        result = self.runtime.submit_change(b, self.user)
        cb = dict(runtime_contract_version=VERSION, turn_id=t, proposal_id=result["proposal_id"], request=dict(expected_revision=result["revision"], idempotency_key="confirm-1", proposal_digest=result["proposal_digest"], accept=True))
        first = self.runtime.confirm(cb, self.user)
        self.assertEqual(first["outcome"], "applied")
        self.assertEqual(first, self.runtime.confirm(cb, self.user))
        self.assertEqual(first, self.runtime.submit_change(b, self.user))

    def test_stale_confirmation_cannot_apply_after_state_change(self):
        t = self.turn(text="采用", kind="skeleton_choice", targets=["skeleton-a"]); p = self.packet(t)
        r = self.send(t, p, adopt(), grant=False)
        self.store.submit(request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))), Actor("user", "user-demo"))
        result = self.runtime.confirm(dict(runtime_contract_version=VERSION, turn_id=t, proposal_id=r["proposal_id"], request=dict(expected_revision=r["revision"], proposal_digest=r["proposal_digest"], idempotency_key="old", accept=True)), self.user)
        self.assertEqual(result["outcome"], "conflict")
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_grant_cannot_authorize_different_content(self):
        t = self.turn(); p = self.packet(t); b, g = self.change(t, p, adopt())
        b["request"]["reason"] = "different"
        self.fault("WRITE_GRANT", lambda: self.runtime.submit_change(b, self.user, g))

    def test_hypothetical_cannot_modify_real_constraint(self):
        t = self.turn(branch="hypothetical"); p = self.packet(t)
        b, g = self.change(t, p, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=2))))
        self.fault("HYPOTHETICAL_WRITE", lambda: self.runtime.submit_change(b, self.user, g))
        self.assertEqual(index(self.store.get_state())["constraint-nights"]["value"]["maximum_nights"], 4)

    def test_incomplete_body_cannot_authorize_adoption(self):
        t = self.turn(kind="skeleton_choice", targets=["skeleton-a"]); p = self.packet(t, 2)
        b, g = self.change(t, p, adopt())
        self.fault("INCOMPLETE_DELIVERY", lambda: self.runtime.submit_change(b, self.user, g))
        self.runtime.page(dict(runtime_contract_version=VERSION, packet_id=p["packet_id"], object_ids=p["deferred_ids"]), self.user)
        self.assertEqual(self.runtime.submit_change(b, self.user, g)["outcome"], "applied")

    def test_input_binding_is_checked_before_business_write(self):
        t = self.turn(); p = self.packet(t); b, g = self.change(t, p, adopt()); b["request"]["input"]["text"] = "伪造授权"
        self.fault("INPUT_BINDING", lambda: self.runtime.submit_change(b, self.user, g))

    def test_failed_fixed_constraint_write_preserves_current_state_and_pending_input(self):
        state = initial_state(); index(state)["constraint-nights"]["override_policy"] = "fixed"
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        before = self.store.get_state(); t = self.turn(text="改成六晚"); p = self.packet(t)
        r = self.send(t, p, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=6))))
        self.assertEqual(r["outcome"], "rejected"); self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.packet(t)["pending_input"]["processing_status"], "rejected")

    def test_api_access_contract_and_method_errors(self):
        path = "/runtime/trips/" + self.store.get_state()["trip_id"] + "/turns"
        status, response = dispatch(self.runtime, "POST", path, self.body(), self.user)
        self.assertEqual(status, 200); validate("turn", response)
        self.assertEqual(dispatch(self.runtime, "GET", path, {}, self.user)[0], 405)
        status, response = dispatch(self.runtime, "POST", path, {}, self.user)
        self.assertEqual(status, 422); validate("error", response)

    def test_expired_grant_is_not_user_authorization(self):
        t = self.turn(); p = self.packet(t); b, g = self.change(t, p, adopt())
        g = WriteGrant(g.principal_id, g.event_id, g.request_digest, g.revision, stamp(self.now))
        self.fault("WRITE_GRANT", lambda: self.runtime.submit_change(b, self.user, g))
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_write_idempotency_conflict_does_not_reapply(self):
        t = self.turn(); p = self.packet(t); b, g = self.change(t, p, adopt())
        first = self.runtime.submit_change(b, self.user, g)
        self.assertEqual(first, self.runtime.submit_change(b, self.user, g))
        b["request"]["reason"] = "changed"
        self.fault("IDEMPOTENCY_CONFLICT", lambda: self.runtime.submit_change(b, self.user, g))
        self.assertEqual(len(self.store.get_history()["changes"]), 1)

    def test_known_date_inapplicability_is_not_fixed_by_same_revision(self):
        state = initial_state(); index(state)["constraint-dates"]["value"] = dict(kind="date_window", start="2030-02-10", end="2030-02-14")
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        p = self.packet(self.turn(targets=["skeleton-a"]))
        row = next(a for a in p["annotations"] if a["id"] == "fact-cairo-luxor")
        self.assertEqual(row["applicability"], "not_applicable")
        self.assertEqual(row["restriction"], "decision_limit")

    def test_unrelated_confirmation_is_not_assumed_applicable(self):
        self.store.submit(request(self.store, adopt()), Actor("user", "user-demo"))
        p = self.packet(self.turn(targets=["candidate-aswan"]))
        row = next(a for a in p["annotations"] if a["id"].startswith("decision-"))
        self.assertEqual(row["applicability"], "unknown")
        self.assertTrue(row["retained"])

    def test_entire_primary_body_respects_utf8_byte_budget(self):
        t = self.turn(targets=["skeleton-a"])
        from context_runtime.runtime import size
        p = self.packet(t, 2000)
        self.assertLessEqual(size(p["objects"]), 2000)
        self.assertEqual(set(o["id"] for o in p["objects"]) | set(p["deferred_ids"]), set(p["context"]["selected_object_ids"]))

    def test_backend_failure_preserves_business_state_and_does_not_claim_success(self):
        before = self.store.get_state()
        self.store.before_commit = lambda: (_ for _ in ()).throw(RuntimeError("injected"))
        t = self.turn(); p = self.packet(t)
        b, g = self.change(t, p, adopt())
        status, response = dispatch(self.runtime, "POST", "/runtime/trips/"+before["trip_id"]+"/changes", b, self.user, g)
        self.assertEqual(status, 500)
        self.assertEqual(response["outcome"], "rejected")
        self.assertEqual(self.store.get_state(), before)

    def test_cross_turn_packet_cannot_be_used_for_change(self):
        t = self.turn(); p = self.packet(t); second = self.turn()
        b, g = self.change(second, p, adopt())
        self.fault("TURN_MISMATCH", lambda: self.runtime.submit_change(b, self.user, g))

    def test_runtime_response_mutation_is_not_business_truth(self):
        t = self.turn(); p = self.packet(t)
        next(o for o in p["objects"] if o["id"] == "constraint-budget")["value"]["maximum_minor"] = 0
        self.assertEqual(index(self.store.get_state())["constraint-budget"]["value"]["maximum_minor"], 2000000)

    def test_DC_M03_candidate_exit_does_not_invent_cause_or_delete_evidence(self):
        t = self.turn(text="卢克索先不去", targets=["candidate-luxor"], kind="candidate_tradeoff"); p = self.packet(t)
        r = self.send(t, p, dict(op="decide_candidate", id="candidate-luxor", value="reject"))
        self.assertEqual(r["outcome"], "applied")
        state = index(self.store.get_state())
        self.assertEqual(state["candidate-luxor"]["exclusion_reason"], "卢克索先不去")
        self.assertIn("pref-culture", state)
        self.assertNotIn("因为", state["candidate-luxor"]["exclusion_reason"])

    def test_DC_M04_scenario_keeps_formal_duration(self):
        state = initial_state(); index(state)["constraint-nights"]["value"]["maximum_nights"] = 8
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        t = self.turn(text="如果少两晚呢", branch="hypothetical"); p = self.packet(t)
        scenario = skeleton("scenario-six", purpose="scenario"); scenario["overrides"] = [dict(constraint_id="constraint-nights", value=dict(kind="duration", maximum_nights=6))]
        result = self.send(t, p, create_command(scenario))
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual(index(self.store.get_state())["constraint-nights"]["value"]["maximum_nights"], 8)

    def test_DC_M05_unknown_condition_does_not_accept_candidate(self):
        state = initial_state()
        index(state)["candidate-luxor"]["reconsider_when"] = dict(op="lt", object_id="constraint-budget", path="/value/minimum_minor", value=100)
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        self.store.submit(request(self.store, dict(op="decide_candidate", id="candidate-luxor", value="reject")), Actor("user", "user-demo"))
        result = self.store.submit(request(self.store, dict(op="reconsider", id="candidate-luxor", trigger_id="constraint-budget"), key="unknown-condition"), Actor("system", "system"))
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(result["errors"][0]["code"], "CONDITION_UNKNOWN")
        self.assertEqual(index(self.store.get_state())["candidate-luxor"]["status"], "excluded")

    def test_true_reconsideration_is_reintroduced_not_accepted(self):
        self.store.submit(request(self.store, dict(op="decide_candidate", id="candidate-luxor", value="reject")), Actor("user", "user-demo"))
        result = self.store.submit(request(self.store, dict(op="reconsider", id="candidate-luxor", trigger_id="constraint-nights"), key="true-condition"), Actor("system", "system"))
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual(index(self.store.get_state())["candidate-luxor"]["status"], "reintroduced")

    def test_DC_M06_acceptance_is_not_skeleton_adoption(self):
        t = self.turn(text="接受卢克索", targets=["candidate-luxor"], kind="candidate_tradeoff"); p = self.packet(t)
        self.assertEqual(self.send(t, p, dict(op="decide_candidate", id="candidate-luxor", value="accept"))["outcome"], "applied")
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_DC_M07_adoption_keeps_unknowns_and_blocks_known_conflict(self):
        t = self.turn(text="按显示范围采用并接受未知费用", kind="skeleton_choice", targets=["skeleton-a"]); p = self.packet(t)
        result = self.send(t, p, adopt()); self.assertEqual(result["outcome"], "applied")
        state = self.store.get_state(); self.assertEqual(state["effective_skeleton_id"], "skeleton-a")
        self.assertTrue(index(state)["skeleton-a"]["assessment"]["unknowns"])
        t2 = self.turn(text="最多两晚", kind="constraint_adjustment"); p2 = self.packet(t2)
        self.send(t2, p2, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=2))))
        t3 = self.turn(text="再次采用", kind="skeleton_choice", targets=["skeleton-a"]); p3 = self.packet(t3)
        before = self.store.get_state(); result = self.send(t3, p3, adopt())
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(before, self.store.get_state())

    def test_DC_M08_duration_change_legally_rechecks_dependencies(self):
        state = initial_state(); index(state)["constraint-nights"]["value"]["maximum_nights"] = 8
        index(state)["constraint-dates"]["value"]["end"] = "2030-01-18"
        index(state)["skeleton-a"]["stops"] = [dict(entity_id="cairo", nights=4), dict(entity_id="luxor", nights=4)]
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        self.store.submit(request(self.store, adopt()), Actor("user", "user-demo"))
        t = self.turn(text="六晚，回程不变，出发日相应改到12日", kind="constraint_adjustment"); p = self.packet(t)
        result = self.send(t, p,
            dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=6))),
            dict(op="revise", object_type="Constraint", id="constraint-dates", changes=dict(value=dict(kind="date_window", start="2030-01-12", end="2030-01-18"))))
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual(index(self.store.get_state())["skeleton-a"]["assessment"]["status"], "stale")
        self.store.submit(request(self.store, dict(op="recalculate", id="skeleton-a"), key="recalc"), Actor("system", "system"))
        self.assertEqual(index(self.store.get_state())["skeleton-a"]["assessment"]["status"], "blocked")

    def test_DC_M08_fixed_dates_reject_entire_change_not_half_apply(self):
        state = initial_state(); index(state)["constraint-nights"]["value"]["maximum_nights"] = 8
        index(state)["constraint-dates"]["override_policy"] = "fixed"
        self.store = Store(state, clock=lambda: self.now); self.runtime = Runtime(self.store)
        before = self.store.get_state(); t = self.turn(text="六晚回程不变", kind="constraint_adjustment"); p = self.packet(t)
        result = self.send(t, p,
            dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=6))),
            dict(op="revise", object_type="Constraint", id="constraint-dates", changes=dict(value=dict(kind="date_window", start="2030-01-12", end="2030-01-14"))))
        self.assertEqual(result["errors"][0]["code"], "FIXED_CONSTRAINT")
        self.assertEqual(self.store.get_state(), before)

    def test_two_runtime_writes_same_version_only_one_applies(self):
        from concurrent.futures import ThreadPoolExecutor
        t = self.turn(text="调整夜数", kind="constraint_adjustment"); p = self.packet(t)
        requests = [self.change(t, p, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=n))), key="concurrent-"+str(n)) for n in (3, 5)]
        def send(pair):
            try:
                return self.runtime.submit_change(pair[0], self.user, pair[1])["outcome"]
            except RuntimeFault as exc:
                return exc.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(send, requests))
        self.assertEqual(sorted(outcomes), ["PACKET_STALE", "applied"])
        self.assertEqual(len(self.store.get_history()["changes"]), 1)

    def test_DC_M09_and_M10_withdraw_then_resume_does_not_restore_authorization(self):
        self.store.submit(request(self.store, adopt()), Actor("user", "user-demo"))
        decision = next(o for o in self.store.get_state()["objects"] if o["type"] == "Decision" and o["decision_kind"] == "adopt_skeleton")
        t = self.turn(key="S", text="撤回采用，明天再看", kind="skeleton_choice", targets=["skeleton-a", decision["id"]]); p = self.packet(t)
        result = self.send(t, p, dict(op="withdraw_decision", id=decision["id"]))
        self.assertEqual(result["outcome"], "applied"); self.assertIsNone(self.store.get_state()["effective_skeleton_id"])
        self.assertEqual(index(self.store.get_state())[decision["id"]]["status"], "revoked")
        t2 = self.turn(key="S", relation="resume", text="接着昨天的方案", kind="skeleton_choice", targets=["skeleton-a", decision["id"]]); p2 = self.packet(t2)
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])
        self.assertNotIn(decision["id"], p2["context"]["active_decisions"])
        row = next(a for a in p2["annotations"] if a["id"] == decision["id"])
        self.assertIn("not_current_authorization", row["reason_codes"])


if __name__ == "__main__":
    unittest.main()
