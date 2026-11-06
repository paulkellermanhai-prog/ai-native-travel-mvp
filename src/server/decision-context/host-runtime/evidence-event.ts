import { createHash, randomUUID } from "node:crypto";
import { EvidenceBoundaryError, recordInputSchema, scopeSchema, type RecordInput } from "../../interaction-evidence/contracts";

/** An internal persistence candidate, never an authorization or a durable receipt. */
export type PreparedEvidenceEvent = {
  ownerId: string; tripId: string; workspaceKey: string; sessionId: string;
  eventId: string; receivedAt: Date; input: RecordInput; inputDigest: string;
};

/**
 * The caller must supply the principal obtained from the authenticated session and
 * a workspace bound by the server. This helper validates shape only; persistence
 * must recheck membership and session inside its transaction before returning a receipt.
 */
export function prepareEvidenceEvent(principal: { userId: string; sessionId: string }, tripId: string, workspaceKey: string, value: unknown, receivedAt: Date): PreparedEvidenceEvent {
  const scope = scopeSchema.safeParse({ owner_id: principal.userId, trip_id: tripId, workspace_key: workspaceKey });
  const input = recordInputSchema.safeParse(value);
  if (!scope.success || !input.success || typeof principal.sessionId !== "string" || principal.sessionId.length < 1 || principal.sessionId.length > 256 || !(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) {
    throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
  }
  const digest = createHash("sha256").update(JSON.stringify([input.data.entry, input.data.text]), "utf8").digest("hex");
  return { ownerId: scope.data.owner_id, tripId: scope.data.trip_id, workspaceKey: scope.data.workspace_key, sessionId: principal.sessionId,
    eventId: `event_${randomUUID()}`, receivedAt: new Date(receivedAt.getTime()), input: { ...input.data }, inputDigest: digest };
}
