import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parseContract, TripStateContractError, type ContractName } from "../../src/server/trip-state/contracts";
import { parseStateReferences } from "../../src/server/trip-state/references";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { schemaResources } from "../../src/server/trip-state/schema-resources.generated";

const source = path.resolve("specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包");
const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(source, "examples", name), "utf8"));
const traces = read("scenario-traces.json") as Array<{
  scenario: string; initial_state: unknown; final_state: unknown; audit: unknown;
  steps: Array<{ request: unknown; response: unknown; state_after: unknown }>;
}>;
const examples = fs.readdirSync(path.join(source, "examples/objects")).sort().map((file) => ({
  name: file, schema: file.replace(".json", "") as ContractName, value: read(`objects/${file}`),
}));
const shapes: Array<{ name: string; schema: ContractName; value: unknown }> = [...examples];
const snapshots: Array<{ name: string; value: unknown }> = [];
for (const trace of traces) {
  snapshots.push({ name: `${trace.scenario}:initial`, value: trace.initial_state }, { name: `${trace.scenario}:final`, value: trace.final_state });
  shapes.push({ name: `${trace.scenario}:history`, schema: "history", value: trace.audit });
  for (const [i, step] of trace.steps.entries()) {
    snapshots.push({ name: `${trace.scenario}:step-${i}`, value: step.state_after });
    shapes.push({ name: `${trace.scenario}:request-${i}`, schema: "change-request", value: step.request },
      { name: `${trace.scenario}:response-${i}`, schema: "response", value: step.response });
    for (const [j, command] of parseContract("change-request", step.request).commands.entries()) shapes.push({ name: `${trace.scenario}:command-${i}-${j}`, schema: "command", value: command });
  }
}
shapes.push(...snapshots.map((entry) => ({ ...entry, schema: "state" as const })),
  { name: "confirm-envelope", schema: "confirm-request", value: { expected_revision: 0, idempotency_key: "synthetic-confirm", proposal_digest: "synthetic-digest", accept: true } },
  { name: "readonly-context-envelope", schema: "context-request", value: { task_id: "synthetic-task", selected_object_ids: [] } });

function initial(): State { return parseContract("state", structuredClone(read("initial-egypt-state.json"))); }
function object<K extends State["objects"][number]["type"]>(state: State, id: string, kind: K) {
  const found = state.objects.find((o) => o.id === id && o.type === kind);
  if (!found) throw new Error(`Bad test fixture: ${id}`);
  return found as Extract<State["objects"][number], { type: K }>;
}
const invalidReferences: Array<{ name: string; code: string; mutate: (state: State) => void }> = [
  { name: "duplicate object identity", code: "DUPLICATE_ID", mutate: (s) => { s.objects.push(structuredClone(s.objects[0])); } },
  { name: "cross-trip object", code: "CROSS_TRIP", mutate: (s) => { s.objects[0].trip_id = "another-trip"; } },
  { name: "dangling candidate subject", code: "DANGLING_REF", mutate: (s) => { object(s, "candidate-luxor", "Candidate").subject_ids = ["missing"]; } },
  { name: "wrong candidate subject type", code: "REF_TYPE", mutate: (s) => { object(s, "candidate-luxor", "Candidate").subject_ids = ["constraint-dates"]; } },
  { name: "wrong entity kind", code: "REF_TYPE", mutate: (s) => { object(s, "candidate-luxor", "Candidate").subject_ids = ["egypt"]; } },
  { name: "wrong preference reference", code: "REF_TYPE", mutate: (s) => { object(s, "candidate-luxor", "Candidate").preference_ids = ["cairo"]; } },
  { name: "wrong issue reference", code: "REF_TYPE", mutate: (s) => { object(s, "candidate-luxor", "Candidate").issue_ids = ["cairo"]; } },
  { name: "dangling nested condition", code: "DANGLING_REF", mutate: (s) => { object(s, "pref-culture", "Preference").condition = { op: "not", arg: { op: "eq", object_id: "missing", path: "/version", value: 1 } }; } },
  { name: "future dependency", code: "FUTURE_REF", mutate: (s) => { object(s, "skeleton-a", "Skeleton").dependencies = [{ object_id: "pref-culture", version: 99, paths: ["/priority"], relation: "input" }]; } },
  { name: "missing dependency field", code: "DEPENDENCY_PATH", mutate: (s) => { object(s, "skeleton-a", "Skeleton").dependencies = [{ object_id: "pref-culture", version: 1, paths: ["/missing"], relation: "input" }]; } },
  { name: "array outside dependency range", code: "DEPENDENCY_PATH", mutate: (s) => { object(s, "candidate-luxor", "Candidate").dependencies = [{ object_id: "skeleton-a", version: 1, paths: ["/stops/99"], relation: "input" }]; } },
  { name: "empty dependency paths", code: "DEPENDENCY_PATH", mutate: (s) => { object(s, "candidate-luxor", "Candidate").dependencies = [{ object_id: "skeleton-a", version: 1, paths: [], relation: "input" }]; } },
  { name: "wrong entity scope", code: "REF_TYPE", mutate: (s) => { object(s, "pref-culture", "Preference").scope = { kind: "entity", ids: ["skeleton-a"] }; } },
  { name: "unregistered traveler", code: "SCOPE", mutate: (s) => { object(s, "pref-culture", "Preference").scope = { kind: "traveler", ids: ["stranger"] }; } },
  { name: "empty local scope", code: "SCOPE", mutate: (s) => { object(s, "pref-culture", "Preference").scope = { kind: "entity", ids: [] }; } },
  { name: "country as a skeleton stop", code: "REF_TYPE", mutate: (s) => { object(s, "skeleton-a", "Skeleton").stops[0].entity_id = "egypt"; } },
  { name: "cost as transport evidence", code: "REF_TYPE", mutate: (s) => { object(s, "skeleton-a", "Skeleton").connections[0].fact_ids = ["cost-transport"]; } },
  { name: "transport as cost evidence", code: "REF_TYPE", mutate: (s) => { object(s, "skeleton-a", "Skeleton").cost_fact_ids = ["fact-cairo-luxor"]; } },
  { name: "entity ancestry cycle", code: "LINEAGE_CYCLE", mutate: (s) => { object(s, "egypt", "DestinationEntity").parent_id = "cairo"; } },
  { name: "input dependency cycle", code: "DEPENDENCY_CYCLE", mutate: (s) => {
    object(s, "candidate-luxor", "Candidate").dependencies = [{ object_id: "candidate-aswan", version: 1, paths: ["/status"], relation: "input" }];
    object(s, "candidate-aswan", "Candidate").dependencies = [{ object_id: "candidate-luxor", version: 1, paths: ["/status"], relation: "input" }];
  } },
  { name: "wrong goal destination", code: "REF_TYPE", mutate: (s) => { object(s, "goal", "TripGoal").destination_ids = ["pref-culture"]; } },
  { name: "wrong preference subject", code: "REF_TYPE", mutate: (s) => { object(s, "pref-culture", "Preference").subject_ids = ["constraint-dates"]; } },
  { name: "dangling fact subject", code: "DANGLING_REF", mutate: (s) => { object(s, "fact-cairo-luxor", "ExternalFact").subject_ids = ["missing"]; } },
  { name: "wrong entity parent", code: "REF_TYPE", mutate: (s) => { object(s, "egypt", "DestinationEntity").parent_id = "skeleton-a"; } },
  { name: "wrong skeleton parent", code: "REF_TYPE", mutate: (s) => { object(s, "skeleton-a", "Skeleton").parent_id = "cairo"; } },
  { name: "wrong hypothetical constraint reference", code: "REF_TYPE", mutate: (s) => {
    object(s, "skeleton-a", "Skeleton").purpose = "scenario";
    object(s, "skeleton-a", "Skeleton").overrides = [{ constraint_id: "cairo", value: { kind: "duration", maximum_nights: 3 } }];
  } },
  { name: "wrong entry endpoint", code: "REF_TYPE", mutate: (s) => { object(s, "constraint-dates", "Constraint").value = { kind: "entry_exit", entry_entity_id: "pref-culture", exit_entity_id: "luxor", arrival: null, departure: null }; } },
  { name: "dangling requirement condition", code: "DANGLING_REF", mutate: (s) => { object(s, "constraint-dates", "Constraint").value = { kind: "requirement", description: "synthetic", condition: { op: "eq", object_id: "missing", path: "/version", value: 1 } }; } },
  { name: "wrong issue affected reference", code: "DANGLING_REF", mutate: (s) => { object(s, "issue-cost", "OpenIssue").affected_ids = ["missing"]; } },
  { name: "wrong issue evidence reference", code: "DANGLING_REF", mutate: (s) => { object(s, "issue-cost", "OpenIssue").evidence_ids = ["missing"]; } },
  { name: "wrong skeleton scope", code: "REF_TYPE", mutate: (s) => { object(s, "pref-culture", "Preference").scope = { kind: "skeleton", ids: ["luxor"] }; } },
  { name: "reversed scope dates", code: "SCOPE", mutate: (s) => { object(s, "pref-culture", "Preference").scope = { kind: "date", ids: [], start: "2030-02-01", end: "2030-01-01" }; } },
  { name: "missing adjacent connection", code: "CONNECTION_COUNT", mutate: (s) => { object(s, "skeleton-a", "Skeleton").connections = []; } },
  { name: "misordered connection", code: "CONNECTION_ORDER", mutate: (s) => { object(s, "skeleton-a", "Skeleton").connections[0].to_id = "cairo"; } },
  { name: "wrong decision subject", code: "REF_TYPE", mutate: (s) => { Object.assign(s, read("final-state.json")); const d = s.objects.find((o) => o.type === "Decision")!; if (d.type === "Decision") d.subject_id = "cairo"; } },
  { name: "future decision subject version", code: "FUTURE_REF", mutate: (s) => { Object.assign(s, read("final-state.json")); const d = s.objects.find((o) => o.type === "Decision")!; if (d.type === "Decision") d.subject_version = 999; } },
  { name: "wrong decision predecessor", code: "REF_TYPE", mutate: (s) => { Object.assign(s, read("final-state.json")); const d = s.objects.find((o) => o.type === "Decision")!; if (d.type === "Decision") d.supersedes = "cairo"; } },
  { name: "dangling decision basis", code: "DANGLING_REF", mutate: (s) => { Object.assign(s, read("final-state.json")); const d = s.objects.find((o) => o.type === "Decision")!; if (d.type === "Decision") d.basis_ids = ["missing"]; } },
  { name: "dangling root skeleton", code: "DANGLING_REF", mutate: (s) => { Object.assign(s, read("final-state.json")); s.effective_skeleton_id = "missing"; } },
  { name: "wrong root skeleton type", code: "REF_TYPE", mutate: (s) => { Object.assign(s, read("final-state.json")); s.effective_skeleton_id = "cairo"; } },
  { name: "preference successor cycle", code: "LINEAGE_CYCLE", mutate: (s) => {
    const a = object(s, "pref-culture", "Preference"), b = structuredClone(a); b.id = "pref-other";
    a.dependencies = [{ object_id: b.id, version: 1, paths: ["/status"], relation: "association" }];
    b.dependencies = [{ object_id: a.id, version: 1, paths: ["/status"], relation: "association" }]; s.objects.push(b);
  } },
];
const invalidShapes: Array<{ name: string; schema: ContractName; value: unknown }> = [
  { name: "root-unknown-field", schema: "state", value: { ...initial(), selected: true } },
  { name: "no-number-coercion", schema: "state", value: { ...initial(), revision: "0" } },
  { name: "forged-host-actor", schema: "change-request", value: { ...parseContract("change-request", traces[0].steps[0].request), actor: { role: "user", id: "forged" } } },
  { name: "forbidden-revise-status", schema: "command", value: { op: "revise", object_type: "Preference", id: "pref-new", changes: { status: "withdrawn" } } },
];
for (const timestamp of ["2030-01-01T00:00:00", "2030-02-31T00:00:00Z"]) {
  const value = initial(); object(value, "fact-cairo-luxor", "ExternalFact").observed_at = timestamp;
  invalidShapes.push({ name: `invalid-instant-${timestamp}`, schema: "state", value });
}
function result(run: () => unknown): string | null {
  try { run(); return null; } catch (error) {
    if (!(error instanceof TripStateContractError)) throw error;
    return error.code;
  }
}

describe("E02-01 immutable offline contracts", () => {
  it("registers exactly the 20 original Draft 2020-12 identities", () => {
    expect(Object.keys(schemaResources)).toHaveLength(20);
    for (const [name, schema] of Object.entries(schemaResources)) {
      expect(schema.$id).toBe(`https://trip-state.example/spec/0.1/${name}.schema.json`);
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });
  it.each(shapes)("validates source shape $name without mutating it", ({ schema, value }) => {
    const before = structuredClone(value);
    expect(parseContract(schema, value)).toEqual(before);
    expect(value).toEqual(before);
  });
  it.each(snapshots)("accepts static references in source snapshot $name", ({ value }) => {
    expect(parseStateReferences(value)).toEqual(value);
  });
  it.each(invalidReferences)("rejects $name with the original code", ({ mutate, code }) => {
    const state = initial(); mutate(state);
    const before = structuredClone(state);
    expect(result(() => parseStateReferences(state))).toBe(code);
    expect(state).toEqual(before);
  });
  it.each(invalidShapes)("rejects shape $name", ({ schema, value }) => {
    expect(result(() => parseContract(schema, value))).toBe("SCHEMA");
  });
  it("rejects unknown fields, coerced numbers, omitted nulls and invalid dates/timezones", () => {
    const state = initial();
    const skeleton = object(state, "skeleton-a", "Skeleton");
    skeleton.stops[0].nights = null;
    expect(parseContract("state", state)).toEqual(state);
    const missing = structuredClone(state) as unknown as { objects: Array<Record<string, unknown>> };
    delete missing.objects[0].parent_id;
    for (const value of [missing, { ...state, actor: "user" }, { ...state, revision: "0" }]) expect(result(() => parseContract("state", value))).toBe("SCHEMA");
    const fact = object(state, "fact-cairo-luxor", "ExternalFact");
    fact.observed_at = "2030-01-01T00:00:00";
    expect(result(() => parseContract("state", state))).toBe("SCHEMA");
    fact.observed_at = "2030-02-31T00:00:00Z";
    expect(result(() => parseContract("state", state))).toBe("SCHEMA");
  });
  it("does not accept actor/patch/status injection through change requests", () => {
    const request = parseContract("change-request", structuredClone(traces[0].steps[0].request));
    for (const extra of [{ actor: { role: "user" } }, { patch: [] }, { status: "confirmed" }]) {
      expect(result(() => parseContract("change-request", { ...request, ...extra }))).toBe("SCHEMA");
    }
    expect(result(() => parseContract("command", { op: "revise", object_type: "Preference", id: "pref-new", changes: { status: "withdrawn" } }))).toBe("SCHEMA");
  });
  it("allows audit-era dependency versions, null parents and association cycles", () => {
    const state = initial();
    const a = object(state, "candidate-luxor", "Candidate"), b = object(state, "candidate-aswan", "Candidate");
    a.dependencies = [{ object_id: b.id, version: 1, paths: ["/status"], relation: "association" }];
    b.dependencies = [{ object_id: a.id, version: 1, paths: ["/status"], relation: "association" }];
    object(state, "skeleton-a", "Skeleton").dependencies = [{ object_id: "pref-culture", version: 1, paths: ["/priority"], relation: "input" }];
    object(state, "pref-culture", "Preference").version = 2;
    a.dependencies.push({ object_id: "skeleton-a", version: 1, paths: ["/parent_id/unknown_child"], relation: "evidence" });
    expect(parseStateReferences(state)).toEqual(state);
  });
  it("compiles and validates with all network entrypoints disabled", async () => {
    const fail = () => { throw new Error("Schema validation must remain offline"); };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(fail);
    const plain = vi.spyOn(http, "request").mockImplementation(fail);
    const secure = vi.spyOn(https, "request").mockImplementation(fail);
    try {
      vi.resetModules();
      const offline = await import("../../src/server/trip-state/contracts");
      for (const sample of shapes) offline.parseContract(sample.schema, sample.value);
      expect(fetch).not.toHaveBeenCalled(); expect(plain).not.toHaveBeenCalled(); expect(secure).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); plain.mockRestore(); secure.mockRestore(); }
  });
  it("cross-checks original Python results rather than treating TS as its own oracle", () => {
    const cases = [
      ...shapes.map((entry) => ({ ...entry, mode: "shape", expected: null })),
      ...invalidShapes.map((entry) => ({ ...entry, mode: "shape", expected: "SCHEMA" })),
      ...snapshots.map((entry) => ({ ...entry, schema: "state", mode: "state", expected: null })),
      ...invalidReferences.map(({ name, mutate, code }) => { const value = initial(); mutate(value); return { name, value, schema: "state", mode: "state", expected: code }; }),
    ];
    const original = read("invalid-cases.json") as Array<{ name: string; schema: ContractName; expected_error: string; value: unknown }>;
    for (const entry of original.filter((c) => c.expected_error === "SCHEMA" || ["DUPLICATE_ID", "DANGLING_REF"].includes(c.expected_error))) {
      cases.push({ ...entry, mode: entry.expected_error === "SCHEMA" ? "shape" : "state", expected: entry.expected_error });
    }
    const output = JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["scripts/trip-state-oracle.py"], {
      input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    })) as { schema_ids: string[]; results: Array<{ name: string; code: string | null }> };
    expect(output.schema_ids).toEqual(Object.values(schemaResources).map((s) => s.$id).sort());
    expect(output.results).toHaveLength(cases.length);
    for (const [i, entry] of cases.entries()) {
      expect(output.results[i], entry.name).toEqual({ name: entry.name, code: entry.expected });
      expect(result(() => entry.mode === "state" ? parseStateReferences(entry.value) : parseContract(entry.schema as ContractName, entry.value)), entry.name).toBe(entry.expected);
    }
    console.info(`Python contract oracle: ${cases.length} matching cases; 7 original scenarios, 31 saved steps`);
  }, 65000); // The existing subprocess has a 60s bound; keep the runner budget consistent.
});

// TypeScript checks these boundaries too; no execution or new business fields are involved.
function typeBoundary(state: TripStateContracts["state"]): void {
  const version: "0.1.0" = state.schema_version;
  void version;
  // @ts-expect-error Schema version is a fixed literal, not a general string.
  state.schema_version = "0.2.0";
}
void typeBoundary;
