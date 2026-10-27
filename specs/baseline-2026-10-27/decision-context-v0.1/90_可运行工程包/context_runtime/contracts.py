"""Single declaration source for runtime 0.2.0, including durable scene recovery."""
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from tripstate.rules import SCHEMAS as TRIP_SCHEMAS

VERSION = "0.2.0"
NS = "https://decision-context.example/runtime/0.2/"


def obj(properties, required=None):
    return dict(type="object", properties=properties,
                required=list(properties) if required is None else required, additionalProperties=False)


def array(items, minimum=0, unique=False):
    return dict(type="array", items=items, minItems=minimum, uniqueItems=unique)


def enum(*values):
    return dict(type="string", enum=list(values))


def ref(name):
    return {"$ref": "#/$defs/" + name}


ID = dict(type="string", pattern="^[A-Za-z][A-Za-z0-9_-]{0,95}$")
TEXT = dict(type="string", minLength=1, maxLength=16000)
INTEGER = dict(type="integer", minimum=0)
IDS = array(ID, unique=True)
NULL_ID = {"anyOf": [ID, {"type": "null"}]}
DATE = dict(type="string", format="date-time")


def definitions():
    span = obj(dict(start=INTEGER, end=INTEGER, quote=TEXT))
    task = obj(dict(task_key=ID, question=TEXT,
                    kind=enum("explore", "candidate_tradeoff", "skeleton_choice", "constraint_adjustment"),
                    target_ids=IDS, branch=enum("actual", "hypothetical"),
                    relation=enum("new", "continue", "refine", "resume", "reopen", "focus"),
                    related_task_keys=IDS, certainty=enum("explicit", "inferred", "ambiguous"),
                    evidence=array(ref("span"), 1), progress=enum("open", "paused", "handled"),
                    progress_evidence={"anyOf": [ref("span"), {"type": "null"}]}))
    event = obj(dict(event_id=ID, entry=enum("dialogue", "map", "timeline", "comparison"),
                     text=TEXT, reference=TEXT, received_at=DATE))
    pending = obj(dict(event=ref("event"), base_revision=INTEGER,
                       processing_status=enum("unprocessed", "proposed", "pending_confirmation", "applied", "rejected", "conflict"),
                       proposal_id=NULL_ID, result_revision=INTEGER,
                       errors=array(obj(dict(code=TEXT, message=TEXT)))))
    annotation = obj(dict(id=ID, retained=dict(type="boolean"),
                          applicability=enum("applicable", "not_applicable", "unknown"),
                          restriction=enum("none", "decision_limit", "known_conflict"),
                          presentation=enum("policy_judgment", "suppressed_unchanged", "limitation_if_used"),
                          reason_codes=array(TEXT), evidence_ids=IDS))
    version_ref = obj(dict(id=ID, version=dict(type="integer", minimum=1)))
    view = obj(dict(entry=enum("dialogue", "map", "timeline", "comparison"), comparison_refs=array(version_ref),
                    selected_id=NULL_ID, expanded_task_keys=IDS))
    draft = obj(dict(draft_id=ID, draft_kind=enum("unsubmitted", "hypothetical"), base_revision=INTEGER,
                     target_ids=IDS, text=TEXT, source_reference=TEXT,
                     proposal={"anyOf": [{"$ref": TRIP_SCHEMAS["change-request"]["$id"]}, {"type": "null"}]}))
    saved_task = obj(dict(task=ref("task"), event=ref("event"), base_revision=INTEGER,
                         processing_status=pending["properties"]["processing_status"], result_revision=INTEGER,
                         errors=pending["properties"]["errors"]))
    checkpoint = obj(dict(checkpoint_format_version={"const": 1}, trip_id=ID, captured_state_revision=INTEGER,
        captured_object_versions=array(version_ref), tasks={**array(saved_task), "maxItems": 128},
        focus_keys=IDS, view=ref("view"), drafts={**array(ref("draft")), "maxItems": 20}, deferred_issue_ids=IDS))
    ack = obj(dict(workspace_key=ID, checkpoint_revision=dict(type="integer", minimum=1), saved_at=DATE,
                   expires_at={"anyOf": [DATE, {"type": "null"}]},
                   payload_digest={"anyOf": [dict(type="string", pattern="^[0-9a-f]{64}$"), {"type": "null"}]},
                   durable={"const": True}, deleted=dict(type="boolean")))
    return dict(span=span, task=task, event=event, pending=pending, annotation=annotation,
                view=view, draft=draft, checkpoint=checkpoint, ack=ack)


def schemas():
    common = dict(runtime_contract_version={"const": VERSION})
    docs = {}
    docs["open-turn"] = obj(dict(**common, trip_id=ID, expected_revision=INTEGER,
                                  event=ref("event"), tasks=array(ref("task"), 1), focus_keys=array(ID, 1, True)))
    docs["turn"] = obj(dict(**common, runtime_id=ID, turn_id=ID, revision=INTEGER, tasks=array(ref("task"), 1), focus_keys=array(ID, 1, True),
                           checkpoint_ack={"anyOf": [ref("ack"), {"type": "null"}]}))
    docs["assemble"] = obj(dict(**common, turn_id=ID, task_key=ID, body_budget_bytes=dict(type="integer", minimum=2, maximum=10000000)))
    docs["page-request"] = obj(dict(**common, packet_id=ID, object_ids=array(ID, 1, True)))
    business = [name for name in ("TripGoal", "Preference", "Constraint", "DestinationEntity", "Candidate", "ExternalFact", "Skeleton", "Decision", "OpenIssue")]
    object_body = {"anyOf": [{"$ref": TRIP_SCHEMAS[k]["$id"]} for k in business]}
    docs["page"] = obj(dict(**common, packet_id=ID, state_revision=INTEGER, objects=array(object_body),
                            remaining_ids=IDS, delivery_only_not_model_comprehension={"const": True}))
    docs["packet"] = obj(dict(**common, packet_id=ID, turn_id=ID, task=ref("task"),
        context={"$ref": TRIP_SCHEMAS["DecisionContext"]["$id"]}, pending_input=ref("pending"),
        objects=array(object_body), deferred_ids=IDS,
        coverage=enum("complete", "layered", "limited"),
        evidence_checked_at=DATE, snapshot_digest=dict(type="string", pattern="^[0-9a-f]{64}$"),
        annotations=array(ref("annotation")),
        support=enum("decision_support", "information_only"), warnings=array(TEXT)))
    docs["change"] = obj(dict(**common, turn_id=ID, packet_id=ID,
                               request={"$ref": TRIP_SCHEMAS["change-request"]["$id"]}))
    docs["confirm"] = obj(dict(**common, turn_id=ID, proposal_id=ID,
                                request={"$ref": TRIP_SCHEMAS["confirm-request"]["$id"]}))
    docs["error"] = obj(dict(**common, code=TEXT, message=TEXT, retryable=dict(type="boolean")))
    docs["checkpoint-payload"] = ref("checkpoint")
    docs["scene-save"] = obj(dict(**common, workspace_key=ID, expected_checkpoint_revision=INTEGER, idempotency_key=ID,
        focus_keys=IDS, view=ref("view"), drafts={**array(ref("draft")), "maxItems": 20}))
    docs["scene-restore"] = obj(dict(**common, workspace_key=ID, body_budget_bytes=dict(type="integer", minimum=2, maximum=10000000)))
    docs["scene-delete"] = obj(dict(**common, workspace_key=ID, expected_checkpoint_revision=INTEGER, idempotency_key=ID))
    docs["scene-list"] = obj(common)
    docs["scene-status"] = obj(common)
    docs["scene-retry"] = obj(common)
    docs["scene-status-result"] = obj(dict(**common, recovery_available=dict(type="boolean"),
        last_acknowledged_revision=INTEGER, current_checkpoint_revision=INTEGER,
        save_pending=dict(type="boolean"), last_error={"anyOf": [TEXT, {"type": "null"}]}))
    docs["scene-ack"] = obj(dict(**common, ack=ref("ack")))
    docs["scene-list-result"] = obj(dict(**common, checkpoints=array(obj(dict(workspace_key=ID,
        checkpoint_revision=dict(type="integer", minimum=1), saved_at=DATE,
        expires_at={"anyOf": [DATE, {"type": "null"}]}, available=dict(type="boolean"))))))
    docs["scene-restored"] = obj(dict(**common, workspace_key=ID, checkpoint_revision=dict(type="integer", minimum=1),
        runtime_id=ID, saved_state_revision=INTEGER, current_state_revision=INTEGER, saved_at=DATE, view=ref("view"),
        drafts=array(ref("draft")), focus_keys=IDS, restored_turns=array(obj(dict(task_key=ID, turn_id=ID))),
        packets=array({"$ref": NS+"packet.schema.json"}), warnings=array(TEXT), stale_draft_ids=IDS,
        missing_target_ids=IDS, stale_comparison_ids=IDS, deferred_issue_ids=IDS, reopened_issue_ids=IDS, recovery_requires_new_authorization={"const": True}))
    for name, schema in docs.items():
        schema.update({"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": NS + name + ".schema.json",
                       "title": name, "$defs": definitions()})
    return docs


SCHEMAS = schemas()
REGISTRY = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in [*TRIP_SCHEMAS.values(), *SCHEMAS.values()])


def validate(name, value):
    Draft202012Validator(SCHEMAS[name], registry=REGISTRY, format_checker=FormatChecker()).validate(value)
