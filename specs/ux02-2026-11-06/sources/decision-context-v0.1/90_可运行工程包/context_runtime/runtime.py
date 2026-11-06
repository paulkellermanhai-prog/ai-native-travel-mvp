"""In-process reference adapter. Host owns authentication and semantic authorization.

Reads use public Store methods with optimistic snapshot validation, not its private lock.
Task interpretations are inputs from an interpreter; this module is NOT an NLP model.
"""
from copy import deepcopy
from dataclasses import dataclass
import json
from threading import RLock
from uuid import uuid4
from jsonschema import ValidationError
from tripstate.engine import Actor, digest
from tripstate.rules import index, instant, stamp, condition_value, fact_usable
from .contracts import VERSION, validate
from .errors import RuntimeFault, check
from .recovery import RecoveryMixin


def size(value):
    return len(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


@dataclass(frozen=True)
class Principal:
    """Created only by authenticated host; never parsed from request JSON."""
    id: str
    allowed_trip_ids: tuple


@dataclass(frozen=True)
class WriteGrant:
    """Host-issued exact permission. Not a JSON field and not a model claim."""
    principal_id: str
    event_id: str
    request_digest: str
    revision: int
    expires_at: str
    runtime_id: str | None = None


class Runtime(RecoveryMixin):
    def __init__(self, store, checkpoints=None, workspace_key="workspace"):
        self.store = store
        self.checkpoints, self.workspace_key = checkpoints, workspace_key
        self.instance_id = "runtime-"+uuid4().hex
        self._scene_loaded, self._recovered_event_ids = set(), set()
        self._checkpoint_revisions, self._scene_views, self._scene_drafts, self._scene_focus = {}, {}, {}, {}
        self._pending_checkpoint_writes, self._scene_errors = {}, {}
        self.tasks, self.turns, self.packets = {}, {}, {}
        self.event_cache, self.write_cache = {}, {}
        self._lock = RLock()

    def _access(self, principal):
        trip = self.store.get_state()["trip_id"]
        check(isinstance(principal, Principal) and trip in principal.allowed_trip_ids,
              "ACCESS_DENIED", "宿主未授权此旅行")
        return trip

    def _owned(self, collection, key, principal):
        self._access(principal)
        check(key in collection and collection[key]["owner"] == principal.id,
              "NOT_FOUND", "运行资源不存在或不属于当前主体")
        return collection[key]

    def _shape(self, name, body):
        try:
            validate(name, body)
        except ValidationError as exc:
            raise RuntimeFault("CONTRACT_INVALID", "字段契约不合法: " + "/".join(map(str, exc.absolute_path))) from None

    def _span(self, span, text):
        check(0 <= span["start"] < span["end"] <= len(text) and text[span["start"]:span["end"]] == span["quote"],
              "SOURCE_SPAN", "证据必须精确定位本轮输入的 Unicode 字符范围")

    def open_turn(self, body, principal):
        with self._lock:
            trip = self._access(principal)
            self._shape("open-turn", body)
            self._ensure_scene(principal)
            event_key = (principal.id, body["event"]["event_id"])
            check(event_key not in self._recovered_event_ids, "RECOVERED_EVENT_REPLAY", "恢复输入只读；新授权须来自新事件")
            if event_key in self.event_cache:
                previous_digest, previous_result = self.event_cache[event_key]
                check(previous_digest == digest(body), "EVENT_REUSE", "同一事件标识不能对应不同内容")
                return deepcopy(previous_result)
            state = self.store.get_state()
            check(body["trip_id"] == trip, "TRIP_MISMATCH", "运行输入不能跨旅行")
            check(body["expected_revision"] == state["revision"], "REVISION_CHANGED", "先刷新基础状态再定位", True)
            check(instant(body["event"]["received_at"]) <= self.store.clock(), "EVENT_TIME", "输入不能来自未来")
            keys = [t["task_key"] for t in body["tasks"]]
            check(len(set(keys)) == len(keys) and set(body["focus_keys"]) <= set(keys), "TASK_KEYS", "焦点必须引用本轮唯一问题")
            current = {key: deepcopy(t) for (owner, key), t in self.tasks.items() if owner == principal.id}
            objects = index(state)
            for task in body["tasks"]:
                key = task["task_key"]
                check(set(task["target_ids"]) <= objects.keys(), "TARGET_NOT_FOUND", "任务对象不存在")
                check(set(task["related_task_keys"]) <= current.keys() and key not in task["related_task_keys"],
                      "TASK_RELATION", "关联必须是本会话已定位问题，不允许自关联")
                for span in task["evidence"]:
                    self._span(span, body["event"]["text"])
                if task["progress"] != "open":
                    check(task["certainty"] == "explicit" and task["progress_evidence"] is not None,
                          "PROGRESS_EVIDENCE", "暂停/完成不能由焦点变化推定")
                if task["progress_evidence"]:
                    self._span(task["progress_evidence"], body["event"]["text"])
                if task["relation"] in ("continue", "focus", "resume", "reopen"):
                    check(key in current, "TASK_NOT_RECOVERABLE", "本运行会话无该问题，不能假报精确恢复")
                    prior = current[key]
                    check((prior["kind"], prior["branch"]) == (task["kind"], task["branch"]),
                          "TASK_IDENTITY", "不同问题种类/假设分支不能复用身份")
                    check(prior["progress"] != "handled" or task["relation"] == "reopen",
                          "TASK_CLOSED", "已处理的问题须显式重审关联")
                    check(prior["progress"] != "paused" or task["progress"] != "open" or task["relation"] in ("resume", "reopen"),
                          "TASK_PAUSED", "焦点变化不能自动恢复暂停问题")
                else:
                    check(key not in current, "TASK_IDENTITY", "新问题不能覆盖旧身份")
                    if task["relation"] == "refine":
                        check(bool(task["related_task_keys"]), "TASK_RELATION", "细化必须引用已有问题")
                current[key] = deepcopy(task)
            # Validate the whole interpretation before mutating even ephemeral task state.
            previous = (deepcopy(self.tasks), deepcopy(self.turns), deepcopy(self.event_cache))
            turn_id = "turn-" + uuid4().hex
            for task in body["tasks"]:
                self.tasks[(principal.id, task["task_key"])] = deepcopy(task)
            self.turns[turn_id] = dict(owner=principal.id, body=deepcopy(body),
                pending=dict(event=deepcopy(body["event"]), base_revision=state["revision"], processing_status="unprocessed",
                             proposal_id=None, result_revision=state["revision"], errors=[]))
            try:
                ack = self._autosave_turn(turn_id, principal)
            except BaseException:
                self.tasks, self.turns, self.event_cache = previous
                raise
            result = dict(runtime_contract_version=VERSION, runtime_id=self.instance_id, turn_id=turn_id, revision=state["revision"],
                          tasks=deepcopy(body["tasks"]), focus_keys=deepcopy(body["focus_keys"]), checkpoint_ack=ack)
            self.event_cache[event_key] = (digest(body), deepcopy(result))
            return result

    def _scope(self, o, task, objects, now):
        scope = o["scope"]
        if o["type"] == "Decision" and o["subject_id"] not in task["target_ids"]:
            return "unknown"  # retained protection is not proof of relevance to this question
        if o["type"] == "OpenIssue" and not set(o["affected_ids"]) & set(task["target_ids"]):
            return "unknown"
        if scope["kind"] == "trip":
            return "applicable"
        targets = set(task["target_ids"])
        entities = set()
        for key in targets:
            target = objects[key]
            entities.update(target.get("subject_ids", []))
            entities.update(s["entity_id"] for s in target.get("stops", []))
            if target["type"] == "DestinationEntity":
                entities.add(key)
        if scope["kind"] == "entity":
            return "applicable" if set(scope["ids"]) & entities else "not_applicable" if entities else "unknown"
        if scope["kind"] == "skeleton":
            return "applicable" if set(scope["ids"]) & targets else "not_applicable" if targets else "unknown"
        # Date/traveler applicability needs task-specific scope data not in this V0.1 envelope.
        return "unknown"

    def _annotations(self, objects, task, now, stale_fact_ids):
        rows = []
        windows = [o["value"] for o in objects.values() if o["type"] == "Constraint" and
                   o["status"] == "active" and o["scope"]["kind"] == "trip" and o["value"]["kind"] == "date_window"]
        for o in objects.values():
            applicability = self._scope(o, task, objects, now)
            condition = condition_value(o["condition"], objects, now) if "condition" in o else True
            if condition is False:
                applicability = "not_applicable"
            elif condition is None and applicability != "not_applicable":
                applicability = "unknown"
            restriction, reasons = "none", []
            if o["type"] == "ExternalFact":
                applicability = o["applicability"]
                if o["id"] in stale_fact_ids:
                    restriction = "decision_limit"
                    reasons = ["fact_unusable" if not fact_usable(o, now) else "fact_contested"]
                query_date = o["query"]["date"]
                if windows and (query_date is None or any(not w["start"] <= query_date <= w["end"] for w in windows)):
                    applicability = "not_applicable" if query_date is not None else "unknown"
                    restriction = "decision_limit"
                    reasons.append("check_current_dates_not_revision_only")
            if o["type"] == "Skeleton":
                status = o["assessment"]["status"]
                if status == "blocked":
                    restriction, reasons = "known_conflict", ["assessment_blocked"]
                elif status != "verified" or o["assessment"].get("unknowns"):
                    restriction, reasons = "decision_limit", ["assessment_incomplete"]
            if o["type"] == "OpenIssue":
                restriction = "decision_limit"
                reasons.append("issue_unresolved")
            if o["type"] == "Decision":
                reasons.append("confirmation_scope_only")
                if o["status"] != "confirmed" or o["review_state"] != "current":
                    restriction = "decision_limit"
                    reasons.append("not_current_authorization")
            presentation = "policy_judgment"
            if o["type"] == "OpenIssue" and o["status"] == "dismissed":
                # Propagation reopens changed issues in Trip State. This is eligibility, not action routing.
                presentation = "suppressed_unchanged"
                reasons.append("disclose_if_conclusion_uses_affected_scope")
            elif restriction != "none":
                presentation = "limitation_if_used"
            rows.append(dict(id=o["id"], retained=True, applicability=applicability,
                restriction=restriction, presentation=presentation, reason_codes=reasons,
                evidence_ids=[d["object_id"] for d in o["dependencies"]]))
        return rows

    def assemble(self, body, principal):
        with self._lock:
            self._shape("assemble", body)
            turn = self._owned(self.turns, body["turn_id"], principal)
            tasks = {t["task_key"]: t for t in turn["body"]["tasks"]}
            check(body["task_key"] in tasks, "TASK_KEYS", "只能组装本轮定位的问题")
            task = tasks[body["task_key"]]
            for _ in range(3):
                state = self.store.get_state()
                seeds = set(task["target_ids"])
                # Conservative finite-MVP recall: all active preferences plus current goal.
                seeds.update(o["id"] for o in state["objects"] if
                    o["type"] == "TripGoal" and o["status"] in ("active", "revised") or
                    o["type"] == "Preference" and o["status"] == "active")
                try:
                    context = self.store.context(dict(task_id=task["task_key"], selected_object_ids=sorted(seeds)))
                except Exception as exc:
                    # A missing target is deterministic; never substitute a similar object.
                    raise RuntimeFault("ASSEMBLY_FAILED", str(exc)) from exc
                after = self.store.get_state()
                if state["revision"] == context["state_revision"] == after["revision"]:
                    break
            else:
                raise RuntimeFault("SNAPSHOT_BUSY", "三次读取仍有并发写入，请稍后重建", True)
            objects = index(state)
            selected = {oid: objects[oid] for oid in context["selected_object_ids"]}
            check(all(objects[v["id"]]["version"] == v["version"] for v in context["assembled_from_versions"]),
                  "SNAPSHOT_MISMATCH", "引用与正文版本不一致", True)
            now = self.store.clock()
            check(now < instant(context["expires_at"]), "PACKET_EXPIRED", "组装过程中已过期", True)
            ordered = [selected[key] for key in sorted(selected)]
            budget = body["body_budget_bytes"]
            complete = size(ordered) <= budget
            primary, used = [], 2
            # Focus objects first; full protected manifest remains in context regardless of body budget.
            priorities = sorted(selected, key=lambda oid: (oid not in task["target_ids"], oid))
            for oid in priorities:
                cost = size(selected[oid]) + (1 if primary else 0)
                if complete or used + cost <= budget:
                    primary.append(deepcopy(selected[oid])); used += cost
            primary_ids = {o["id"] for o in primary}
            deferred = sorted(set(selected) - primary_ids)
            coverage = "complete" if complete else "layered" if primary else "limited"
            warnings = [] if complete else ["partial_hydration_no_trip_feasibility_claim", "manifest_not_a_model_prompt"]
            if turn.get("recovered"):
                warnings.append("restored_input_read_only_repreview_required")
            if principal.id in self._pending_checkpoint_writes:
                warnings.append("scene_save_unacknowledged_business_state_is_separate")
            if context["stale_fact_ids"]:
                warnings.append("unusable_evidence_not_current_fact")
            if state["revision"] != turn["pending"]["base_revision"] and turn["pending"]["processing_status"] not in ("applied",):
                warnings.append("input_based_on_older_revision_revalidate_before_write")
            packet = dict(runtime_contract_version=VERSION, packet_id="packet-" + uuid4().hex,
                turn_id=body["turn_id"], task=deepcopy(task), context=context,
                pending_input=deepcopy(turn["pending"]), objects=primary, deferred_ids=deferred,
                coverage=coverage, evidence_checked_at=stamp(now), snapshot_digest=digest(state),
                annotations=self._annotations(selected, task, now, set(context["stale_fact_ids"])),
                support="decision_support" if complete else "information_only", warnings=warnings)
            self._shape("packet", packet)
            self.packets[packet["packet_id"]] = dict(owner=principal.id, packet=deepcopy(packet),
                snapshot=state, objects=selected, delivered=set(primary_ids))
            return deepcopy(packet)

    def _current(self, item):
        packet = item["packet"]
        state = self.store.get_state()
        check(state["revision"] == packet["context"]["state_revision"] and digest(state) == packet["snapshot_digest"],
              "PACKET_STALE", "状态/正文版本已变化，重新组装", True)
        check(self.store.clock() < instant(packet["context"]["expires_at"]), "PACKET_EXPIRED", "读取包已到期", True)
        check(self.store.context_is_current(packet["context"]), "EVIDENCE_CHANGED", "事实/保护集合不再一致", True)

    def page(self, body, principal):
        with self._lock:
            self._shape("page-request", body)
            item = self._owned(self.packets, body["packet_id"], principal)
            self._current(item)
            check(set(body["object_ids"]) <= item["objects"].keys(), "PAGE_SCOPE", "页读取不能扩大到原清单外")
            result = [deepcopy(item["objects"][key]) for key in body["object_ids"]]
            self._current(item)
            item["delivered"].update(body["object_ids"])
            return dict(runtime_contract_version=VERSION, packet_id=body["packet_id"], state_revision=item["snapshot"]["revision"],
                        objects=result, remaining_ids=sorted(set(item["objects"]) - item["delivered"]),
                        delivery_only_not_model_comprehension=True)

    def submit_change(self, body, principal, grant=None):
        with self._lock:
            self._shape("change", body)
            turn = self._owned(self.turns, body["turn_id"], principal)
            item = self._owned(self.packets, body["packet_id"], principal)
            check(not turn.get("recovered"), "RESTORED_INPUT_READ_ONLY", "恢复讨论不授予提交权限；请处理新输入并重新预览")
            cache_key = (principal.id, body["turn_id"], body["request"]["idempotency_key"])
            if cache_key in self.write_cache:
                previous_digest, previous_result = self.write_cache[cache_key]
                check(previous_digest == digest(body), "IDEMPOTENCY_CONFLICT", "幂等键内容不同")
                return deepcopy(previous_result)
            check(item["packet"]["turn_id"] == body["turn_id"], "TURN_MISMATCH", "不能混用其他轮次读取")
            self._current(item)
            request = body["request"]
            check(request["expected_revision"] == item["snapshot"]["revision"], "REVISION_CHANGED", "写入须绑定所读版本", True)
            check(item["packet"]["task"]["branch"] == "actual" or all(c["op"] == "create" and c.get("object_type") == "Skeleton" and c["data"].get("purpose") == "scenario" for c in request["commands"]),
                  "HYPOTHETICAL_WRITE", "假设分支只允许建立隔离 scenario，不改有效状态")
            event = turn["pending"]["event"]
            check(request["input"]["text"] == event["text"] and request["input"]["reference"] == event["reference"],
                  "INPUT_BINDING", "命令必须保留本轮原话及来源")
            if grant is not None:
                check(isinstance(grant, WriteGrant) and grant.principal_id == principal.id and
                      grant.event_id == event["event_id"] and grant.request_digest == digest(request) and
                      grant.revision == request["expected_revision"] and instant(grant.expires_at) > self.store.clock(),
                      "WRITE_GRANT", "宿主授权不匹配/到期")
                check(self.checkpoints is None or grant.runtime_id == self.instance_id,
                      "WRITE_GRANT", "其他运行实例的旧授权不能跨会话恢复")
                actor = Actor("user", principal.id)
            else:
                actor = Actor("model", "runtime-interpreter")
            consequential = any(c["op"] in ("adopt_skeleton", "decide_candidate", "withdraw_decision") for c in request["commands"])
            check(not consequential or item["delivered"] == set(item["objects"]),
                  "INCOMPLETE_DELIVERY", "重要选择不能以部分正文冒充完整消费")
            result = self.store.submit(request, actor)
            turn["pending"].update(processing_status=result["outcome"], proposal_id=result["proposal_id"],
                                   result_revision=result["revision"], errors=deepcopy(result["errors"]))
            self.write_cache[cache_key] = (digest(body), deepcopy(result))
            self._after_business_result(body["turn_id"], principal)
            return deepcopy(result)

    def confirm(self, body, principal):
        with self._lock:
            self._shape("confirm", body)
            turn = self._owned(self.turns, body["turn_id"], principal)
            check(not turn.get("recovered"), "RESTORED_INPUT_READ_ONLY", "恢复的旧提案不能直接确认，必须重新预览")
            check(turn["pending"]["proposal_id"] == body["proposal_id"],
                  "PROPOSAL_BINDING", "提案不属于当前轮次")
            result = self.store.confirm(body["proposal_id"], body["request"], Actor("user", principal.id))
            turn["pending"].update(processing_status=result["outcome"], result_revision=result["revision"], errors=deepcopy(result["errors"]))
            if result["outcome"] in ("applied", "rejected") and not result["errors"]:
                for key, (request_digest, cached) in list(self.write_cache.items()):
                    if key[0] == principal.id and cached["proposal_id"] == body["proposal_id"]:
                        self.write_cache[key] = (request_digest, deepcopy(result))
            self._after_business_result(body["turn_id"], principal)
            return deepcopy(result)
