import { CheckpointError } from "../checkpoint-core";
import type { openEvidenceHost } from "../host-runtime/evidence-host";

type EvidenceHost = Awaited<ReturnType<typeof openEvidenceHost>>;

/**
 * Checkpoint persistence operations exposed by the trusted host. The host owns
 * the opaque workspace ticket and revalidates the Cookie Session, Trip
 * membership, registered Task sources and E11 retention barrier in PostgreSQL.
 */
export type TrustedCheckpointHost = Pick<EvidenceHost, "saveCheckpoint" | "inspectCheckpoint" | "reopenWorkspace" | "restoreCheckpoint">;

export function connectTrustedCheckpointHost(host: TrustedCheckpointHost) {
  let closed = false;

  function active() {
    if (closed) throw new CheckpointError("RECOVERY_UNAVAILABLE");
  }

  return Object.freeze({
    /** CAS, operation-key idempotency and acknowledgement validation stay in the host transaction. */
    async save(ticket: object, credential: Headers, input: unknown, expectedRevision: number, operationKey: string) {
      active();
      return host.saveCheckpoint(ticket, credential, input, expectedRevision, operationKey);
    },

    /** Metadata-only inspection; checkpoint payload and original text are not returned. */
    async inspect(ticket: object, credential: Headers) {
      active();
      return host.inspectCheckpoint(ticket, credential);
    },

    /** The workspace key is a locator only; the host mints the new opaque ticket after current authorization. */
    async reopen(tripId: string, credential: Headers, workspaceKey: string) {
      active();
      return host.reopenWorkspace(tripId, credential, workspaceKey);
    },

    /** Restores current, source-checked Task state without reviving old write authority. */
    async restore(ticket: object, credential: Headers, bodyBudgetBytes?: number) {
      active();
      return host.restoreCheckpoint(ticket, credential, bodyBudgetBytes);
    },

    close() { closed = true; },
  });
}
