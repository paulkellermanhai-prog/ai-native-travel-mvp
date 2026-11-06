import { describe, expect, it } from "vitest";
import { TripStateContractError } from "../../src/server/trip-state/contracts";
import { restorationRequest, restorationImpact, parseRestorationHttpResponse, type RestorationInput } from "../../src/server/trip-state/restoration";
import { planCommand, previewCommand, failureResponse, type CommandRequest, type Actor } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, oracle, uuids } from "../support/command-fixtures";

const user = { role: "user" as const, id: "scenario-user" }, model = { role: "model" as const, id: "scenario-model" };
const source = "specs/ux02-2026-11-06/sources/trip-state-schema-v0.1/90_可运行工程包";
const adopt = (id: string): TripStateContracts["command"] => ({ op: "adopt_skeleton", id, acknowledge_unknowns: true, confirmation_scope: ["cities", "order", "stays", "connections"] });
const execute = (state: State, request: CommandRequest, actor: Actor = user) => planCommand(state, request, actor, clock, uuids(2000 + state.revision * 100));
function fixture() {
  let state = execute(base, change(base, [adopt("skeleton-a")])).snapshot;
  const next = createFrom(object(state, "skeleton-a", "Skeleton"), "current-plan");
  if (next.op !== "create" || next.object_type !== "Skeleton") throw new Error("Fixture");
  next.data.stops[0].nights = 1; next.data.parent_id = "skeleton-a";
  state = execute(state, change(state, [next, adopt("current-plan")])).snapshot;
  return state;
}
function options(state: State, extra: Partial<RestorationInput> = {}): RestorationInput {
  return { sourceId: "skeleton-a", sourceVersion: object(state, "skeleton-a", "Skeleton").version, newId: "restored-plan", expectedRevision: state.revision, idempotencyKey: "ux02-restore",
    input: { kind: "dialogue", reference: "new-input", text: "恢复已展示的旧方案", target_ids: [] }, reason: "本轮明确恢复", acknowledgeUnknowns: true, ...extra };
}
function independent(state: State, request: CommandRequest) {
  return oracle<Array<{ response: TripStateContracts["response"]; state_after: State }>>({ initial: state, operations: [{ request, actor: user }], uuidStart: 2000 + state.revision * 100 }, source)[0];
}

describe("UX-02 existing atomic commands support history restoration", () => {
  it.each([undefined, "luxor"])("%s restore is read only at preview and matches independent Python", (cityId) => {
    const state = fixture(), before = structuredClone(state), request = restorationRequest(state, options(state, { cityId }));
    expect(request).toEqual(oracle({ mode: "restoration", state, options: { source_id: "skeleton-a", source_version: object(state, "skeleton-a", "Skeleton").version, new_id: "restored-plan", expected_revision: state.revision,
      idempotency_key: "ux02-restore", input: options(state).input, reason: "本轮明确恢复", city_id: cityId ?? null, acknowledge_unknowns: true } }, source));
    const preview = previewCommand(state, request, user, clock, uuids(2000 + state.revision * 100));
    expect(preview.outcome).toBe("preview"); expect(state).toEqual(before);
    const result = execute(state, request), expected = independent(state, request);
    expect(result.snapshot).toEqual(expected.state_after); expect(result.response).toEqual(expected.response);
    const restored = object(result.snapshot, "restored-plan", "Skeleton");
    expect(restored.parent_id).toBe("current-plan"); expect(restored.stops[0].nights).toBe(cityId ? 1 : 2);
    expect(object(result.snapshot, "skeleton-a", "Skeleton")).toEqual(object(before, "skeleton-a", "Skeleton"));
    expect(result.change.reason).toContain("source=skeleton-a");
    for (const id of ["constraint-dates", "pref-culture", "candidate-aswan"]) expect(result.snapshot.objects.find((o) => o.id === id)).toEqual(before.objects.find((o) => o.id === id));
  });
  it("F02 validates success, both conflict shapes, hard block and sanitized authorization errors", () => {
    const state = fixture(), request = restorationRequest(state, options(state)), preview = previewCommand(state, request, user, clock), impact = restorationImpact(state, request, clock);
    const success = { request, preview, impact, can_submit: true, warnings: [] };
    expect(parseRestorationHttpResponse(success, 200).kind).toBe("preview");
    const conflict = failureResponse(state, new TripStateContractError("VERSION_CONFLICT", "changed"));
    expect(parseRestorationHttpResponse(conflict, 409).kind).toBe("error");
    expect(parseRestorationHttpResponse({ ...success, preview: conflict, can_submit: false }, 409).kind).toBe("preview");
    const block = failureResponse(state, new TripStateContractError("HARD_CONFLICT", "blocked"));
    expect(parseRestorationHttpResponse({ ...success, preview: block, can_submit: false }, 422).kind).toBe("preview");
    const denied = failureResponse(state, new TripStateContractError("PERMISSION", "Access denied"));
    expect(parseRestorationHttpResponse(denied, 403).kind).toBe("error");
    expect(() => parseRestorationHttpResponse({ ...success, preview: conflict, can_submit: true }, 409)).toThrow();
    expect(() => parseRestorationHttpResponse(success, 409)).toThrow();
  });
  it("a saved important plan candidate can be used without pretending it was adopted before", () => {
    const state = fixture(), saved = createFrom(object(state, "skeleton-a", "Skeleton"), "saved-candidate");
    const current = execute(state, change(state, [saved])).snapshot;
    expect(current.objects.some((o) => o.type === "Decision" && o.subject_id === "saved-candidate")).toBe(false);
    expect(execute(current, restorationRequest(current, options(current, { sourceId: "saved-candidate", sourceVersion: object(current, "saved-candidate", "Skeleton").version }))).response.outcome).toBe("applied");
  });
  it("F01: restores the explicitly selected older version of a revised saved candidate", () => {
    let state = fixture();
    const saved = createFrom(object(state, "skeleton-a", "Skeleton"), "versioned-candidate");
    state = execute(state, change(state, [saved], "candidate-v1")).snapshot;
    const v1 = structuredClone(object(state, "versioned-candidate", "Skeleton"));
    const stops = structuredClone(v1.stops); stops[1].nights = 1;
    const revision = execute(state, change(state, [{ op: "revise", object_type: "Skeleton", id: "versioned-candidate", changes: { stops } }], "candidate-v2"));
    state = revision.snapshot;
    expect(object(state, "versioned-candidate", "Skeleton").version).toBeGreaterThan(v1.version);
    const selected = { ...options(state, { sourceId: "versioned-candidate" }), sourceVersion: v1.version } as RestorationInput;
    const request = restorationRequest(state, selected, { intents: [revision.intent], changes: [revision.change] });
    const command = request.commands[0];
    if (command.op !== "create" || command.object_type !== "Skeleton") throw new Error("Fixture");
    expect(command.data.stops[1].nights).toBe(v1.stops[1].nights);
    expect(request.reason).toContain(`version=${v1.version}`);
    expect(() => restorationRequest(state, selected)).toThrowError(expect.objectContaining({ code: "RESTORE_SOURCE_VERSION" }));
    const corrupted = structuredClone(revision.change), entry = corrupted.diff.find(d => d.id === "versioned-candidate")!;
    if (entry.before?.type !== "Skeleton") throw new Error("Fixture"); entry.before.stops[1].nights = 7;
    expect(() => restorationRequest(state, selected, { intents: [revision.intent], changes: [revision.change, corrupted] })).toThrowError(expect.objectContaining({ code: "RESTORE_SOURCE_INTEGRITY" }));
  });
  it("restores the changed target city without rolling back another city's new stay", () => {
    let state = fixture();
    const next = createFrom(object(state, "current-plan", "Skeleton"), "distinct-current");
    if (next.op !== "create" || next.object_type !== "Skeleton") throw new Error("Fixture");
    next.data.parent_id = "current-plan"; next.data.stops[1].nights = 1;
    state = execute(state, change(state, [next, adopt("distinct-current")], "different-cities")).snapshot;
    const old = object(state, "skeleton-a", "Skeleton"), current = object(state, "distinct-current", "Skeleton");
    expect(old.stops.map(s => s.nights)).toEqual([2, 2]);
    expect(current.stops.map(s => s.nights)).toEqual([1, 1]);
    const request = restorationRequest(state, options(state, { cityId: "luxor" }));
    const before = structuredClone(state), preview = previewCommand(state, request, user, clock, uuids(9000));
    expect(preview.outcome).toBe("preview"); expect(state).toEqual(before);
    const restored = object(execute(state, request).snapshot, "restored-plan", "Skeleton");
    expect(restored.stops.map(s => s.nights)).toEqual([1, 2]);
    expect(restored.connections).toEqual(old.connections);
    expect(restored.cost_fact_ids).toEqual(current.cost_fact_ids);
  });
  it("current hard constraints reject atomically", () => {
    const state = fixture(); object(state, "constraint-nights", "Constraint").value = { kind: "duration", maximum_nights: 3 };
    const before = structuredClone(state), request = restorationRequest(state, options(state));
    expect(independent(state, request).response.errors[0].code).toBe("HARD_CONFLICT");
    const impact = restorationImpact(state, request, clock);
    expect(impact.diff.find((d) => d.id === "restored-plan")?.after).toMatchObject({ assessment: { status: "blocked" } });
    expect(() => execute(state, request)).toThrowError(expect.objectContaining({ code: "HARD_CONFLICT" })); expect(state).toEqual(before);
  });
  it("facts are recomputed at current time and unknowns need fresh acknowledgment", () => {
    const state = fixture(), later = () => new Date("2030-03-01T00:00:00Z");
    const request = restorationRequest(state, options(state, { acknowledgeUnknowns: false }));
    expect(() => planCommand(state, request, user, later)).toThrowError(expect.objectContaining({ code: "UNKNOWN_ACK" }));
    const result = planCommand(state, restorationRequest(state, options(state)), user, later);
    expect(object(result.snapshot, "restored-plan", "Skeleton").assessment.connection_minutes).toContain(null);
  });
  it("stale bases cannot replace a new version, and Model remains a proposal", () => {
    const state = fixture(); expect(() => restorationRequest(state, options(state, { expectedRevision: state.revision - 1 }))).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    const result = execute(state, restorationRequest(state, options(state)), model);
    expect(result.response.outcome).toBe("pending_confirmation"); expect(result.snapshot).toEqual(state);
  });
  it("missing cities require an explicit insertion position; changed edges stay unknown", () => {
    let state = fixture(); const next = createFrom(object(state, "current-plan", "Skeleton"), "without-luxor");
    if (next.op !== "create" || next.object_type !== "Skeleton") throw new Error("Fixture");
    Object.assign(next.data, { stops: [{ entity_id: "cairo", nights: 1 }], connections: [], cost_fact_ids: [] });
    state = execute(state, change(state, [next, adopt("without-luxor")])).snapshot;
    expect(() => restorationRequest(state, options(state, { cityId: "luxor" }))).toThrowError(expect.objectContaining({ code: "RESTORE_POSITION_REQUIRED" }));
    const req = restorationRequest(state, options(state, { cityId: "luxor", insertAt: 0 })), created = req.commands[0];
    if (created.op !== "create" || created.object_type !== "Skeleton") throw new Error("Fixture");
    expect(created.data.connections).toEqual([{ from_id: "luxor", to_id: "cairo", fact_ids: [] }]);
    expect(execute(state, req).response.outcome).toBe("applied");
  });
  it("viewing, hypothetical creation and abandoned previews never adopt", () => {
    const state = fixture(), original = structuredClone(state), scenario = createFrom(object(state, "current-plan", "Skeleton"), "what-if");
    if (scenario.op !== "create" || scenario.object_type !== "Skeleton") throw new Error("Fixture"); scenario.data.purpose = "scenario";
    const result = execute(state, change(state, [scenario]));
    expect(result.snapshot.effective_skeleton_id).toBe("current-plan"); expect(state).toEqual(original);
    expect(() => restorationRequest(result.snapshot, options(result.snapshot, { sourceId: "what-if", sourceVersion: object(result.snapshot, "what-if", "Skeleton").version }))).toThrowError(expect.objectContaining({ code: "RESTORE_SOURCE" }));
  });
  it("date-free adoption confirms planning while reality stays unknown", () => {
    const state = structuredClone(base); state.objects = state.objects.filter((o) => o.id !== "constraint-dates");
    const result = execute(state, change(state, [adopt("skeleton-a")]));
    expect(object(result.snapshot, "skeleton-a", "Skeleton").assessment.unknowns).toContain("travel_dates_missing");
    expect(result.snapshot.effective_skeleton_id).toBe("skeleton-a");
  });
  it("an accepted experience cannot silently lose its city", () => {
    let state = fixture(); const experience = createFrom(object(state, "luxor", "DestinationEntity"), "temple");
    if (experience.op !== "create" || experience.object_type !== "DestinationEntity") throw new Error("Fixture");
    Object.assign(experience.data, { entity_kind: "experience", parent_id: "luxor" });
    state = planCommand(state, change(state, [experience]), { role: "system", id: "catalog" }, clock).snapshot;
    const candidate = createFrom(object(state, "candidate-luxor", "Candidate"), "temple-candidate");
    if (candidate.op !== "create" || candidate.object_type !== "Candidate") throw new Error("Fixture");
    Object.assign(candidate.data, { candidate_kind: "experience", subject_ids: ["temple"] });
    state = execute(state, change(state, [candidate, { op: "decide_candidate", id: "temple-candidate", value: "accept" }])).snapshot;
    const next = createFrom(object(state, "current-plan", "Skeleton"), "without-experience");
    if (next.op !== "create" || next.object_type !== "Skeleton") throw new Error("Fixture");
    Object.assign(next.data, { stops: [{ entity_id: "cairo", nights: 1 }], connections: [], cost_fact_ids: [] });
    const req = change(state, [next, adopt(next.id)]);
    expect(independent(state, req).response.errors[0].code).toBe("CONFIRMED_CANDIDATE");
    expect(() => execute(state, req)).toThrowError(expect.objectContaining({ code: "CONFIRMED_CANDIDATE" }));
  });
});
