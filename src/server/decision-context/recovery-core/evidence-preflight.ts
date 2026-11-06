import type { EvidencePage, EvidenceScope } from "../../interaction-evidence/contracts";
import type { CheckpointPayload } from "../contracts.generated";

type PreflightReason = "EVIDENCE_UNAVAILABLE" | "EVIDENCE_MISSING" | "EVIDENCE_DELETED" | "EVIDENCE_EXPIRED";
/**
 * Candidate preflight only. A positive result is NOT a current deletion barrier:
 * the host must hold/revalidate a real E11 permission+retention proof at delivery.
 * No original text, packet, identity capability or write grant is returned here.
 */
export function checkEvidencePreflight(scope: EvidenceScope, checkpoint: CheckpointPayload,
  pages: ReadonlyMap<string, EvidencePage>) {
  if (checkpoint.trip_id !== scope.trip_id) return { ready: false, failures: [{ task_key: "", reason: "EVIDENCE_UNAVAILABLE" as const }] };
  const failures: { task_key: string; reason: PreflightReason }[] = [];
  for (const { task, event } of checkpoint.tasks) {
    const page = pages.get(task.task_key);
    let reason: PreflightReason | undefined;
    if (!page || page.authority !== "historical_evidence_only") reason = "EVIDENCE_UNAVAILABLE";
    else if (page.status === "deleted") reason = "EVIDENCE_DELETED";
    else if (page.status === "expired") reason = "EVIDENCE_EXPIRED";
    else if (page.status !== "complete" || !page.complete || page.cursor !== null) reason = "EVIDENCE_UNAVAILABLE";
    else {
      const eventRecord = page.events.find((row) => row.event_id === event.event_id && row.task_key === task.task_key);
      if (!eventRecord || eventRecord.owner_id !== scope.owner_id || eventRecord.trip_id !== scope.trip_id ||
          eventRecord.workspace_key !== scope.workspace_key || eventRecord.source_reference !== event.reference ||
          eventRecord.source_reference !== `host-interaction:${event.event_id}` || eventRecord.entry !== event.entry ||
          eventRecord.text !== event.text || eventRecord.received_at !== event.received_at) reason = "EVIDENCE_MISSING";
    }
    if (reason) failures.push({ task_key: task.task_key, reason });
  }
  // Draft source verification is not supplied by this first preflight contract.
  // Do not let a matching recent task event certify unrelated draft text.
  if (checkpoint.drafts.length) failures.push({ task_key: "", reason: "EVIDENCE_UNAVAILABLE" });
  return { ready: failures.length === 0, failures };
}
