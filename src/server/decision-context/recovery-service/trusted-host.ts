import { CheckpointError } from "../checkpoint-core";
import type { openEvidenceHost } from "../host-runtime/evidence-host";

type EvidenceHost = Awaited<ReturnType<typeof openEvidenceHost>>;

/**
 * Checkpoint persistence operations exposed by the trusted host. The host owns
 * the opaque workspace ticket and revalidates the Cookie Session, Trip
 * membership, registered Task sources and E11 retention barrier in PostgreSQL.
 */
export type TrustedCheckpointHost = Pick<EvidenceHost, "saveCheckpoint" | "inspectCheckpoint">;

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

    close() { closed = true; },
  });
}
