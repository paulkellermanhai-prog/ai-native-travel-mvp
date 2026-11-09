import { checkReadWindow } from "../../interaction-evidence/boundaries";
import { PAGE_LIMIT, type EvidencePage, type EvidenceScope, type HostInteractionEvidenceReader } from "../../interaction-evidence/contracts";
import type { CheckpointPayload } from "../contracts.generated";
import { checkEvidencePreflight } from "../recovery-core/evidence-preflight";

/**
 * Internal integration seam only. A ready result is not an authorization or a
 * deletion lock and must never be used to open a restore endpoint by itself.
 * The host must supply verified scope/credential/window and an actual E11 reader.
 */
export async function inspectRecoveryEvidence(reader: HostInteractionEvidenceReader, scope: EvidenceScope,
  checkpoint: CheckpointPayload, credential: Headers, window: { from: Date; to: Date }) {
  const unavailable = () => ({ ready:false, failures:[{task_key:"",reason:"EVIDENCE_UNAVAILABLE" as const}] });
  if (!(credential instanceof Headers) || !credential.get("cookie") || checkpoint.trip_id !== scope.trip_id) return unavailable();
  try { checkReadWindow(PAGE_LIMIT,window.from,window.to); }
  catch { return unavailable(); }
  const pages = new Map<string, EvidencePage>();
  for (const {task} of checkpoint.tasks) {
    try {
      const page = await reader.read({ ...scope, task_key:task.task_key }, {
        page_size:PAGE_LIMIT, from:window.from.toISOString(), to:window.to.toISOString(), cursor:null,
      }, new Headers({ cookie:credential.get("cookie") ?? "" }));
      pages.set(task.task_key,page);
    } catch { /* E11 unavailable or denied remains unknown; do not fabricate evidence. */ }
  }
  return checkEvidencePreflight(scope,checkpoint,pages);
}
