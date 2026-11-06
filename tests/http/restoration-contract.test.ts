import { beforeEach, describe, expect, it, vi } from "vitest";
import { base, object } from "../support/bcg-fixtures";
import { clock } from "../support/command-fixtures";
import { failureResponse, previewCommand } from "../../src/server/trip-state/commands";
import { TripStateContractError } from "../../src/server/trip-state/contracts";
import { parseRestorationHttpResponse } from "../../src/server/trip-state/restoration";

const mock = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock("../../src/server/http/runtime", () => ({ webRuntime: mock.runtime }));
import { handleTripHttp } from "../../src/server/http/trips";
const origin = "https://antu.example.invalid", user = { role: "user" as const, id: "scenario-user" };
function body() { return { source_id: "skeleton-a", source_version: object(base, "skeleton-a", "Skeleton").version, new_id: "contract-preview", expected_revision: base.revision, idempotency_key: "contract-key", reason: "恢复", input: { kind: "dialogue", reference: "ref", text: "恢复", target_ids: [] }, acknowledge_unknowns: true }; }
function request(value: object) { return new Request(origin, { method: "POST", headers: { origin, "content-type": "application/json", cookie: "session=test" }, body: JSON.stringify(value) }); }
const state = vi.fn(), history = vi.fn(), preview = vi.fn();
beforeEach(() => { vi.resetAllMocks(); state.mockResolvedValue(structuredClone(base)); history.mockResolvedValue({ intents: [], changes: [] }); mock.runtime.mockResolvedValue({ identity: { config: { origin } }, trips: { state, history, preview } }); });
async function call(value: object) { const response = await handleTripHttp(request(value), base.trip_id, ["restorations", "preview"]); return { status: response.status, body: await response.json() }; }

describe("F02 authenticated preview HTTP response contract", () => {
  it("returns complete success envelope", async () => { preview.mockImplementation((_trip, change) => previewCommand(base, change, user, clock)); const r = await call(body()); expect(r.status).toBe(200); expect(parseRestorationHttpResponse(r.body, r.status)).toMatchObject({ kind: "preview", can_submit: true }); });
  it("returns a raw conflict when the initial revision is stale", async () => { const r = await call({ ...body(), expected_revision: base.revision + 1 }); expect(r.status).toBe(409); expect(parseRestorationHttpResponse(r.body, r.status)).toMatchObject({ kind: "error", error: { errors: [{ code: "VERSION_CONFLICT" }] } }); expect(preview).not.toHaveBeenCalled(); });
  it("returns a conflict envelope when revision changes after compilation", async () => { const conflict = failureResponse(base, new TripStateContractError("VERSION_CONFLICT", "changed")); conflict.revision += 1; preview.mockResolvedValue(conflict); const r = await call(body()); expect(r.status).toBe(409); expect(parseRestorationHttpResponse(r.body, r.status)).toMatchObject({ kind: "preview", can_submit: false, warnings: expect.arrayContaining(["state_changed_refresh_preview"]) }); });
  it("returns a blocked envelope and sanitized raw authorization/internal failures", async () => { preview.mockResolvedValue(failureResponse(base, new TripStateContractError("HARD_CONFLICT", "blocked"))); let r = await call(body()); expect(r.status).toBe(422); expect(parseRestorationHttpResponse(r.body, r.status)).toMatchObject({ kind: "preview", can_submit: false }); state.mockRejectedValueOnce(new TripStateContractError("PERMISSION", "private")); r = await call(body()); expect(r.status).toBe(403); expect(parseRestorationHttpResponse(r.body, r.status)).toMatchObject({ kind: "error", error: { revision: 0, errors: [{ code: "PERMISSION", message: "Access denied" }] } }); state.mockRejectedValueOnce(new Error("private")); r = await call(body()); expect(r.status).toBe(500); expect(parseRestorationHttpResponse(r.body, r.status)).toMatchObject({ kind: "error", error: { revision: 0, errors: [{ code: "INTERNAL_FAILURE", message: "Request failed" }] } }); });
});
