import { describe, expect, it } from "vitest";
import { planCommand, planConfirmation, previewCommand, type Actor, type CommandRequest, type PendingProposal } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, oracle, uuids } from "../support/command-fixtures";
import { factActors, ingest } from "../support/fact-fixtures";

const source = "specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包";
const other: Actor = { role: "user", id: "other-member" };
const adopt = (id = "skeleton-a"): TripStateContracts["command"] => ({ op: "adopt_skeleton", id, acknowledge_unknowns: true,
  confirmation_scope: ["cities", "order", "stays", "connections"] });
const execute = (state: State, commands: CommandRequest["commands"], actor = factActors.user) =>
  planCommand(state, change(state, commands), actor, clock, uuids(2000));
const expected = (state: State, request: CommandRequest, actor: Actor) => oracle<Array<{ response: TripStateContracts["response"]; state_after: State }>>({
  initial: state, operations: [{ request, actor }], uuidStart: 2000,
}, source)[0];

describe("stage A eight mechanisms: Trip State runtime boundaries", () => {
  it.each(["adopt", "candidate"] as const)("X01 only original confirmer can revoke %s", (kind) => {
    const initial = execute(base, [kind === "adopt" ? adopt() : { op: "decide_candidate", id: "candidate-luxor", value: "accept" }]).snapshot;
    const decision = initial.objects.find((o) => o.type === "Decision" && o.status === "confirmed")!;
    const request = change(initial, [{ op: "withdraw_decision", id: decision.id }]);
    expect(expected(initial, request, other).response.errors[0].code).toBe("PERMISSION");
    expect(() => previewCommand(initial, request, other, clock, uuids(2000))).toThrowError(expect.objectContaining({ code: "PERMISSION" }));
    expect(() => planCommand(initial, request, other, clock, uuids(2000))).toThrowError(expect.objectContaining({ code: "PERMISSION" }));
    expect(execute(initial, request.commands).snapshot.objects.find((o) => o.id === decision.id)?.status).toBe("revoked");
    expect(initial.objects.find((o) => o.id === decision.id)?.status).toBe("confirmed");
  });

  it("X01 Model proposal checks the actual accepting User while rejection remains available", () => {
    const initial = execute(base, [adopt()]).snapshot;
    const decision = initial.objects.find((o) => o.type === "Decision" && o.status === "confirmed")!;
    const proposal = execute(initial, [{ op: "withdraw_decision", id: decision.id }], factActors.model);
    expect(proposal.response.outcome).toBe("pending_confirmation");
    const pending: PendingProposal = { proposalId: proposal.response.proposal_id!, request: proposal.request,
      actor: factActors.model, digest: proposal.response.proposal_digest!, expires: proposal.proposalDetails!.expires_at, details: proposal.proposalDetails! };
    const body = { expected_revision: initial.revision, idempotency_key: "confirm-ac8", proposal_digest: pending.digest, accept: true };
    expect(() => planConfirmation(initial, pending, body, other, clock, uuids(3000))).toThrowError(expect.objectContaining({ code: "PERMISSION" }));
    expect(planConfirmation(initial, pending, { ...body, accept: false }, other, clock, uuids(3000)).response.outcome).toBe("rejected");
    expect(planConfirmation(initial, pending, body, factActors.user, clock, uuids(3000)).snapshot.objects.find((o) => o.id === decision.id)?.status).toBe("revoked");
    expect(initial.objects.find((o) => o.id === decision.id)?.status).toBe("confirmed");
  });

  it("C12 opposite comparable transport blocks adoption through one reference and stales old adoption", () => {
    const first = execute(base, [adopt()]).snapshot;
    const opposite = ingest("opposite-service"); opposite.data.query_status = "no_service";
    if (opposite.data.value?.kind !== "transport") throw new Error("Fixture");
    Object.assign(opposite.data.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null });
    const next = execute(first, [opposite], factActors.tool).snapshot;
    expect(object(next, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
    expect(next.objects.find((o) => o.type === "Decision" && o.status === "confirmed")).toBeTruthy();
    const newSkeleton = createFrom(object(next, "skeleton-a", "Skeleton"), "skeleton-contested");
    const request = change(next, [newSkeleton, adopt("skeleton-contested")]);
    expect(expected(next, request, factActors.user).response.errors[0].code).toBe("HARD_CONFLICT");
    expect(() => planCommand(next, request, factActors.user, clock, uuids(2000))).toThrowError(expect.objectContaining({ code: "HARD_CONFLICT" }));
  });

  it("C12 a different query is not treated as a comparable opposite", () => {
    const opposite = ingest("other-query"); opposite.data.query_status = "no_service";
    opposite.data.query.parameters = [{ name: "mode", value: "bus" }];
    if (opposite.data.value?.kind !== "transport") throw new Error("Fixture");
    Object.assign(opposite.data.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null });
    const state = execute(base, [opposite], factActors.tool).snapshot;
    expect(execute(state, [adopt()]).response.outcome).toBe("applied");
  });

  it("C12 declared cost conflict blocks only a skeleton that consumes the disputed fact", () => {
    const original = object(base, "cost-transport", "ExternalFact"), otherCost = ingest("other-cost");
    otherCost.data = { subject_ids: [...original.subject_ids], query: structuredClone(original.query), provider: "SECOND_TEST_PROVIDER",
      query_status: original.query_status, observed_at: original.observed_at, expires_at: original.expires_at,
      valid_for: structuredClone(original.valid_for), missing_fields: [], value: { ...original.value!, amount_minor: 200000 } as typeof original.value };
    const withCost = execute(base, [otherCost], factActors.tool).snapshot;
    const issue = createFrom(object(withCost, "issue-cost", "OpenIssue"), "cost-conflict");
    if (issue.op !== "create" || issue.object_type !== "OpenIssue") throw new Error("Fixture");
    Object.assign(issue.data, { issue_kind: "conflict", question: "同一费用项报价矛盾", affected_ids: ["cost-transport", "other-cost"], owner: "system" });
    const contested = execute(withCost, [issue], factActors.system).snapshot;
    const request = change(contested, [adopt()]);
    expect(expected(contested, request, factActors.user).response.errors[0].code).toBe("HARD_CONFLICT");
    expect(() => planCommand(contested, request, factActors.user, clock, uuids(2000))).toThrowError(expect.objectContaining({ code: "HARD_CONFLICT" }));
    const alternate = createFrom(object(contested, "skeleton-a", "Skeleton"), "without-disputed-cost");
    if (alternate.op !== "create" || alternate.object_type !== "Skeleton") throw new Error("Fixture");
    alternate.data.cost_fact_ids = [];
    expect(execute(contested, [alternate, adopt("without-disputed-cost")]).response.outcome).toBe("applied");
  });

  it("P03 one input may correct two scoped objects without resetting unrelated authority", () => {
    const created = createFrom(object(base, "pref-culture", "Preference"), "pref-transfer");
    if (created.op !== "create" || created.object_type !== "Preference") throw new Error("Fixture");
    created.scope = { kind: "entity", ids: ["aswan"] }; created.data.subject_ids = ["aswan"];
    created.data.certainty = "inferred"; created.data.support = "weak"; created.data.evidence_refs = ["synthetic-old-behavior"];
    const initial = execute(base, [created]).snapshot;
    const request = change(initial, [
      { op: "revise", object_type: "Preference", id: "pref-culture", changes: { priority: "ordinary", expression: "文化仍喜欢，但本轮不优先" } },
      { op: "revise", object_type: "Preference", id: "pref-transfer", changes: { certainty: "explicit", support: "supported",
        expression: "阿斯旺交通舒服些仍想去", evidence_refs: ["synthetic-old-behavior", "synthetic-user-correction"] } },
    ]);
    const result = planCommand(initial, request, factActors.user, clock, uuids(2000));
    expect(result.snapshot.objects.find((o) => o.id === "constraint-budget")).toEqual(initial.objects.find((o) => o.id === "constraint-budget"));
    expect(result.change.diff.map((d) => d.id)).toEqual(expect.arrayContaining(["pref-culture", "pref-transfer"]));
    expect(result.intent.input.text).toBe(request.input.text);
  });

  it("P04 three interacted items remain weak local preferences; unshown items stay unknown", () => {
    const ancient = Array.from({ length: 6 }, (_, n) => `ancient-${n + 1}`), nature = ["nature-1", "nature-2"];
    const catalog = [...ancient, ...nature].map((id) => {
      const command = createFrom(object(base, "luxor", "DestinationEntity"), id);
      if (command.op !== "create" || command.object_type !== "DestinationEntity") throw new Error("Fixture");
      Object.assign(command.data, { entity_kind: "experience", name: id, parent_id: "luxor" });
      return command;
    });
    let state = execute(base, [catalog[0], ...catalog.slice(1)], factActors.system).snapshot;
    for (const [n, id] of ancient.slice(0, 3).entries()) {
      const command = createFrom(object(state, "pref-culture", "Preference"), `pref-like-${n + 1}`);
      if (command.op !== "create" || command.object_type !== "Preference") throw new Error("Fixture");
      command.scope = { kind: "entity", ids: [id] }; Object.assign(command.data, { subject_ids: [id], certainty: "inferred",
        support: "weak", priority: "ordinary", expression: `合成互动：喜欢具体对象 ${id}`, evidence_refs: [`synthetic-exposure-and-like-${n + 1}`] });
      state = execute(state, [command], factActors.model).snapshot;
    }
    expect(state.objects.filter((o) => o.type === "Decision")).toHaveLength(0);
    expect(state.objects.filter((o) => o.type === "Preference" && o.id.startsWith("pref-like-")).map((o) => o.scope)).toEqual(
      ancient.slice(0, 3).map((id) => ({ kind: "entity", ids: [id] })));
    expect(state.objects.filter((o) => o.type === "Preference" && o.subject_ids.some((id) => nature.includes(id)))).toHaveLength(0);
    for (const id of ["candidate-luxor", "candidate-aswan"]) expect(state.objects.find((o) => o.id === id)).toEqual(base.objects.find((o) => o.id === id));
  });

  it("P05 incomplete budget scope cannot write a formal hard ceiling", () => {
    const command = createFrom(object(base, "constraint-budget", "Constraint"), "rough-budget");
    if (command.op !== "create" || command.object_type !== "Constraint") throw new Error("Fixture");
    command.data.value = { kind: "budget", mode: "intent", minimum_minor: null, maximum_minor: 2000000,
      currency: null as never, people: null as never, categories: [] };
    const before = structuredClone(base), request = change(base, [command]);
    expect(() => planCommand(base, request, factActors.user, clock, uuids(2000))).toThrowError(expect.objectContaining({ code: "SCHEMA" }));
    expect(base).toEqual(before);
  });
});
