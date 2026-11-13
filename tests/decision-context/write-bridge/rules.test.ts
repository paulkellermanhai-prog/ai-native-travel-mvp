import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { checkChangeRules, checkConfirmationRules, checkGrantFields } from "../../../src/server/decision-context/write-bridge/rules";
import { digest } from "../../../src/server/trip-state/command-json";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";

const fixtures = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: unknown}>;
function fixture<N extends keyof DecisionContextContracts>(name: N): DecisionContextContracts[N] {
  return structuredClone(fixtures.find(row => row.schema === name)!.value) as DecisionContextContracts[N];
}
function current(packet: DecisionContextContracts["packet"]) { return { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }; }
describe("E03-04 isolated R6 write rules, not authorization", () => {
  it("binds event, packet, turn and revision without mutating input", () => {
    const body = fixture("change"), packet = fixture("packet"), before = structuredClone(body);
    expect(checkChangeRules(body, packet, current(packet), [])).toEqual(body); expect(body).toEqual(before);
    for (const [bad, code] of [
      [{ ...body, turn_id: "turn-other" }, "TURN_MISMATCH"],
      [{ ...body, packet_id: "packet-other" }, "TURN_MISMATCH"],
      [{ ...body, request: { ...body.request, expected_revision: 1 } }, "REVISION_CHANGED"],
      [{ ...body, request: { ...body.request, input: { ...body.request.input, text: "other" } } }, "INPUT_BINDING"],
      [{ ...body, request: { ...body.request, input: { ...body.request.input, reference: "other" } } }, "INPUT_BINDING"],
    ] as const) expect(() => checkChangeRules(bad, packet, current(packet), [])).toThrowError(expect.objectContaining({ code }));
    expect(() => checkChangeRules(body, packet, { ...current(packet), recovered: true }, [])).toThrowError(expect.objectContaining({ code: "RESTORED_INPUT_READ_ONLY" }));
    expect(() => checkChangeRules(body, packet, { ...current(packet), event: { ...current(packet).event, event_id: "event-other" } }, [])).toThrowError(expect.objectContaining({ code: "INPUT_BINDING" }));
  });
  it("requires complete delivery for important actions only; forbids hypothetical real changes", () => {
    const body = fixture("change"), packet = fixture("packet");
    body.request.commands = [{ op: "adopt_skeleton", id: "skeleton-a", acknowledge_unknowns: true, confirmation_scope: ["cities", "order", "stays", "connections"] }];
    expect(() => checkChangeRules(body, packet, current(packet), [])).toThrowError(expect.objectContaining({ code: "INCOMPLETE_DELIVERY" }));
    expect(checkChangeRules(body, packet, current(packet), packet.context.selected_object_ids)).toEqual(body);
    expect(() => checkChangeRules(body, { ...packet, task: { ...packet.task, branch: "hypothetical" } }, current(packet), packet.context.selected_object_ids)).toThrowError(expect.objectContaining({ code: "HYPOTHETICAL_WRITE" }));
    body.request.commands = [{ op: "create", object_type: "Skeleton", id: "skeleton-scenario", scope: { kind: "trip", ids: [] }, dependencies: [], data: {
      purpose: "scenario", stops: [{ entity_id: "cairo", nights: 4 }], connections: [], cost_fact_ids: [], parent_id: null, overrides: [], tradeoffs: { gains: [], losses: [] },
    } }];
    expect(checkChangeRules(body, { ...packet, task: { ...packet.task, branch: "hypothetical" } }, current(packet), [])).toEqual(body);
  });
  it("checks every grant binding and strict expiry, without issuing a grant", () => {
    const request = fixture("change").request;
    const args = { principalId: "user-a", eventId: "event-1", request, now: "2030-01-01T00:00:00.000000Z", runtimeId: "instance-a" };
    const grant = { principalId: args.principalId, eventId: args.eventId, requestDigest: digest(request), revision: request.expected_revision, expiresAt: "2030-01-01T00:00:00.000001Z", runtimeId: args.runtimeId };
    expect(() => checkGrantFields(grant, args)).not.toThrow();
    for (const patch of [{ principalId: "user-b" }, { eventId: "event-2" }, { requestDigest: "wrong" }, { revision: 1 }, { runtimeId: "old" }, { expiresAt: args.now }, { expiresAt: "bad" }])
      expect(() => checkGrantFields({ ...grant, ...patch }, args)).toThrowError(expect.objectContaining({ code: "WRITE_GRANT" }));
  });
  it("rejects restored or unrelated proposals", () => {
    const body = fixture("confirm"), current = { turnId: body.turn_id, proposalId: body.proposal_id, recovered: false };
    expect(checkConfirmationRules(body, current)).toEqual(body);
    expect(() => checkConfirmationRules(body, { ...current, recovered: true })).toThrowError(expect.objectContaining({ code: "RESTORED_INPUT_READ_ONLY" }));
    expect(() => checkConfirmationRules(body, { ...current, proposalId: "proposal-other" })).toThrowError(expect.objectContaining({ code: "PROPOSAL_BINDING" }));
  });
});
