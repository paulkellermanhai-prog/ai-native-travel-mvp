import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { planCommand, previewCommand, planConfirmation, proposalDeadline, type Actor, type PendingProposal, type ConfirmRequest } from "../../src/server/trip-state/commands";
import type { State } from "../../src/server/trip-state/contracts.generated";
import { scenario, clock, uuids, oracle, requestAt, source, type Audit } from "../support/command-fixtures";

const model: Actor = { role: "model", id: "scenario-ai" }, user: Actor = { role: "user", id: "scenario-user" };
const cases = [
  { name: "model goal create", state: scenario.steps[0].state_after, request: requestAt(1, 1) },
  { name: "model goal activation", state: scenario.steps[1].state_after, request: requestAt(2, 2) },
  { name: "model explicit preference revision", state: scenario.steps[4].state_after, request: requestAt(4, 5) },
  { name: "model candidate acceptance", state: scenario.steps[5].state_after, request: requestAt(6, 6) },
];
type Result = { response: unknown; state_after: State; audit: Audit; pending: Record<string, { expires: string }> };
function pendingFrom(batch: ReturnType<typeof planCommand>): PendingProposal {
  return { proposalId: batch.response.proposal_id!, request: batch.request, actor: model, digest: batch.response.proposal_digest!,
    expires: batch.proposalDetails!.expires_at, details: batch.proposalDetails! };
}
const confirmBody = (revision: number, digest = "@digest", accept = true): ConfirmRequest => ({ expected_revision: revision, idempotency_key: "synthetic-confirm", proposal_digest: digest, accept });

describe("E02-04A original preview, pending and confirmation rules", () => {
  it.each(cases)("$name: preview and pending exactly match Python without changing authority", ({ state, request }) => {
    const before = structuredClone(state), uuid = uuids();
    const preview = previewCommand(state, request, model, clock, uuid), batch = planCommand(state, request, model, clock, uuid);
    const expected = oracle<Result[]>({ mode: "lifecycle", initial: state, operations: [
      { method: "preview", request, actor: model }, { request, actor: model },
    ] });
    expect(preview).toEqual(expected[0].response); expect(batch.response).toEqual(expected[1].response);
    expect(batch.snapshot).toEqual(state); expect(state).toEqual(before); expect(expected[0].audit).toEqual({ intents: [], changes: [] });
    expect({ intents: [batch.intent], changes: [batch.change] }).toEqual(expected[1].audit);
    expect(batch.response).toMatchObject({ outcome: "pending_confirmation", revision: state.revision, confirmation_required: true });
    expect(batch.change.result_revision).toBe(state.revision); expect(batch.response.diff.length).toBeGreaterThan(0);
  });
  it.each(cases.flatMap((c) => [true, false].map((accept) => ({ ...c, accept }))))("$name: User accept=$accept matches Python source and history", ({ state, request, accept }) => {
    const uuid = uuids();
    const batch = planCommand(state, request, model, clock, uuid), pending = pendingFrom(batch), body = confirmBody(state.revision, pending.digest, accept);
    const result = planConfirmation(state, pending, body, user, clock, uuid);
    const expected = oracle<Result[]>({ mode: "lifecycle", initial: state, operations: [
      { request, actor: model }, { method: "confirm", proposalIndex: 0, request: body, actor: user },
    ] });
    expect(result.response).toEqual(expected[1].response); expect(result.snapshot).toEqual(expected[1].state_after);
    expect({ intents: [batch.intent, result.intent], changes: [batch.change, result.change] }).toEqual(expected[1].audit);
    expect(result.intent.actor_role).toBe("model"); expect(result.change.confirmation_actor).toBe(user.id);
    expect(result.response.proposal_digest).toBe(batch.response.proposal_digest);
    if (accept && request.commands[0].op === "decide_candidate") expect(result.snapshot.objects.find((o) => o.type === "Decision")).toMatchObject({ confirmed_by: user.id, source: { actor: "user", actor_id: user.id } });
    if (!accept) { expect(result.snapshot).toEqual(state); expect(result.response).toMatchObject({ outcome: "rejected", diff: [], errors: [] }); }
  });
  it("User preview proposes a change without advancing revision or generating journals", () => {
    const state = scenario.initial_state, request = requestAt(0, 0), actor = scenario.steps[0].actor;
    const result = previewCommand(state, request, actor, clock, uuids());
    expect(result).toEqual(oracle<Result[]>({ initial: state, operations: [{ method: "preview", request, actor }] })[0].response);
    expect(result).toMatchObject({ outcome: "preview", revision: 0, confirmation_required: false });
    expect(state.objects).toEqual([]);
  });
  it.each(["role", "digest", "revision", "expiry", "payload"])("rejects invalid confirmation %s without altering state", (kind) => {
    const state = structuredClone(scenario.steps[5].state_after), batch = planCommand(state, requestAt(6, 6), model, clock, uuids());
    const pending = pendingFrom(batch), body = confirmBody(6, pending.digest), uuid = uuids(2000);
    let actor = user, now = clock, code = "CONFIRMATION_SCOPE";
    if (kind === "role") { actor = model; code = "PERMISSION"; }
    if (kind === "digest") body.proposal_digest = "different";
    if (kind === "revision") { body.expected_revision = 5; code = "VERSION_CONFLICT"; }
    if (kind === "expiry") { now = () => new Date("2030-01-01T00:05:00Z"); code = "CONFIRMATION_EXPIRED"; }
    if (kind === "payload") { pending.details.diff = []; code = "STORAGE_INTEGRITY"; }
    expect(() => planConfirmation(state, pending, body, actor, now, uuid)).toThrowError(expect.objectContaining({ code }));
    expect(state).toEqual(scenario.steps[5].state_after);
  });
  it("caps expiry at the earliest future fact, retaining original microseconds", () => {
    const state = JSON.parse(fs.readFileSync(`${source}/examples/initial-egypt-state.json`, "utf8")) as State;
    for (const o of state.objects) if (o.type === "ExternalFact") { o.observed_at = "2029-01-01T00:00:00Z"; o.expires_at = "2030-01-01T00:10:00Z"; }
    const fact = state.objects.find((o) => o.type === "ExternalFact")!;
    if (fact.type === "ExternalFact") fact.expires_at = "2030-01-01T00:00:01.000001Z";
    const request = requestAt(4, 0); request.commands = [{ op: "revise", object_type: "Preference", id: "pref-culture", changes: { expression: "合成提案" } }]; request.input.target_ids = [];
    const python = oracle<Result[]>({ mode: "lifecycle", initial: state, operations: [{ request, actor: model }] });
    const expiry = Object.values(python[0].pending)[0].expires.replace("+00:00", "Z");
    expect(proposalDeadline(state, clock())).toBe(expiry);
    expect(expiry).toBe("2030-01-01T00:00:01.000001Z");
  });
});
