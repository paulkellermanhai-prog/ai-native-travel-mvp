"""Synthetic fixtures. All dates, schedules, prices and providers are TEST DATA."""
from copy import deepcopy
from datetime import datetime, timezone
from .rules import blank_assessment

NOW = datetime(2030, 1, 1, 0, 0, tzinfo=timezone.utc)
AT = "2030-01-01T00:00:00Z"
TRIP = "trip-egypt-test"


def base(oid, kind, status, **data):
    return dict(id=oid, type=kind, trip_id=TRIP, version=1, status=status,
                scope=dict(kind="trip", ids=[]), source=dict(actor="user", actor_id="user-demo",
                reference="synthetic-input", text="测试材料，不代表真实用户或现实交通", at=AT),
                dependencies=[], updated_at=AT, **data)


def entity(oid, name, kind="city", parent=None):
    return base(oid, "DestinationEntity", "known", entity_kind=kind, name=name, parent_id=parent,
                geo_identity=None, knowledge_refs=["synthetic-catalog"], coverage="partial")


def preference(oid="pref-culture", certainty="explicit"):
    return base(oid, "Preference", "active", subject_ids=["luxor"], aspect="文化体验", polarity="positive",
                certainty=certainty, support="supported", priority="important", expression="我喜欢文化体验；不代表必须去某座城",
                condition={"op": "always"}, evidence_refs=["synthetic-dialogue-1"])


def fact(oid="fact-cairo-luxor", **updates):
    data = dict(subject_ids=["cairo", "luxor"], query=dict(date="2030-01-12", parameters=[]),
                provider="TEST_ONLY_PROVIDER", query_status="result", verification="date_specific",
                freshness="current", applicability="applicable", observed_at=AT, expires_at="2030-01-02T00:00:00Z",
                valid_for=dict(start="2030-01-12", end="2030-01-12"), missing_fields=[],
                value=dict(kind="transport", from_id="cairo", to_id="luxor", departure="2030-01-12T10:00:00+02:00",
                           arrival="2030-01-12T11:00:00+02:00", duration_minutes=60, service_exists=True))
    data.update(updates)
    obj = base(oid, "ExternalFact", "active", **data)
    obj["source"].update(actor="tool", actor_id="test-provider", reference="synthetic-result")
    return obj


def skeleton(oid="skeleton-a", purpose="plan"):
    return base(oid, "Skeleton", "active", purpose=purpose,
                stops=[dict(entity_id="cairo", nights=2), dict(entity_id="luxor", nights=2)],
                connections=[dict(from_id="cairo", to_id="luxor", fact_ids=["fact-cairo-luxor"])],
                cost_fact_ids=["cost-transport"], parent_id=None, overrides=[],
                tradeoffs=dict(gains=["文化体验"], losses=["转场时间"]), assessment=blank_assessment())


def candidate(oid="candidate-luxor", subject="luxor"):
    return base(oid, "Candidate", "retained", subject_ids=[subject], candidate_kind="city",
                inclusion_reason="文化兴趣", exclusion_reason=None,
                reconsider_when=dict(op="gte", object_id="constraint-nights", path="/value/maximum_nights", value=4),
                preference_ids=["pref-culture"], issue_ids=[], review_state="current")


def minimal_state():
    return dict(schema_version="0.1.0", trip_id=TRIP, revision=0, effective_skeleton_id=None, objects=[])


def initial_state():
    state = minimal_state()
    state["objects"] = [
        entity("egypt", "埃及", "country"), entity("cairo", "开罗", parent="egypt"),
        entity("luxor", "卢克索", parent="egypt"), entity("aswan", "阿斯旺", parent="egypt"),
        base("goal", "TripGoal", "active", destination_ids=["egypt"], purpose="测试多城市旅行骨架",
             success_definition="理解取舍、保留核验边界", traveler_ids=["traveler-demo"], current_task="compare"),
        preference(),
        base("constraint-dates", "Constraint", "active", hardness="hard", override_policy="user",
             value=dict(kind="date_window", start="2030-01-10", end="2030-01-14")),
        base("constraint-nights", "Constraint", "active", hardness="hard", override_policy="user",
             value=dict(kind="duration", maximum_nights=4)),
        base("constraint-budget", "Constraint", "active", hardness="soft", override_policy="user",
             value=dict(kind="budget", mode="intent", minimum_minor=None, maximum_minor=2000000,
                        currency="CNY", people=2, categories=["transport", "experience", "lodging", "food"])),
        candidate(), candidate("candidate-aswan", "aswan"), fact(),
        fact("cost-transport", value=dict(kind="cost", amount_minor=120000, currency="CNY", people=2,
                                         category="transport", item_key="synthetic-cairo-luxor-fare")),
        skeleton(),
        base("issue-cost", "OpenIssue", "open", issue_kind="missing", question="住宿餐饮尚未取得费用依据",
             affected_ids=["skeleton-a"], severity="warning", required_inputs=["lodging_cost", "food_cost"],
             candidate_actions=["verify"], owner="provider", resolution=None, evidence_ids=[]),
    ]
    return state


def request(store_or_revision, *commands, key="test-key", reason="测试明确修改"):
    revision = store_or_revision if isinstance(store_or_revision, int) else store_or_revision.get_state()["revision"]
    return dict(expected_revision=revision, idempotency_key=key, reason=reason,
                input=dict(kind="dialogue", reference="synthetic-input", text=reason, target_ids=[]), commands=list(commands))


def adopt(oid="skeleton-a", acknowledge=True):
    return dict(op="adopt_skeleton", id=oid, acknowledge_unknowns=acknowledge,
                confirmation_scope=["cities", "order", "stays", "connections"])


def create_command(o):
    from .contracts import FIELDS, DERIVED
    return dict(op="create", object_type=o["type"], id=o["id"], scope=deepcopy(o["scope"]),
                dependencies=deepcopy(o["dependencies"]),
                data={k: deepcopy(o[k]) for k in FIELDS[o["type"]] if k not in DERIVED.get(o["type"], set())})


def ingest_command(o):
    from .contracts import FIELDS, DERIVED
    return dict(op="ingest_fact", id=o["id"], scope=deepcopy(o["scope"]), dependencies=deepcopy(o["dependencies"]),
                data={k: deepcopy(o[k]) for k in FIELDS["ExternalFact"] if k not in DERIVED["ExternalFact"]})
