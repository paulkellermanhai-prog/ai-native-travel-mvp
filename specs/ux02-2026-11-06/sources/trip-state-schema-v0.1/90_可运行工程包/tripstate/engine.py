"""In-memory reference transaction processor. Actor is injected by trusted host code."""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
from threading import RLock
from uuid import uuid4
from .contracts import STATES, TRANSITIONS
from .rules import (RuleError, require, validate_shape, validate_state, index, instant, stamp,
                    condition_value, references, fact_usable, applicable, assess, blank_assessment,
                    reservation_profile, reservation_overlaps_trip, conflicting_fact_ids)


@dataclass(frozen=True)
class Actor:
    role: str
    id: str


def digest(value):
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def changes(before, after):
    old, new = index(before), index(after)
    return [dict(id=oid, before=deepcopy(old.get(oid)), after=deepcopy(new.get(oid)))
            for oid in sorted(set(old) | set(new)) if old.get(oid) != new.get(oid)]


def changed_paths(old, new, prefix=""):
    if isinstance(old, dict) and isinstance(new, dict):
        result = set()
        for key in set(old) | set(new):
            if key not in old or key not in new:
                result.add(prefix + "/" + key)
            else:
                result |= changed_paths(old[key], new[key], prefix + "/" + key)
        return result
    return {prefix} if old != new else set()


class Store:
    def __init__(self, state, clock=None):
        validate_state(state)
        self._state = deepcopy(state)
        self._history = dict(intents=[], changes=[])
        self._pending, self._cache = {}, {}
        self._lock = RLock()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.before_commit = None  # fault-injection seam; not an API field

    def get_state(self):
        with self._lock:
            return deepcopy(self._state)

    def get_history(self):
        with self._lock:
            return deepcopy(self._history)

    def _response(self, outcome, proposal=None, request_digest=None, delta=None, error=None):
        response = dict(outcome=outcome, revision=self._state["revision"], proposal_id=proposal,
                        proposal_digest=request_digest, confirmation_required=outcome == "pending_confirmation",
                        affected_ids=[d["id"] for d in delta or []], diff=delta or [],
                        errors=[] if error is None else [dict(code=error.code, message=str(error))])
        validate_shape("response", response)
        return response

    def _actor(self, actor):
        require(isinstance(actor, Actor) and actor.role in ("user", "model", "tool", "system"), "ACTOR", "执行主体必须由宿主鉴权后注入")

    def _needs_confirmation(self, request, actor):
        if actor.role == "user":
            return False
        objects = index(self._state)
        for cmd in request["commands"]:
            if cmd["op"] in ("adopt_skeleton", "decide_candidate", "withdraw_decision", "dismiss_issue"):
                return True
            if cmd["op"] == "create":
                if cmd["object_type"] in ("TripGoal", "Constraint") or cmd["object_type"] == "Preference" and cmd["data"]["certainty"] == "explicit":
                    return True
            old = objects.get(cmd.get("id"))
            if old and cmd["op"] in ("revise", "transition"):
                if old["type"] == "Constraint" and old["override_policy"] == "fixed" and cmd.get("event") == "invalidate" and actor.role == "system":
                    continue
                if old["type"] in ("TripGoal", "Constraint") or old["type"] == "Preference" and old["certainty"] == "explicit":
                    return True
                if cmd.get("event") in ("exclude", "archive", "withdraw", "supersede") and actor.role == "model":
                    return True
        return False

    def preview(self, request, actor):
        with self._lock:
            return self._submit(request, actor, preview=True)

    def submit(self, request, actor):
        with self._lock:
            return self._submit(request, actor, preview=False)

    def _submit(self, request, actor, preview):
        try:
            self._actor(actor)
            validate_shape("change-request", request)
            key = (actor.id, actor.role, request["idempotency_key"])
            request_hash = digest(request)
            if not preview and key in self._cache:
                previous_hash, previous_response = self._cache[key]
                require(previous_hash == request_hash, "IDEMPOTENCY_CONFLICT", "同一幂等键对应不同请求")
                return deepcopy(previous_response)
            require(request["expected_revision"] == self._state["revision"], "VERSION_CONFLICT", "旅行版本已改变；重新读取并预览")
            for oid in request["input"]["target_ids"]:
                require(oid in index(self._state), "DANGLING_REF", "操作意图引用不存在")
            now = self.clock()
            proposal = "proposal-" + uuid4().hex
            needs = self._needs_confirmation(request, actor)
            require(actor.role != "tool" or all(c["op"] == "ingest_fact" or
                    c["op"] == "transition" and c["event"] in ("supersede", "contradict") and
                    index(self._state).get(c["id"], {}).get("type") == "ExternalFact"
                    for c in request["commands"]), "PERMISSION", "工具仅能导入事实或使已有事实被替代／反证")
            effective_actor = Actor("user", "pending-user") if needs else actor
            after = self._execute(request, effective_actor, proposal, now, simulating_confirmation=needs)
            delta = changes(self._state, after)
            proposal_digest = digest(dict(request=request, diff=delta, effective=after["effective_skeleton_id"]))
            response = self._response("preview" if preview else "pending_confirmation" if needs else "applied", proposal, proposal_digest, delta)
            if preview:
                response["confirmation_required"] = needs
                return response
            if needs:
                expiry = now + timedelta(minutes=5)
                for fact in self._state["objects"]:
                    if fact["type"] == "ExternalFact" and instant(fact["expires_at"]) > now:
                        expiry = min(expiry, instant(fact["expires_at"]))
                pending = dict(request=deepcopy(request), actor=actor, digest=proposal_digest, expires=expiry, cache_key=key)
                history = self._journal(request, actor, proposal, "pending_confirmation", proposal_digest, self._state, delta, now)
                # All validation precedes these in-memory assignments, under the same lock.
                self._pending[proposal] = pending
                self._history = history
            else:
                history = self._journal(request, actor, proposal, "applied", proposal_digest, after, delta, now)
                if self.before_commit:
                    self.before_commit()
                self._state, self._history = after, history
                response["revision"] = after["revision"]
            self._cache[key] = (request_hash, deepcopy(response))
            return response
        except RuleError as exc:
            return self._response("conflict" if exc.code in ("VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT") else "rejected", error=exc)
        except Exception as exc:
            return self._response("rejected", error=RuleError("INTERNAL_FAILURE", type(exc).__name__ + ": " + str(exc)))

    def confirm(self, proposal_id, request, actor):
        with self._lock:
            try:
                self._actor(actor)
                require(actor.role == "user", "PERMISSION", "只有经鉴权用户可确认")
                validate_shape("confirm-request", request)
                key = (actor.id, "confirmation", request["idempotency_key"])
                request_hash = digest(dict(proposal_id=proposal_id, request=request))
                if key in self._cache:
                    old_hash, response = self._cache[key]
                    require(old_hash == request_hash, "IDEMPOTENCY_CONFLICT", "确认幂等键内容不同")
                    return deepcopy(response)
                require(proposal_id in self._pending, "PROPOSAL_NOT_FOUND", "提案不存在或已经处理")
                pending = self._pending[proposal_id]
                require(request["proposal_digest"] == pending["digest"], "CONFIRMATION_SCOPE", "确认内容与所展示提案不同")
                original = pending["request"]
                require(request["expected_revision"] == self._state["revision"] == original["expected_revision"], "VERSION_CONFLICT", "确认依据已变化，必须重新预览")
                now = self.clock()
                require(now < pending["expires"], "CONFIRMATION_EXPIRED", "确认已过期，必须重新核验")
                after = self._execute(original, actor, proposal_id, now) if request["accept"] else deepcopy(self._state)
                delta = changes(self._state, after)
                outcome = "applied" if request["accept"] else "rejected"
                history = self._journal(original, pending["actor"], proposal_id, outcome, pending["digest"], after, delta, now, actor.id)
                if self.before_commit:
                    self.before_commit()
                self._state, self._history = after, history
                del self._pending[proposal_id]
                response = self._response(outcome, proposal_id, pending["digest"], delta)
                self._cache[key] = (request_hash, deepcopy(response))
                old_hash = self._cache[pending["cache_key"]][0]
                self._cache[pending["cache_key"]] = (old_hash, deepcopy(response))
                return response
            except RuleError as exc:
                return self._response("conflict" if exc.code in ("VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT") else "rejected", error=exc)
            except Exception as exc:
                return self._response("rejected", error=RuleError("INTERNAL_FAILURE", str(exc)))

    def _journal(self, request, actor, proposal, outcome, proposal_digest, after, delta, now, confirmation_actor=None):
        history = deepcopy(self._history)
        intent_id = "intent-" + uuid4().hex
        intent = dict(id=intent_id, type="OperationIntent", trip_id=self._state["trip_id"],
                      actor_id=actor.id, actor_role=actor.role, input=deepcopy(request["input"]),
                      base_revision=request["expected_revision"], created_at=stamp(now))
        record = dict(id="change-" + uuid4().hex, type="ChangeRecord", trip_id=self._state["trip_id"],
                      proposal_id=proposal, intent_id=intent_id, outcome=outcome,
                      actions=[c["op"] for c in request["commands"]], reason=request["reason"],
                      base_revision=self._state["revision"], result_revision=after["revision"], created_at=stamp(now),
                      confirmation_actor=confirmation_actor or (actor.id if actor.role == "user" and outcome == "applied" else None),
                      request_digest=proposal_digest, affected_ids=[d["id"] for d in delta],
                      effective_before=self._state["effective_skeleton_id"], effective_after=after["effective_skeleton_id"], diff=deepcopy(delta))
        validate_shape("OperationIntent", intent)
        validate_shape("ChangeRecord", record)
        history["intents"].append(intent)
        history["changes"].append(record)
        return history

    def _execute(self, request, actor, proposal, now, *, simulating_confirmation=False):
        before = self._state
        state = deepcopy(before)
        objects = index(state)
        source = dict(actor=actor.role, actor_id=actor.id, reference=request["input"]["reference"], text=request["input"]["text"], at=stamp(now))

        def get(oid, kind=None):
            require(oid in objects, "DANGLING_REF", oid)
            value = objects[oid]
            require(kind is None or value["type"] == kind, "REF_TYPE", oid)
            return value

        def make(oid, kind, data, scope=None, dependencies=None):
            require(oid not in objects, "DUPLICATE_ID", oid)
            o = dict(id=oid, type=kind, trip_id=state["trip_id"], version=1, status=STATES[kind][0],
                     scope=scope or dict(kind="trip", ids=[]), dependencies=deepcopy(dependencies or []),
                     source=deepcopy(source), updated_at=stamp(now), **deepcopy(data))
            objects[oid] = o
            state["objects"].append(o)
            return o

        recalculate, adoptions = set(), []
        for cmd in request["commands"]:
            op = cmd["op"]
            if op == "create":
                kind = cmd["object_type"]
                require(kind != "DestinationEntity" or actor.role == "system", "PERMISSION", "目录由系统适配器维护")
                require(kind not in ("Constraint", "TripGoal") or actor.role == "user", "PERMISSION", "目标和约束须用户明确表达")
                require(kind != "Preference" or cmd["data"]["certainty"] != "explicit" or actor.role == "user", "PERMISSION", "明确偏好须有用户表达")
                o = make(cmd["id"], kind, cmd["data"], cmd["scope"], cmd["dependencies"])
                if kind == "Skeleton":
                    o["assessment"] = blank_assessment()
                if kind == "Candidate":
                    o["review_state"] = "current"
                if kind == "OpenIssue":
                    require(o["resolution"] is None and not o["evidence_ids"], "ISSUE_STATE", "新问题不能伪装已解决")
            elif op == "revise":
                o = get(cmd["id"], cmd["object_type"])
                require(o["status"] not in ("superseded", "withdrawn", "invalidated", "relaxed", "closed", "retired", "archived", "resolved", "dismissed"), "IMMUTABLE_HISTORY", "终态不得原位修改；创建新对象或允许的重开操作")
                require(o["id"] != state["effective_skeleton_id"], "EFFECTIVE_IMMUTABLE", "修改有效骨架须创建暂定版本")
                if o["type"] == "Skeleton":
                    require(not any(d["type"] == "Decision" and d["subject_id"] == o["id"] and d["status"] == "confirmed" for d in objects.values()), "CONFIRMED_IMMUTABLE", "确认过的骨架须新建版本")
                if o["type"] in ("TripGoal", "Constraint") or o["type"] == "Preference" and o["certainty"] == "explicit":
                    require(actor.role == "user", "PERMISSION", "明确值不得被推断覆盖")
                if o["type"] == "Constraint":
                    require(o["override_policy"] != "fixed", "FIXED_CONSTRAINT", "固定现实条件不可通过普通修改放宽；新增证据并走纠错")
                if o["type"] == "DestinationEntity":
                    require(actor.role == "system", "PERMISSION", "目录仅系统维护")
                if o["type"] == "Preference" and cmd["changes"].get("certainty") == "explicit":
                    require(actor.role == "user", "PERMISSION", "推断不能升级为明确表达")
                o.update(deepcopy(cmd["changes"]))
                o["source"] = deepcopy(source)
            elif op == "transition":
                o = get(cmd["id"])
                event = cmd["event"]
                require(event not in ("confirm", "reconsider", "resolve", "dismiss", "revoke"), "DEDICATED_COMMAND", "此转换必须经专用业务命令")
                require(not (event == "supersede" and o["type"] in ("Skeleton", "Decision")),
                        "DEDICATED_COMMAND", "骨架及决定的替代只能由专用采用／选择命令原子完成")
                if o["type"] == "OpenIssue" and event == "make_actionable":
                    require(bool(o["candidate_actions"]), "ACTION_NOT_READY", "至少需要一个可尝试的候选动作")
                self._transition(o, event, actor)
                if o["type"] == "Constraint" and o["override_policy"] == "fixed":
                    require(event == "invalidate" and actor.role == "system", "FIXED_CONSTRAINT", "固定约束只允许系统有依据地失效")
                    invalid_evidence = [objects[d["object_id"]] for d in o["dependencies"]
                                        if d["relation"] == "evidence" and d["object_id"] in objects
                                        and objects[d["object_id"]]["type"] == "ExternalFact"]
                    require(any(f["status"] in ("contradicted", "superseded") for f in invalid_evidence),
                            "FIXED_CONSTRAINT_EVIDENCE", "固定条件失效须有已被反证或替代的事实依据；单纯过期仍保留原约束")
                require(o["id"] != state["effective_skeleton_id"], "EFFECTIVE_IMMUTABLE", "当前有效骨架不能单独归档或替代")
                if o["type"] == "Candidate" and event in ("exclude", "exclude_conditionally"):
                    committed = [reservation_profile(f) for f in objects.values()
                                 if f["type"] == "ExternalFact" and f["status"] == "active"]
                    require(not any(p and p["commitment_state"] == "confirmed" and p["city_id"] in o["subject_ids"]
                                    and reservation_overlaps_trip(p, objects)
                                    for p in committed), "COMMITTED_FACT_CONFLICT", "已有住宿确认，不能单独排除其城市；先核验取消／变更")
                    if actor.role != "user":
                        tradeoffs = [objects[pid] for pid in o["preference_ids"] if pid in objects
                                     and objects[pid]["status"] == "active" and objects[pid]["polarity"] == "tradeoff"
                                     and objects[pid]["certainty"] == "explicit"]
                        eligible = [p for p in tradeoffs if p["scope"]["kind"] == "trip" or
                                    p["scope"]["kind"] == "entity" and set(p["scope"]["ids"]) & set(o["subject_ids"])]
                        require(any(condition_value(p["condition"], objects, now) is True for p in eligible),
                                "CONDITION_UNKNOWN", "未确认适用取舍条件成立，不得自动排除")
                    require(not any(d["type"] == "Decision" and d["subject_id"] == o["id"] and d["status"] == "confirmed" and d["value"] == "accept" for d in objects.values()), "CONFIRMED_CANDIDATE", "先明确撤销该候选决定")
                    for sk in objects.values():
                        if sk["id"] == state["effective_skeleton_id"]:
                            require(not set(o["subject_ids"]) & {s["entity_id"] for s in sk["stops"]}, "CONFIRMED_CANDIDATE", "排除会影响当前骨架，须创建并确认替代方案")
                    o["exclusion_reason"] = request["reason"]
                o["source"] = deepcopy(source)
            elif op == "ingest_fact":
                require(actor.role == "tool", "PERMISSION", "事实由可信适配器导入，普通用户/模型不能写核验结论")
                o = make(cmd["id"], "ExternalFact", cmd["data"], cmd["scope"], cmd["dependencies"])
                require(instant(o["observed_at"]) <= now, "FACT_TIME", "观察时间不能来自未来")
                if o["value"] and o["value"]["kind"] == "transport" and o["query_status"] == "result":
                    required = ("service_exists", "departure", "arrival")
                    o["missing_fields"] = sorted(set(o["missing_fields"] + [key for key in required if o["value"][key] is None]))
                    if o["value"]["service_exists"] is False:
                        o["missing_fields"] = sorted(set(o["missing_fields"] + ["explicit_no_service_outcome_required"]))
                if o["value"] and o["value"]["kind"] == "condition" and o["value"]["value"] is None:
                    o["missing_fields"] = sorted(set(o["missing_fields"] + ["value"]))
                complete = o["query_status"] in ("result", "no_service") and o["query"]["date"] is not None and not o["missing_fields"] and o["value"] is not None
                o["verification"] = "date_specific" if complete else "estimated" if o["value"] is not None else "unverified"
                o["freshness"] = "current" if instant(o["expires_at"]) > now else "stale"
                o["applicability"] = "applicable" if complete and o["valid_for"]["start"] <= o["query"]["date"] <= o["valid_for"]["end"] else "unknown"
            elif op == "check_freshness":
                require(actor.role == "system", "PERMISSION", "时效维护由系统执行")
                for o in objects.values():
                    if o["type"] == "ExternalFact" and instant(o["expires_at"]) <= now:
                        o["freshness"] = "stale"
            elif op == "reconsider":
                o = get(cmd["id"], "Candidate")
                get(cmd["trigger_id"])
                require(cmd["trigger_id"] in set(references(o["reconsider_when"])), "RECONSIDER_TRIGGER", "触发对象必须属于重新考虑条件")
                require(condition_value(o["reconsider_when"], objects, now) is True, "CONDITION_UNKNOWN", "重新考虑条件未成立或未知")
                self._transition(o, "reconsider", actor)
                o["review_state"] = "current"
            elif op == "recalculate":
                sk = get(cmd["id"], "Skeleton")
                require(sk["status"] == "active", "IMMUTABLE_HISTORY", "历史版本不可重算覆盖；创建新暂定版本")
                require(actor.role in ("system", "user"), "PERMISSION", "计算由确定性程序执行")
                recalculate.add(cmd["id"])
            elif op == "adopt_skeleton":
                require(actor.role == "user", "PERMISSION", "采用骨架须用户确认")
                o = get(cmd["id"], "Skeleton")
                require(o["purpose"] == "plan" and o["status"] == "active", "SCENARIO_ADOPTION", "假设、归档或替代版本不能直接采用")
                require(state["effective_skeleton_id"] != o["id"], "ALREADY_ADOPTED", "已经是当前骨架")
                recalculate.add(o["id"])
                adoptions.append(cmd)
            elif op == "decide_candidate":
                require(actor.role == "user", "PERMISSION", "用户决定必须经确认")
                o = get(cmd["id"], "Candidate")
                if cmd["value"] in ("accept", "retain"):
                    require(o["status"] not in ("excluded", "conditionally_excluded"), "CANDIDATE_EXCLUDED", "被排除候选须先重新考虑")
                if cmd["value"] == "reject" and state["effective_skeleton_id"]:
                    sk = objects[state["effective_skeleton_id"]]
                    require(not set(o["subject_ids"]) & {s["entity_id"] for s in sk["stops"]}, "CONFIRMED_CANDIDATE", "拒绝当前骨架中的城市须先确认替代骨架")
                if cmd["value"] == "reject":
                    committed = [reservation_profile(f) for f in objects.values()
                                 if f["type"] == "ExternalFact" and f["status"] == "active"]
                    require(not any(p and p["commitment_state"] == "confirmed" and p["city_id"] in o["subject_ids"]
                                    and reservation_overlaps_trip(p, objects)
                                    for p in committed), "COMMITTED_FACT_CONFLICT", "已有住宿确认，须先核验取消／变更")
                prior = [d for d in objects.values() if d["type"] == "Decision" and d["subject_id"] == o["id"] and d["status"] == "confirmed"]
                for d in prior:
                    d["status"] = "revised"
                target_status = "excluded" if cmd["value"] == "reject" else "retained"
                if o["status"] != target_status:
                    self._transition(o, "exclude" if cmd["value"] == "reject" else "retain", actor)
                if cmd["value"] == "reject":
                    o["exclusion_reason"] = request["reason"]
                d = make("decision-" + proposal + "-" + str(len(objects)), "Decision",
                         self._decision_data(o, "candidate_choice", cmd["value"], ["candidate"], [], actor, now, prior))
                d["status"] = "confirmed"
            elif op == "withdraw_decision":
                o = get(cmd["id"], "Decision")
                if o["status"] == "confirmed" and not simulating_confirmation:
                    require(o["confirmed_by"] == actor.id, "PERMISSION", "只有原确认人可以撤销该决定")
                self._transition(o, "revoke", actor)
                if o["decision_kind"] == "adopt_skeleton" and o["subject_id"] == state["effective_skeleton_id"]:
                    state["effective_skeleton_id"] = None
            elif op in ("resolve_issue", "dismiss_issue"):
                o = get(cmd["id"], "OpenIssue")
                self._transition(o, "resolve" if op == "resolve_issue" else "dismiss", actor)
                if op == "resolve_issue":
                    require(bool(cmd["evidence_ids"]), "RESOLUTION_EVIDENCE", "解决问题必须提供证据")
                    is_conflict = o["issue_kind"] == "conflict"
                    contested = conflicting_fact_ids(objects, now)
                    if is_conflict:
                        live_facts = [get(oid) for oid in o["affected_ids"] if get(oid)["type"] == "ExternalFact"]
                        require(sum(fact_usable(fact, now) for fact in live_facts) <= 1,
                                "ISSUE_STILL_BLOCKED", "仍有多条可用的冲突事实，须先核验取舍")
                    for eid in cmd["evidence_ids"]:
                        evidence = get(eid)
                        require(evidence["type"] in ("ExternalFact", "Constraint", "Decision", "Skeleton"), "RESOLUTION_EVIDENCE", "证据类型不能解决问题")
                        if evidence["type"] == "ExternalFact":
                            require(fact_usable(evidence, now) and eid not in contested,
                                    "RESOLUTION_EVIDENCE", "解决依据不可过期、未知或仍有争议")
                        allowed = set(o["affected_ids"])
                        for aid in o["affected_ids"]:
                            subject = get(aid)
                            allowed.update(d["object_id"] for d in subject["dependencies"])
                            allowed.update(subject.get("cost_fact_ids", []))
                            allowed.update(fid for c in subject.get("connections", []) for fid in c["fact_ids"])
                        require(eid in allowed, "RESOLUTION_EVIDENCE", "证据必须与问题对象或其依赖关联")
                    for affected in o["affected_ids"]:
                        item = get(affected)
                        if item["type"] == "ExternalFact" and not (is_conflict and item["status"] in ("contradicted", "superseded")):
                            require(fact_usable(item, now) and affected not in contested,
                                    "ISSUE_STILL_BLOCKED", "原事实仍未核验或仍有争议")
                        if item["type"] == "Constraint":
                            require(item["status"] == "active", "ISSUE_STILL_BLOCKED", "条件尚未生效")
                        if item["type"] == "Decision":
                            require(item["status"] == "confirmed" and item["review_state"] == "current", "ISSUE_STILL_BLOCKED", "决定依据仍待检查")
                        if item["type"] == "Candidate":
                            require(item["review_state"] == "current", "ISSUE_STILL_BLOCKED", "候选仍待重新判断")
                        if item["type"] == "Skeleton":
                            a = assess(item, objects, now)
                            require(a["status"] == "verified", "ISSUE_STILL_BLOCKED", "受影响骨架仍有未知或冲突")
                    o["evidence_ids"] = cmd["evidence_ids"]
                o["resolution"] = cmd["reason"]

        # Structural validation before evaluation prevents malformed references causing accidental writes.
        for previous in before["objects"]:
            profile = reservation_profile(previous) if previous["type"] == "ExternalFact" else None
            if not profile or previous["status"] != "active" or profile["commitment_state"] != "confirmed":
                continue
            if objects[previous["id"]]["status"] in ("superseded", "contradicted"):
                successors = [f for f in objects.values() if f["type"] == "ExternalFact" and f["id"] not in index(before)
                              and (next_profile := reservation_profile(f)) and
                              next_profile["confirmation_ref"] == profile["confirmation_ref"]]
                require(len(successors) == 1 and successors[0]["status"] == "active" and
                        successors[0]["freshness"] == "current" and instant(successors[0]["expires_at"]) > now and
                        instant(successors[0]["observed_at"]) <= now,
                        "COMMITTED_FACT_EVIDENCE", "取消或变更已确认住宿须在同笔提交中导入可信同回执后继")
        validate_state(state)
        # Global travel-date edits invalidate applicability, never the original observation.
        windows = [o["value"] for o in objects.values() if o["type"] == "Constraint" and o["status"] == "active"
                   and o["hardness"] == "hard" and o["scope"]["kind"] == "trip" and o["value"]["kind"] == "date_window"]
        for fact in objects.values():
            if fact["type"] != "ExternalFact" or fact["query"]["date"] is None:
                continue
            if windows and not all(w["start"] <= fact["query"]["date"] <= w["end"] for w in windows):
                fact["applicability"] = "not_applicable"
            elif fact["verification"] in ("date_specific", "purchasable") and fact["valid_for"]["start"] <= fact["query"]["date"] <= fact["valid_for"]["end"]:
                fact["applicability"] = "applicable"
        self._propagate(before, state, now, make)
        for oid in recalculate:
            o = objects[oid]
            o["assessment"] = assess(o, objects, now)
            dep_ids = {d["object_id"] for d in o["dependencies"]}
            required = [c["id"] for c in objects.values() if c["type"] == "Constraint" and c["status"] == "active" and applicable(c, o)]
            required += o["cost_fact_ids"] + [fid for c in o["connections"] for fid in c["fact_ids"]]
            for rid in sorted(set(required) - dep_ids):
                source_obj = objects[rid]
                fields = ["/status", "/value"] if source_obj["type"] == "Constraint" else ["/status", "/value", "/freshness", "/applicability", "/expires_at"]
                o["dependencies"].append(dict(object_id=rid, version=source_obj["version"], paths=fields, relation="input"))
            for dep in o["dependencies"]:
                dep["version"] = objects[dep["object_id"]]["version"]
        # Recomputed output can change solely because time advanced, with no input write.
        # Propagate that output change, without invalidating the result just calculated.
        if recalculate:
            self._propagate(before, state, now, make, recomputed=recalculate)
        require(len(adoptions) <= 1, "MULTIPLE_ADOPTIONS", "一笔提交只能采用一个骨架")
        for cmd in adoptions:
            o = objects[cmd["id"]]
            cities = {s["entity_id"] for s in o["stops"]}
            for prior_choice in objects.values():
                if prior_choice["type"] != "Decision" or prior_choice["status"] != "confirmed" or prior_choice["decision_kind"] != "candidate_choice":
                    continue
                candidate = objects[prior_choice["subject_id"]]
                if candidate["candidate_kind"] == "city":
                    included = set(candidate["subject_ids"]) <= cities
                    require(not (prior_choice["value"] == "accept" and not included or prior_choice["value"] == "reject" and included),
                            "CONFIRMED_CANDIDATE", "新骨架与明确候选决定冲突，须在同笔提交中明确撤销该决定")
                if candidate["candidate_kind"] == "experience" and prior_choice["value"] == "accept":
                    # Experience detail is not a Skeleton field. At least protect its owning city.
                    for subject in candidate["subject_ids"]:
                        entity, seen = objects[subject], set()
                        while entity["type"] == "DestinationEntity" and entity.get("parent_id") and entity["id"] not in seen:
                            seen.add(entity["id"])
                            entity = objects[entity["parent_id"]]
                            if entity.get("entity_kind") == "city":
                                require(entity["id"] in cities, "CONFIRMED_CANDIDATE", "新骨架移除了已确认体验所在城市，须明确处理原决定")
                                break
            require(o["assessment"]["status"] != "blocked", "HARD_CONFLICT", "已知硬约束冲突阻止新骨架生效")
            require(not o["assessment"]["unknowns"] or cmd["acknowledge_unknowns"], "UNKNOWN_ACK", "必须承认已展示待核验项")
            old = state["effective_skeleton_id"]
            prior = [d for d in objects.values() if d["type"] == "Decision" and d["status"] == "confirmed" and d["decision_kind"] == "adopt_skeleton"]
            for d in prior:
                d["status"] = "revised"
            if old:
                objects[old]["status"] = "superseded"
            data = self._decision_data(o, "adopt_skeleton", "accept", cmd["confirmation_scope"], o["assessment"]["unknowns"], actor, now, prior)
            data["basis_ids"] = [d["object_id"] for d in o["dependencies"]]
            d = make("decision-" + proposal, "Decision", data)
            d["status"] = "confirmed"
            state["effective_skeleton_id"] = o["id"]
        old_objects = index(before)
        for o in state["objects"]:
            old = old_objects.get(o["id"])
            if old and o != old:
                o["version"] = old["version"] + 1
                o["updated_at"] = stamp(now)
        # Pin new decisions and successful calculations to the resulting versions.
        for o in state["objects"]:
            if o["type"] == "Decision" and o["id"] not in old_objects:
                o["subject_version"] = objects[o["subject_id"]]["version"]
            if o["id"] in recalculate:
                for dep in o["dependencies"]:
                    dep["version"] = objects[dep["object_id"]]["version"]
        if changes(before, state) or before["effective_skeleton_id"] != state["effective_skeleton_id"]:
            state["revision"] += 1
        validate_state(state)
        return state

    @staticmethod
    def _transition(obj, event, actor):
        matches = [t for t in TRANSITIONS if t["object_type"] == obj["type"] and t["from_state"] == obj["status"] and t["event"] == event]
        require(bool(matches), "ILLEGAL_TRANSITION", f"{obj['type']}:{obj['status']} -> {event}")
        transition = matches[0]
        require(actor.role in transition["actors"], "PERMISSION", "执行主体没有此转换权限")
        obj["status"] = transition["to_state"]

    @staticmethod
    def _decision_data(subject, kind, value, scope, unknowns, actor, now, prior):
        return dict(subject_id=subject["id"], subject_version=subject["version"], decision_kind=kind, value=value,
                    confirmation_scope=scope, basis_ids=[], acknowledged_unknowns=deepcopy(unknowns),
                    confirmed_by=actor.id, confirmed_at=stamp(now), supersedes=prior[-1]["id"] if prior else None,
                    review_state="current")

    @staticmethod
    def _propagate(before, after, now, make, recomputed=frozenset()):
        old, objects = index(before), index(after)
        changed = {oid: changed_paths(old.get(oid, {}), obj)
                   for oid, obj in objects.items() if old.get(oid) != obj}
        for oid in conflicting_fact_ids(old, now) ^ conflicting_fact_ids(objects, now):
            changed.setdefault(oid, set()).add("")
        affected = set()
        while True:
            added = set()
            for oid, obj in list(objects.items()):
                if oid in affected or oid in recomputed:
                    continue
                if obj["type"] == "Skeleton" and obj["status"] != "active":
                    continue
                if obj["type"] == "Decision" and (obj["status"] != "confirmed" or oid not in old):
                    continue
                hits = any(d["relation"] in ("input", "evidence") and d["object_id"] in changed and
                           any(p == q or p.startswith(q + "/") or q.startswith(p + "/") for p in d["paths"] for q in changed[d["object_id"]])
                           for d in obj["dependencies"])
                if obj["type"] == "Preference":
                    hits |= bool(set(references(obj["condition"])) & changed.keys())
                if obj["type"] == "Constraint" and obj["value"]["kind"] == "requirement":
                    hits |= bool(set(references(obj["value"]["condition"])) & changed.keys())
                if obj["type"] == "Skeleton":
                    implicit = set(obj["cost_fact_ids"]) | {fid for c in obj["connections"] for fid in c["fact_ids"]}
                    hits |= bool(implicit & changed.keys())
                    hits |= any(objects[r]["type"] == "Constraint" and applicable(objects[r], obj) for r in changed)
                    hits |= any(objects[r]["type"] == "TripGoal" for r in changed)
                    hits |= any(objects[r]["type"] == "ExternalFact" and reservation_profile(objects[r]) for r in changed)
                    hits |= any(objects[r]["type"] == "Candidate" and
                                bool(set(objects[r]["subject_ids"]) & {s["entity_id"] for s in obj["stops"]})
                                for r in changed)
                    # Editing the tentative skeleton itself invalidates its old calculation.
                    hits |= oid in changed and bool(changed[oid] & {"/stops", "/connections", "/cost_fact_ids", "/overrides"})
                if obj["type"] == "Candidate":
                    hits |= bool(set(obj["preference_ids"]) & changed.keys())
                    hits |= bool(set(references(obj["reconsider_when"])) & changed.keys())
                    hits |= any(objects[r]["type"] == "ExternalFact" and
                                (profile := reservation_profile(objects[r])) and profile["city_id"] in obj["subject_ids"]
                                for r in changed)
                if obj["type"] == "Decision":
                    hits |= obj["subject_id"] in changed or bool(set(obj["basis_ids"]) & changed.keys())
                if not hits:
                    continue
                if obj["type"] == "Skeleton":
                    obj["assessment"]["status"] = "stale"
                    obj["assessment"]["unknowns"] = sorted(set(obj["assessment"]["unknowns"] + ["inputs_changed"]))
                    added.add(oid)
                elif obj["type"] in ("Candidate", "Decision"):
                    obj["review_state"] = "stale"
                    added.add(oid)
                else:
                    # Pass changed applicability through source objects, preserving their values.
                    added.add(oid)
            if not added:
                break
            affected |= added
            for oid in added:
                changed[oid] = changed_paths(old.get(oid, {}), objects[oid]) or {""}
        for oid in sorted(affected):
            if objects[oid]["type"] not in ("Skeleton", "Decision"):
                continue
            issue_id = "issue-dependency-" + oid
            if issue_id in objects:
                objects[issue_id]["status"] = "open"
                objects[issue_id]["resolution"] = None
            else:
                issue = make(issue_id, "OpenIssue", dict(issue_kind="dependency", question="输入变化，需要重新核验或计算",
                             affected_ids=[oid], severity="warning", required_inputs=["fresh_dependencies"],
                             candidate_actions=["verify", "calculate", "confirm"], owner="system", resolution=None, evidence_ids=[]))
                objects[issue_id] = issue

    def context(self, request):
        with self._lock:
            validate_shape("context-request", request)
            now, objects = self.clock(), index(self._state)
            selected = set(request["selected_object_ids"])
            require(selected <= objects.keys(), "DANGLING_REF", "上下文选取对象不存在")
            constraints = [o["id"] for o in objects.values() if o["type"] == "Constraint" and o["status"] == "active"]
            decisions = [o["id"] for o in objects.values() if o["type"] == "Decision" and o["status"] == "confirmed"]
            issues = [o["id"] for o in objects.values() if o["type"] == "OpenIssue" and o["status"] != "resolved"]
            selected.update(constraints + decisions + issues)
            if self._state["effective_skeleton_id"]:
                selected.add(self._state["effective_skeleton_id"])
            while True:
                extra = set()
                for oid in selected:
                    o = objects[oid]
                    extra.update(d["object_id"] for d in o["dependencies"])
                    for key in ("basis_ids", "subject_ids", "preference_ids", "affected_ids", "cost_fact_ids", "destination_ids"):
                        extra.update(o.get(key, []))
                    if o["type"] == "Skeleton":
                        extra.update(s["entity_id"] for s in o["stops"])
                        extra.update(fid for c in o["connections"] for fid in c["fact_ids"])
                    for key in ("condition", "reconsider_when"):
                        if key in o:
                            extra.update(references(o[key]))
                    if o["type"] == "Constraint" and o["value"]["kind"] == "requirement":
                        extra.update(references(o["value"]["condition"]))
                    if o["type"] == "Decision":
                        extra.add(o["subject_id"])
                if extra <= selected:
                    break
                selected |= extra
            facts = sorted(oid for oid in selected if objects[oid]["type"] == "ExternalFact")
            contested = conflicting_fact_ids(objects, now)
            expiry = min([now + timedelta(minutes=5)] + [instant(objects[oid]["expires_at"]) for oid in facts if instant(objects[oid]["expires_at"]) > now])
            result = dict(id="context-" + uuid4().hex, type="DecisionContext", trip_id=self._state["trip_id"],
                          task_id=request["task_id"], status="active", state_revision=self._state["revision"],
                          assembled_at=stamp(now), expires_at=stamp(expiry), selected_object_ids=sorted(selected),
                          must_include_constraints=sorted(oid for oid in constraints if objects[oid]["hardness"] == "hard"),
                          active_decisions=sorted(decisions), open_issues=sorted(issues), relevant_facts=facts,
                          assembled_from_versions=[dict(id=oid, version=objects[oid]["version"]) for oid in sorted(selected)],
                          stale_fact_ids=[oid for oid in facts if oid in contested or not fact_usable(objects[oid], now)])
            validate_shape("DecisionContext", result)
            return result

    def context_is_current(self, context):
        with self._lock:
            validate_shape("DecisionContext", context)
            if context["trip_id"] != self._state["trip_id"] or context["status"] != "active" or context["state_revision"] != self._state["revision"] or instant(context["expires_at"]) <= self.clock():
                return False
            rebuilt = self.context(dict(task_id=context["task_id"], selected_object_ids=context["selected_object_ids"]))
            return all(context[field] == rebuilt[field] for field in ("must_include_constraints", "active_decisions", "open_issues", "assembled_from_versions", "stale_fact_ids"))
