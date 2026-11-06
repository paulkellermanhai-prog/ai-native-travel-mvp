import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assembleContextSnapshot } from "../../src/server/decision-context/context-assembly";
import type { ExternalFact, State } from "../../src/server/trip-state/contracts.generated";
import { base, object } from "../support/bcg-fixtures";

const now = new Date("2030-01-01T00:00:00Z"), targets = ["skeleton-a"];
const read = (state: State) => assembleContextSnapshot(state, "task-c12-scope", targets, now);
function referenceApplicability(state: State, id = "pref-culture") {
  const result = JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["scripts/e03-02-annotation-oracle.py"], {
    input: JSON.stringify([{ state, targets, now: now.toISOString() }]), encoding: "utf8", timeout: 20000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })) as Array<{ annotations: Array<{ id: string; applicability: string }> }>;
  return result[0].annotations.find(item => item.id === id)?.applicability;
}
const annotation = (state: State, id = "pref-culture") => {
  const row = read(state).annotations.find(item => item.id === id);
  if (!row) throw new Error("Missing selected annotation");
  return row;
};
function fixture() {
  const state = structuredClone(base), fact = object(state, "fact-cairo-luxor", "ExternalFact"), pref = object(state, "pref-culture", "Preference");
  pref.condition = { op: "eq", object_id: fact.id, path: "/value/service_exists", value: true };
  const opposite = structuredClone(fact);
  opposite.id = "scope-unselected-opposite"; opposite.query_status = "no_service";
  if (opposite.value?.kind !== "transport") throw new Error("Source transport fixture");
  Object.assign(opposite.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null });
  state.objects.push(opposite);
  return { state, fact, pref, opposite };
}

describe("E03-02 C12 approved scope and unrelated evidence boundaries", () => {
  it("does not turn independently not-applicable entity scope into unknown for a disputed condition", () => {
    const { state, pref, fact, opposite } = fixture();
    // Aswan is outside the Cairo/Luxor skeleton's entity scope.
    pref.scope = { kind: "entity", ids: ["aswan"] };
    const result = read(state), row = result.annotations.find(item => item.id === pref.id);
    expect(result.context.stale_fact_ids).toContain(fact.id);
    expect(result.context.selected_object_ids).not.toContain(opposite.id);
    expect(row).toMatchObject({ applicability: "not_applicable", retained: true, presentation: "policy_judgment" });
    expect(referenceApplicability(state)).toBe("not_applicable");
    expect(object(state, pref.id, "Preference").status).toBe("active");
  });

  it.each(["date", "traveler"] as const)("does not promote unknown %s scope to applicable when condition is true", kind => {
    const { state, pref, opposite } = fixture(); opposite.status = "contradicted";
    pref.scope = kind === "date" ? { kind: "date", ids: [], start: "2030-01-10", end: "2030-01-14" }
      : { kind: "traveler", ids: ["traveler-demo"] };
    expect(annotation(state)).toMatchObject({ applicability: "unknown", retained: true });
    expect(referenceApplicability(state)).toBe("unknown");
  });

  it("changes an expression formerly false to unknown when its referenced fact becomes contested", () => {
    const { state, pref, fact, opposite } = fixture();
    pref.condition = { op: "eq", object_id: fact.id, path: "/value/service_exists", value: false };
    const result = read(state);
    expect(result.context.stale_fact_ids).toContain(fact.id);
    expect(result.context.selected_object_ids).not.toContain(opposite.id);
    expect(result.annotations.find(item => item.id === pref.id)).toMatchObject({ applicability: "unknown", retained: true });
    expect(referenceApplicability(state)).toBe("not_applicable");
    opposite.status = "contradicted";
    expect(annotation(state)).toMatchObject({ applicability: "not_applicable", retained: true });
  });

  it("leaves independent preferences and always conditions unchanged under another fact's dispute", () => {
    const { state, pref } = fixture();
    const unrelated = structuredClone(pref); unrelated.id = "unrelated-pref";
    unrelated.condition = { op: "eq", object_id: "constraint-budget", path: "/value/maximum_minor", value: 2000000 };
    const always = structuredClone(pref); always.id = "always-pref"; always.condition = { op: "always" };
    state.objects.push(unrelated, always);
    const before = structuredClone(state), result = read(state);
    for (const id of [unrelated.id, always.id]) {
      expect(result.annotations.find(item => item.id === id)).toMatchObject({ applicability: "applicable", retained: true, restriction: "none", presentation: "policy_judgment" });
      expect(result.objects.find(item => item.id === id)).toEqual(before.objects.find(item => item.id === id));
    }
    expect(state).toEqual(before);
  });

  it.each([
    { name: "different date", alter: (f: ExternalFact) => { f.query.date = "2030-01-13"; f.valid_for = { start: "2030-01-13", end: "2030-01-13" }; } },
    { name: "different direction", alter: (f: ExternalFact) => { if (f.value?.kind !== "transport") throw new Error("Fixture"); [f.value.from_id, f.value.to_id] = [f.value.to_id, f.value.from_id]; } },
    { name: "different parameters", alter: (f: ExternalFact) => { f.query.parameters = [{ name: "ticket_class", value: "different" }]; } },
    { name: "different scope", alter: (f: ExternalFact) => { f.scope = { kind: "entity", ids: ["cairo"] }; } },
    { name: "superseded", alter: (f: ExternalFact) => { f.status = "superseded"; } },
    { name: "contradicted", alter: (f: ExternalFact) => { f.status = "contradicted"; } },
    { name: "expired", alter: (f: ExternalFact) => { f.expires_at = "2029-12-31T23:59:59Z"; f.observed_at = "2029-12-31T23:00:00Z"; } },
    { name: "missing fields", alter: (f: ExternalFact) => { f.missing_fields = ["departure"]; } },
  ])("does not infer a dispute for $name", ({ alter }) => {
    const { state, fact, opposite } = fixture(); alter(opposite);
    const result = read(state);
    expect(result.context.selected_object_ids).not.toContain(opposite.id);
    expect(result.context.stale_fact_ids).not.toContain(fact.id);
    expect(result.annotations.find(item => item.id === "pref-culture")).toMatchObject({ applicability: "applicable", retained: true });
    expect(result.annotations.find(item => item.id === fact.id)).toMatchObject({ restriction: "none" });
  });
});
