"""Durable scene acceptance: actual SQLite files, fresh processes and forced exits."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dependency import BASE
from context_runtime.checkpoints import CheckpointRepository
from context_runtime.contracts import VERSION, validate
from context_runtime.runtime import Runtime, RuntimeFault, Principal, WriteGrant
from context_runtime.api import dispatch
from tripstate.engine import Store, Actor, digest
from tripstate.fixtures import initial_state, minimal_state, NOW, request, adopt
from tripstate.rules import index, stamp

ROOT = Path(__file__).resolve().parents[1]


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.path = self.folder / "scene.sqlite"
        self.now = NOW
        self.repo = CheckpointRepository(self.path)
        self.store = Store(initial_state(), clock=lambda: self.now)
        self.user = Principal("user-demo", (self.store.get_state()["trip_id"],))
        self.runtime = Runtime(self.store, self.repo)
        self.number = 0

    def event(self, key="E", relation="new", text="先看看", targets=None, progress="open", related=None):
        self.number += 1
        evidence = dict(start=0, end=len(text), quote=text)
        return dict(runtime_contract_version=VERSION, trip_id=self.store.get_state()["trip_id"], expected_revision=self.store.get_state()["revision"],
            event=dict(event_id="event-"+str(self.number), entry="comparison", text=text, reference="synthetic-"+str(self.number), received_at=stamp(self.now)),
            tasks=[dict(task_key=key, question=text, kind="explore", target_ids=targets or ["skeleton-a"], branch="actual", relation=relation,
                        related_task_keys=related or [], certainty="explicit", evidence=[evidence], progress=progress,
                        progress_evidence=evidence if progress != "open" else None)], focus_keys=[key])

    def opened(self, **kw):
        return self.runtime.open_turn(self.event(**kw), self.user)

    def scene(self, key="save-1", expected=None, drafts=None):
        objects = index(self.store.get_state())
        return dict(runtime_contract_version=VERSION, workspace_key="workspace",
            expected_checkpoint_revision=expected if expected is not None else self.runtime._checkpoint_revisions[self.user.id], idempotency_key=key,
            focus_keys=["E"], view=dict(entry="comparison", comparison_refs=[dict(id="skeleton-a", version=objects["skeleton-a"]["version"])],
                                     selected_id="skeleton-a", expanded_task_keys=["E"]), drafts=drafts or [])

    def draft(self):
        return dict(draft_id="six-night-draft", draft_kind="hypothetical", base_revision=self.store.get_state()["revision"],
                    target_ids=["constraint-nights"], text="如果六晚呢", source_reference="draft-input", proposal=None)

    def restore(self, runtime=None, principal=None):
        return (runtime or self.runtime).restore_scene(dict(runtime_contract_version=VERSION, workspace_key="workspace", body_budget_bytes=1000000), principal or self.user)

    def fresh(self):
        return Runtime(self.store, CheckpointRepository(self.path))

    def fault(self, code, call):
        with self.assertRaises(RuntimeFault) as caught:
            call()
        self.assertEqual(caught.exception.code, code)

    def child(self, code, *args):
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(ROOT), str(BASE))), PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run([sys.executable, "-B", "-c", code, *map(str, args)], env=env,
                              capture_output=True, text=True, timeout=20)

    def test_UX02_history_focus_and_shared_draft_recover_without_business_restore(self):
        self.opened()
        self.store.submit(request(self.store, adopt(), key="adopt-original"), Actor("user", self.user.id))
        from tripstate.fixtures import create_command
        replacement = deepcopy(index(self.store.get_state())["skeleton-a"])
        replacement.update(id="next-plan", parent_id="skeleton-a")
        replacement["stops"][0]["nights"] = 1
        self.store.submit(request(self.store, create_command(replacement), adopt("next-plan"), key="next"), Actor("user", self.user.id))
        draft = self.draft(); draft.update(draft_kind="unsubmitted", target_ids=["next-plan"], text="未提交编辑")
        body = self.scene(drafts=[draft]); body["view"]["entry"] = "map"
        self.runtime.save_scene(body, self.user)
        before, history = self.store.get_state(), self.store.get_history()
        restored = self.restore(self.fresh())
        self.assertEqual(restored["view"]["selected_id"], "skeleton-a")
        self.assertEqual(restored["drafts"], [draft])
        self.assertIn("historical_comparison_read_only_not_current_evidence", restored["warnings"])
        self.assertEqual(restored["packets"][0]["task"]["target_ids"], ["skeleton-a"])
        self.assertEqual(self.store.get_state(), before); self.assertEqual(self.store.get_history(), history)

    def test_UX02_hypothetical_draft_is_inert_and_new_targets_must_be_bound(self):
        self.opened(); draft = self.draft()
        proposal = request(self.store, adopt(), key="unsafe-draft", reason=draft["text"])
        proposal["input"]["reference"] = draft["source_reference"]
        draft["proposal"] = proposal
        before = self.store.get_state()
        self.runtime.save_scene(self.scene(drafts=[draft]), self.user)
        restored = self.restore(self.fresh())
        self.assertIn("hypothetical_draft_requires_new_actual_intent", restored["warnings"])
        self.assertEqual(self.store.get_state(), before)
        draft["draft_kind"] = "unsubmitted"; proposal["input"]["target_ids"] = ["skeleton-a"]
        self.fault("INPUT_BINDING", lambda: self.runtime.save_scene(self.scene(drafts=[draft]), self.user))
        restored = self.restore(self.fresh()); self.assertEqual(restored["drafts"][0]["draft_kind"], "hypothetical")

    def test_DC_R01_open_turn_auto_saves_and_fresh_instance_recovers_identity(self):
        turn = self.opened()
        self.assertTrue(turn["checkpoint_ack"]["durable"])
        recovered = self.restore(self.fresh())
        self.assertEqual(recovered["focus_keys"], ["E"])
        self.assertEqual(recovered["restored_turns"][0]["task_key"], "E")
        self.assertNotEqual(recovered["restored_turns"][0]["turn_id"], turn["turn_id"])
        self.assertTrue(recovered["recovery_requires_new_authorization"])

    def test_unresolved_ambiguous_input_recovers_as_read_only_unknown(self):
        body = self.event(text="把那个去掉")
        body["tasks"][0].update(target_ids=[], certainty="ambiguous", question="去掉的对象尚不明确")
        before = self.store.get_state()
        self.runtime.open_turn(body, self.user)
        restored = self.restore(self.fresh())
        packet = restored["packets"][0]
        self.assertEqual(packet["task"]["certainty"], "ambiguous")
        self.assertEqual(packet["task"]["target_ids"], [])
        self.assertEqual(packet["pending_input"]["event"]["text"], "把那个去掉")
        self.assertEqual(packet["pending_input"]["processing_status"], "unprocessed")
        self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.store.get_history()["changes"], [])

    def test_latest_task_event_recovers_without_inventing_earlier_interaction(self):
        first = self.event(text="阿斯旺太远，先别定")
        self.runtime.open_turn(first, self.user)
        latest = self.event(relation="continue", text="那个先不确定")
        latest["tasks"][0].update(certainty="ambiguous", target_ids=[], question="那个的对象仍未知")
        self.runtime.open_turn(latest, self.user)
        saved = self.repo.load(self.user.id, self.store.get_state()["trip_id"], "workspace", self.now)["payload"]
        self.assertEqual(len(saved["tasks"]), 1)
        self.assertEqual(saved["tasks"][0]["event"], latest["event"])
        self.assertNotIn(first["event"]["text"], json.dumps(saved, ensure_ascii=False))
        fresh = self.fresh()
        restored = self.restore(fresh)
        self.assertEqual(restored["packets"][0]["task"]["certainty"], "ambiguous")
        self.assertEqual(restored["packets"][0]["pending_input"]["event"], latest["event"])
        self.assertTrue(restored["recovery_requires_new_authorization"])
        self.assertEqual(self.store.get_history()["changes"], [])

    def test_bad_new_source_span_does_not_replace_last_saved_task(self):
        first = self.event(text="先比较两条路线")
        self.runtime.open_turn(first, self.user)
        bad = self.event(relation="continue", text="再看看阿斯旺")
        bad["tasks"][0]["evidence"][0]["quote"] = "没有说过的话"
        self.fault("SOURCE_SPAN", lambda: self.runtime.open_turn(bad, self.user))
        self.assertEqual(self.runtime._checkpoint_revisions[self.user.id], 1)
        restored = self.restore(self.fresh())
        self.assertEqual(restored["packets"][0]["pending_input"]["event"], first["event"])
        self.assertEqual(self.store.get_history()["changes"], [])

    def test_one_supplied_event_can_register_multiple_tasks_in_current_contract(self):
        body = self.event(text="比较阿斯旺，也看看交通")
        body["event"].update(event_id="HostEvent1", reference="host-interaction:HostEvent1")
        second = deepcopy(body["tasks"][0])
        second.update(task_key="Q", question="看看交通", kind="candidate_tradeoff")
        body["tasks"].append(second)
        body["focus_keys"] = ["E", "Q"]
        self.runtime.open_turn(body, self.user)
        saved = self.repo.load(self.user.id, self.store.get_state()["trip_id"], "workspace", self.now)["payload"]
        self.assertEqual({row["task"]["task_key"] for row in saved["tasks"]}, {"E", "Q"})
        self.assertTrue(all(row["event"] == body["event"] for row in saved["tasks"]))
        self.assertEqual(self.store.get_history()["changes"], [])

    def test_DC_R01_actual_new_process_restores_view_draft_and_tasks(self):
        self.opened()
        self.runtime.save_scene(self.scene(drafts=[self.draft()]), self.user)
        state = self.folder / "authority.json"; state.write_text(json.dumps(self.store.get_state()))
        child = self.child('''
import json,sys
from context_runtime.runtime import Runtime,Principal
from context_runtime.checkpoints import CheckpointRepository
from context_runtime.contracts import VERSION
from tripstate.engine import Store
from tripstate.fixtures import NOW
state=json.load(open(sys.argv[2]))
r=Runtime(Store(state,clock=lambda:NOW),CheckpointRepository(sys.argv[1]))
v=r.restore_scene(dict(runtime_contract_version=VERSION,workspace_key="workspace",body_budget_bytes=1000000),Principal("user-demo",(state["trip_id"],)))
print(json.dumps(v,ensure_ascii=False))
''', self.path, state)
        self.assertEqual(child.returncode, 0, child.stderr)
        result = json.loads(child.stdout)
        self.assertEqual(result["view"]["selected_id"], "skeleton-a")
        self.assertEqual(result["drafts"][0]["draft_id"], "six-night-draft")
        self.assertEqual(result["focus_keys"], ["E"])

    def test_DC_R02_revision_change_rebuilds_and_marks_stale_draft(self):
        self.opened(); self.runtime.save_scene(self.scene(drafts=[self.draft()]), self.user)
        self.store.submit(request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))), Actor("user", "user-demo"))
        result = self.restore(self.fresh())
        self.assertIn("six-night-draft", result["stale_draft_ids"])
        self.assertGreater(result["current_state_revision"], result["saved_state_revision"])
        packet = result["packets"][0]
        self.assertEqual(packet["context"]["state_revision"], self.store.get_state()["revision"])
        self.assertEqual(next(o for o in packet["objects"] if o["id"] == "constraint-nights")["value"]["maximum_nights"], 3)

    def test_DC_R02_expiry_without_state_change_rebuilds_fact_limits(self):
        self.opened(); revision = self.store.get_state()["revision"]
        self.now += timedelta(days=2)
        result = self.restore(self.fresh())
        self.assertEqual(self.store.get_state()["revision"], revision)
        self.assertIn("fact-cairo-luxor", result["packets"][0]["context"]["stale_fact_ids"])

    def test_DC_R03_structured_proposal_recovers_but_never_applies(self):
        self.opened(); before = self.store.get_state()
        draft = self.draft()
        proposal = request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=6))), reason=draft["text"])
        proposal["input"]["reference"] = draft["source_reference"]
        draft["proposal"] = proposal
        self.runtime.save_scene(self.scene(drafts=[draft]), self.user)
        restored = self.restore(self.fresh())
        self.assertEqual(restored["drafts"][0]["proposal"], proposal)
        self.assertEqual(self.store.get_state(), before)
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_DC_R04_withdrawal_after_save_does_not_restore_adoption(self):
        self.store.submit(request(self.store, adopt()), Actor("user", "user-demo"))
        self.opened(); self.runtime.save_scene(self.scene(), self.user)
        decision = next(o for o in self.store.get_state()["objects"] if o["type"] == "Decision" and o["decision_kind"] == "adopt_skeleton")
        self.store.submit(request(self.store, dict(op="withdraw_decision", id=decision["id"]), key="withdraw"), Actor("user", "user-demo"))
        result = self.restore(self.fresh())
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])
        self.assertNotIn(decision["id"], result["packets"][0]["context"]["active_decisions"])

    def test_DC_R05_two_instances_cannot_last_writer_win(self):
        self.opened(); second = self.fresh(); self.restore(second)
        first_body = self.scene(key="first", expected=1)
        second_body = self.scene(key="second", expected=1)
        second_body["view"]["selected_id"] = "candidate-aswan"
        self.runtime.save_scene(first_body, self.user)
        self.fault("CHECKPOINT_CONFLICT", lambda: second.save_scene(second_body, self.user))
        self.assertEqual(self.restore(self.fresh())["view"]["selected_id"], "skeleton-a")

    def test_DC_R05_two_concurrent_writers_exactly_one_acknowledged(self):
        self.opened(); second = self.fresh(); self.restore(second)
        bodies = [self.scene(key="writer-"+str(n), expected=1) for n in range(2)]
        def save(pair):
            rt, body = pair
            try: return rt.save_scene(body, self.user)["ack"]["checkpoint_revision"]
            except RuntimeFault as exc: return exc.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(save, [(self.runtime, bodies[0]), (second, bodies[1])]))
        self.assertEqual(outcomes.count(2), 1)
        self.assertEqual(outcomes.count("CHECKPOINT_CONFLICT"), 1)

    def test_DC_R05_other_account_and_revoked_access_cannot_read(self):
        self.opened()
        other = Principal("other-user", self.user.allowed_trip_ids)
        self.assertEqual(self.fresh().list_scenes(dict(runtime_contract_version=VERSION), other)["checkpoints"], [])
        self.fault("CHECKPOINT_NOT_FOUND", lambda: self.restore(self.fresh(), other))
        self.fault("ACCESS_DENIED", lambda: self.restore(self.fresh(), Principal(self.user.id, ("other-trip",))))

    def test_DC_R06_before_commit_failure_has_no_ack_or_partial_turn(self):
        self.repo.failpoint = lambda stage: (_ for _ in ()).throw(RuntimeError("injected")) if stage == "before_commit" else None
        with self.assertRaises(RuntimeError): self.opened()
        self.assertEqual(self.runtime.tasks, {})
        self.fault("CHECKPOINT_NOT_FOUND", lambda: self.repo.load(self.user.id, self.user.allowed_trip_ids[0], "workspace", self.now))

    def test_DC_R06_after_commit_lost_ack_exact_retry_returns_one_revision(self):
        body = self.event()
        self.repo.failpoint = lambda stage: (_ for _ in ()).throw(RuntimeError("lost-ack")) if stage == "after_commit" else None
        self.fault("CHECKPOINT_ACK_UNKNOWN", lambda: self.runtime.open_turn(body, self.user))
        self.repo.failpoint = None
        result = self.runtime.open_turn(body, self.user)
        self.assertEqual(result["checkpoint_ack"]["checkpoint_revision"], 1)
        self.assertEqual(self.repo.revision(self.user.id, self.user.allowed_trip_ids[0], "workspace"), 1)

    def test_DC_R06_killed_process_before_commit_preserves_previous_checkpoint(self):
        self._kill_case("before_commit", 1)

    def test_DC_R06_killed_process_after_commit_preserves_new_checkpoint(self):
        self._kill_case("after_commit", 2)

    def _kill_case(self, stage, expected):
        owner, trip = self.user.id, self.user.allowed_trip_ids[0]
        self.repo.save(owner, trip, "workspace", 0, "old", {"value": 1}, self.now)
        result = self.child('''
import sys,os,signal
from context_runtime.checkpoints import CheckpointRepository
from tripstate.fixtures import NOW
r=CheckpointRepository(sys.argv[1])
r.failpoint=lambda stage:os.kill(os.getpid(),signal.SIGKILL) if stage==sys.argv[2] else None
r.save("user-demo","trip-egypt-test","workspace",1,"crash",{"value":2},NOW)
''', self.path, stage)
        self.assertLess(result.returncode, 0, result.stderr)
        saved = CheckpointRepository(self.path).load(owner, trip, "workspace", self.now)
        self.assertEqual(saved["revision"], expected)
        self.assertEqual(saved["payload"]["value"], expected)
        if stage == "after_commit":
            ack = self.repo.save(owner, trip, "workspace", 1, "crash", {"value": 2}, self.now)
            self.assertEqual(ack["checkpoint_revision"], 2)

    def test_DC_R07_dismissed_and_paused_state_survive_without_auto_reopen(self):
        self.store.submit(request(self.store, dict(op="dismiss_issue", id="issue-cost", reason="先不考虑")), Actor("user", self.user.id))
        self.opened(progress="paused", text="这个先暂停")
        result = self.restore(self.fresh())
        self.assertIn("issue-cost", result["deferred_issue_ids"])
        row = next(a for a in result["packets"][0]["annotations"] if a["id"] == "issue-cost")
        self.assertEqual(row["presentation"], "suppressed_unchanged")
        self.assertEqual(result["packets"][0]["task"]["progress"], "paused")
        self.assertEqual(result["reopened_issue_ids"], [])

    def test_DC_R07_current_reopened_issue_overrides_saved_dismissal(self):
        self.store.submit(request(self.store, dict(op="dismiss_issue", id="issue-cost", reason="先不考虑")), Actor("user", self.user.id))
        self.opened()
        self.store.submit(request(self.store, dict(op="transition", id="issue-cost", event="reopen"), key="reopen"), Actor("system", "system"))
        result = self.restore(self.fresh())
        self.assertIn("issue-cost", result["reopened_issue_ids"])
        self.assertNotIn("issue-cost", result["deferred_issue_ids"])

    def test_recovered_turn_cannot_submit_or_confirm_old_operations(self):
        self.opened(); fresh = self.fresh(); result = self.restore(fresh)
        turn = result["restored_turns"][0]["turn_id"]; packet = result["packets"][0]
        r = request(self.store, adopt())
        body = dict(runtime_contract_version=VERSION, turn_id=turn, packet_id=packet["packet_id"], request=r)
        self.fault("RESTORED_INPUT_READ_ONLY", lambda: fresh.submit_change(body, self.user))
        confirmation = dict(runtime_contract_version=VERSION, turn_id=turn, proposal_id="old-proposal", request=dict(expected_revision=0, proposal_digest="a"*64, idempotency_key="old-key", accept=True))
        self.fault("RESTORED_INPUT_READ_ONLY", lambda: fresh.confirm(confirmation, self.user))

    def test_old_event_and_other_runtime_grant_cannot_be_replayed(self):
        original = self.event(); self.runtime.open_turn(original, self.user)
        fresh = self.fresh(); self.restore(fresh)
        self.fault("RECOVERED_EVENT_REPLAY", lambda: fresh.open_turn(original, self.user))
        body = self.event(relation="continue", text="现在明确采用")
        turn = fresh.open_turn(body, self.user)
        packet = fresh.assemble(dict(runtime_contract_version=VERSION, turn_id=turn["turn_id"], task_key="E", body_budget_bytes=1000000), self.user)
        r = request(self.store, adopt(), reason=body["event"]["text"]); r["input"]["reference"] = body["event"]["reference"]
        write = dict(runtime_contract_version=VERSION, turn_id=turn["turn_id"], packet_id=packet["packet_id"], request=r)
        old = WriteGrant(self.user.id, body["event"]["event_id"], digest(r), r["expected_revision"], stamp(self.now+timedelta(minutes=5)), self.runtime.instance_id)
        self.fault("WRITE_GRANT", lambda: fresh.submit_change(write, self.user, old))
        current = WriteGrant(old.principal_id, old.event_id, old.request_digest, old.revision, old.expires_at, fresh.instance_id)
        self.assertEqual(fresh.submit_change(write, self.user, current)["outcome"], "applied")

    def test_same_process_restore_rotates_authorization_generation(self):
        self.opened()
        previous = self.runtime.instance_id
        self.restore(self.runtime)
        self.assertNotEqual(previous, self.runtime.instance_id)
        body = self.event(relation="continue", text="现在明确采用")
        turn = self.runtime.open_turn(body, self.user)
        packet = self.runtime.assemble(dict(runtime_contract_version=VERSION, turn_id=turn["turn_id"], task_key="E", body_budget_bytes=1000000), self.user)
        r = request(self.store, adopt(), reason=body["event"]["text"])
        r["input"]["reference"] = body["event"]["reference"]
        write = dict(runtime_contract_version=VERSION, turn_id=turn["turn_id"], packet_id=packet["packet_id"], request=r)
        old = WriteGrant(self.user.id, body["event"]["event_id"], digest(r), r["expected_revision"], stamp(self.now+timedelta(minutes=5)), previous)
        self.fault("WRITE_GRANT", lambda: self.runtime.submit_change(write, self.user, old))

    def test_related_exploration_comparison_and_adoption_tasks_survive_focus_switch(self):
        self.opened(key="E", text="先探索城市")
        comparison = self.event(key="Q", relation="refine", text="比较两座城市", related=["E"])
        comparison["tasks"][0]["kind"] = "candidate_tradeoff"
        self.runtime.open_turn(comparison, self.user)
        adoption = self.event(key="S", relation="refine", text="看看如何采用骨架", related=["Q"])
        adoption["tasks"][0]["kind"] = "skeleton_choice"
        self.runtime.open_turn(adoption, self.user)
        fresh = self.fresh()
        restored = self.restore(fresh)
        self.assertEqual(restored["focus_keys"], ["S"])
        self.assertEqual({key for owner, key in fresh.tasks}, {"E", "Q", "S"})
        self.assertEqual(fresh.tasks[(self.user.id, "Q")]["related_task_keys"], ["E"])
        self.assertEqual(fresh.tasks[(self.user.id, "S")]["related_task_keys"], ["Q"])
        self.assertTrue(all(task["progress"] == "open" for task in fresh.tasks.values()))
        self.assertIsNone(self.store.get_state()["effective_skeleton_id"])

    def test_exported_recovery_example_validates_current_machine_contracts(self):
        sample = json.loads((ROOT / "examples/recovery.json").read_text())
        for schema, field in (("open-turn", "open_turn"), ("turn", "turn"), ("scene-save", "scene_save"),
                              ("scene-ack", "scene_ack"), ("scene-restore", "scene_restore"), ("scene-restored", "scene_restored")):
            validate(schema, sample[field])

    def test_resume_next_input_auto_loads_task_identity(self):
        self.opened(); fresh = self.fresh()
        body = self.event(relation="continue", text="继续原来的比较")
        result = fresh.open_turn(body, self.user)
        self.assertEqual(result["tasks"][0]["task_key"], "E")
        self.assertEqual(result["checkpoint_ack"]["checkpoint_revision"], 2)

    def test_delete_scrubs_payload_and_old_save_cannot_resurrect(self):
        self.opened(); body = self.scene(); self.runtime.save_scene(body, self.user)
        deletion = dict(runtime_contract_version=VERSION, workspace_key="workspace", expected_checkpoint_revision=2, idempotency_key="delete")
        self.runtime.delete_scene(deletion, self.user)
        self.fault("CHECKPOINT_NOT_FOUND", lambda: self.restore(self.fresh()))
        with closing(sqlite3.connect(self.path)) as db:
            self.assertIsNone(db.execute("SELECT payload FROM checkpoints").fetchone()[0])
        self.fault("CHECKPOINT_CONFLICT", lambda: self.runtime.save_scene(body, self.user))

    def test_checkpoint_version_and_digest_tampering_are_rejected(self):
        self.opened()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE checkpoints SET payload='{}'"); db.commit()
        self.fault("CHECKPOINT_CORRUPT", lambda: self.restore(self.fresh()))

    def test_unsupported_database_version_is_not_downgraded(self):
        other = self.folder / "future.sqlite"
        with closing(sqlite3.connect(other)) as db:
            db.execute("PRAGMA user_version=99"); db.commit()
        self.fault("CHECKPOINT_DB_VERSION", lambda: CheckpointRepository(other))

    def test_explicit_retention_expiry_does_not_pretend_recovery(self):
        self.runtime = Runtime(self.store, CheckpointRepository(self.path, retention_seconds=10))
        self.opened(); self.now += timedelta(seconds=10)
        self.fault("CHECKPOINT_EXPIRED", lambda: self.restore(self.fresh()))

    def test_forged_owner_or_actor_in_scene_request_is_rejected(self):
        self.opened(); body = self.scene(); body["owner"] = "another-user"
        self.fault("CONTRACT_INVALID", lambda: self.runtime.save_scene(body, self.user))

    def test_snapshot_does_not_contain_business_values_or_grants(self):
        self.opened()
        saved = self.repo.load(self.user.id, self.user.allowed_trip_ids[0], "workspace", self.now)
        payload = saved["payload"]
        self.assertNotIn("objects", payload)
        self.assertNotIn("effective_skeleton_id", payload)
        self.assertNotIn("proposal_id", payload["tasks"][0])
        self.assertNotIn("grant", json.dumps(payload))
        validate("checkpoint-payload", payload)

    def test_scene_save_status_and_retry_are_explicit(self):
        self.opened(); body = self.scene()
        self.repo.failpoint = lambda stage: (_ for _ in ()).throw(RuntimeError("network")) if stage == "after_commit" else None
        self.fault("CHECKPOINT_ACK_UNKNOWN", lambda: self.runtime.save_scene(body, self.user))
        status = self.runtime.scene_status(dict(runtime_contract_version=VERSION), self.user)
        self.assertTrue(status["save_pending"])
        self.repo.failpoint = None
        ack = self.runtime.retry_scene(dict(runtime_contract_version=VERSION), self.user)
        self.assertEqual(ack["ack"]["checkpoint_revision"], 2)
        self.assertFalse(self.runtime.scene_status(dict(runtime_contract_version=VERSION), self.user)["save_pending"])

    def test_missing_target_is_preserved_as_history_not_fabricated(self):
        self.opened(); state = initial_state(); state["revision"] = 1
        state["objects"] = [o for o in state["objects"] if o["id"] != "skeleton-a"]
        state["objects"] = [o for o in state["objects"] if o["id"] != "issue-cost"]
        fresh = Runtime(Store(state, clock=lambda:self.now), CheckpointRepository(self.path))
        result = self.restore(fresh)
        self.assertIn("skeleton-a", result["missing_target_ids"])
        self.assertEqual(result["packets"], [])

    def test_authoritative_state_cannot_be_older_than_checkpoint(self):
        self.store.submit(request(self.store, dict(op="recalculate", id="skeleton-a")), Actor("system", "system"))
        self.opened()
        fresh = Runtime(Store(initial_state(), clock=lambda:self.now), CheckpointRepository(self.path))
        self.fault("STATE_BEHIND_CHECKPOINT", lambda: self.restore(fresh))

    def test_all_checkpoint_endpoints_and_absent_backend(self):
        prefix = "/runtime/trips/"+self.user.allowed_trip_ids[0]+"/checkpoints/"
        plain = Runtime(self.store)
        self.assertEqual(dispatch(plain, "POST", prefix+"restore", dict(runtime_contract_version=VERSION, workspace_key="workspace", body_budget_bytes=2), self.user)[0], 503)
        self.opened()
        code, result = dispatch(self.runtime, "POST", prefix+"restore", dict(runtime_contract_version=VERSION, workspace_key="workspace", body_budget_bytes=2), self.user)
        self.assertEqual(code, 200); validate("scene-restored", result)
        code, result = dispatch(self.runtime, "POST", prefix+"list", dict(runtime_contract_version=VERSION), self.user)
        self.assertEqual(code, 200); self.assertTrue(result["checkpoints"])

    def test_business_commit_checkpoint_failure_is_reported_separately(self):
        opened = self.opened(text="按当前范围采用")
        packet = self.runtime.assemble(dict(runtime_contract_version=VERSION, turn_id=opened["turn_id"], task_key="E", body_budget_bytes=1000000), self.user)
        event = self.runtime.turns[opened["turn_id"]]["pending"]["event"]
        r = request(self.store, adopt(), reason=event["text"]); r["input"]["reference"] = event["reference"]
        grant = WriteGrant(self.user.id, event["event_id"], digest(r), r["expected_revision"], stamp(self.now+timedelta(minutes=5)), self.runtime.instance_id)
        self.repo.failpoint = lambda stage: (_ for _ in ()).throw(RuntimeError("disk")) if stage == "before_commit" else None
        result = self.runtime.submit_change(dict(runtime_contract_version=VERSION, turn_id=opened["turn_id"], packet_id=packet["packet_id"], request=r), self.user, grant)
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual(self.store.get_state()["effective_skeleton_id"], "skeleton-a")
        self.assertTrue(self.runtime.scene_status(dict(runtime_contract_version=VERSION), self.user)["save_pending"])
        self.repo.failpoint = None
        self.runtime.retry_scene(dict(runtime_contract_version=VERSION), self.user)
        saved = self.repo.load(self.user.id, self.user.allowed_trip_ids[0], "workspace", self.now)
        self.assertEqual(saved["payload"]["tasks"][0]["processing_status"], "applied")

    def test_result_status_automatically_saved_without_another_user_confirmation(self):
        opened = self.opened(text="预算改成一万元")
        packet = self.runtime.assemble(dict(runtime_contract_version=VERSION, turn_id=opened["turn_id"], task_key="E", body_budget_bytes=1000000), self.user)
        event = self.runtime.turns[opened["turn_id"]]["pending"]["event"]
        value = deepcopy(index(self.store.get_state())["constraint-budget"]["value"]); value["maximum_minor"] = 1000000
        r = request(self.store, dict(op="revise", object_type="Constraint", id="constraint-budget", changes=dict(value=value)), reason=event["text"])
        r["input"]["reference"] = event["reference"]
        result = self.runtime.submit_change(dict(runtime_contract_version=VERSION, turn_id=opened["turn_id"], packet_id=packet["packet_id"], request=r), self.user,
            WriteGrant(self.user.id, event["event_id"], digest(r), r["expected_revision"], stamp(self.now+timedelta(minutes=5)), self.runtime.instance_id))
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual(self.restore(self.fresh())["packets"][0]["pending_input"]["processing_status"], "applied")

    def test_delete_lost_ack_can_be_retried_without_resurrection(self):
        self.opened()
        body = dict(runtime_contract_version=VERSION, workspace_key="workspace", expected_checkpoint_revision=1, idempotency_key="delete-ack")
        self.repo.failpoint = lambda stage: (_ for _ in ()).throw(RuntimeError("lost")) if stage == "after_commit" else None
        self.fault("CHECKPOINT_ACK_UNKNOWN", lambda: self.runtime.delete_scene(body, self.user))
        self.repo.failpoint = None
        self.assertTrue(self.runtime.delete_scene(body, self.user)["ack"]["deleted"])
        self.fault("CHECKPOINT_NOT_FOUND", lambda: self.restore(self.fresh()))

    def test_same_save_key_different_draft_is_rejected(self):
        self.opened(); body = self.scene(); self.runtime.save_scene(body, self.user)
        body["drafts"] = [self.draft()]
        self.fault("CHECKPOINT_IDEMPOTENCY", lambda: self.runtime.save_scene(body, self.user))

    def test_old_success_ack_is_not_reported_as_latest_after_new_save(self):
        self.opened(); original = self.scene(); self.runtime.save_scene(original, self.user)
        self.runtime.save_scene(self.scene(key="newer", drafts=[self.draft()]), self.user)
        self.fault("CHECKPOINT_SUPERSEDED", lambda: self.runtime.save_scene(original, self.user))

    def test_runtime_01_current_contract_accepts_recovery_fields(self):
        body = self.event(); body["runtime_contract_version"] = "0.1.0"
        result = self.runtime.open_turn(body, self.user)
        self.assertEqual(result["checkpoint_ack"]["durable"], True)

    def test_incompatible_payload_format_is_not_guessed(self):
        self.opened(); row = self.repo.load(self.user.id, self.user.allowed_trip_ids[0], "workspace", self.now)
        payload = row["payload"]; payload["checkpoint_format_version"] = 99
        self.repo.save(self.user.id, self.user.allowed_trip_ids[0], "workspace", 1, "future", payload, self.now)
        self.fault("CONTRACT_INVALID", lambda: self.restore(self.fresh()))

    def test_oversize_checkpoint_is_not_truncated_or_acknowledged(self):
        body = self.event(text="长"*16000)
        body["tasks"] = [{**deepcopy(body["tasks"][0]), "task_key":"large-"+str(n)} for n in range(70)]
        body["focus_keys"] = ["large-0"]
        self.fault("CHECKPOINT_TOO_LARGE", lambda: self.runtime.open_turn(body, self.user))
        self.assertEqual(self.runtime.tasks, {})
        self.assertEqual(self.repo.revision(self.user.id, self.user.allowed_trip_ids[0], "workspace"), 0)

    def test_wrong_workspace_cannot_be_implicitly_switched(self):
        self.opened(); body = self.scene(); body["workspace_key"] = "other-workspace"
        self.fault("WORKSPACE_MISMATCH", lambda: self.runtime.save_scene(body, self.user))

    def test_saved_view_versions_are_preserved_and_flagged_when_changed(self):
        self.opened(); self.runtime.save_scene(self.scene(), self.user)
        self.store.submit(request(self.store, dict(op="revise", object_type="Constraint", id="constraint-nights", changes=dict(value=dict(kind="duration", maximum_nights=3)))), Actor("user", self.user.id))
        result = self.restore(self.fresh())
        self.assertEqual(result["view"]["comparison_refs"][0]["version"], 1)
        self.assertIn("skeleton-a", result["stale_comparison_ids"])

    def test_database_file_permissions_are_private_on_tested_platform(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_DC_R05_actual_processes_use_shared_cas_not_python_locks(self):
        self.opened()
        payload = self.repo.load(self.user.id, self.user.allowed_trip_ids[0], "workspace", self.now)["payload"]
        source = self.folder / "payload.json"; source.write_text(json.dumps(payload))
        gate = self.folder / "go"
        code = '''
import json,sys,time
from pathlib import Path
from context_runtime.checkpoints import CheckpointRepository
from context_runtime.errors import RuntimeFault
from tripstate.fixtures import NOW
r=CheckpointRepository(sys.argv[1]); payload=json.load(open(sys.argv[2]))
while not Path(sys.argv[3]).exists(): time.sleep(.01)
try: print(r.save("user-demo","trip-egypt-test","workspace",1,sys.argv[4],payload,NOW)["checkpoint_revision"])
except RuntimeFault as e: print(e.code)
'''
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(ROOT), str(BASE))), PYTHONDONTWRITEBYTECODE="1")
        children = [subprocess.Popen([sys.executable, "-B", "-c", code, str(self.path), str(source), str(gate), "process-"+str(n)],
                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for n in range(2)]
        try:
            gate.touch()
            outputs = [p.communicate(timeout=20) for p in children]
            self.assertTrue(all(p.returncode == 0 for p in children), outputs)
            self.assertEqual(sorted(o[0].strip() for o in outputs), ["2", "CHECKPOINT_CONFLICT"])
        finally:
            for child in children:
                if child.poll() is None: child.kill(); child.wait()


if __name__ == "__main__": unittest.main()
