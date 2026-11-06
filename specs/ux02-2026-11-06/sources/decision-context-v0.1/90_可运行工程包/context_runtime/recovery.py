"""Runtime scene capture and read-only recovery; business writes are never replayed."""
from copy import deepcopy
from uuid import uuid4
from tripstate.rules import index
from .contracts import VERSION
from .errors import RuntimeFault, check


class RecoveryMixin:
    def _backend(self):
        check(self.checkpoints is not None, "RECOVERY_UNAVAILABLE", "未配置持久检查点，不可声称首版精确恢复可用")

    def _workspace(self, body):
        check(body["workspace_key"] == self.workspace_key, "WORKSPACE_MISMATCH", "宿主运行实例绑定的工作区不匹配")

    def _ensure_scene(self, principal):
        if self.checkpoints is None or principal.id in self._scene_loaded:
            return
        trip = self._access(principal)
        try:
            saved = self.checkpoints.load(principal.id, trip, self.workspace_key, self.store.clock())
        except RuntimeFault as exc:
            if exc.code != "CHECKPOINT_NOT_FOUND":
                raise
            self._checkpoint_revisions[principal.id] = self.checkpoints.revision(principal.id, trip, self.workspace_key)
            self._scene_loaded.add(principal.id)
            return
        self._install_scene(saved, principal)

    def _validate_scene(self, payload, principal):
        self._shape("checkpoint-payload", payload)
        state = self.store.get_state()
        check(payload["trip_id"] == self._access(principal), "TRIP_MISMATCH", "检查点不属于当前旅行")
        check(payload["captured_state_revision"] <= state["revision"], "STATE_BEHIND_CHECKPOINT", "权威状态版本落后于保存点；不得从检查点倒造业务状态", True)
        keys = [item["task"]["task_key"] for item in payload["tasks"]]
        check(len(keys) == len(set(keys)) and set(payload["focus_keys"]) <= set(keys), "CHECKPOINT_CORRUPT", "检查点任务/焦点引用不一致")
        for item in payload["tasks"]:
            task = item["task"]
            check(set(task["related_task_keys"]) <= set(keys) and task["task_key"] not in task["related_task_keys"],
                  "CHECKPOINT_CORRUPT", "检查点问题关系不一致")
            check(item["base_revision"] <= payload["captured_state_revision"] and item["result_revision"] <= payload["captured_state_revision"],
                  "CHECKPOINT_CORRUPT", "检查点来源版本来自未来")
            for span in task["evidence"]:
                self._span(span, item["event"]["text"])
            if task["progress"] != "open":
                check(task["certainty"] == "explicit" and task["progress_evidence"] is not None,
                      "CHECKPOINT_CORRUPT", "暂停/完成来源缺失")
            if task["progress_evidence"]:
                self._span(task["progress_evidence"], item["event"]["text"])
        check(set(payload["view"]["expanded_task_keys"]) <= set(keys), "SCENE_REFERENCES", "展开焦点引用未知任务")
        draft_ids = [d["draft_id"] for d in payload["drafts"]]
        check(len(draft_ids) == len(set(draft_ids)), "SCENE_REFERENCES", "草稿 ID 不唯一")
        for draft in payload["drafts"]:
            check(draft["base_revision"] <= payload["captured_state_revision"], "SCENE_REFERENCES", "草稿基准版本来自未来")
            if draft["proposal"] is not None:
                proposal = draft["proposal"]
                check(proposal["expected_revision"] == draft["base_revision"] and proposal["input"]["text"] == draft["text"] and
                      proposal["input"]["reference"] == draft["source_reference"], "INPUT_BINDING", "草稿结构与原话/版本必须一致")

    def _scene_payload(self, principal, focus, view, drafts):
        state = self.store.get_state()
        objects = index(state)
        task_rows = []
        for (owner, key), task in sorted(self.tasks.items()):
            if owner != principal.id:
                continue
            source = next((turn for turn in reversed(list(self.turns.values())) if turn["owner"] == owner and
                           any(t["task_key"] == key for t in turn["body"]["tasks"])), None)
            check(source is not None, "SCENE_REFERENCES", "任务原始输入不可定位")
            pending = source["pending"]
            task_rows.append(dict(task=deepcopy(task), event=deepcopy(pending["event"]), base_revision=pending["base_revision"],
                                  processing_status=pending["processing_status"], result_revision=pending["result_revision"], errors=deepcopy(pending["errors"])))
        payload = dict(checkpoint_format_version=1, trip_id=state["trip_id"], captured_state_revision=state["revision"],
            captured_object_versions=[dict(id=o["id"], version=o["version"]) for o in sorted(objects.values(), key=lambda o: o["id"])],
            tasks=task_rows, focus_keys=deepcopy(focus), view=deepcopy(view), drafts=deepcopy(drafts),
            deferred_issue_ids=sorted(o["id"] for o in objects.values() if o["type"] == "OpenIssue" and o["status"] == "dismissed"))
        self._validate_scene(payload, principal)
        # Historical references may remain after later state changes; never claim them as current.
        return payload

    def _write_scene(self, payload, expected_revision, key, principal):
        from .runtime import size
        check(size(payload) <= 2000000, "CHECKPOINT_TOO_LARGE", "检查点超过 2MB 参考上限，未保存；不能截断")
        try:
            ack = self.checkpoints.save(principal.id, self._access(principal), self.workspace_key, expected_revision,
                                        key, payload, self.store.clock())
        except Exception as exc:
            self._pending_checkpoint_writes[principal.id] = (deepcopy(payload), expected_revision, key)
            self._scene_errors[principal.id] = exc.code if isinstance(exc, RuntimeFault) else "CHECKPOINT_STORAGE"
            raise
        self._shape("scene-ack", dict(runtime_contract_version=VERSION, ack=ack))
        self._checkpoint_revisions[principal.id] = ack["checkpoint_revision"]
        self._scene_views[principal.id] = deepcopy(payload["view"])
        self._scene_drafts[principal.id] = deepcopy(payload["drafts"])
        self._scene_focus[principal.id] = deepcopy(payload["focus_keys"])
        self._pending_checkpoint_writes.pop(principal.id, None)
        self._scene_errors.pop(principal.id, None)
        return ack

    def _after_business_result(self, turn_id, principal):
        if self.checkpoints is None:
            return
        turn = self.turns[turn_id]
        pending = turn["pending"]
        try:
            payload = self._scene_payload(principal, self._scene_focus.get(principal.id, turn["body"]["focus_keys"]),
                self._scene_views.get(principal.id, dict(entry="dialogue", comparison_refs=[], selected_id=None, expanded_task_keys=[])),
                self._scene_drafts.get(principal.id, []))
            key = "result-" + turn_id + "-" + pending["processing_status"] + "-" + str(pending["result_revision"])
            self._write_scene(payload, self._checkpoint_revisions.get(principal.id, 0), key, principal)
        except Exception as exc:
            # Business commit is already authoritative. Never turn this into a false business rejection.
            # scene-status/packet warnings explicitly report the unacknowledged scene save.
            self._scene_errors[principal.id] = exc.code if isinstance(exc, RuntimeFault) else "CHECKPOINT_STORAGE"

    def _autosave_turn(self, turn_id, principal):
        if self.checkpoints is None:
            return None
        turn = self.turns[turn_id]
        view = deepcopy(self._scene_views.get(principal.id, dict(entry="dialogue", comparison_refs=[], selected_id=None, expanded_task_keys=[])))
        view["entry"] = turn["body"]["event"]["entry"]
        payload = self._scene_payload(principal, turn["body"]["focus_keys"], view, self._scene_drafts.get(principal.id, []))
        return self._write_scene(payload, self._checkpoint_revisions.get(principal.id, 0), "auto-"+turn["body"]["event"]["event_id"], principal)

    def save_scene(self, body, principal):
        with self._lock:
            self._access(principal); self._shape("scene-save", body); self._backend(); self._workspace(body)
            self._ensure_scene(principal)
            head = next((row for row in self.checkpoints.list(principal.id, self._access(principal), self.store.clock())
                         if row["workspace_key"] == self.workspace_key), None)
            if head and not head["available"] and body["expected_checkpoint_revision"] != head["checkpoint_revision"]:
                raise RuntimeFault("CHECKPOINT_CONFLICT", "旧请求不能复活已删除/到期的现场", True)
            objects = index(self.store.get_state())
            # New UI targets must exist. Already-saved historical/draft references can be retained exactly.
            old_view = self._scene_views.get(principal.id)
            if body["view"] != old_view:
                for reference in body["view"]["comparison_refs"]:
                    check(reference["id"] in objects and reference["version"] <= objects[reference["id"]]["version"],
                          "SCENE_REFERENCES", "比较对象/版本不可解析")
                check(body["view"]["selected_id"] is None or body["view"]["selected_id"] in objects,
                      "SCENE_REFERENCES", "选中对象不可解析")
            old_drafts = {d["draft_id"]: d for d in self._scene_drafts.get(principal.id, [])}
            for draft in body["drafts"]:
                if old_drafts.get(draft["draft_id"]) != draft:
                    check(set(draft["target_ids"]) <= objects.keys(), "SCENE_REFERENCES", "新草稿目标不存在")
                    if draft["proposal"] is not None:
                        check(set(draft["proposal"]["input"]["target_ids"]) <= set(draft["target_ids"]),
                              "INPUT_BINDING", "新草稿须保留结构化提案引用的所有输入目标")
            payload = self._scene_payload(principal, body["focus_keys"], body["view"], body["drafts"])
            ack = self._write_scene(payload, body["expected_checkpoint_revision"], body["idempotency_key"], principal)
            return dict(runtime_contract_version=VERSION, ack=ack)

    def _install_scene(self, saved, principal):
        payload = saved["payload"]
        self._validate_scene(payload, principal)
        self.instance_id = "runtime-"+uuid4().hex  # new authorization generation, even within the same process
        # No packets, delivered receipts, Grants, pending proposal tokens or write cache are restored.
        self.tasks = {key: value for key, value in self.tasks.items() if key[0] != principal.id}
        self.turns = {key: value for key, value in self.turns.items() if value["owner"] != principal.id}
        self.packets = {key: value for key, value in self.packets.items() if value["owner"] != principal.id}
        self.event_cache = {key: value for key, value in self.event_cache.items() if key[0] != principal.id}
        self.write_cache = {key: value for key, value in self.write_cache.items() if key[0] != principal.id}
        restored = []
        for item in payload["tasks"]:
            task = deepcopy(item["task"])
            self.tasks[(principal.id, task["task_key"])] = task
            turn_id = "turn-"+uuid4().hex
            self.turns[turn_id] = dict(owner=principal.id, recovered=True,
                body=dict(runtime_contract_version=VERSION, trip_id=payload["trip_id"], expected_revision=item["base_revision"],
                          event=deepcopy(item["event"]), tasks=[task], focus_keys=[task["task_key"]]),
                pending=dict(event=deepcopy(item["event"]), base_revision=item["base_revision"], processing_status=item["processing_status"],
                             proposal_id=None, result_revision=item["result_revision"], errors=deepcopy(item["errors"])))
            self._recovered_event_ids.add((principal.id, item["event"]["event_id"]))
            restored.append(dict(task_key=task["task_key"], turn_id=turn_id))
        self._scene_views[principal.id] = deepcopy(payload["view"])
        self._scene_drafts[principal.id] = deepcopy(payload["drafts"])
        self._scene_focus[principal.id] = deepcopy(payload["focus_keys"])
        self._checkpoint_revisions[principal.id] = saved["revision"]
        self._scene_loaded.add(principal.id)
        return restored

    def restore_scene(self, body, principal):
        with self._lock:
            trip = self._access(principal); self._shape("scene-restore", body); self._backend(); self._workspace(body)
            saved = self.checkpoints.load(principal.id, trip, self.workspace_key, self.store.clock())
            restored = self._install_scene(saved, principal)
            state = self.store.get_state(); objects = index(state); payload = saved["payload"]
            missing = set()
            for row in payload["tasks"]:
                missing.update(set(row["task"]["target_ids"])-objects.keys())
            for draft in payload["drafts"]:
                missing.update(set(draft["target_ids"])-objects.keys())
            references = payload["view"]["comparison_refs"]
            missing.update(ref["id"] for ref in references if ref["id"] not in objects)
            if payload["view"]["selected_id"] is not None and payload["view"]["selected_id"] not in objects:
                missing.add(payload["view"]["selected_id"])
            stale_comparisons = sorted({r["id"] for r in references if r["id"] not in objects or objects[r["id"]]["version"] != r["version"]})
            packets = []
            for row in restored:
                if row["task_key"] not in payload["focus_keys"]:
                    continue
                task = self.tasks[(principal.id, row["task_key"])]
                if set(task["target_ids"]) <= objects.keys():
                    packets.append(self.assemble(dict(runtime_contract_version=VERSION, turn_id=row["turn_id"],
                        task_key=row["task_key"], body_budget_bytes=body["body_budget_bytes"]), principal))
            # Verify no state transition crossed the entire restore response. Retry is explicit.
            check(self.store.get_state()["revision"] == state["revision"], "REVISION_CHANGED", "恢复期间状态变化，请重新恢复/组装", True)
            for packet in packets:
                self._current(self.packets[packet["packet_id"]])
            deferred = sorted(o["id"] for o in objects.values() if o["type"] == "OpenIssue" and o["status"] == "dismissed")
            reopened = sorted(oid for oid in payload["deferred_issue_ids"] if oid in objects and objects[oid]["status"] not in ("dismissed", "resolved"))
            warnings = ["restored_scene_not_old_authorization", "drafts_read_only_no_automatic_submission"]
            if state["revision"] != payload["captured_state_revision"]:
                warnings.append("state_changed_rebuilt_from_current_authority")
            if missing: warnings.append("missing_references_preserved_for_review")
            if stale_comparisons: warnings.append("comparison_versions_changed")
            if any(objects.get(r["id"], {}).get("type") == "Skeleton" and
                   r["id"] != state["effective_skeleton_id"] and
                   objects[r["id"]].get("status") in ("superseded", "archived") for r in references):
                warnings.append("historical_comparison_read_only_not_current_evidence")
            if any(p["context"]["stale_fact_ids"] for p in packets): warnings.append("evidence_expired_or_unusable")
            if reopened: warnings.append("deferred_issues_reopened_by_current_state")
            if any(d["draft_kind"] == "hypothetical" for d in payload["drafts"]):
                warnings.append("hypothetical_draft_requires_new_actual_intent")
            if any(d["proposal"] is not None and not set(d["proposal"]["input"]["target_ids"]) <= set(d["target_ids"])
                   for d in payload["drafts"]):
                warnings.append("legacy_draft_target_binding_requires_review")
            result = dict(runtime_contract_version=VERSION, runtime_id=self.instance_id, workspace_key=self.workspace_key,
                checkpoint_revision=saved["revision"], saved_state_revision=payload["captured_state_revision"],
                current_state_revision=state["revision"], saved_at=saved["saved_at"], view=deepcopy(payload["view"]),
                drafts=deepcopy(payload["drafts"]), focus_keys=deepcopy(payload["focus_keys"]), restored_turns=restored,
                packets=packets, warnings=warnings, stale_draft_ids=sorted(d["draft_id"] for d in payload["drafts"] if d["base_revision"] != state["revision"]),
                missing_target_ids=sorted(missing), stale_comparison_ids=stale_comparisons,
                deferred_issue_ids=deferred, reopened_issue_ids=reopened, recovery_requires_new_authorization=True)
            self._shape("scene-restored", result)
            return result

    def delete_scene(self, body, principal):
        with self._lock:
            trip = self._access(principal); self._shape("scene-delete", body); self._backend(); self._workspace(body)
            ack = self.checkpoints.delete(principal.id, trip, self.workspace_key, body["expected_checkpoint_revision"], body["idempotency_key"], self.store.clock())
            # Do not silently republish the deleted scene from this instance.
            self.tasks = {key: value for key, value in self.tasks.items() if key[0] != principal.id}
            for collection in (self.turns, self.packets):
                for key in [key for key, value in collection.items() if value["owner"] == principal.id]: del collection[key]
            self.event_cache = {key: value for key, value in self.event_cache.items() if key[0] != principal.id}
            self.write_cache = {key: value for key, value in self.write_cache.items() if key[0] != principal.id}
            for mapping in (self._scene_views, self._scene_drafts, self._scene_focus): mapping.pop(principal.id, None)
            self._checkpoint_revisions[principal.id] = ack["checkpoint_revision"]
            self._scene_loaded.add(principal.id)
            self._pending_checkpoint_writes.pop(principal.id, None)
            self._scene_errors.pop(principal.id, None)
            return dict(runtime_contract_version=VERSION, ack=ack)

    def scene_status(self, body, principal):
        self._shape("scene-status", body); trip = self._access(principal)
        current = self.checkpoints.revision(principal.id, trip, self.workspace_key) if self.checkpoints is not None else 0
        result = dict(runtime_contract_version=VERSION, recovery_available=self.checkpoints is not None,
            last_acknowledged_revision=self._checkpoint_revisions.get(principal.id, 0), current_checkpoint_revision=current,
            save_pending=principal.id in self._pending_checkpoint_writes or principal.id in self._scene_errors,
            last_error=self._scene_errors.get(principal.id))
        self._shape("scene-status-result", result)
        return result

    def retry_scene(self, body, principal):
        with self._lock:
            self._shape("scene-retry", body); self._access(principal); self._backend()
            check(principal.id in self._pending_checkpoint_writes, "CHECKPOINT_RETRY_EMPTY", "没有待重试的现场保存")
            payload, expected, key = self._pending_checkpoint_writes[principal.id]
            ack = self._write_scene(payload, expected, key, principal)
            saved = self.checkpoints.load(principal.id, payload["trip_id"], self.workspace_key, self.store.clock())
            self._install_scene(saved, principal)
            return dict(runtime_contract_version=VERSION, ack=ack)

    def list_scenes(self, body, principal):
        self._shape("scene-list", body); trip = self._access(principal); self._backend()
        result = dict(runtime_contract_version=VERSION, checkpoints=self.checkpoints.list(principal.id, trip, self.store.clock()))
        self._shape("scene-list-result", result)
        return result
