import { describe, expect, it } from "vitest";
import { assembleContextSnapshot, validateContextSnapshot } from "../../src/server/decision-context/context-assembly";
import { digest } from "../../src/server/trip-state/command-json";
import { factUsable } from "../../src/server/trip-state/conditions";
import type { Condition, State } from "../../src/server/trip-state/contracts.generated";
import { base, object } from "../support/bcg-fixtures";

const at = (value: string) => new Date(value);
const initial = at("2030-01-01T00:00:00.000Z");
const read = (state: State, now: Date) => assembleContextSnapshot(state, "task-c12-temporal", ["skeleton-a"], now);
const prefApplicability = (result: ReturnType<typeof read>) => result.annotations.find(a => a.id === "pref-culture")?.applicability;
const condition: Condition = { op: "eq", object_id: "fact-cairo-luxor", path: "/value/service_exists", value: true };
const no: Condition = { op: "not", arg: { op: "always" } };

function fixture(oppositeObserved: string, oppositeExpires: string) {
  const state = structuredClone(base), fact = object(state, "fact-cairo-luxor", "ExternalFact"), pref = object(state, "pref-culture", "Preference");
  pref.condition = structuredClone(condition);
  const opposite = structuredClone(fact);
  opposite.id = "temporal-unselected-opposite";
  opposite.query_status = "no_service";
  opposite.observed_at = oppositeObserved;
  opposite.expires_at = oppositeExpires;
  if (opposite.value?.kind !== "transport") throw new Error("Expected transport source fixture");
  Object.assign(opposite.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null });
  state.objects.push(opposite);
  return { state, oppositeId: opposite.id, factId: fact.id };
}

function selectedEvidence(result: ReturnType<typeof read>, factId: string, oppositeId: string) {
  expect(result.context.selected_object_ids).toContain(factId);
  expect(result.context.selected_object_ids).not.toContain(oppositeId);
  expect(result.objects.map(o => o.id)).not.toContain(oppositeId);
}

describe("E03-02 C12 temporal and composite condition consumption", () => {
  it("invalidates the old context when an unselected opposite observation becomes usable without a revision write", () => {
    // A future observation is only a synthetic time-boundary fixture, not a permitted ingest assertion.
    const { state, factId, oppositeId } = fixture("2030-01-01T00:00:01.000001Z", "2030-01-01T00:10:00Z");
    const baseline = structuredClone(state), packet = read(state, initial);
    selectedEvidence(packet, factId, oppositeId);
    expect(packet.context.stale_fact_ids).not.toContain(factId);
    expect(prefApplicability(packet)).toBe("applicable");
    expect(() => validateContextSnapshot(packet, state, at("2030-01-01T00:00:01.000Z"))).not.toThrow();
    expect(() => validateContextSnapshot(packet, state, at("2030-01-01T00:00:01.001Z"))).toThrowError(expect.objectContaining({ code: "EVIDENCE_CHANGED" }));
    const fresh = read(state, at("2030-01-01T00:00:01.001Z"));
    selectedEvidence(fresh, factId, oppositeId);
    expect(fresh.context.stale_fact_ids).toContain(factId);
    expect(prefApplicability(fresh)).toBe("unknown");
    expect(state.revision).toBe(packet.context.state_revision);
    expect(state).toEqual(baseline);
  });

  it("invalidates the old context when an unselected opposite expires, even though selected-fact TTL is still open", () => {
    const { state, factId, oppositeId } = fixture("2029-12-31T23:59:00Z", "2030-01-01T00:00:01.000001Z");
    const baseline = structuredClone(state), packet = read(state, initial);
    selectedEvidence(packet, factId, oppositeId);
    expect(packet.context.stale_fact_ids).toContain(factId);
    expect(prefApplicability(packet)).toBe("unknown");
    // The unselected fact does not cap the original selected-fact TTL.
    expect(packet.context.expires_at).toBe("2030-01-01T00:05:00Z");
    expect(() => validateContextSnapshot(packet, state, at("2030-01-01T00:00:01.000Z"))).not.toThrow();
    expect(() => validateContextSnapshot(packet, state, at("2030-01-01T00:00:01.001Z"))).toThrowError(expect.objectContaining({ code: "EVIDENCE_CHANGED" }));
    const fresh = read(state, at("2030-01-01T00:00:01.001Z"));
    selectedEvidence(fresh, factId, oppositeId);
    expect(fresh.context.stale_fact_ids).not.toContain(factId);
    expect(prefApplicability(fresh)).toBe("applicable");
    expect(state.revision).toBe(packet.context.state_revision);
    expect(state).toEqual(baseline);
  });

  it.each([
    { transition: "observed", observed: "2030-01-01T00:00:01.000Z", expires: "2030-01-01T00:10:00Z", before: "applicable", after: "unknown" },
    { transition: "expired", observed: "2029-12-31T23:59:00Z", expires: "2030-01-01T00:00:01.000Z", before: "unknown", after: "applicable" },
  ])("revalidates unselected opposite at the exact millisecond-aligned $transition boundary", ({ transition, observed, expires, before, after }) => {
    // Date provides millisecond precision. Existing tests straddle a non-aligned
    // .000001Z fact timestamp; here alignment lets us test equality itself.
    const { state, factId, oppositeId } = fixture(observed, expires), original = structuredClone(state), old = read(state, initial), beforePoint = at("2030-01-01T00:00:00.999Z"), point = at("2030-01-01T00:00:01.000Z"), afterPoint = at("2030-01-01T00:00:01.001Z");
    expect(old.context.expires_at).toBe("2030-01-01T00:05:00Z");
    expect(prefApplicability(old)).toBe(before); selectedEvidence(old, factId, oppositeId);
    expect(() => validateContextSnapshot(old, state, beforePoint)).not.toThrow();
    for (const moment of [point, afterPoint]) {
      expect(() => validateContextSnapshot(old, state, moment)).toThrowError(expect.objectContaining({ code: "EVIDENCE_CHANGED" }));
      const fresh = read(state, moment); expect(prefApplicability(fresh)).toBe(after);
      expect(fresh.context.state_revision).toBe(old.context.state_revision);
      expect(fresh.snapshot_digest).toBe(old.snapshot_digest);
      selectedEvidence(fresh, factId, oppositeId);
    }
    expect(digest(state)).toBe(old.snapshot_digest); expect(state).toEqual(original);
    const other = object(state, oppositeId, "ExternalFact");
    expect(factUsable(other, beforePoint)).toBe(transition === "expired");
    expect(factUsable(other, point)).toBe(transition === "observed");
    expect(factUsable(other, afterPoint)).toBe(transition === "observed");
  });

  it("keeps the dispute when an unselected opposite expires but another usable opposite remains", () => {
    const { state, factId, oppositeId } = fixture("2029-12-31T23:59:00Z", "2030-01-01T00:00:01.000Z");
    const third = structuredClone(object(state, oppositeId, "ExternalFact"));
    third.id = "temporal-persistent-opposite"; third.expires_at = "2030-01-01T00:10:00Z"; state.objects.push(third);
    const original = structuredClone(state), old = read(state, initial), moment = at("2030-01-01T00:00:01.000Z");
    expect(old.context.stale_fact_ids).toContain(factId); expect(prefApplicability(old)).toBe("unknown");
    expect(old.context.selected_object_ids).not.toContain(third.id);
    expect(factUsable(object(state, oppositeId, "ExternalFact"), moment)).toBe(false); expect(factUsable(third, moment)).toBe(true);
    expect(() => validateContextSnapshot(old, state, moment)).not.toThrow();
    const fresh = read(state, moment); expect(fresh.context.stale_fact_ids).toContain(factId); expect(prefApplicability(fresh)).toBe("unknown");
    expect(fresh.context.state_revision).toBe(old.context.state_revision); expect(fresh.snapshot_digest).toBe(old.snapshot_digest);
    expect(state).toEqual(original);
  });

  it("does not expire an unrelated unselected non-comparable fact globally", () => {
    const { state, factId, oppositeId } = fixture("2029-12-31T23:59:00Z", "2030-01-01T00:00:01.000Z");
    // The differing query parameter makes this observation non-comparable under the existing algorithm.
    object(state, oppositeId, "ExternalFact").query.parameters.push({name: "unrelated-route", value: "different"});
    const original = structuredClone(state), old = read(state, initial), before = at("2030-01-01T00:00:00.999Z"), point = at("2030-01-01T00:00:01.000Z"), after = at("2030-01-01T00:00:01.001Z");
    selectedEvidence(old, factId, oppositeId); expect(old.context.stale_fact_ids).not.toContain(factId); expect(prefApplicability(old)).toBe("applicable");
    for (const moment of [before, point, after]) {
      expect(() => validateContextSnapshot(old, state, moment)).not.toThrow();
      const fresh = read(state, moment); expect(fresh.context.stale_fact_ids).toEqual(old.context.stale_fact_ids);
      expect(fresh.annotations).toEqual(old.annotations); expect(fresh.snapshot_digest).toBe(old.snapshot_digest);
    }
    expect(factUsable(object(state, oppositeId, "ExternalFact"), before)).toBe(true);
    expect(factUsable(object(state, oppositeId, "ExternalFact"), point)).toBe(false);
    expect(state.revision).toBe(old.context.state_revision); expect(state).toEqual(original);
  });

  it.each([
    { name: "not unknown", expr: { op: "not", arg: condition } as Condition, contested: "unknown", clear: "not_applicable" },
    { name: "all unknown + true", expr: { op: "all", args: [condition, { op: "always" }] } as Condition, contested: "unknown", clear: "applicable" },
    { name: "all unknown + false", expr: { op: "all", args: [condition, no] } as Condition, contested: "not_applicable", clear: "not_applicable" },
    { name: "any unknown + false", expr: { op: "any", args: [condition, no] } as Condition, contested: "unknown", clear: "applicable" },
    { name: "any unknown + true", expr: { op: "any", args: [condition, { op: "always" }] } as Condition, contested: "applicable", clear: "applicable" },
  ])("applies three-valued logic to $name", ({ expr, contested, clear }) => {
    const { state, factId, oppositeId } = fixture("2029-12-31T23:59:00Z", "2030-01-01T00:00:01.000001Z");
    object(state, "pref-culture", "Preference").condition = expr;
    const before = read(state, initial), after = read(state, at("2030-01-01T00:00:01.001Z"));
    selectedEvidence(before, factId, oppositeId); selectedEvidence(after, factId, oppositeId);
    expect(prefApplicability(before)).toBe(contested);
    expect(prefApplicability(after)).toBe(clear);
    // Even if a compound expression has a decisive true/false branch, the evidence manifest changes.
    expect(() => validateContextSnapshot(before, state, at("2030-01-01T00:00:01.001Z"))).toThrowError(expect.objectContaining({ code: "EVIDENCE_CHANGED" }));
  });
});
