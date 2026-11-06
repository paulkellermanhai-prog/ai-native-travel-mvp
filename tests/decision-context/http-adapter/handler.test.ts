import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeHandler } from "../../../src/server/decision-context/http-adapter/handler";
import { RuntimeHttpFault } from "../../../src/server/decision-context/http-core/response";
import { TripStateContractError } from "../../../src/server/trip-state/contracts";
import { scenario } from "../../support/command-fixtures";

const fixtures = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: unknown}>;
const fixture = (name: string) => structuredClone(fixtures.find(row => row.schema === name)!.value);
const origin = "http://example.invalid";
const request = (route: string, body: unknown) => new Request(`${origin}/runtime/trips/trip-egypt-test/${route}`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: "synthetic=yes", "x-user-id": "forged" }, body: JSON.stringify(body) });
describe("E03-07 handler contract mapping, synthetic host", () => {
  it("forwards only cookie to trusted host and validates request before invoking operations", async () => {
    const run = vi.fn(async () => fixture("turn"));
    const authorize = vi.fn(async (_trip: string, headers: Headers) => { expect([...headers.keys()]).toEqual(["cookie"]); return { turns: run }; });
    const handle = createRuntimeHandler({ origin, authorize });
    expect((await handle(request("turns", { ...fixture("open-turn") as object, actor: "user" }))).status).toBe(422);
    expect(run).not.toHaveBeenCalled();
    expect((await handle(request("turns", fixture("open-turn")))).status).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not leak permission errors, raw exception data or invalid output", async () => {
    const forbidden = createRuntimeHandler({ origin, async authorize() { throw new TripStateContractError("PERMISSION", "secret"); } });
    const denied = await forbidden(request("turns", fixture("open-turn"))); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("secret");
    const bad = createRuntimeHandler({ origin, async authorize() { return { turns: async () => ({ secret: "wrong-output" }) }; } });
    const result = await bad(request("turns", fixture("open-turn"))); expect(result.status).toBe(500); expect(await result.text()).not.toContain("wrong-output");
    const internal = createRuntimeHandler({ origin, async authorize() { throw new Error("sensitive"); } });
    const error = await internal(request("turns", fixture("open-turn"))); expect(error.status).toBe(500); expect(await error.text()).not.toContain("sensitive");
  });
  it("maps TS business results without turning a rejection into success", async () => {
    const rejected = structuredClone(scenario.steps[0].response);
    rejected.outcome = "rejected"; rejected.errors = [{ code: "HARD_CONFLICT", message: "conflict" }];
    const handle = createRuntimeHandler({ origin, async authorize() { return { changes: async () => rejected }; } });
    const result = await handle(request("changes", fixture("change"))); expect(result.status).toBe(422); expect(await result.json()).toEqual(rejected);
    const deny = structuredClone(rejected); deny.errors = [{ code: "PERMISSION", message: "sensitive" }]; deny.revision = 10;
    const guarded = createRuntimeHandler({ origin, async authorize() { return { changes: async () => deny }; } });
    const response = await guarded(request("changes", fixture("change"))); expect(response.status).toBe(403);
    const body = await response.json(); expect(body.revision).toBe(0); expect(JSON.stringify(body)).not.toContain("sensitive");
  });
  it("keeps runtime faults distinct from business errors", async () => {
    const handle = createRuntimeHandler({ origin, async authorize() { return { turns: async () => { throw new RuntimeHttpFault("PACKET_STALE", true); } }; } });
    const response = await handle(request("turns", fixture("open-turn"))); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "PACKET_STALE", retryable: true });
  });
  it.each([
    ["CHECKPOINT_CONFLICT", 409], ["CHECKPOINT_SUPERSEDED", 409], ["STATE_BEHIND_CHECKPOINT", 409],
    ["CHECKPOINT_EXPIRED", 422], ["CHECKPOINT_CORRUPT", 422], ["CHECKPOINT_DB_VERSION", 422],
    ["CHECKPOINT_IDEMPOTENCY", 422], ["CHECKPOINT_RETRY_EMPTY", 422], ["WORKSPACE_MISMATCH", 422],
    ["CHECKPOINT_ACK_UNKNOWN", 503], ["CHECKPOINT_STORAGE", 503], ["CHECKPOINT_NOT_FOUND", 404],
  ])("maps %s to %s without disclosing details", async (code, status) => {
    const handle = createRuntimeHandler({ origin, async authorize() { return { turns: async () => { throw new RuntimeHttpFault(code, status === 409 || status === 503); } }; } });
    const response = await handle(request("turns", fixture("open-turn"))); expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code });
  });
});
