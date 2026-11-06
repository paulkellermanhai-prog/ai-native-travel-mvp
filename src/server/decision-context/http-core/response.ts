import { parseDCContract } from "../contracts";
import { json } from "../../http/security";
import { parseContract, type TripStateContracts } from "../../trip-state/contracts";
import { BridgeRuleError } from "../write-bridge/rules";

const statuses: Readonly<Record<string, number>> = {
  ACCESS_DENIED: 403, NOT_FOUND: 404, CHECKPOINT_NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  CONTRACT_INVALID: 422, TRIP_MISMATCH: 422, TARGET_NOT_FOUND: 422, SOURCE_SPAN: 422, EVENT_TIME: 422,
  TASK_KEYS: 422, TASK_RELATION: 422, TASK_IDENTITY: 422, TASK_CLOSED: 422, TASK_PAUSED: 422,
  PROGRESS_EVIDENCE: 422, TASK_NOT_RECOVERABLE: 422, PAGE_SCOPE: 422, TURN_MISMATCH: 422,
  INPUT_BINDING: 422, WRITE_GRANT: 422, HYPOTHETICAL_WRITE: 422, INCOMPLETE_DELIVERY: 422, ASSEMBLY_FAILED: 422,
  PROPOSAL_BINDING: 422, RESTORED_INPUT_READ_ONLY: 422, RECOVERED_EVENT_REPLAY: 422,
  CHECKPOINT_EXPIRED: 422, CHECKPOINT_CORRUPT: 422, CHECKPOINT_DB_VERSION: 422, CHECKPOINT_POLICY: 422,
  CHECKPOINT_IDEMPOTENCY: 422, CHECKPOINT_TOO_LARGE: 422, CHECKPOINT_RETRY_EMPTY: 422, WORKSPACE_MISMATCH: 422, SCENE_REFERENCES: 422,
  EVENT_REUSE: 409, IDEMPOTENCY_CONFLICT: 409, CHECKPOINT_CONFLICT: 409, CHECKPOINT_SUPERSEDED: 409, STATE_BEHIND_CHECKPOINT: 409,
  REVISION_CHANGED: 409, SNAPSHOT_BUSY: 409, SNAPSHOT_MISMATCH: 409, PACKET_STALE: 409,
  PACKET_EXPIRED: 409, EVIDENCE_CHANGED: 409, CHECKPOINT_STORAGE: 503, CHECKPOINT_ACK_UNKNOWN: 503,
  RECOVERY_UNAVAILABLE: 503, INTERNAL_FAILURE: 500,
};
export class RuntimeHttpFault extends Error {
  constructor(readonly code: string, readonly retryable = false) { super("Runtime operation failed"); this.name = "RuntimeHttpFault"; }
}
// R6: revision drift allows a fresh read/reassembly, never automatic replay of
// a consequential write. Other bridge refusals require corrected input or proof.
const bridgeRetryable: Readonly<Record<string, boolean>> = {
  RESTORED_INPUT_READ_ONLY: false, TURN_MISMATCH: false, REVISION_CHANGED: true,
  INPUT_BINDING: false, HYPOTHETICAL_WRITE: false, INCOMPLETE_DELIVERY: false,
  WRITE_GRANT: false, PROPOSAL_BINDING: false, IDEMPOTENCY_CONFLICT: false,
};
export function runtimeError(error: unknown): Response {
  const bridge = error instanceof BridgeRuleError && Object.hasOwn(bridgeRetryable, error.code);
  const known = bridge || error instanceof RuntimeHttpFault && Object.hasOwn(statuses, error.code);
  const code = known ? error.code : "INTERNAL_FAILURE";
  const status = statuses[code];
  const message = status === 403 ? "Access denied" : status >= 500 ? "Runtime unavailable" : "Runtime request rejected";
  const retryable = bridge ? bridgeRetryable[error.code] : error instanceof RuntimeHttpFault && known && error.retryable;
  const value = parseDCContract("error", { runtime_contract_version: "0.1.0", code, message, retryable });
  return json(value, status, status === 405 ? { Allow: "POST" } : {});
}
export function businessResponse(value: unknown): Response {
  const result: TripStateContracts["response"] = parseContract("response", value);
  const code = result.errors[0]?.code;
  if (code === "PERMISSION" || code === "ACTOR") return json(parseContract("response", { outcome: "rejected", revision: 0, proposal_id: null, proposal_digest: null, confirmation_required: false, affected_ids: [], diff: [], errors: [{ code: "PERMISSION", message: "Access denied" }] }), 403);
  if (code === "INTERNAL_FAILURE" || code?.startsWith("STORAGE_")) return runtimeError(new RuntimeHttpFault("INTERNAL_FAILURE"));
  return json(result, { applied: 200, preview: 200, pending_confirmation: 202, conflict: 409, rejected: 422 }[result.outcome]);
}
