import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeHandler } from "../../../src/server/decision-context/http-adapter/handler";
import { submitChange, confirmChange, type TransactionalBridgeHost } from "../../../src/server/decision-context/write-bridge/orchestrator";
import { BridgeRuleError } from "../../../src/server/decision-context/write-bridge/rules";
import { TripStateContractError } from "../../../src/server/trip-state/contracts";
import { digest } from "../../../src/server/trip-state/command-json";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";
import { scenario } from "../../support/command-fixtures";

// Exercises raw Request -> HTTP decoder -> actual bridge -> HTTP error mapping.
// The transaction host is synthetic; these tests do not prove Session/PG authority.
const fixtures = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: unknown}>;
function fixture<N extends keyof DecisionContextContracts>(name: N): DecisionContextContracts[N] { return structuredClone(fixtures.find(row => row.schema === name)!.value) as DecisionContextContracts[N]; }
const origin = "http://example.invalid";
function request(route: "changes" | "confirm", raw: string) { return new Request(`${origin}/runtime/trips/trip-egypt-test/${route}`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: "synthetic=yes" }, body: raw }); }

describe("write bridge faults through the actual HTTP adapter", () => {
  it("returns conflict for same-key changed request without re-executing", async () => {
    const body = fixture("change"), packet = fixture("packet"), commit = vi.fn(async () => scenario.steps[0].response);
    const host: TransactionalBridgeHost = { change: async (_body, action) => action({ packet, turn: { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }, deliveredIds: [], principalId: "user-a", now: "2030-01-01T00:00:00Z", replay: { bodyDigest: digest(body), response: scenario.steps[0].response } }, commit), confirm: async () => { throw new Error("unused"); } };
    const handle = createRuntimeHandler({ origin, async authorize() { return { changes: async value => submitChange(host, value) }; } });
    const changed = { ...body, request: { ...body.request, reason: "different" } };
    const response = await handle(request("changes", JSON.stringify(changed)));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false }); expect(commit).not.toHaveBeenCalled();
  });
  it("maps revision drift as rereadable, but expired grant and missing delivery as nonretryable", async () => {
    const body = fixture("change"), packet = fixture("packet"), commit = vi.fn(async () => scenario.steps[0].response);
    const scope = { packet, turn: { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }, deliveredIds: [] as string[], principalId: "user-a", now: "2030-01-01T00:00:00Z" };
    const host: TransactionalBridgeHost = { change: async (_body, action) => action(scope, commit), confirm: async () => { throw new Error("unused"); } };
    const handle = createRuntimeHandler({ origin, async authorize() { return { changes: async value => submitChange(host, value) }; } });
    const drift = { ...body, request: { ...body.request, expected_revision: 1 } };
    let response = await handle(request("changes", JSON.stringify(drift)));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "REVISION_CHANGED", retryable: true });
    const grant = { principalId: "user-a", eventId: scope.turn.event.event_id, requestDigest: digest(body.request), revision: body.request.expected_revision, expiresAt: scope.now };
    const expired: TransactionalBridgeHost = { ...host, change: async (_body, action) => action({ ...scope, grant }, commit) };
    const expiredHandler = createRuntimeHandler({ origin, async authorize() { return { changes: async value => submitChange(expired, value) }; } });
    response = await expiredHandler(request("changes", JSON.stringify(body)));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: "WRITE_GRANT", retryable: false });
    const important = structuredClone(body); important.request.commands = [{ op: "adopt_skeleton", id: "skeleton-a", acknowledge_unknowns: true, confirmation_scope: ["cities", "order", "stays", "connections"] }];
    response = await handle(request("changes", JSON.stringify(important)));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: "INCOMPLETE_DELIVERY", retryable: false }); expect(commit).not.toHaveBeenCalled();
  });
  it("returns proposal binding failure through confirm without calling the transaction", async () => {
    const body = fixture("confirm"), confirm = vi.fn(async () => scenario.steps[0].response);
    const host: TransactionalBridgeHost = { change: async () => { throw new Error("unused"); }, confirm: async (_body, action) => action({ turnId: body.turn_id, proposalId: "proposal-other", recovered: false }, confirm) };
    const handle = createRuntimeHandler({ origin, async authorize() { return { confirm: async value => confirmChange(host, value) }; } });
    const response = await handle(request("confirm", JSON.stringify(body)));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: "PROPOSAL_BINDING", retryable: false }); expect(confirm).not.toHaveBeenCalled();
  });
  it.each(["TURN_MISMATCH", "INPUT_BINDING", "HYPOTHETICAL_WRITE", "RESTORED_INPUT_READ_ONLY"] as const)("maps actual bridge refusal %s without invoking submit", async code => {
    const body = fixture("change"), packet = fixture("packet"), commit = vi.fn(async () => scenario.steps[0].response);
    const turn = { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false };
    if (code === "TURN_MISMATCH") body.turn_id = "turn-other";
    if (code === "INPUT_BINDING") body.request.input.reference = "not-current-event";
    if (code === "HYPOTHETICAL_WRITE") packet.task.branch = "hypothetical";
    if (code === "RESTORED_INPUT_READ_ONLY") turn.recovered = true;
    const host: TransactionalBridgeHost = { change: async (_body, action) => action({ packet, turn, deliveredIds: [], principalId: "user-a", now: "2030-01-01T00:00:00Z" }, commit), confirm: async () => { throw new Error("unused"); } };
    const handle = createRuntimeHandler({ origin, async authorize() { return { changes: async value => submitChange(host, value) }; } });
    const response = await handle(request("changes", JSON.stringify(body)));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code, retryable: false }); expect(commit).not.toHaveBeenCalled();
  });
  it("uses Model when the valid request has no host grant", async () => {
    const body = fixture("change"), packet = fixture("packet"), commit = vi.fn(async () => scenario.steps[0].response);
    const host: TransactionalBridgeHost = { change: async (_body, action) => action({ packet, turn: { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }, deliveredIds: [], principalId: "user-a", now: "2030-01-01T00:00:00Z" }, commit), confirm: async () => { throw new Error("unused"); } };
    const handle = createRuntimeHandler({ origin, async authorize() { return { changes: async value => submitChange(host, value) }; } });
    const response = await handle(request("changes", JSON.stringify(body))); expect(response.status).toBe(200); expect(commit).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledWith("model", body.request);
  });
  it("preserves raw numeric decoding and never dispatches an inexact token", async () => {
    const body = fixture("change"), operation = vi.fn(async () => scenario.steps[0].response);
    const handle = createRuntimeHandler({ origin, async authorize() { return { changes: operation }; } });
    const raw = JSON.stringify(body).replace('"expected_revision":0', '"expected_revision":0.00000000000000001');
    const response = await handle(request("changes", raw)); expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "CONTRACT_INVALID", retryable: false }); expect(operation).not.toHaveBeenCalled();
  });
  it("does not disclose rejected auth or unknown exception content", async () => {
    const body = fixture("change");
    for (const error of [new TripStateContractError("PERMISSION", "SECRET"), new BridgeRuleError("SECRET"), new Error("SECRET")]) {
      const handle = createRuntimeHandler({ origin, async authorize() { return { changes: async () => { throw error; } }; } });
      const response = await handle(request("changes", JSON.stringify(body)));
      expect(response.status).toBe(error instanceof TripStateContractError ? 403 : 500);
      const text = await response.text(); expect(text).not.toContain("SECRET"); expect(JSON.parse(text).retryable).toBe(false);
    }
  });
});
