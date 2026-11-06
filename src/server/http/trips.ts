import { restorationRequest, parseRestorationInput, restorationImpact } from "../trip-state/restoration";
import { decodeCommandJson } from "../trip-state/command-json";
import { parseContract, TripStateContractError } from "../trip-state/contracts";
import { StorageError } from "../trip-state/internal/persistence";
import type { TripStateContracts } from "../trip-state/contracts.generated";
import { webRuntime } from "./runtime";
import { json, readJsonText, requireOrigin } from "./security";

export function errorResponse(code: string, message: string, revision = 0) {
  return parseContract("response", { outcome: ["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(code) ? "conflict" : "rejected", revision,
    proposal_id: null, proposal_digest: null, confirmation_required: false, affected_ids: [], diff: [], errors: [{ code, message }] });
}
export function statusFor(response: TripStateContracts["response"]) {
  const code = response.errors[0]?.code;
  if (["PERMISSION", "ACTOR"].includes(code ?? "")) return 403;
  if (code === "INTERNAL_FAILURE" || code?.startsWith("STORAGE_")) return 500;
  if (code === "NOT_FOUND") return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  return { applied: 200, preview: 200, pending_confirmation: 202, conflict: 409, rejected: 422 }[response.outcome];
}

export async function handleTripHttp(request: Request, tripId: string, resource: string[]) {
  let revision = 0;
  try {
    const runtime = await webRuntime(), { identity } = runtime;
    const authorization = request.headers.get("authorization"), cookie = request.headers.get("cookie");
    if (authorization && (cookie || !authorization.startsWith("Bearer ") || !runtime.models)) throw new TripStateContractError("PERMISSION", "Access denied");
    const trips = authorization ? runtime.models! : runtime.trips;
    const credential = authorization ? authorization.slice(7) : new Headers({ cookie: cookie ?? "" });
    // Authorize before reporting whether a trip/resource exists, and before accepting any input.
    const before = await trips.state(tripId, credential);
    if (!before) throw new TripStateContractError("NOT_FOUND", "旅行不存在"); revision = before.revision;
    const path = resource.join("/"), id = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/;
    if (!id.test(tripId)) throw new TripStateContractError("NOT_FOUND", "接口不存在");
    const confirmation = resource.length === 3 && resource[0] === "changes" && resource[2] === "confirm" && id.test(resource[1]);
    const get = path === "state" || path === "changes", post = path === "changes" || path === "changes/preview" || path === "restorations/preview" || confirmation;
    if (!get && !post) throw new TripStateContractError("NOT_FOUND", "接口不存在");
    if (request.method === "GET" && get) return json(path === "state" ? before : parseContract("history", await trips.history(tripId, credential)), 200);
    if (request.method !== "POST" || !post) return json(errorResponse("METHOD_NOT_ALLOWED", "方法不适用于该接口", revision), 405, { Allow: path === "changes" ? "GET, POST" : get ? "GET" : "POST" });
    requireOrigin(request, identity.config.origin);
    const raw = await readJsonText(request); // Keep the original numeric tokens for the existing controlled decoder.
    if (path === "restorations/preview") {
      const restore = restorationRequest(before, parseRestorationInput(decodeCommandJson(raw)));
      const preview = await trips.preview(tripId, restore, credential);
      if (["PERMISSION", "ACTOR"].includes(preview.errors[0]?.code ?? "")) return json(errorResponse("PERMISSION", "Access denied"), 403);
      if (statusFor(preview) === 500) return json(errorResponse("INTERNAL_FAILURE", "Request failed"), 500);
      // Even blocked adoption returns a read-only candidate assessment for explanation and repair.
      const impact = restorationImpact(before, restore);
      return json({ request: restore, preview, impact, can_submit: preview.outcome === "preview", warnings: ["historical_content_not_current_verification", "present_current_impacts_before_authorization", "cost_coverage_is_partial", ...(preview.revision !== before.revision ? ["state_changed_refresh_preview"] : [])] }, statusFor(preview));
    }
    const response = confirmation ? await trips.confirm(tripId, resource[1], raw, credential)
      : path === "changes/preview" ? await trips.preview(tripId, raw, credential) : await trips.submit(tripId, raw, credential);
    // No revision or identity details escape if a live transaction guard detects intervening revocation.
    if (["PERMISSION", "ACTOR"].includes(response.errors[0]?.code ?? "")) return json(errorResponse("PERMISSION", "Access denied"), 403);
    if (statusFor(response) === 500) return json(errorResponse("INTERNAL_FAILURE", "Request failed"), 500);
    return json(parseContract("response", response), statusFor(response));
  } catch (error) {
    let code = "INTERNAL_FAILURE", message = "Request failed";
    if (error instanceof SyntaxError) { code = "SCHEMA"; message = "Invalid JSON"; }
    else if (error instanceof TripStateContractError || error instanceof StorageError) {
      code = error.code === "STORAGE_TRIP_NOT_FOUND" ? "NOT_FOUND" : error.code.startsWith("STORAGE_") ? "INTERNAL_FAILURE" : error.code; message = code === "INTERNAL_FAILURE" ? "Request failed" : error.message;
    }
    if (["PERMISSION", "ACTOR"].includes(code)) { code = "PERMISSION"; message = "Access denied"; revision = 0; }
    const response = errorResponse(code, message, code === "INTERNAL_FAILURE" ? 0 : revision);
    return json(response, statusFor(response));
  }
}
