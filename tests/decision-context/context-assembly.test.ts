import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assembleContextSnapshot, validateContextSnapshot } from "../../src/server/decision-context/context-assembly";
import { parseContract } from "../../src/server/trip-state/contracts";
import { planCommand } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, object } from "../support/bcg-fixtures";
import { clock, uuids } from "../support/command-fixtures";

const now = () => new Date("2030-01-01T00:00:00Z");
const clone = () => structuredClone(base);
const assemble = (s: State, targets: string[] = ["skeleton-a"], at = now()) => assembleContextSnapshot(s, "task-test", targets, at);
const adopt: TripStateContracts["command"] = { op: "adopt_skeleton", id: "skeleton-a", acknowledge_unknowns: true, confirmation_scope: ["cities", "order", "stays", "connections"] };

function reference(state: State, targets: string[], at = now()): Record<string, unknown> {
  const python = `import json,sys\nfrom datetime import datetime\nsys.path.insert(0,'specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包')\nfrom tripstate.engine import Store\nx=json.load(sys.stdin)\ns=x['state']; seeds=set(x['targets'])\nseeds.update(o['id'] for o in s['objects'] if (o['type']=='TripGoal' and o['status'] in ('active','revised')) or (o['type']=='Preference' and o['status']=='active'))\nc=Store(s,clock=lambda:datetime.fromisoformat(x['now'].replace('Z','+00:00'))).context({'task_id':'task-test','selected_object_ids':sorted(seeds)})\nprint(json.dumps(c,ensure_ascii=False))`;
  return JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["-c", python], {
    input: JSON.stringify({ state, targets, now: at.toISOString() }), encoding: "utf8", timeout: 20000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })) as Record<string, unknown>;
}

const compared = ["selected_object_ids", "must_include_constraints", "active_decisions", "open_issues", "relevant_facts", "assembled_from_versions", "stale_fact_ids", "expires_at"] as const;

describe("E03-02 same-snapshot context assembly and consumption", () => {
  it("hydrates exact complete object bodies and versions and matches the original TS context", () => {
    const state = clone(), old = structuredClone(state), result = assemble(state), original = reference(state, ["skeleton-a"]);
    parseContract("DecisionContext", result.context);
    for (const field of compared) expect(result.context[field], field).toEqual(original[field]);
    expect(result.context.trip_id).toBe(state.trip_id); expect(result.context.state_revision).toBe(state.revision);
    expect(result.objects.map(o => o.id)).toEqual(result.context.selected_object_ids);
    expect(result.objects.map(o => ({ id:o.id, version:o.version }))).toEqual(result.context.assembled_from_versions);
    expect(result.objects).toEqual(result.context.selected_object_ids.map(id => state.objects.find(o => o.id === id)));
    for (const id of [...result.context.must_include_constraints, ...result.context.open_issues]) expect(result.context.selected_object_ids).toContain(id);
    expect(result.snapshot_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(state).toEqual(old); expect(() => validateContextSnapshot(result, state, now())).not.toThrow();
  });

  it("keeps confirmed stale decisions and referenced bases in protection with a decision limitation", () => {
    const state = planCommand(clone(), change(base, [adopt]), { role:"user", id:"scenario-user" }, clock, uuids(2000)).snapshot;
    const decision = state.objects.find(o => o.type === "Decision" && o.status === "confirmed");
    if (!decision || decision.type !== "Decision") throw new Error("Missing source decision");
    decision.review_state = "stale";
    const result = assemble(state), annotation = result.annotations.find(a => a.id === decision.id);
    expect(result.context.active_decisions).toContain(decision.id);
    expect(result.context.selected_object_ids).toEqual(expect.arrayContaining([decision.id, decision.subject_id, ...decision.basis_ids]));
    expect(annotation).toMatchObject({ retained:true, restriction:"decision_limit" });
    expect(annotation?.reason_codes).toContain("not_current_authorization");
  });

  it("caps a context at the next selected fact expiry with microsecond precision", () => {
    const state = clone(), fact = object(state, "fact-cairo-luxor", "ExternalFact");
    fact.expires_at = "2030-01-01T00:00:00.000001Z";
    const result = assemble(state), original = reference(state, ["skeleton-a"]);
    expect(result.context.expires_at).toBe("2030-01-01T00:00:00.000001Z");
    expect(result.context.expires_at).toEqual(original.expires_at);
    expect(() => validateContextSnapshot(result, state, now())).not.toThrow();
    expect(() => validateContextSnapshot(result, state, new Date("2030-01-01T00:00:00.001Z"))).toThrowError(expect.objectContaining({ code:"PACKET_EXPIRED" }));
  });

  it("normalizes offset expiry to the same UTC representation as the locked source", () => {
    const state = clone(); object(state, "fact-cairo-luxor", "ExternalFact").expires_at = "2030-01-01T02:00:00.000001+02:00";
    const result = assemble(state), original = reference(state, ["skeleton-a"]);
    expect(result.context.expires_at).toEqual(original.expires_at);
  });

  it("marks opposite usable same-scope facts contested rather than treating them as reliable", () => {
    const state = clone(), source = object(state, "fact-cairo-luxor", "ExternalFact"), opposite = structuredClone(source);
    opposite.id = "fact-no-service"; opposite.provider = "SECOND_TEST_PROVIDER"; opposite.query_status = "no_service";
    if (opposite.value?.kind !== "transport") throw new Error("transport fixture");
    Object.assign(opposite.value, { service_exists:false, departure:null, arrival:null, duration_minutes:null });
    state.objects.push(opposite);
    const result = assemble(state), original = reference(state, ["skeleton-a"]);
    for (const field of compared) expect(result.context[field], field).toEqual(original[field]);
    expect(result.context.stale_fact_ids).toContain(source.id);
    expect(result.annotations.find(a => a.id === source.id)).toMatchObject({ restriction:"decision_limit", reason_codes:expect.arrayContaining(["fact_contested"]) });
    expect(result.annotations.find(a => a.id === "cost-transport")).toMatchObject({ restriction:"none" });
  });

  it("does not convert unknown conditions to false or silently substitute missing references", () => {
    const state = clone(), pref = object(state, "pref-culture", "Preference");
    pref.condition = { op:"lt", object_id:"constraint-budget", path:"/value/minimum_minor", value:100 };
    const result = assemble(state);
    expect(result.annotations.find(a => a.id === pref.id)).toMatchObject({ retained:true, applicability:"unknown" });
    const missing = clone(), candidate = object(missing, "candidate-luxor", "Candidate");
    candidate.dependencies = [{ object_id:"missing", version:1, paths:["/status"], relation:"association" }];
    expect(() => assemble(missing, [candidate.id])).toThrow();
    expect(() => assemble(clone(), ["missing"])).toThrow();
  });

  it("limits facts with unknown query dates instead of claiming applicability", () => {
    const state = clone(), fact = object(state, "fact-cairo-luxor", "ExternalFact");
    fact.query.date = null; fact.verification = "unverified";
    const result = assemble(state), row = result.annotations.find(a => a.id === fact.id);
    expect(result.context.stale_fact_ids).toContain(fact.id);
    expect(row).toMatchObject({ applicability:"unknown", restriction:"decision_limit", reason_codes:expect.arrayContaining(["fact_unusable", "check_current_dates_not_revision_only"]) });
  });

  it("refuses consumption after revision changes or unversioned body changes", () => {
    const state = clone(), result = assemble(state), advanced = structuredClone(state);
    advanced.revision += 1;
    expect(() => validateContextSnapshot(result, advanced, now())).toThrowError(expect.objectContaining({ code:"PACKET_STALE" }));
    const tampered = structuredClone(state); object(tampered, "pref-culture", "Preference").expression = "body changed without revision";
    expect(() => validateContextSnapshot(result, tampered, now())).toThrowError(expect.objectContaining({ code:"PACKET_STALE" }));
  });

  it("refuses altered selected object bodies, versions, or protected manifest", () => {
    const state = clone(), result = assemble(state);
    const body = structuredClone(result); body.objects[0].version += 1;
    expect(() => validateContextSnapshot(body, state, now())).toThrow();
    const versions = structuredClone(result); versions.context.assembled_from_versions[0].version += 1;
    expect(() => validateContextSnapshot(versions, state, now())).toThrow();
    const protectedSet = structuredClone(result); protectedSet.context.must_include_constraints = [];
    expect(() => validateContextSnapshot(protectedSet, state, now())).toThrow();
  });

  it("rejects expired packets while a freshly rebuilt context limits expired evidence", () => {
    const state = clone(), old = assemble(state), later = new Date("2030-01-02T00:00:00Z");
    expect(() => validateContextSnapshot(old, state, later)).toThrowError(expect.objectContaining({ code:"PACKET_EXPIRED" }));
    const fresh = assemble(state, ["skeleton-a"], later);
    expect(fresh.context.stale_fact_ids).toContain("fact-cairo-luxor");
    expect(fresh.annotations.find(a => a.id === "fact-cairo-luxor")).toMatchObject({ restriction:"decision_limit", reason_codes:expect.arrayContaining(["fact_unusable"]) });
    expect(state.revision).toBe(old.context.state_revision);
  });
});
