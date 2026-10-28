import { beforeAll, describe, expect, it } from "vitest";
import { conditionValue } from "../../src/server/trip-state/conditions";
import type { Condition } from "../../src/server/trip-state/contracts.generated";
import { base, object } from "../support/bcg-fixtures";
import { clock, oracle } from "../support/command-fixtures";

type Comparison = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
const cmp = (op: Comparison, object_id: string, path: string, value: string | number | boolean | null): Condition => ({ op, object_id, path, value });
const yes: Condition = { op: "always" }, no: Condition = { op: "not", arg: yes }, unknown = cmp("eq", "cairo", "/geo_identity", "missing");
const rows: Array<{ name: string; condition: Condition; expected: boolean | null }> = [
  { name: "always", condition: yes, expected: true }, { name: "not true", condition: no, expected: false },
  { name: "not unknown", condition: { op: "not", arg: unknown }, expected: null },
  { name: "all true and unknown", condition: { op: "all", args: [yes, unknown] }, expected: null },
  { name: "all false is decisive over unknown", condition: { op: "all", args: [unknown, no] }, expected: false },
  { name: "any true is decisive over unknown", condition: { op: "any", args: [unknown, yes] }, expected: true },
  { name: "any false and unknown", condition: { op: "any", args: [no, unknown] }, expected: null },
  { name: "any false only", condition: { op: "any", args: [no] }, expected: false },
  { name: "all true only", condition: { op: "all", args: [yes] }, expected: true },
  { name: "no numeric text coercion", condition: cmp("eq", "constraint-nights", "/value/maximum_nights", "4"), expected: null },
  { name: "no numeric boolean coercion", condition: cmp("eq", "constraint-nights", "/value/maximum_nights", true), expected: null },
  { name: "null on right is unknown", condition: cmp("ne", "constraint-nights", "/value/maximum_nights", null), expected: null },
  { name: "missing path", condition: cmp("eq", "pref-culture", "/missing", "x"), expected: null },
  { name: "missing object", condition: cmp("eq", "unknown-object", "/status", "active"), expected: null },
  { name: "object is not scalar", condition: cmp("eq", "pref-culture", "/scope", "trip"), expected: null },
  { name: "array is not scalar", condition: cmp("eq", "pref-culture", "/subject_ids", "luxor"), expected: null },
  { name: "string equality", condition: cmp("eq", "candidate-luxor", "/status", "retained"), expected: true },
  { name: "string ordering is unknown", condition: cmp("gte", "candidate-luxor", "/status", "excluded"), expected: null },
  ...(["0", "-1", "+00", "0_0", "٠", "０", "\u00850", "  +0_0  "] as const).map((index) => ({ name: `original integer array offset ${JSON.stringify(index)}`, condition: cmp("eq", "pref-culture", `/subject_ids/${index}`, "luxor"), expected: true })),
  ...(["99", "1.0", "_0", "\ufeff0"] as const).map((index) => ({ name: `invalid/out-of-range offset ${JSON.stringify(index)}`, condition: cmp("eq", "pref-culture", `/subject_ids/${index}`, "luxor"), expected: null })),
  ...(["eq", "ne", "lt", "lte", "gt", "gte"] as const).map((op) => ({ name: `numeric ${op}`, condition: cmp(op, "constraint-nights", "/value/maximum_nights", 4), expected: ["eq", "lte", "gte"].includes(op) })),
];
describe("E02-04B original true/false/unknown conditions", () => {
  let python: Array<boolean | null>;
  beforeAll(() => { python = oracle({ mode: "conditions", state: base, conditions: rows.map((r) => r.condition) }); });
  it.each(rows)("$name", ({ condition, expected }) => {
    const i = rows.findIndex((r) => r.condition === condition);
    expect(python[i]).toBe(expected);
    expect(conditionValue(condition, new Map(base.objects.map((o) => [o.id, o])), clock())).toBe(python[i]);
  });
  it.each(["superseded", "withdrawn"] as const)("historical Preference %s becomes unknown without deleting evidence", (status) => {
    const state = structuredClone(base), pref = object(state, "pref-culture", "Preference"); pref.status = status;
    // Superseded expressions need their formal successor even in a read-side fixture.
    if (status === "superseded") { const next = structuredClone(pref); next.id = "pref-successor"; next.status = "active"; next.dependencies = [{ object_id: pref.id, version: 1, paths: ["/status"], relation: "association" }]; state.objects.push(next); }
    const condition = cmp("eq", pref.id, "/priority", "important");
    expect(oracle({ mode: "conditions", state, conditions: [condition] })).toEqual([null]);
    expect(conditionValue(condition, new Map(state.objects.map((o) => [o.id, o])), clock())).toBeNull(); expect(pref.evidence_refs.length).toBeGreaterThan(0);
  });
  it.each(["expired", "future-observation", "unverified", "not-applicable", "missing-fields"])("existing fact %s is unknown without changing its observation", (kind) => {
    const state = structuredClone(base), fact = object(state, "fact-cairo-luxor", "ExternalFact");
    if (kind === "expired") { fact.observed_at = "2029-12-01T00:00:00Z"; fact.expires_at = clock().toISOString(); }
    if (kind === "future-observation") { fact.observed_at = "2030-01-02T00:00:00Z"; fact.expires_at = "2031-01-01T00:00:00Z"; }
    if (kind === "unverified") fact.verification = "estimated";
    if (kind === "not-applicable") fact.applicability = "not_applicable";
    if (kind === "missing-fields") { fact.verification = "estimated"; fact.missing_fields = ["synthetic-missing"]; }
    const before = structuredClone(state), condition = cmp("eq", fact.id, "/value/service_exists", true);
    expect(oracle({ mode: "conditions", state, conditions: [condition] })).toEqual([null]);
    expect(conditionValue(condition, new Map(state.objects.map((o) => [o.id, o])), clock())).toBeNull(); expect(state).toEqual(before);
  });
  it("fails explicitly for unsafe integer operands rather than approving a rounded condition", () => {
    const state = structuredClone(base), c = object(state, "constraint-nights", "Constraint"); if (c.value.kind === "duration") c.value.maximum_nights = 2 ** 53;
    expect(() => conditionValue(cmp("gte", c.id, "/value/maximum_nights", 4), new Map(state.objects.map((o) => [o.id, o])), clock())).toThrowError(expect.objectContaining({ code: "INTEGER_REPRESENTATION" }));
  });
});
