import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { submitChange, confirmChange, type TransactionalBridgeHost } from "../../../src/server/decision-context/write-bridge/orchestrator";
import { digest } from "../../../src/server/trip-state/command-json";
import { scenario } from "../../support/command-fixtures";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";

const fixtures = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: unknown}>;
function fixture<N extends keyof DecisionContextContracts>(name: N): DecisionContextContracts[N] { return structuredClone(fixtures.find(row => row.schema === name)!.value) as DecisionContextContracts[N]; }

describe("E03-04 orchestration with synthetic transaction host, not authorization", () => {
  it("routes a grantless request as Model, and matching host-supplied grant as User", async () => {
    const body = fixture("change"), packet = fixture("packet"), commit = vi.fn(async () => structuredClone(scenario.steps[0].response));
    const scope = { packet, turn: { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }, deliveredIds: [], principalId: "user-a", now: "2030-01-01T00:00:00Z", runtimeId: "runtime-a" };
    const state: { grant?: { principalId: string; eventId: string; requestDigest: string; revision: number; expiresAt: string; runtimeId: string } } = {};
    const host: TransactionalBridgeHost = { change: async (_body, action) => action({ ...scope, grant: state.grant }, commit), confirm: async () => { throw new Error("not used"); } };
    await submitChange(host, body); expect(commit).toHaveBeenLastCalledWith("model", body.request);
    state.grant = { principalId: "user-a", eventId: scope.turn.event.event_id, requestDigest: digest(body.request), revision: body.request.expected_revision, expiresAt: "2030-01-01T00:01:00Z", runtimeId: "runtime-a" };
    await submitChange(host, body); expect(commit).toHaveBeenLastCalledWith("user", body.request);
    state.grant.requestDigest = "wrong"; await expect(submitChange(host, body)).rejects.toMatchObject({ code: "WRITE_GRANT" }); expect(commit).toHaveBeenCalledTimes(2);
  });
  it("returns matching durable replay without re-execution and rejects reused key with changed body", async () => {
    const body = fixture("change"), packet = fixture("packet"), commit = vi.fn(async () => structuredClone(scenario.steps[0].response));
    const scope = { packet, turn: { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }, deliveredIds: [], principalId: "user-a", now: "2030-01-01T00:00:00Z", replay: { bodyDigest: digest(body), response: scenario.steps[0].response } };
    const host: TransactionalBridgeHost = { change: async (_body, action) => action(scope, commit), confirm: async () => { throw new Error("not used"); } };
    expect(await submitChange(host, body)).toEqual(scope.replay.response); expect(commit).not.toHaveBeenCalled();
    await expect(submitChange(host, { ...body, packet_id: "packet-other" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" }); expect(commit).not.toHaveBeenCalled();
  });
  it("does not call confirmation when the turn or proposal is wrong", async () => {
    const body = fixture("confirm"), commit = vi.fn(async () => structuredClone(scenario.steps[0].response));
    const host: TransactionalBridgeHost = { change: async () => { throw new Error("not used"); }, confirm: async (_body, action) => action({ turnId: body.turn_id, proposalId: "proposal-other", recovered: false }, commit) };
    await expect(confirmChange(host, body)).rejects.toMatchObject({ code: "PROPOSAL_BINDING" }); expect(commit).not.toHaveBeenCalled();
  });
});
