"""UX-02 history restoration compiler; emits existing atomic commands, never writes.

The authenticated host supplies a NEW input and presents the normal TS preview.
Historical source content is not authorization, current facts, or current tradeoffs.
"""
from copy import deepcopy
from .rules import require, validate_state, validate_shape, index


def restoration_request(state, *, source_id, source_version, new_id, expected_revision, idempotency_key,
                        input, reason, city_id=None, insert_at=None, acknowledge_unknowns=False, history=None):
    validate_state(state)
    require(expected_revision == state["revision"], "VERSION_CONFLICT", "恢复基准已变，重新预览")
    objects = index(state)
    require(type(source_version) is int and source_version > 0, "SCHEMA", "必须指定历史来源版本")
    candidates = [objects.get(source_id)]
    for change in (history or {}).get("changes", []):
        if change["outcome"] == "applied" and change["trip_id"] == state["trip_id"] and change["result_revision"] <= state["revision"]:
            for diff in change["diff"]:
                if diff["id"] == source_id:
                    candidates.extend([diff["before"], diff["after"]])
    candidates = [o for o in candidates if o and o["type"] == "Skeleton" and o["id"] == source_id and o["trip_id"] == state["trip_id"] and o["version"] == source_version]
    require(bool(candidates), "RESTORE_SOURCE_VERSION", "所选历史来源版本不可用")
    require(all(o == candidates[0] for o in candidates), "RESTORE_SOURCE_INTEGRITY", "同一历史版本的来源不一致")
    source = candidates[0]
    require(source["purpose"] == "plan",
            "RESTORE_SOURCE", "恢复来源必须是历史规划骨架")
    require(new_id not in objects, "DUPLICATE_ID", "恢复必须生成新骨架")
    current_id = state["effective_skeleton_id"]
    current = objects.get(current_id)
    if city_id is None:
        require(insert_at is None, "RESTORE_SCOPE", "整份恢复不接受城市位置")
        stops = deepcopy(source["stops"])
        connections = deepcopy(source["connections"])
        costs = list(source["cost_fact_ids"])
    else:
        require(current is not None, "RESTORE_SCOPE", "城市恢复需要当前有效骨架")
        selected = [s for s in source["stops"] if s["entity_id"] == city_id]
        require(len(selected) == 1, "RESTORE_SCOPE", "来源必须包含目标城市")
        stops = deepcopy(current["stops"])
        positions = [i for i, s in enumerate(stops) if s["entity_id"] == city_id]
        if positions:
            require(insert_at is None, "RESTORE_SCOPE", "已有城市保持当前顺序；改序须单独预览")
            stops[positions[0]] = deepcopy(selected[0])
        else:
            require(type(insert_at) is int and 0 <= insert_at <= len(stops),
                    "RESTORE_POSITION_REQUIRED", "城市已不在当前方案，需明确插入位置")
            stops.insert(insert_at, deepcopy(selected[0]))
        connections = []
        for a, b in zip(stops, stops[1:]):
            left, right = a["entity_id"], b["entity_id"]
            pool = source["connections"] if city_id in (left, right) else current["connections"]
            edge = next((c for c in pool if c["from_id"] == left and c["to_id"] == right), None)
            connections.append(deepcopy(edge) if edge else dict(from_id=left, to_id=right, fact_ids=[]))
        def touches(oid):
            fact = objects.get(oid)
            return fact is not None and fact["type"] == "ExternalFact" and city_id in fact["subject_ids"]
        costs = list(dict.fromkeys([oid for oid in current["cost_fact_ids"] if not touches(oid)] +
                                  [oid for oid in source["cost_fact_ids"] if touches(oid)]))
    # No historical constraint overrides, assessment, Decision, authorization or fact value is replayed.
    # Unaffected business objects stay in the current aggregate. Dependencies are rebuilt by TS recalc.
    data = dict(purpose="plan", stops=stops, connections=connections, cost_fact_ids=costs,
                parent_id=current_id, overrides=[], tradeoffs=dict(gains=[], losses=[]))
    targets = list(dict.fromkeys([*input["target_ids"], source_id, *([current_id] if current_id else []),
                                 *([city_id] if city_id else [])]))
    body = dict(expected_revision=expected_revision, idempotency_key=idempotency_key,
                input=dict(deepcopy(input), target_ids=targets),
                reason=reason + " | UX02 restore source=" + source_id + " version=" + str(source_version) + (" city=" + city_id if city_id else " whole"),
                commands=[dict(op="create", object_type="Skeleton", id=new_id,
                               scope=dict(kind="trip", ids=[]), dependencies=[], data=data),
                          dict(op="adopt_skeleton", id=new_id, acknowledge_unknowns=acknowledge_unknowns,
                               confirmation_scope=["cities", "order", "stays", "connections"])])
    validate_shape("change-request", body)
    return body


def restoration_impact(state, request, clock=None):
    """Read-only candidate calculation, including blocked cases; never a write grant."""
    from .engine import Store, Actor
    shadow = Store(state, clock=clock)
    calculation = deepcopy(request)
    calculation["commands"] = [calculation["commands"][0], dict(op="recalculate", id=request["commands"][0]["id"])]
    return shadow.preview(calculation, Actor("system", "restoration-preview-calculator"))
