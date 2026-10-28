import { describe, expect, it } from "vitest";
import { planCommand, type Actor, type CommandRequest } from "../../src/server/trip-state/commands";
import { TripStateContractError } from "../../src/server/trip-state/contracts";
import type { State } from "../../src/server/trip-state/contracts.generated";
import { base, bcg, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, uuids, oracle, traces, type Audit } from "../support/command-fixtures";

const user: Actor = { role: "user", id: "scenario-user" }, system: Actor = { role: "system", id: "scenario-system" }, model: Actor = { role: "model", id: "scenario-ai" };
const excluded = bcg[0].trace.steps[0].state_after;
const adopted = traces.find((t) => t.scenario.startsWith("D-"))!.steps[0].state_after;
function compare(state: State, request: CommandRequest, actor = user, now = clock, expectedError?: string) {
  const before = structuredClone(state), python = oracle<Array<{ response: { outcome: string; errors: Array<{ code: string }> }; state_after: State; audit: Audit }>>({ initial: state, operations: [{ request, actor }], clock: now().toISOString(), uuidStart: 2000 })[0];
  if (expectedError) expect(python.response.errors[0]?.code).toBe(expectedError);
  if (python.response.outcome === "rejected" || python.response.outcome === "conflict") {
    expect(() => planCommand(state, request, actor, now, uuids(2000))).toThrowError(expect.objectContaining({ code: python.response.errors[0].code }));
    expect(python.state_after).toEqual(before); expect(python.audit).toEqual({ intents: [], changes: [] }); expect(state).toEqual(before);
    return null;
  }
  const batch = planCommand(state, request, actor, now, uuids(2000));
  expect(batch.response).toEqual(python.response); expect(batch.snapshot).toEqual(python.state_after);
  expect({ intents: [batch.intent], changes: [batch.change] }).toEqual(python.audit); expect(state).toEqual(before);
  return batch;
}

describe("E02-04B lifecycle and retained preference authority", () => {
  it("supersedes a shared expression only with a same-transaction successor association and preserves evidence", () => {
    const next = createFrom(object(base, "pref-culture", "Preference"), "pref-successor");
    if (next.op !== "create") throw new Error("Invalid fixture");
    next.dependencies = [{ object_id: "pref-culture", version: 1, paths: ["/status"], relation: "association" }];
    const request = change(base, [{ op: "transition", id: "pref-culture", event: "supersede" }, next]);
    const batch = compare(base, request)!;
    expect(object(batch.snapshot, "pref-culture", "Preference")).toMatchObject({ status: "superseded", evidence_refs: object(base, "pref-culture", "Preference").evidence_refs });
    expect(object(batch.snapshot, "pref-successor", "Preference").dependencies[0]).toMatchObject({ object_id: "pref-culture", relation: "association", paths: ["/status"] });
    for (const id of ["candidate-luxor", "candidate-aswan"]) expect(object(batch.snapshot, id, "Candidate")).toMatchObject({ review_state: "stale", preference_ids: ["pref-culture"] });
  });
  it("rejects superseding without a successor, atomically", () => { compare(base, change(base, [{ op: "transition", id: "pref-culture", event: "supersede" }]), user, clock, "PREFERENCE_SUCCESSOR"); });
  it("withdraws an expression while retaining evidence and both candidate links", () => {
    const batch = compare(base, change(base, [{ op: "transition", id: "pref-culture", event: "withdraw" }]))!;
    expect(object(batch.snapshot, "pref-culture", "Preference").evidence_refs).toEqual(object(base, "pref-culture", "Preference").evidence_refs);
    expect(batch.snapshot.objects).toHaveLength(base.objects.length + 1); // Formal dependency OpenIssue; nothing is deleted.
  });
  it.each(["false", "unknown", "wrong-trigger", "always-without-trigger-reference", "model", "direct-transition", "retain-bypass"])("rejects invalid reconsider path %s without treating unknown as true", (kind) => {
    const state = structuredClone(excluded), c = object(state, "candidate-luxor", "Candidate");
    let actor = system; let commands: CommandRequest["commands"] = [{ op: "reconsider", id: c.id, trigger_id: "constraint-nights" }];
    if (kind === "false") c.reconsider_when = { op: "gt", object_id: "constraint-nights", path: "/value/maximum_nights", value: 100 };
    if (kind === "unknown") c.reconsider_when = { op: "eq", object_id: "cairo", path: "/geo_identity", value: "unknown" };
    if (kind === "unknown") commands = [{ op: "reconsider", id: c.id, trigger_id: "cairo" }];
    if (kind === "wrong-trigger") commands = [{ op: "reconsider", id: c.id, trigger_id: "cairo" }];
    if (kind === "always-without-trigger-reference") c.reconsider_when = { op: "always" };
    if (kind === "model") actor = model;
    if (kind === "direct-transition") commands = [{ op: "transition", id: c.id, event: "reconsider" }];
    if (kind === "retain-bypass") commands = [{ op: "decide_candidate", id: c.id, value: "retain" }];
    const code = ["false", "unknown"].includes(kind) ? "CONDITION_UNKNOWN" : ["wrong-trigger", "always-without-trigger-reference"].includes(kind) ? "RECONSIDER_TRIGGER" : kind === "model" ? "PERMISSION" : kind === "direct-transition" ? "DEDICATED_COMMAND" : "CANDIDATE_EXCLUDED";
    compare(state, change(state, commands), actor, clock, code);
  });
  it.each(["trip", "matching-local", "wrong-local", "false", "unknown"])("conditional exclusion uses only a truly satisfied applicable explicit tradeoff: %s", (kind) => {
    const state = structuredClone(base), p = object(state, "pref-culture", "Preference"); p.polarity = "tradeoff";
    p.condition = { op: "gte", object_id: "constraint-nights", path: "/value/maximum_nights", value: 4 };
    if (kind === "matching-local" || kind === "wrong-local") p.scope = { kind: "entity", ids: [kind === "matching-local" ? "luxor" : "aswan"] };
    if (kind === "false") p.condition.value = 99;
    if (kind === "unknown") p.condition = { op: "eq", object_id: "cairo", path: "/geo_identity", value: "unknown" };
    const batch = compare(state, change(state, [{ op: "transition", id: "candidate-luxor", event: "exclude_conditionally" }]), system, clock, ["trip", "matching-local"].includes(kind) ? undefined : "CONDITION_UNKNOWN");
    expect(!!batch).toBe(["trip", "matching-local"].includes(kind));
    if (batch) { expect(object(batch.snapshot, "candidate-aswan", "Candidate")).toEqual(object(state, "candidate-aswan", "Candidate")); expect(object(batch.snapshot, p.id, "Preference")).toEqual(p); }
  });
  it("does not silently exclude an explicitly accepted candidate through a generic transition", () => {
    const state = bcg[2].trace.steps[0].state_after;
    compare(state, change(state, [{ op: "transition", id: "candidate-luxor", event: "exclude" }]), user, clock, "CONFIRMED_CANDIDATE");
  });
  it("withdraws a candidate decision through revoke, preserving the old decision record", () => {
    const state = bcg[2].trace.steps[0].state_after, decision = state.objects.find((o) => o.type === "Decision")!;
    const batch = compare(state, change(state, [{ op: "withdraw_decision", id: decision.id }]))!;
    expect(batch.snapshot.objects.find((o) => o.id === decision.id)).toMatchObject({ status: "revoked", version: decision.version + 1 });
    expect(object(batch.snapshot, "candidate-luxor", "Candidate").status).toBe("retained");
  });
  it.each(["revise-effective", "archive-effective", "reject-effective-city", "generic-decision-supersede"])("protects effective skeleton/decision authority: %s", (kind) => {
    const decision = adopted.objects.find((o) => o.type === "Decision" && o.decision_kind === "adopt_skeleton")!;
    const commands: CommandRequest["commands"] = kind === "revise-effective" ? [{ op: "revise", object_type: "Skeleton", id: "skeleton-a", changes: { stops: structuredClone(object(adopted, "skeleton-a", "Skeleton").stops) } }]
      : kind === "archive-effective" ? [{ op: "transition", id: "skeleton-a", event: "archive" }]
      : kind === "reject-effective-city" ? [{ op: "decide_candidate", id: "candidate-luxor", value: "reject" }]
      : [{ op: "transition", id: decision.id, event: "supersede" }];
    compare(adopted, change(adopted, commands), user, clock, kind === "generic-decision-supersede" ? "DEDICATED_COMMAND" : kind === "reject-effective-city" ? "CONFIRMED_CANDIDATE" : "EFFECTIVE_IMMUTABLE");
  });
  it("revokes an adopted decision and atomically clears only its current authoritative root", () => {
    const decision = adopted.objects.find((o) => o.type === "Decision" && o.decision_kind === "adopt_skeleton")!;
    const batch = compare(adopted, change(adopted, [{ op: "withdraw_decision", id: decision.id }]))!;
    expect(batch.snapshot.effective_skeleton_id).toBeNull(); expect(batch.snapshot.objects.find((o) => o.id === decision.id)).toMatchObject({ status: "revoked" });
    expect(object(batch.snapshot, "skeleton-a", "Skeleton")).toEqual(object(adopted, "skeleton-a", "Skeleton"));
  });
  it("creates and revises tentative skeletons using original fields and derived stale assessment", () => {
    const create = createFrom(object(base, "skeleton-a", "Skeleton"), "skeleton-next");
    const created = compare(base, change(base, [create]), model)!.snapshot;
    const sk = object(created, "skeleton-next", "Skeleton"), stops = structuredClone(sk.stops); stops[0].nights = 3;
    const batch = compare(created, change(created, [{ op: "revise", object_type: "Skeleton", id: sk.id, changes: { stops } }]), model)!;
    expect(object(batch.snapshot, sk.id, "Skeleton").assessment).toMatchObject({ status: "stale", unknowns: ["inputs_changed"] });
  });
  it("propagates relevant constraint changes but not unrelated entity-scoped constraints", () => {
    const next = createFrom(object(base, "constraint-nights", "Constraint"), "constraint-local");
    if (next.op !== "create") throw new Error("Invalid fixture"); next.scope = { kind: "entity", ids: ["aswan"] };
    const batch = compare(base, change(base, [next]))!;
    expect(object(batch.snapshot, "skeleton-a", "Skeleton")).toEqual(object(base, "skeleton-a", "Skeleton"));
    const revised = compare(base, change(base, [{ op: "revise", object_type: "Constraint", id: "constraint-nights", changes: { value: { kind: "duration", maximum_nights: 6 } } }]))!;
    expect(object(revised.snapshot, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
  });
  it("normalizes only fact applicability after a date edit, retaining observations, verification and freshness", () => {
    const batch = compare(base, change(base, [{ op: "revise", object_type: "Constraint", id: "constraint-dates", changes: { value: { kind: "date_window", start: "2031-01-01", end: "2031-01-05" } } }]))!;
    for (const original of base.objects.filter((o) => o.type === "ExternalFact")) {
      const fact = object(batch.snapshot, original.id, "ExternalFact");
      expect(fact.applicability).toBe("not_applicable"); expect(fact.value).toEqual(original.value); expect(fact.verification).toBe(original.verification); expect(fact.freshness).toBe(original.freshness); expect(fact.source).toEqual(original.source);
    }
  });
  it("retains a known lodging commitment guard even when its receipt is expired", () => {
    const state = traces.find((t) => t.scenario.startsWith("E-"))!.steps[0].state_after;
    const now = () => new Date("2032-01-01T00:00:00Z");
    compare(state, change(state, [{ op: "decide_candidate", id: "candidate-luxor", value: "reject" }]), user, now, "COMMITTED_FACT_CONFLICT");
  });
  it.each(["matching-input", "unrelated-field", "association"])("keeps Skeleton dependency paths and relation semantics: %s", (kind) => {
    const state = structuredClone(base), extra = structuredClone(object(state, "pref-culture", "Preference")); extra.id = "pref-extra"; state.objects.push(extra);
    object(state, "skeleton-a", "Skeleton").dependencies = [{ object_id: extra.id, version: 1, paths: [kind === "unrelated-field" ? "/aspect" : "/expression"], relation: kind === "association" ? "association" : "input" }];
    const batch = compare(state, change(state, [{ op: "revise", object_type: "Preference", id: extra.id, changes: { expression: "用户新的明确表达" } }]))!;
    expect(object(batch.snapshot, "skeleton-a", "Skeleton").assessment.status).toBe(kind === "matching-input" ? "stale" : "unchecked");
  });
  it("passes changed condition dependencies through an unchanged Constraint without manufacturing a version increment", () => {
    const state = structuredClone(base), p = structuredClone(object(state, "pref-culture", "Preference")); p.id = "pref-extra"; state.objects.push(p);
    const c = structuredClone(object(state, "constraint-nights", "Constraint")); c.id = "constraint-requirement";
    c.scope = { kind: "entity", ids: ["aswan"] }; c.value = { kind: "requirement", description: "合成条件依赖", condition: { op: "eq", object_id: p.id, path: "/expression", value: "用户新的明确表达" } }; state.objects.push(c);
    object(state, "skeleton-a", "Skeleton").dependencies = [{ object_id: c.id, version: 1, paths: ["/value/condition"], relation: "input" }];
    const batch = compare(state, change(state, [{ op: "revise", object_type: "Preference", id: p.id, changes: { expression: "用户新的明确表达" } }]))!;
    expect(object(batch.snapshot, c.id, "Constraint")).toEqual(c); expect(object(batch.snapshot, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
  });
  it("marks an existing adopted plan and decision stale while retaining confirmed authority and root", () => {
    const batch = compare(adopted, change(adopted, [{ op: "revise", object_type: "Preference", id: "pref-culture", changes: { expression: "用户修正共享兴趣" } }]))!;
    expect(batch.snapshot.effective_skeleton_id).toBe(adopted.effective_skeleton_id);
    expect(object(batch.snapshot, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
    const decision = batch.snapshot.objects.find((o) => o.type === "Decision" && o.decision_kind === "adopt_skeleton")!;
    expect(decision).toMatchObject({ status: "confirmed", review_state: "stale" });
  });
  it.each(["user-revise", "user-relax", "stale-only", "contradicted-evidence"])("protects fixed Constraint semantics: %s", (kind) => {
    const state = structuredClone(base), c = object(state, "constraint-nights", "Constraint"), fact = object(state, "fact-cairo-luxor", "ExternalFact");
    c.override_policy = "fixed"; c.dependencies = [{ object_id: fact.id, version: 1, paths: ["/status"], relation: "evidence" }];
    if (kind === "contradicted-evidence") fact.status = "contradicted";
    if (kind === "stale-only") fact.freshness = "stale";
    const commands: CommandRequest["commands"] = kind === "user-revise" ? [{ op: "revise", object_type: "Constraint", id: c.id, changes: { value: { kind: "duration", maximum_nights: 10 } } }]
      : [{ op: "transition", id: c.id, event: kind === "user-relax" ? "relax" : "invalidate" }];
    const batch = compare(state, change(state, commands), kind.startsWith("user-") ? user : system, clock,
      kind.startsWith("user-") ? "FIXED_CONSTRAINT" : kind === "stale-only" ? "FIXED_CONSTRAINT_EVIDENCE" : undefined);
    if (batch) expect(object(batch.snapshot, c.id, "Constraint").status).toBe("invalidated");
  });
  it.each(["recalculate", "adopt_skeleton"] as const)("clearly refuses unimplemented %s without pretending to have calculated facts", (op) => {
    const request = change(base, [op === "recalculate" ? { op, id: "skeleton-a" } : { op, id: "skeleton-a", confirmation_scope: ["cities", "order", "stays", "connections"], acknowledge_unknowns: true }]);
    expect(() => planCommand(base, request, user, clock, uuids())).toThrowError(TripStateContractError);
    expect(() => planCommand(base, request, user, clock, uuids())).toThrowError(expect.objectContaining({ code: "E02_SLICE_UNSUPPORTED" }));
  });
});
