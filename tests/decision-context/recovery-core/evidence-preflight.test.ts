import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEvidencePreflight } from "../../../src/server/decision-context/recovery-core/evidence-preflight";
import type { CheckpointPayload } from "../../../src/server/decision-context/contracts.generated";
import type { EvidencePage, EvidenceScope } from "../../../src/server/interaction-evidence/contracts";

const sample = (JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:CheckpointPayload}[]).find((r) => r.schema === "checkpoint-payload")!.value;
function fixture() {
  const payload = structuredClone(sample), event = payload.tasks[0].event, task = payload.tasks[0].task;
  event.reference = `host-interaction:${event.event_id}`;
  const scope: EvidenceScope = { owner_id:"owner", trip_id:payload.trip_id, workspace_key:"workspace" };
  const page: EvidencePage = { authority:"historical_evidence_only", status:"complete", complete:true, cursor:null,
    events:[{ ...scope, task_key:task.task_key, event_id:event.event_id, text:event.text, entry:event.entry,
      received_at:event.received_at, recorded_at:event.received_at, source_reference:event.reference, sequence:1, association_revision:1 }] };
  return { payload, scope, page, taskKey:task.task_key };
}
describe("E11 recovery preflight never reconstructs evidence or authorization", () => {
  it("matches same-owner/trip/workspace/task/event and returns no original text", () => {
    const {payload,scope,page,taskKey} = fixture();
    const result = checkEvidencePreflight(scope,payload,new Map([[taskKey,page]]));
    expect(result).toEqual({ ready:true, failures:[] });
    expect(JSON.stringify(result)).not.toContain(payload.tasks[0].event.text);
  });
  it.each([ ["deleted","EVIDENCE_DELETED"], ["expired","EVIDENCE_EXPIRED"], ["partial","EVIDENCE_UNAVAILABLE"], ["missing","EVIDENCE_UNAVAILABLE"] ] as const)("fails closed for %s evidence", (status,reason) => {
    const {payload,scope,page,taskKey} = fixture(); page.status = status;
    expect(checkEvidencePreflight(scope,payload,new Map([[taskKey,page]]))).toEqual({ready:false, failures:[{task_key:taskKey,reason}]});
  });
  it("rejects a forged scope, text or incomplete cursor and does not infer user silence", () => {
    const {payload,scope,page,taskKey} = fixture(); page.events[0].owner_id = "other-user";
    expect(checkEvidencePreflight(scope,payload,new Map([[taskKey,page]])).failures[0].reason).toBe("EVIDENCE_MISSING");
    page.events[0].owner_id = scope.owner_id; page.events[0].text = "forged";
    expect(checkEvidencePreflight(scope,payload,new Map([[taskKey,page]])).failures[0].reason).toBe("EVIDENCE_MISSING");
    page.events[0].text = payload.tasks[0].event.text; page.events[0].received_at = "2031-01-01T00:00:00Z";
    expect(checkEvidencePreflight(scope,payload,new Map([[taskKey,page]])).failures[0].reason).toBe("EVIDENCE_MISSING");
    page.cursor = "next";
    expect(checkEvidencePreflight(scope,payload,new Map([[taskKey,page]])).failures[0].reason).toBe("EVIDENCE_UNAVAILABLE");
    expect(checkEvidencePreflight(scope,payload,new Map()).ready).toBe(false);
  });
  it("keeps draft-bearing restoration closed until draft sources are verifiable", () => {
    const {payload,scope,page,taskKey} = fixture();
    payload.drafts = [{draft_id:"draft-1",draft_kind:"unsubmitted",base_revision:0,target_ids:[],text:"历史草稿",source_reference:"draft-source",proposal:null}];
    expect(checkEvidencePreflight(scope,payload,new Map([[taskKey,page]]))).toEqual({ready:false,failures:[{task_key:"",reason:"EVIDENCE_UNAVAILABLE"}]});
  });
});
