import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { planCommand, failureResponse, type Actor, type CommandRequest } from "../../src/server/trip-state/commands";
import { TripStateContractError } from "../../src/server/trip-state/contracts";
import { conditionValue } from "../../src/server/trip-state/conditions";
import type { State } from "../../src/server/trip-state/contracts.generated";
import { base, object, change } from "../support/bcg-fixtures";
import { clock, uuids, oracle, traces, type Audit } from "../support/command-fixtures";

const approvedSource = "specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包";
import { ingest, booking, cancellation, factActors as actors, factSegments, type FactResult, type FactOperation, type Ingest } from "../support/fact-fixtures";

const evidence: unknown[] = [];
function compare(initial: State, operations: FactOperation[], uuidStart = 3000) {
  const python = oracle<FactResult[]>({ initial, operations, uuidStart }, approvedSource), uuid = uuids(uuidStart), audit: Audit = { intents: [], changes: [] }, actual: FactResult[] = [];
  let state = structuredClone(initial);
  for (const [i, op] of operations.entries()) {
    let response;
    try {
      const batch = planCommand(state, op.request, op.actor, op.clock ? () => new Date(op.clock!) : clock, uuid);
      state = batch.snapshot; audit.intents.push(batch.intent); audit.changes.push(batch.change); response = batch.response;
    } catch (error) {
      if (!(error instanceof TripStateContractError)) throw error;
      response = failureResponse(state, error);
      expect(response.outcome).toBe(python[i].response.outcome);
      expect(response.errors[0].code).toBe(python[i].response.errors[0].code);
    }
    const result = { response, state_after: structuredClone(state), audit: structuredClone(audit) };
    // Error codes/envelopes are exact; static validators may localize diagnostic text. Keep the actual TS output in evidence.
    expect({ ...result, response: { ...response, errors: python[i].response.errors } }).toEqual(python[i]); actual.push(result);
  }
  return actual;
}
function single(command: CommandRequest["commands"][number], actor: Actor = actors.tool, state = base, at = clock().toISOString(), code?: string) {
  const result = compare(state, [{ request: change(state, [command]), actor, clock: at }])[0];
  expect(result.response.outcome).toBe(code ? "rejected" : "applied");
  if (code) { expect(result.response.errors[0].code).toBe(code); expect(result.state_after).toEqual(state); expect(result.audit).toEqual({ intents: [], changes: [] }); }
  return result;
}

describe("E02-04C ExternalFact original Python behavior", () => {
  it.each(factSegments)("$name: actual TS ↔ independent Python ↔ original machine segment", (segment) => {
    const actual = compare(segment.initial, segment.steps, segment.uuidStart);
    for (const [i, result] of actual.entries()) {
      expect(result.response).toEqual(segment.steps[i].response); expect(result.state_after).toEqual(segment.steps[i].state_after);
      console.info(`TS ${segment.name} step ${i + 1}: ${result.response.outcome}, revision=${result.state_after.revision}; Python+machine exact match`);
    }
    expect(actual.at(-1)!.audit).toEqual(segment.audit);
    evidence.push({ segment: segment.name, boundary: "Partial E/F; no TS adoption/calculation claimed", independent_python_and_machine_match: true, actual });
    if (process.env.E02_FACT_EVIDENCE_PATH) fs.writeFileSync(process.env.E02_FACT_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
  });
  it.each(["empty", "timeout", "error"] as const)("retains distinct %s observations without verified conclusions", (query_status) => {
    const c = ingest(); c.data.query_status = query_status; c.data.value = null;
    const f = object(single(c).state_after, c.id, "ExternalFact");
    expect(f).toMatchObject({ query_status, value: null, verification: "unverified", freshness: "current", applicability: "unknown" });
  });
  it("explicit no_service is verified evidence of absence, unlike an empty result", () => {
    const c = ingest(); c.data.query_status = "no_service";
    if (c.data.value?.kind !== "transport") throw new Error("Invalid fixture");
    Object.assign(c.data.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null });
    const f = object(single(c).state_after, c.id, "ExternalFact");
    expect(f).toMatchObject({ query_status: "no_service", verification: "date_specific", applicability: "applicable", missing_fields: [] });
    expect(conditionValue({ op: "eq", object_id: f.id, path: "/value/service_exists", value: false }, new Map([[f.id, f]]), clock())).toBe(true);
  });
  it.each(["departure", "arrival", "service_exists", "false-result", "unknown-condition", "missing-date", "missing-field"])("incomplete %s remains estimated, never silently fills facts", (kind) => {
    const c = ingest();
    if (c.data.value?.kind !== "transport") throw new Error("Invalid fixture");
    if (kind === "departure" || kind === "arrival" || kind === "service_exists") c.data.value[kind] = null;
    if (kind === "false-result") c.data.value.service_exists = false;
    if (kind === "unknown-condition") c.data.value = { kind: "condition", value: null, description: "合成未知条件" };
    if (kind === "missing-date") c.data.query.date = null;
    if (kind === "missing-field") c.data.missing_fields = ["synthetic-required-input"];
    const f = object(single(c).state_after, c.id, "ExternalFact");
    expect(f.verification).toBe("estimated"); expect(f.value).toEqual(c.data.value);
    expect(conditionValue({ op: "eq", object_id: f.id, path: "/value/service_exists", value: true }, new Map([[f.id, f]]), clock())).toBe(null);
    if (kind === "false-result") expect(f.missing_fields).toContain("explicit_no_service_outcome_required");
    if (kind === "unknown-condition") expect(f.missing_fields).toContain("value");
  });
  it.each(["empty", "timeout", "error", "no_service"] as const)("rejects false %s evidence rather than inventing verification", (query_status) => {
    const c = ingest(); c.data.query_status = query_status;
    single(c, actors.tool, base, clock().toISOString(), query_status === "no_service" ? "NO_SERVICE_EVIDENCE" : "FALSE_VERIFICATION");
  });
  it.each(["user", "model", "system"] as const)("%s cannot ingest any fact, even when data claims a trusted provider", (role) => { single(ingest(), actors[role], base, clock().toISOString(), "PERMISSION"); });
  it.each(["user", "model", "tool"] as const)("%s cannot perform System freshness maintenance", (role) => { single({ op: "check_freshness" }, actors[role], base, clock().toISOString(), "PERMISSION"); });
  it.each(["supersede", "contradict"] as const)("Tool/System %s append provenance and retain the observation", (event) => {
    for (const role of ["tool", "system"] as const) {
      const result = single({ op: "transition", id: "fact-cairo-luxor", event }, actors[role]);
      const f = object(result.state_after, "fact-cairo-luxor", "ExternalFact");
      expect(f).toMatchObject({ status: event === "supersede" ? "superseded" : "contradicted", version: 2, source: { actor: role, actor_id: actors[role].id } });
      expect(f.value).toEqual(object(base, f.id, "ExternalFact").value); expect(result.audit.changes).toHaveLength(1);
    }
  });
  it.each(["user", "model"] as const)("%s cannot supersede/contradict a fact, and preview cannot mint authorization", (role) => {
    for (const event of ["supersede", "contradict"] as const) single({ op: "transition", id: "fact-cairo-luxor", event }, actors[role], base, clock().toISOString(), "PERMISSION");
  });
  it.each(["future-observation", "reversed-time", "reversed-window", "microsecond-future"])("rejects invalid %s without history", (kind) => {
    const c = ingest();
    if (kind === "future-observation") c.data.observed_at = "2030-01-01T00:00:01Z";
    if (kind === "microsecond-future") c.data.observed_at = "2030-01-01T00:00:00.000001Z";
    if (kind === "reversed-time") c.data.expires_at = c.data.observed_at;
    if (kind === "reversed-window") c.data.valid_for.end = "2030-01-11";
    single(c, actors.tool, base, clock().toISOString(), "FACT_TIME");
  });
  it.each(["fresh", "expired", "outside-valid-for", "outside-trip-window"])("verification/freshness/applicability remain independent: %s", (kind) => {
    const c = ingest(); let at = clock().toISOString();
    if (kind === "expired") at = "2030-01-02T00:00:00Z";
    if (kind === "outside-valid-for") c.data.valid_for = { start: "2030-01-13", end: "2030-01-13" };
    if (kind === "outside-trip-window") { c.data.query.date = "2030-02-12"; c.data.valid_for = { start: "2030-02-12", end: "2030-02-12" }; }
    const f = object(single(c, actors.tool, base, at).state_after, c.id, "ExternalFact");
    expect(f.verification).toBe("date_specific"); expect(f.freshness).toBe(kind === "expired" ? "stale" : "current");
    expect(f.applicability).toBe(kind === "outside-trip-window" ? "not_applicable" : kind === "outside-valid-for" ? "unknown" : "applicable");
  });
  it("expiry preserves observations, sources, confirmed decisions and effective authority while propagating stale", () => {
    const state = structuredClone(traces.find((t) => t.scenario.startsWith("D-"))!.steps[0].state_after);
    object(state, "candidate-luxor", "Candidate").dependencies.push({ object_id: "fact-cairo-luxor", version: 1, paths: ["/freshness"], relation: "input" });
    const result = single({ op: "check_freshness" }, actors.system, state, "2030-01-02T00:00:00Z"), after = result.state_after;
    expect(after.effective_skeleton_id).toBe(state.effective_skeleton_id);
    for (const old of state.objects.filter((o) => o.type === "ExternalFact")) { const f = object(after, old.id, "ExternalFact"); expect(f).toMatchObject({ value: old.value, source: old.source, verification: old.verification, status: old.status, freshness: "stale", version: old.version + 1 }); }
    expect(object(after, "candidate-luxor", "Candidate").review_state).toBe("stale");
    expect(object(after, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
    expect(after.objects.find((o) => o.type === "Decision")).toMatchObject({ status: "confirmed", review_state: "stale" });
    const repeat = single({ op: "check_freshness" }, actors.system, after, "2030-01-02T00:00:00Z"); expect(repeat.state_after).toEqual(after);
  });
  it("fixed evidence constraint cannot be invalidated by expiry, but can after System contradiction", () => {
    const state = structuredClone(base), c = object(state, "constraint-nights", "Constraint");
    c.override_policy = "fixed"; c.dependencies = [{ object_id: "fact-cairo-luxor", version: 1, paths: ["/status"], relation: "evidence" }];
    const result = compare(state, [{ actor: actors.system, request: change(state, [{ op: "transition", id: "fact-cairo-luxor", event: "contradict" }, { op: "transition", id: c.id, event: "invalidate" }]) }])[0];
    expect(result.response.outcome).toBe("applied"); expect(object(result.state_after, c.id, "Constraint").status).toBe("invalidated");
  });
  it.each(["supersede", "contradict"] as const)("confirmed lodging %s requires exactly one current same-receipt successor in the same batch", (event) => {
    const initial = factSegments[0].steps[0].state_after;
    for (const bad of ["none", "different-receipt", "stale", "two-successors"] as const) {
      const c = cancellation();
      if (bad === "different-receipt") c.data.query.parameters.find((p) => p.name === "confirmation_ref")!.value = "TEST-DIFFERENT-RECEIPT";
      if (bad === "stale") { c.data.observed_at = "2029-12-30T00:00:00Z"; c.data.expires_at = clock().toISOString(); }
      const commands: CommandRequest["commands"] = [{ op: "transition", id: "receipt-luxor", event }];
      if (bad !== "none") commands.push(c); if (bad === "two-successors") commands.push({ ...structuredClone(c), id: "receipt-second" });
      const r = compare(initial, [{ request: change(initial, commands), actor: actors.tool }])[0];
      expect(r.response.errors[0].code).toBe("COMMITTED_FACT_EVIDENCE"); expect(r.state_after).toEqual(initial);
    }
    const good = compare(initial, [{ request: change(initial, [{ op: "transition", id: "receipt-luxor", event }, cancellation()]), actor: actors.tool }])[0];
    expect(good.response.outcome).toBe("applied"); expect(object(good.state_after, "receipt-luxor-cancelled", "ExternalFact").status).toBe("active");
  });
  it.each(["duplicate-parameter", "incomplete", "wrong-city", "wrong-condition", "date-mismatch", "duplicate-current"])("rejects invalid reservation-v0.1 %s", (kind) => {
    const c = booking(), initial = kind === "duplicate-current" ? factSegments[0].steps[0].state_after : base;
    if (kind === "duplicate-parameter") c.data.query.parameters.push(c.data.query.parameters[0]);
    if (kind === "incomplete") c.data.missing_fields = ["confirmation"];
    if (kind === "wrong-city") c.data.query.parameters.find((p) => p.name === "city_id")!.value = "egypt";
    if (kind === "wrong-condition") c.data.value = { kind: "condition", value: false, description: "合成不一致回执" };
    if (kind === "date-mismatch") c.data.query.date = "2030-01-13";
    if (kind === "duplicate-current") c.id = "receipt-duplicate";
    single(c, actors.tool, initial, clock().toISOString(), "RESERVATION_PROFILE");
  });
  it("expiry never cancels a confirmed lodging commitment or permits candidate exclusion", () => {
    const initial = factSegments[0].steps[0].state_after, at = "2030-01-02T00:00:00Z";
    const expired = single({ op: "check_freshness" }, actors.system, initial, at).state_after;
    single({ op: "decide_candidate", id: "candidate-luxor", value: "reject" }, actors.user, expired, at, "COMMITTED_FACT_CONFLICT");
    single({ op: "transition", id: "candidate-luxor", event: "exclude" }, actors.user, expired, at, "COMMITTED_FACT_CONFLICT");
  });
  it.each(["transport", "condition"] as const)("normalizes %s missing fields in original Unicode code-point order", (kind) => {
    const c = ingest(); c.data.missing_fields = ["😀", "\uE000", "arrival"];
    if (kind === "condition") c.data.value = { kind: "condition", value: null, description: "合成未知" };
    else if (c.data.value?.kind === "transport") c.data.value.arrival = null;
    const f = object(single(c).state_after, c.id, "ExternalFact");
    expect(f.missing_fields.at(-2)).toBe("\uE000"); expect(f.missing_fields.at(-1)).toBe("😀");
    expect(f.missing_fields.filter((f) => f === "arrival")).toHaveLength(1);
  });
  it.each([true, false])("partial results with value=%s remain estimated/unverified independently of query_status", (hasValue) => {
    const c = ingest(); c.data.query_status = "partial"; if (!hasValue) c.data.value = null;
    expect(object(single(c).state_after, c.id, "ExternalFact")).toMatchObject({ query_status: "partial", verification: hasValue ? "estimated" : "unverified", applicability: "unknown" });
  });
  it("new observations can update evidence without mutating or deleting the previous value", () => {
    const c = ingest("updated-observation"); if (c.data.value?.kind !== "transport") throw new Error("Invalid fixture");
    c.data.value.duration_minutes = 75;
    const r = compare(base, [{ actor: actors.tool, request: change(base, [{ op: "transition", id: "fact-cairo-luxor", event: "supersede" }, c]) }])[0];
    expect(r.response.outcome).toBe("applied");
    expect(object(r.state_after, "fact-cairo-luxor", "ExternalFact").value).toEqual(object(base, "fact-cairo-luxor", "ExternalFact").value);
    expect(object(r.state_after, c.id, "ExternalFact").value).toEqual(c.data.value);
    expect(r.audit.changes[0].diff.find((d) => d.id === "fact-cairo-luxor")?.before).toEqual(object(base, "fact-cairo-luxor", "ExternalFact"));
  });
  it.each(["supersede", "contradict"] as const)("a terminal fact cannot repeat %s or be reactivated", (event) => {
    const first = single({ op: "transition", id: "fact-cairo-luxor", event }, actors.tool).state_after;
    for (const next of ["supersede", "contradict", "activate"] as const) single({ op: "transition", id: "fact-cairo-luxor", event: next }, actors.system, first, clock().toISOString(), "ILLEGAL_TRANSITION");
  });
  it("fact changes propagate through related Constraint paths while preserving unrelated objects and fixed authority", () => {
    const initial = structuredClone(base), c = object(initial, "constraint-nights", "Constraint");
    c.override_policy = "fixed"; c.dependencies = [{ object_id: "fact-cairo-luxor", version: 1, paths: ["/freshness"], relation: "evidence" }];
    const r = single({ op: "check_freshness" }, actors.system, initial, "2030-01-02T00:00:00Z");
    expect(object(r.state_after, c.id, "Constraint")).toEqual(c);
    expect(object(r.state_after, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
    expect(object(r.state_after, "candidate-aswan", "Candidate").review_state).toBe("stale");
    for (const id of ["pref-culture", "luxor", "cairo"]) expect(r.state_after.objects.find((o) => o.id === id)).toEqual(initial.objects.find((o) => o.id === id));
  });
  it("valid cancellation releases candidate exclusion while retaining both receipts and provenance", () => {
    const initial = factSegments[0].steps[0].state_after;
    const replaced = compare(initial, [{ actor: actors.tool, request: change(initial, [{ op: "transition", id: "receipt-luxor", event: "supersede" }, cancellation()]) }])[0].state_after;
    const r = single({ op: "decide_candidate", id: "candidate-luxor", value: "reject" }, actors.user, replaced);
    expect(object(r.state_after, "candidate-luxor", "Candidate").status).toBe("excluded");
    for (const id of ["receipt-luxor", "receipt-luxor-cancelled"]) expect(r.state_after.objects.find((o) => o.id === id)).toEqual(replaced.objects.find((o) => o.id === id));
  });
  it("date changes preserve an out-of-window receipt and permit later trusted cancellation", () => {
    const initial = factSegments[0].steps[0].state_after;
    const moved = single({ op: "revise", object_type: "Constraint", id: "constraint-dates", changes: { value: { kind: "date_window", start: "2030-02-10", end: "2030-02-14" } } }, actors.user, initial).state_after;
    expect(object(moved, "receipt-luxor", "ExternalFact")).toMatchObject({ status: "active", applicability: "not_applicable", verification: "date_specific" });
    const r = single({ op: "decide_candidate", id: "candidate-luxor", value: "reject" }, actors.user, moved);
    const cancelled = compare(r.state_after, [{ actor: actors.tool, request: change(r.state_after, [{ op: "transition", id: "receipt-luxor", event: "supersede" }, cancellation()]) }])[0];
    expect(cancelled.response.outcome).toBe("applied");
  });
  it("cannot smuggle verification, status or source through ingest fields or use generic revise/create", () => {
    for (const field of ["verification", "freshness", "applicability", "status", "source"]) {
      const c = ingest(); Object.assign(c.data, { [field]: field === "source" ? { actor: "tool" } : "purchasable" });
      expect(() => planCommand(base, change(base, [c]), actors.tool, clock, uuids())).toThrowError(expect.objectContaining({ code: "SCHEMA" }));
    }
    for (const op of ["create", "revise"]) {
      const cmd = { op, object_type: "ExternalFact", id: "fact-cairo-luxor", scope: { kind: "trip", ids: [] }, dependencies: [], data: ingest().data, changes: { verification: "purchasable" } };
      expect(() => planCommand(base, change(base, [cmd as unknown as Ingest]), actors.user, clock, uuids())).toThrowError(expect.objectContaining({ code: "SCHEMA" }));
    }
  });
});
