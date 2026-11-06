"""Cross-object invariants and deterministic, deliberately limited calculations."""
from datetime import datetime, timezone, date
import json
from .contracts import schemas
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


class RuleError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition, code, message):
    if not condition:
        raise RuleError(code, message)


SCHEMAS = schemas()
REGISTRY = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in SCHEMAS.values())


def validate_shape(name, value):
    errors = sorted(Draft202012Validator(SCHEMAS[name], registry=REGISTRY,
                                         format_checker=FormatChecker()).iter_errors(value), key=lambda e: str(e.path))
    if errors:
        e = errors[0]
        raise RuleError("SCHEMA", f"{name}:{'/'.join(map(str, e.absolute_path))}: {e.message[:350]}")


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def stamp(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def index(state):
    return {o["id"]: o for o in state["objects"]}


def references(condition):
    if "object_id" in condition:
        yield condition["object_id"]
    for child in condition.get("args", []):
        yield from references(child)
    if "arg" in condition:
        yield from references(condition["arg"])


def pointer(value, path):
    try:
        for part in path.strip("/").split("/"):
            value = value[int(part)] if isinstance(value, list) else value[part]
        return value
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def condition_value(condition, objects, now, *, contested=None):
    op = condition["op"]
    if op == "always":
        return True
    if op == "not":
        v = condition_value(condition["arg"], objects, now, contested=contested)
        return None if v is None else not v
    if op in ("all", "any"):
        values = [condition_value(c, objects, now, contested=contested) for c in condition["args"]]
        decisive = False if op == "all" else True
        if decisive in values:
            return decisive
        return None if None in values else not decisive
    obj = objects.get(condition["object_id"])
    if not obj or obj["status"] in ("superseded", "withdrawn", "invalidated", "relaxed", "contradicted"):
        return None
    if obj["type"] == "ExternalFact":
        if not fact_usable(obj, now):
            return None
        if obj["id"] in (conflicting_fact_ids(objects, now) if contested is None else contested):
            return None
    left, right = pointer(obj, condition["path"]), condition["value"]
    if left is None or right is None or isinstance(left, (dict, list)):
        return None
    if type(left) != type(right) and not (type(left) in (int, float) and type(right) in (int, float)):
        return None
    if op in ("lt", "lte", "gt", "gte") and not (type(left) in (int, float) and type(right) in (int, float)):
        return None
    return {"eq": lambda: left == right, "ne": lambda: left != right,
            "lt": lambda: left < right, "lte": lambda: left <= right,
            "gt": lambda: left > right, "gte": lambda: left >= right}[op]()


def fact_usable(fact, now, window=None):
    if (fact["status"] != "active" or fact["freshness"] != "current"
            or fact["applicability"] != "applicable" or instant(fact["expires_at"]) <= now
            or instant(fact["observed_at"]) > now or fact["missing_fields"]
            or fact["query_status"] not in ("result", "no_service")):
        return False
    query_date = fact["query"]["date"]
    if not query_date or not fact["valid_for"]["start"] <= query_date <= fact["valid_for"]["end"]:
        return False
    if window and not window["start"] <= query_date <= window["end"]:
        return False
    return fact["verification"] in ("date_specific", "purchasable")


def conflicting_fact_ids(objects, now, window=None):
    """Detect comparable transport opposites and honor unresolved, sourced conflict issues."""
    usable = {oid: obj for oid, obj in objects.items()
              if obj["type"] == "ExternalFact" and fact_usable(obj, now, window)}
    transport = {}
    for oid, fact in usable.items():
        value = fact["value"]
        if value["kind"] != "transport":
            continue
        scope = fact["scope"]
        params = tuple(sorted(json.dumps(p, sort_keys=True) for p in fact["query"]["parameters"]))
        key = (fact["query"]["date"], value["from_id"], value["to_id"], params, scope["kind"],
               tuple(sorted(scope["ids"])), scope.get("start"), scope.get("end"))
        by_outcome = transport.setdefault(key, {True: set(), False: set()})
        by_outcome[value["service_exists"]].add(oid)
    contested = set()
    for by_outcome in transport.values():
        if by_outcome[True] and by_outcome[False]:
            contested.update(by_outcome[True] | by_outcome[False])
    for issue in objects.values():
        if issue["type"] == "OpenIssue" and issue["issue_kind"] == "conflict" and issue["status"] != "resolved":
            related = usable.keys() & set(issue["affected_ids"])
            if len(related) > 1:
                contested.update(related)
    return contested


def applicable(constraint, skeleton):
    scope = constraint["scope"]
    return (scope["kind"] in ("trip", "date", "traveler") or
            scope["kind"] == "skeleton" and skeleton["id"] in scope["ids"] or
            scope["kind"] == "entity" and bool(set(scope["ids"]) & {s["entity_id"] for s in skeleton["stops"]}))


def blank_assessment():
    return dict(status="unchecked", total_nights=None, connection_minutes=[], cost_groups=[],
                cost_coverage="none", unknowns=[], violations=[], checked_at=None)


def reservation_profile(fact):
    """A strict, read-only reservation receipt profile within existing ExternalFact fields."""
    if fact["type"] != "ExternalFact":
        return None
    raw = fact["query"]["parameters"]
    if not any(p["name"] == "profile" and p["value"] == "reservation-v0.1" for p in raw):
        return None
    fields = {p["name"]: p["value"] for p in raw}
    required = {"profile", "commitment_kind", "confirmation_ref", "city_id", "check_in", "check_out", "commitment_state"}
    require(len(raw) == len(fields) and set(fields) == required, "RESERVATION_PROFILE", "预订回执参数必须唯一且完整")
    require(fields["commitment_kind"] == "lodging" and fields["commitment_state"] in ("confirmed", "cancelled"),
            "RESERVATION_PROFILE", "当前只支持只读住宿确认／取消回执")
    require(all(isinstance(fields[k], str) and fields[k] for k in required), "RESERVATION_PROFILE", "预订回执字段须为非空文本")
    try:
        check_in, check_out = date.fromisoformat(fields["check_in"]), date.fromisoformat(fields["check_out"])
    except ValueError as exc:
        raise RuleError("RESERVATION_PROFILE", "预订日期格式错误") from exc
    require(check_in < check_out and fact["query"]["date"] == fields["check_in"],
            "RESERVATION_PROFILE", "住宿起止日期或查询日期不一致")
    require(fact["valid_for"]["start"] <= fields["check_in"] and fields["check_out"] <= fact["valid_for"]["end"],
            "RESERVATION_PROFILE", "回执适用日期未覆盖住宿期间")
    require(fact["query_status"] == "result" and fact["value"] is not None and fact["value"]["kind"] == "condition"
            and fact["value"]["value"] is (fields["commitment_state"] == "confirmed")
            and fact["source"]["actor"] == "tool" and not fact["missing_fields"]
            and fact["verification"] in ("date_specific", "purchasable"),
            "RESERVATION_PROFILE", "预订状态只能来自完整的可信工具回执")
    require(fields["city_id"] in fact["subject_ids"], "RESERVATION_PROFILE", "城市必须是事实主体")
    return fields


def reservation_overlaps_trip(profile, objects):
    """No known trip window means the commitment must remain a conservative guard."""
    windows = [o["value"] for o in objects.values() if o["type"] == "Constraint" and o["status"] == "active"
               and o["hardness"] == "hard" and o["scope"]["kind"] == "trip" and o["value"]["kind"] == "date_window"]
    if not windows:
        return True
    start, end = max(w["start"] for w in windows), min(w["end"] for w in windows)
    return start > end or not (profile["check_out"] <= start or profile["check_in"] > end)


def assess(skeleton, objects, now):
    """Known costs are a subtotal only. No route search or fabricated data."""
    result = blank_assessment()
    nights = [s["nights"] for s in skeleton["stops"]]
    result["total_nights"] = sum(nights) if all(n is not None for n in nights) else None
    result["checked_at"] = stamp(now)
    unknowns, violations = [], []
    if result["total_nights"] is None:
        unknowns.append("stay_nights_missing")
    constraints = [o for o in objects.values() if o["type"] == "Constraint" and o["status"] == "active" and applicable(o, skeleton)]
    overrides = {v["constraint_id"]: v["value"] for v in skeleton["overrides"]} if skeleton["purpose"] == "scenario" else {}
    values = [(c, overrides.get(c["id"], c["value"])) for c in constraints]
    windows = [v for c, v in values if v["kind"] == "date_window" and c["hardness"] == "hard" and c["scope"]["kind"] in ("trip", "skeleton")]
    window = {"start": max(v["start"] for v in windows), "end": min(v["end"] for v in windows)} if windows else None
    if not window:
        unknowns.append("travel_dates_missing")
    elif window["start"] > window["end"]:
        violations.append("incompatible_date_windows")
    cities = {stop["entity_id"] for stop in skeleton["stops"]}
    for receipt in objects.values():
        profile = reservation_profile(receipt) if receipt["type"] == "ExternalFact" else None
        if not profile or receipt["status"] != "active" or profile["commitment_state"] != "confirmed":
            continue
        if not window or profile["check_out"] <= window["start"] or profile["check_in"] > window["end"]:
            unknowns.append("reservation_outside_or_unknown_trip_window:" + receipt["id"])
        elif profile["city_id"] not in cities:
            violations.append("reservation_city_conflict:" + receipt["id"])
        else:
            # City inclusion is checkable; allocation to exact nights is not yet calendarized.
            unknowns.append("reservation_dates_not_checked:" + receipt["id"])
        if receipt["freshness"] != "current" or instant(receipt["expires_at"]) <= now or instant(receipt["observed_at"]) > now:
            unknowns.append("reservation_receipt_needs_recheck:" + receipt["id"])
    contested = conflicting_fact_ids(objects, now, window)
    groups, seen_cost_items = {}, set()
    for fid in skeleton["cost_fact_ids"]:
        fact = objects.get(fid)
        if not fact or not fact_usable(fact, now, window) or not fact["value"] or fact["value"]["kind"] != "cost":
            unknowns.append("cost:" + fid)
            continue
        if fid in contested:
            violations.append("contested_fact:" + fid)
            unknowns.append("cost:" + fid)
            continue
        value = fact["value"]
        if value["item_key"] in seen_cost_items:
            unknowns.append("duplicate_cost_item:" + value["item_key"])
            continue
        seen_cost_items.add(value["item_key"])
        key = (value["currency"], value["people"])
        group = groups.setdefault(key, dict(currency=key[0], people=key[1], subtotal_minor=0, fact_ids=[]))
        group["subtotal_minor"] += value["amount_minor"]
        group["fact_ids"].append(fid)
    result["cost_groups"] = list(groups.values())
    result["cost_coverage"] = "partial" if groups else "none"
    # Schedule comparison uses UTC instants; date applicability uses source local date.
    previous_arrival = None
    chosen_connections = []
    for n, connection in enumerate(skeleton["connections"]):
        facts = [objects[fid] for fid in connection["fact_ids"] if fid in objects]
        usable = [f for f in facts if fact_usable(f, now, window) and f["value"] and f["value"]["kind"] == "transport"]
        usable = [f for f in usable if f["value"]["from_id"] == connection["from_id"] and f["value"]["to_id"] == connection["to_id"]]
        if any(f["id"] in contested for f in usable):
            violations.append(f"connection:{n}:contested_evidence")
            result["connection_minutes"].append(None)
            continue
        if any(f["query_status"] == "no_service" or f["value"]["service_exists"] is False for f in usable):
            violations.append(f"no_service:{n}")
        if len(usable) != 1:
            unknowns.append(f"connection:{n}:missing_or_conflicting_evidence")
            result["connection_minutes"].append(None)
            continue
        fact = usable[0]
        value = fact["value"]
        if not value["departure"] or not value["arrival"] or value["service_exists"] is not True:
            unknowns.append(f"connection:{n}:incomplete_schedule")
            result["connection_minutes"].append(None)
            continue
        departure, arrival = instant(value["departure"]), instant(value["arrival"])
        duration = (arrival - departure).total_seconds() / 60
        if duration < 0 or duration != int(duration):
            violations.append(f"connection:{n}:invalid_times")
            result["connection_minutes"].append(None)
            continue
        if value["duration_minutes"] is not None and value["duration_minutes"] != int(duration):
            violations.append(f"connection:{n}:duration_mismatch")
        if fact["query"]["date"] != value["departure"][:10]:
            violations.append(f"connection:{n}:query_date_mismatch")
        if window and not (window["start"] <= value["departure"][:10] <= value["arrival"][:10] <= window["end"]):
            violations.append(f"connection:{n}:outside_dates")
        if previous_arrival and departure < previous_arrival:
            violations.append(f"connection:{n}:missed_connection")
        previous_arrival = arrival
        chosen_connections.append((departure, arrival))
        result["connection_minutes"].append(int(duration))
    for constraint, value in values:
        hard = constraint["hardness"] == "hard"
        kind = value["kind"]
        if constraint["scope"]["kind"] in ("date", "traveler", "entity"):
            unknowns.append("scoped_calculation_not_implemented:" + constraint["id"])
            continue
        if kind == "duration" and result["total_nights"] is not None and result["total_nights"] > value["maximum_nights"]:
            (violations if hard else unknowns).append(constraint["id"])
        elif kind == "date_window":
            available = (date.fromisoformat(value["end"]) - date.fromisoformat(value["start"])).days
            if result["total_nights"] is not None and result["total_nights"] > available:
                (violations if hard else unknowns).append(constraint["id"])
        elif kind == "budget":
            subtotal = sum(objects[fid]["value"]["amount_minor"] for group in result["cost_groups"]
                           for fid in group["fact_ids"] if objects[fid]["value"]["currency"] == value["currency"]
                           and objects[fid]["value"]["people"] == value["people"]
                           and objects[fid]["value"]["category"] in value["categories"])
            if value["maximum_minor"] is not None and subtotal > value["maximum_minor"]:
                (violations if hard else unknowns).append(constraint["id"])
            unknowns.append("partial_budget:" + constraint["id"])
        elif kind == "requirement":
            outcome = condition_value(value["condition"], objects, now, contested=contested)
            if outcome is False:
                (violations if hard else unknowns).append(constraint["id"])
            elif outcome is None:
                unknowns.append(constraint["id"])
                if hard and contested.intersection(references(value["condition"])):
                    violations.append("contested_fact:" + constraint["id"])
        elif kind == "travelers":
            goals = [o for o in objects.values() if o["type"] == "TripGoal" and o["status"] in ("active", "revised")]
            if not goals or not goals[0]["traveler_ids"]:
                unknowns.append(constraint["id"] + ":travelers_unknown")
            elif len(goals[0]["traveler_ids"]) != value["count"]:
                (violations if hard else unknowns).append(constraint["id"])
        elif kind == "entry_exit":
            if any(objects[value[key]]["entity_kind"] != "city" for key in ("entry_entity_id", "exit_entity_id")):
                unknowns.append(constraint["id"] + ":endpoint_mapping_not_implemented")
            elif (skeleton["stops"][0]["entity_id"] != value["entry_entity_id"] or
                    skeleton["stops"][-1]["entity_id"] != value["exit_entity_id"]):
                (violations if hard else unknowns).append(constraint["id"])
            if value["arrival"] and chosen_connections and chosen_connections[0][0] < instant(value["arrival"]):
                (violations if hard else unknowns).append(constraint["id"] + ":entry_time")
            if value["departure"] and chosen_connections and chosen_connections[-1][1] > instant(value["departure"]):
                (violations if hard else unknowns).append(constraint["id"] + ":exit_time")
            if not value["arrival"] or not value["departure"]:
                unknowns.append(constraint["id"] + ":boundary_time_missing")
    result["unknowns"] = sorted(set(unknowns))
    result["violations"] = sorted(set(violations))
    result["status"] = "blocked" if violations else "pending" if unknowns else "verified"
    return result


def validate_state(state):
    validate_shape("state", state)
    objects = index(state)
    require(len(objects) == len(state["objects"]), "DUPLICATE_ID", "对象 ID 重复")
    require(sum(o["type"] == "TripGoal" and o["status"] in ("active", "revised") for o in objects.values()) <= 1,
            "GOAL_AUTHORITY", "一趟旅行最多一个当前目标")

    def target(oid, kinds=None):
        require(oid in objects, "DANGLING_REF", f"引用不存在: {oid}")
        require(kinds is None or objects[oid]["type"] in kinds, "REF_TYPE", f"引用类型错误: {oid}")
        return objects[oid]

    def check_constraint_value(value, hardness):
        if value["kind"] == "budget":
            lower, upper = value["minimum_minor"], value["maximum_minor"]
            require(lower is None or upper is None or lower <= upper, "BUDGET_RANGE", "预算区间反向")
            require((value["mode"] == "ceiling") == (hardness == "hard"), "BUDGET_HARDNESS", "预算意向/区间为软，明确上限为硬")
            require(value["mode"] != "ceiling" or upper is not None, "BUDGET_MISSING", "硬上限必须明确金额")
            require(value["mode"] != "range" or lower is not None and upper is not None, "BUDGET_MISSING", "目标区间必须有上下界")
            require(bool(value["categories"]), "BUDGET_SCOPE", "费用口径不得为空")
        if value["kind"] == "date_window":
            require(value["start"] <= value["end"], "DATE_RANGE", "旅行日期反向")
        if value["kind"] == "entry_exit":
            target(value["entry_entity_id"], ["DestinationEntity"])
            target(value["exit_entity_id"], ["DestinationEntity"])
            require(not value["arrival"] or not value["departure"] or instant(value["arrival"]) < instant(value["departure"]), "DATE_RANGE", "入离境时间反向")
        if value["kind"] == "requirement":
            for oid in references(value["condition"]):
                target(oid)

    for o in objects.values():
        require(o["trip_id"] == state["trip_id"], "CROSS_TRIP", o["id"])
        scope = o["scope"]
        require((scope["kind"] in ("trip", "date")) == (len(scope["ids"]) == 0), "SCOPE", "全程/日期范围 ids 为空，其他局部范围须列出对象")
        if scope["kind"] == "date":
            require(scope["start"] <= scope["end"], "SCOPE", "适用日期范围反向")
        for oid in scope["ids"]:
            if scope["kind"] == "traveler":
                require(any(oid in goal["traveler_ids"] for goal in objects.values() if goal["type"] == "TripGoal"), "SCOPE", "参与人必须来自旅行目标登记")
            else:
                target(oid, ["DestinationEntity"] if scope["kind"] == "entity" else ["Skeleton"])
        for dep in o["dependencies"]:
            other = target(dep["object_id"])
            require(dep["version"] <= other["version"], "FUTURE_REF", "引用了未来版本")
            require(bool(dep["paths"]), "DEPENDENCY_PATH", "依赖必须列出字段")
            for path in dep["paths"]:
                node = other
                for segment in path.split("/")[1:]:
                    # A nullable parent means the dependent value is unknown, not absent.
                    if node is None:
                        break
                    if isinstance(node, dict):
                        require(segment in node, "DEPENDENCY_PATH", "依赖字段不存在")
                        node = node[segment]
                    else:
                        require(isinstance(node, list) and segment.isdigit() and int(segment) < len(node),
                                "DEPENDENCY_PATH", "依赖字段或数组位置不存在")
                        node = node[int(segment)]
        for field in ("condition", "reconsider_when"):
            if field in o:
                for oid in references(o[field]):
                    target(oid)
        kind = o["type"]
        if kind == "TripGoal":
            for oid in o["destination_ids"]:
                target(oid, ["DestinationEntity"])
        if kind == "Preference":
            for oid in o["subject_ids"]:
                target(oid, ["DestinationEntity", "Candidate", "Skeleton", "TripGoal"])
            require(bool(o["evidence_refs"]), "EVIDENCE", "偏好必须保留表达证据")
        if kind == "Constraint":
            check_constraint_value(o["value"], o["hardness"])
        if kind == "DestinationEntity" and o["parent_id"]:
            target(o["parent_id"], ["DestinationEntity"])
        if kind == "Candidate":
            require(bool(o["subject_ids"]), "CANDIDATE_SUBJECT", "候选须有实体")
            for oid in o["subject_ids"]:
                target(oid, ["DestinationEntity"])
            if o["candidate_kind"] in ("city", "experience"):
                require(len(o["subject_ids"]) == 1 and objects[o["subject_ids"][0]]["entity_kind"] == o["candidate_kind"],
                        "REF_TYPE", "单城市／体验候选须引用一个对应实体")
            if o["candidate_kind"] == "connection":
                require(len(o["subject_ids"]) == 2 and all(objects[oid]["entity_kind"] in ("city", "transport_node") for oid in o["subject_ids"]),
                        "REF_TYPE", "连接候选须给出两个有序城市／交通端点")
            for oid in o["preference_ids"]:
                target(oid, ["Preference"])
            for oid in o["issue_ids"]:
                target(oid, ["OpenIssue"])
            if o["status"] in ("excluded", "conditionally_excluded"):
                require(bool(o["exclusion_reason"]), "EXCLUSION_REASON", "排除须保留原因")
        if kind == "ExternalFact":
            for oid in o["subject_ids"]:
                target(oid)
            require(instant(o["observed_at"]) < instant(o["expires_at"]), "FACT_TIME", "失效时间必须晚于观察时间")
            require(o["valid_for"]["start"] <= o["valid_for"]["end"], "FACT_TIME", "事实适用日期反向")
            if o["query_status"] in ("empty", "timeout", "error"):
                require(o["value"] is None and o["verification"] == "unverified", "FALSE_VERIFICATION", "失败或空集不得有已核验结论")
            if o["verification"] in ("date_specific", "purchasable"):
                require(o["query_status"] in ("result", "no_service") and not o["missing_fields"] and o["query"]["date"] is not None and o["value"] is not None,
                        "FALSE_VERIFICATION", "核验缺少结果、日期或必需字段")
                if o["value"]["kind"] == "condition":
                    require(o["value"]["value"] is not None, "FALSE_VERIFICATION", "条件值未知不能核验成功")
            if o["value"] and o["value"]["kind"] == "transport":
                target(o["value"]["from_id"], ["DestinationEntity"])
                target(o["value"]["to_id"], ["DestinationEntity"])
                if o["verification"] in ("date_specific", "purchasable") and o["query_status"] == "result":
                    require(o["value"]["service_exists"] is True and o["value"]["departure"] is not None and o["value"]["arrival"] is not None,
                            "FALSE_VERIFICATION", "指定日期班次核验须明确服务存在与起止时间")
            if o["query_status"] == "no_service":
                require(o["value"] is not None and o["value"]["kind"] == "transport" and o["value"]["service_exists"] is False,
                        "NO_SERVICE_EVIDENCE", "证实无服务须有显式证据")
            profile = reservation_profile(o)
            if profile:
                city = target(profile["city_id"], ["DestinationEntity"])
                require(city["entity_kind"] == "city", "RESERVATION_PROFILE", "住宿回执须锚定城市")
        if kind == "Skeleton":
            require(o["purpose"] == "scenario" or not o["overrides"], "SCENARIO_LEAK", "规划版本不得携带假设覆盖")
            override_ids = [v["constraint_id"] for v in o["overrides"]]
            require(len(override_ids) == len(set(override_ids)), "SCENARIO_OVERRIDE", "同一约束不能有两个假设覆盖")
            for override in o["overrides"]:
                original = target(override["constraint_id"], ["Constraint"])
                require(override["value"]["kind"] == original["value"]["kind"], "SCENARIO_OVERRIDE", "假设覆盖不得改变约束种类")
                check_constraint_value(override["value"], original["hardness"])
            if o["parent_id"]:
                target(o["parent_id"], ["Skeleton"])
            for stop in o["stops"]:
                entity = target(stop["entity_id"], ["DestinationEntity"])
                require(entity["entity_kind"] == "city", "REF_TYPE", "城市级骨架的停留须引用城市")
            require(len(o["connections"]) == len(o["stops"]) - 1, "CONNECTION_COUNT", "连接须对应每对相邻停留")
            for n, connection in enumerate(o["connections"]):
                require(connection["from_id"] == o["stops"][n]["entity_id"] and connection["to_id"] == o["stops"][n+1]["entity_id"], "CONNECTION_ORDER", "连接顺序不一致")
                for fid in connection["fact_ids"]:
                    fact = target(fid, ["ExternalFact"])
                    require(fact["value"] is None or fact["value"]["kind"] == "transport", "REF_TYPE", "连接只能引用交通事实或查询失败记录")
            for fid in o["cost_fact_ids"]:
                fact = target(fid, ["ExternalFact"])
                require(fact["value"] is None or fact["value"]["kind"] == "cost", "REF_TYPE", "费用只能引用费用事实或查询失败记录")
        if kind == "Decision":
            subject = target(o["subject_id"], ["Skeleton"] if o["decision_kind"] == "adopt_skeleton" else ["Candidate"])
            require(o["subject_version"] <= subject["version"], "FUTURE_REF", "确认指向未来版本")
            for oid in o["basis_ids"]:
                target(oid)
            if o["supersedes"]:
                prior = target(o["supersedes"], ["Decision"])
                require(prior["decision_kind"] == o["decision_kind"] and
                        (o["decision_kind"] == "adopt_skeleton" or prior["subject_id"] == o["subject_id"]),
                        "DECISION_SCOPE", "只能替代同类、同候选范围的决定；骨架采用为旅行级范围")
            if o["status"] == "confirmed":
                require(o["confirmed_by"] is not None and o["confirmed_at"] is not None and bool(o["confirmation_scope"]), "CONFIRMATION", "确认缺少主体、时间或范围")
                expected_scope = {"cities", "order", "stays", "connections"} if o["decision_kind"] == "adopt_skeleton" else {"candidate"}
                require(set(o["confirmation_scope"]) == expected_scope, "CONFIRMATION_SCOPE", "确认范围不完整或含未知范围")
                require(o["decision_kind"] != "adopt_skeleton" or o["value"] == "accept", "DECISION_SCOPE", "采用骨架决定必须为接受")
        if kind == "OpenIssue":
            for oid in o["affected_ids"] + o["evidence_ids"]:
                target(oid)
            if o["status"] in ("resolved", "dismissed"):
                require(o["resolution"] is not None, "ISSUE_REASON", "关闭问题必须有理由")
    # Identity/version ancestry is not an ordinary association: it cannot loop.
    for origin in objects.values():
        field = "supersedes" if origin["type"] == "Decision" else "parent_id"
        if field not in origin:
            continue
        seen, current = set(), origin
        while current is not None:
            require(current["id"] not in seen, "LINEAGE_CYCLE", "实体／版本继承关系存在环")
            seen.add(current["id"])
            current = objects[current[field]] if current[field] else None
    # Only calculation/input dependency edges must be acyclic. Evidence/association may cycle.
    visiting, finished = set(), set()

    def visit(oid):
        require(oid not in visiting, "DEPENDENCY_CYCLE", "计算依赖存在环")
        if oid in finished:
            return
        visiting.add(oid)
        for dep in objects[oid]["dependencies"]:
            if dep["relation"] == "input":
                visit(dep["object_id"])
        visiting.remove(oid)
        finished.add(oid)
    for oid in objects:
        visit(oid)
    active_receipts = [reservation_profile(o) for o in objects.values()
                       if o["type"] == "ExternalFact" and o["status"] == "active"]
    refs = [p["confirmation_ref"] for p in active_receipts if p]
    require(len(refs) == len(set(refs)), "RESERVATION_PROFILE", "同一预订回执不能有两个当前版本")
    preference_successors = {oid: [] for oid, o in objects.items() if o["type"] == "Preference"}
    for successor in objects.values():
        if successor["type"] != "Preference":
            continue
        for dep in successor["dependencies"]:
            if dep["relation"] == "association" and "/status" in dep["paths"] and dep["object_id"] in preference_successors:
                preference_successors[dep["object_id"]].append(successor["id"])
    for oid, successors in preference_successors.items():
        if objects[oid]["status"] == "superseded":
            require(bool(successors), "PREFERENCE_SUCCESSOR", "被替代偏好必须有可追溯的后继表达；单纯撤回应使用 withdrawn")
    visiting, finished = set(), set()
    def visit_preference(oid):
        require(oid not in visiting, "LINEAGE_CYCLE", "偏好替代谱系存在环")
        if oid in finished:
            return
        visiting.add(oid)
        for child in preference_successors[oid]:
            visit_preference(child)
        visiting.remove(oid)
        finished.add(oid)
    for oid in preference_successors:
        visit_preference(oid)
    effective = state["effective_skeleton_id"]
    adopted = [o for o in objects.values() if o["type"] == "Decision" and o["status"] == "confirmed" and o["decision_kind"] == "adopt_skeleton"]
    require(len(adopted) == (1 if effective else 0), "ADOPTION_AUTHORITY", "当前采用引用与有效确认决定数量不一致")
    choices = [o["subject_id"] for o in objects.values() if o["type"] == "Decision" and o["status"] == "confirmed" and o["decision_kind"] == "candidate_choice"]
    require(len(choices) == len(set(choices)), "DECISION_AUTHORITY", "同一候选不可同时有多个有效选择")
    if effective:
        skeleton = target(effective, ["Skeleton"])
        require(skeleton["purpose"] == "plan" and skeleton["status"] == "active", "EFFECTIVE_SKELETON", "当前骨架必须为活动规划版本")
        matching = [o for o in objects.values() if o["type"] == "Decision" and o["status"] == "confirmed"
                    and o["decision_kind"] == "adopt_skeleton" and o["subject_id"] == effective and o["value"] == "accept"]
        require(len(matching) == 1, "ADOPTION_AUTHORITY", "当前骨架必须有唯一确认决定")
