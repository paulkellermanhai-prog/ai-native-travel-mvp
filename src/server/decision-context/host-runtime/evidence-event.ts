import { createHash, createHmac, randomUUID } from "node:crypto";
import { EvidenceBoundaryError, recordInputSchema, scopeSchema, type RecordInput } from "../../interaction-evidence/contracts";

/** An internal persistence candidate, never an authorization or a durable receipt. */
export type PreparedEvidenceEvent = {
  ownerId: string; tripId: string; workspaceKey: string; sessionId: string;
  eventId: string; receivedAt: Date; input: RecordInput; inputDigest: string;
};

/** An opaque lookup token, so a client-supplied key is not retained as plaintext. */
export function evidenceKeyToken(secret: string, scope: { ownerId: string; tripId: string; workspaceKey: string }, key: string): string {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32 || typeof key !== "string" || key.length < 1 || key.length > 256) {
    throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
  }
  return createHmac("sha256", secret).update(JSON.stringify([scope.ownerId, scope.tripId, scope.workspaceKey, key]), "utf8").digest("hex");
}

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
