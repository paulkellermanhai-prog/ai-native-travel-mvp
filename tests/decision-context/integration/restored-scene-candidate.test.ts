import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRestoredSceneCandidate } from "../../../src/server/decision-context/integration/restored-scene-candidate";
import { parseDCContract } from "../../../src/server/decision-context/contracts";
import { checkConfirmationRules } from "../../../src/server/decision-context/write-bridge/rules";
import { emptyDeliveryLedger, checkConsumption } from "../../../src/server/decision-context/packet-core/packet";
import type { CheckpointPayload, Confirm } from "../../../src/server/decision-context/contracts.generated";
import { base } from "../../support/bcg-fixtures";

const rows=JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json","utf8")) as {schema:string;value:unknown}[];
const fixture=()=>structuredClone(rows.find(r=>r.schema==="checkpoint-payload")!.value) as CheckpointPayload;
const confirm=()=>structuredClone(rows.find(r=>r.schema==="confirm")!.value) as Confirm;
const input=()=>({checkpoint:fixture(),currentState:structuredClone(base),workspaceKey:"workspace",checkpointRevision:1,
  savedAt:"2030-01-01T00:00:00Z",runtimeId:"runtime-test",bodyBudgetBytes:2,now:new Date("2030-01-01T00:00:00Z"),saveUnacknowledged:false});

describe("restored scene assembly candidate (synthetic, no host authority)",()=>{
  it("rebuilds a focused read-only packet on one snapshot without mutating sources",()=>{
    const args=input(), before=structuredClone(args), result=buildRestoredSceneCandidate(args);
    expect(args).toEqual(before);
    expect(parseDCContract("scene-restored",result.scene)).toEqual(result.scene);
    expect(result.scene).toMatchObject({workspace_key:"workspace",checkpoint_revision:1,saved_state_revision:0,current_state_revision:0,recovery_requires_new_authorization:true});
    expect(result.scene.warnings).toEqual(expect.arrayContaining(["restored_scene_not_old_authorization","drafts_read_only_no_automatic_submission"]));
    expect(result.scene.restored_turns).toHaveLength(1); expect(result.packets).toHaveLength(1);
    const candidate=result.packets[0], {turn,pending,recovered}=result.turns[0];
    expect(recovered).toBe(true); expect(pending.proposal_id).toBeNull();
    expect(turn.turn_id).toBe(candidate.packet.turn_id);
    expect(candidate.packet.warnings).toContain("restored_input_read_only_repreview_required");
    expect(candidate.packet.coverage).toBe("limited"); expect(candidate.packet.support).toBe("information_only");
    expect(checkConsumption(candidate,args.currentState,args.now,emptyDeliveryLedger(candidate)).remainingIds).toEqual(candidate.assembly.context.selected_object_ids);
    expect(()=>checkConfirmationRules(confirm(),{turnId:turn.turn_id,proposalId:null,recovered:true})).toThrowError(expect.objectContaining({code:"RESTORED_INPUT_READ_ONLY"}));
  });
  it("keeps an unacknowledged save warning in the recovered packet",()=>{
    const args=input(); args.saveUnacknowledged=true;
    const candidate=buildRestoredSceneCandidate(args);
    expect(candidate.packets[0].packet.warnings).toContain("scene_save_unacknowledged_business_state_is_separate");
  });
  it("preserves missing targets and omits their packets rather than inventing one",()=>{
    const args=input(); args.checkpoint.tasks[0].task.target_ids=["missing-object"];
    args.checkpoint.view.selected_id="missing-object"; args.checkpoint.view.comparison_refs=[{id:"missing-object",version:1}];
    const result=buildRestoredSceneCandidate(args);
    expect(result.scene.restored_turns).toHaveLength(1); expect(result.scene.packets).toEqual([]);
    expect(result.scene.missing_target_ids).toEqual(["missing-object"]);
    expect(result.scene.stale_comparison_ids).toEqual(["missing-object"]);
    expect(result.scene.warnings).toEqual(expect.arrayContaining(["missing_references_preserved_for_review","comparison_versions_changed"]));
  });
  it("preserves stale draft contents as read-only data without applying commands",()=>{
    const args=input(); args.currentState.revision=1;
    args.checkpoint.drafts=[{draft_id:"draft-z",draft_kind:"hypothetical",base_revision:0,target_ids:[],text:"假设少一晚",source_reference:"draft-source",proposal:null},
      {draft_id:"draft-a",draft_kind:"unsubmitted",base_revision:0,target_ids:[],text:"我想修改",source_reference:"draft-other",proposal:null}];
    const before=structuredClone(args.currentState), result=buildRestoredSceneCandidate(args);
    expect(result.scene.drafts).toEqual(args.checkpoint.drafts);
    expect(result.scene.stale_draft_ids).toEqual(["draft-a","draft-z"]);
    expect(result.scene.warnings).toContain("state_changed_rebuilt_from_current_authority");
    expect(args.currentState).toEqual(before);
  });
  it("keeps nonfocused tasks but generates packets only for focused tasks",()=>{
    const args=input(), extra=structuredClone(args.checkpoint.tasks[0]);
    extra.task.task_key="other-task"; args.checkpoint.tasks.push(extra);
    const result=buildRestoredSceneCandidate(args);
    expect(result.scene.restored_turns).toHaveLength(2); expect(result.scene.packets).toHaveLength(1);
    expect(result.scene.packets[0].task.task_key).toBe(args.checkpoint.focus_keys[0]);
  });
});
