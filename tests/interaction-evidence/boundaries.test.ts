import {describe,it,expect} from "vitest";
import {eventSchema,recordInputSchema,associationSchema,disabledProductionConfig,requireProductionEvidence,CURSOR_TTL_MS} from "../../src/server/interaction-evidence/contracts";
import {checkCursor,checkReadWindow} from "../../src/server/interaction-evidence/boundaries";
import {evidenceDeadline,requireReadableEvidence} from "../../src/server/interaction-evidence/retention";
const scope={owner_id:"user-a",trip_id:"trip-a",workspace_key:"workspace-a",task_key:"task-a"};
const now=new Date("2030-01-01T00:00:00Z");
const input={recordedAt:now,tripEndedAt:null,lastVerifiedRelatedAt:null,deletedAt:null};
const event={contract:"host-interaction-evidence/v1",owner_id:scope.owner_id,trip_id:scope.trip_id,workspace_key:scope.workspace_key,event_id:"event-a",entry:"dialogue",text:"原话",received_at:now.toISOString(),recorded_at:now.toISOString(),sequence:1,source:"authenticated_user",session_ref:"session-a",source_reference:"host-interaction:event-a",idempotency_key:"submit-a",input_digest:"a".repeat(64),policy:"DC-AC8-PRIVACY-01",deleted_at:null};
describe("E11 independent contract/policy foundation",()=>{
 it("accepts only client content and idempotency input, rejecting self-declared identity/event/time",()=>{
  const body={entry:"dialogue",text:"原话",idempotency_key:"submit-a"};expect(recordInputSchema.safeParse(body).success).toBe(true);
  for(const v of [{...body,event_id:"forged"},{...body,owner_id:"other"},{...body,received_at:now.toISOString()},{...body,source:"authenticated_user"}])expect(recordInputSchema.safeParse(v).success).toBe(false);
 });
 it("validates original event separately from DC and rejects forged source/reference/extra authority",()=>{
  expect(eventSchema.safeParse(event).success).toBe(true);
  for(const v of [{...event,source:"model"},{...event,source_reference:"host-interaction:event-other"},{...event,current_grant:true},{...event,sequence:9007199254740992}])expect(eventSchema.safeParse(v).success).toBe(false);
 });
 it("counts Unicode codepoints at the original 16000 character boundary",()=>{expect(eventSchema.safeParse({...event,text:"🙂".repeat(16000)}).success).toBe(true);expect(eventSchema.safeParse({...event,text:"🙂".repeat(16001)}).success).toBe(false);});
 it("locks append-only association revision and exact expected-version transition",()=>{
  const link={...scope,link_id:"link-a",event_id:"event-a",action:"link",association_revision:1,expected_association_revision:0,source_turn_id:"turn-a",linked_at:now.toISOString(),idempotency_key:"link-key"};
  expect(associationSchema.safeParse(link).success).toBe(true);expect(associationSchema.safeParse({...link,association_revision:2}).success).toBe(false);
 });
 it("uses the earliest trip+30 / related+180 / record+12 calendar months deadline",()=>{
  expect(evidenceDeadline(input).toISOString()).toBe("2030-06-30T00:00:00.000Z");
  expect(evidenceDeadline({...input,tripEndedAt:new Date("2030-01-02Z")}).toISOString()).toBe("2030-02-01T00:00:00.000Z");
  expect(evidenceDeadline({...input,lastVerifiedRelatedAt:new Date("2030-12-01Z")}).toISOString()).toBe("2031-01-01T00:00:00.000Z");
  expect(evidenceDeadline({...input,recordedAt:new Date("2028-02-29T12:30:00Z"),lastVerifiedRelatedAt:new Date("2029-01-01Z")}).toISOString()).toBe("2029-02-28T12:30:00.000Z");
 });
 it("blocks deletion immediately, expiry at the exact deadline and unknown policy timestamps",()=>{
  expect(()=>requireReadableEvidence({...input,deletedAt:now},now)).toThrow("EVIDENCE_DELETED");
  expect(()=>requireReadableEvidence(input,evidenceDeadline(input))).toThrow("EVIDENCE_EXPIRED");
  expect(()=>requireReadableEvidence(input,new Date("invalid"))).toThrow("EVIDENCE_UNAVAILABLE");
  expect(()=>requireReadableEvidence({...input,lastVerifiedRelatedAt:new Date("2030-02-01Z")},now)).toThrow("EVIDENCE_UNAVAILABLE");
 });
 it("invalidates cursor on each scope dimension, deletion/association revision, expiry or invalid watermarks",()=>{
  const cursor={...scope,high_watermark:10,after_sequence:0,association_revision:2,retention_revision:3,expires_at:new Date(now.getTime()+CURSOR_TTL_MS).toISOString()};
  expect(checkCursor(cursor,scope,now,{association:2,retention:3})).toEqual(cursor);
  for(const key of ["owner_id","trip_id","workspace_key","task_key"] as const)expect(()=>checkCursor(cursor,{...scope,[key]:"other"},now,{association:2,retention:3})).toThrow("EVIDENCE_CURSOR_STALE");
  for(const c of [{...cursor,retention_revision:4},{...cursor,association_revision:3},{...cursor,expires_at:now.toISOString()},{...cursor,after_sequence:11}])expect(()=>checkCursor(c,scope,now,{association:2,retention:3})).toThrow("EVIDENCE_CURSOR_STALE");
 });
 it("enforces finite read windows/page sizes",()=>{checkReadWindow(100,now,now);for(const n of [0,101,1.1,Infinity])expect(()=>checkReadWindow(n,now,now)).toThrow();expect(()=>checkReadWindow(1,now,new Date("2031-01-01Z"))).toThrow();});
 it("keeps production disabled until finite cleanup/audit, notice, deletion and engineering gates are set",()=>{
  expect(()=>requireProductionEvidence(disabledProductionConfig)).toThrow("EVIDENCE_UNAVAILABLE");
  const c={enabled:true,backup_cleanup_days:7,audit_retention_days:30,notice_approved:true,deletion_verified:true,engineering_gate_passed:true};
  expect(requireProductionEvidence(c)).toEqual(c);
  for(const v of [{...c,backup_cleanup_days:null},{...c,audit_retention_days:Infinity},{...c,notice_approved:false},{...c,deletion_verified:false},{...c,engineering_gate_passed:false}])expect(()=>requireProductionEvidence(v)).toThrow();
 });
});
