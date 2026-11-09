import { randomUUID } from "node:crypto";
import { parseDCContract } from "../contracts";
import type { CheckpointPayload, Pending, SceneRestored, Turn } from "../contracts.generated";
import type { State } from "../../trip-state/contracts.generated";
import { classifyRecovery } from "../recovery-core";
import { assembleContextSnapshot } from "../context-assembly";
import { buildPacketCandidate, checkPacketTurn, type PacketCandidate } from "../packet-core/packet";

/**
 * Pure assembly candidate: every input, including the state, saved payload and
 * status flags, must already come from the authorized host. It creates no
 * Session, ownership, delivery receipt, grant or deletion/retention proof.
 * The returned bodies may contain original user text; do not publish, cache or
 * call this from an external route until the real delivery barrier is connected.
 */
export function buildRestoredSceneCandidate(input: {
  checkpoint: CheckpointPayload; currentState: State; workspaceKey: string;
  checkpointRevision: number; savedAt: string; runtimeId: string; bodyBudgetBytes: number;
  now: Date; saveUnacknowledged: boolean;
}): { scene: SceneRestored; turns: Array<{ turn: Turn; pending: Pending; recovered: true }>; packets: PacketCandidate[] } {
  const request=parseDCContract("scene-restore",{runtime_contract_version:"0.1.0",workspace_key:input.workspaceKey,body_budget_bytes:input.bodyBudgetBytes});
  const now=new Date(input.now.getTime());
  if (!Number.isFinite(now.getTime()) || typeof input.saveUnacknowledged!=="boolean") throw new Error("SCENE_STATUS_UNAVAILABLE");
  const classified=classifyRecovery(input.checkpoint,input.currentState);
  const payload=classified.payload;
  const objectIds=new Set(input.currentState.objects.map(object=>object.id));
  const turns: Array<{turn:Turn;pending:Pending;recovered:true}>=[], packets:PacketCandidate[]=[];
  const restoredTurns:SceneRestored["restored_turns"]=[];
  for (const row of payload.tasks) {
    const turnId=`turn-${randomUUID().replaceAll("-","")}`;
    const turn=parseDCContract("turn",{runtime_contract_version:"0.1.0",runtime_id:input.runtimeId,turn_id:turnId,
      revision:row.base_revision,tasks:[row.task],focus_keys:[row.task.task_key],checkpoint_ack:null});
    const pending:Pending={event:structuredClone(row.event),base_revision:row.base_revision,processing_status:row.processing_status,
      proposal_id:null,result_revision:row.result_revision,errors:structuredClone(row.errors)};
    turns.push({turn,pending,recovered:true});
    restoredTurns.push({task_key:row.task.task_key,turn_id:turnId});
    if (!payload.focus_keys.includes(row.task.task_key) || row.task.target_ids.some(id=>!objectIds.has(id))) continue;
    const assembly=assembleContextSnapshot(input.currentState,row.task.task_key,row.task.target_ids,now);
    const candidate=buildPacketCandidate({request:{runtime_contract_version:"0.1.0",turn_id:turnId,task_key:row.task.task_key,
      body_budget_bytes:request.body_budget_bytes},packetId:`packet-${randomUUID().replaceAll("-","")}`,task:row.task,pending,
      assembly,state:input.currentState,now,recoveredInput:true,saveUnacknowledged:input.saveUnacknowledged});
    checkPacketTurn(candidate,turn,pending); packets.push(candidate);
  }
  const warnings=["restored_scene_not_old_authorization","drafts_read_only_no_automatic_submission"];
  if (input.currentState.revision!==payload.captured_state_revision) warnings.push("state_changed_rebuilt_from_current_authority");
  if (classified.missing_target_ids.length) warnings.push("missing_references_preserved_for_review");
  if (classified.stale_comparison_ids.length) warnings.push("comparison_versions_changed");
  if (packets.some(p=>p.packet.context.stale_fact_ids.length)) warnings.push("evidence_expired_or_unusable");
  if (classified.reopened_issue_ids.length) warnings.push("deferred_issues_reopened_by_current_state");
  const scene=parseDCContract("scene-restored",{runtime_contract_version:"0.1.0",workspace_key:request.workspace_key,
    checkpoint_revision:input.checkpointRevision,runtime_id:input.runtimeId,saved_state_revision:classified.saved_state_revision,
    current_state_revision:classified.current_state_revision,saved_at:input.savedAt,view:payload.view,drafts:payload.drafts,
    focus_keys:payload.focus_keys,restored_turns:restoredTurns,packets:packets.map(p=>p.packet),warnings,
    stale_draft_ids:[...classified.stale_draft_ids].sort(),missing_target_ids:classified.missing_target_ids,
    stale_comparison_ids:classified.stale_comparison_ids,deferred_issue_ids:classified.deferred_issue_ids,
    reopened_issue_ids:classified.reopened_issue_ids,recovery_requires_new_authorization:true});
  return {scene:structuredClone(scene),turns:structuredClone(turns),packets:structuredClone(packets)};
}
