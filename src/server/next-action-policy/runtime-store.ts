import type {Prisma} from "../../generated/prisma/client";
import {canonicalJson,digest} from "../trip-state/command-json";
import {nextActionPhase,type ActionPhase} from "./action-phase";
import type {DecisionPlan} from "./decision-engine";
import {validatePlanRequestConsistency} from "./plan-packet-consistency";
import type {TrustedDecisionRequest} from "./trusted-packet-source";

export type NapRuntimeScope={ownerId:string;tripId:string;workspaceKey:string;runtimeId:string};
type DecisionRow={runtime_id:string;request_digest:string;plan_digest:string;state_revision:bigint;expires_at:Date;request_json:unknown;plan_json:unknown;created_at:Date};
type ActionRow={action_id:string;phase:ActionPhase;receipt_lookup_required:boolean;result_json:unknown;updated_at:Date};
type StepRow={action_id:string;step_id:string;position:number;kind:string;depends_on:unknown;status:"pending"|"running"|"succeeded"|"failed"|"stale";
  claim_token:string|null;result_json:unknown;attempted_at:Date|null;completed_at:Date|null};

export class NapRuntimeError extends Error{
  constructor(readonly code:"DECISION_CONFLICT"|"NOT_FOUND"|"STORAGE_INTEGRITY"|"CLAIM_CONFLICT"){
    super(`NAP runtime: ${code}`);this.name="NapRuntimeError";
  }
}
const fail=(code:NapRuntimeError["code"]):never=>{throw new NapRuntimeError(code);};
const same=(left:unknown,right:unknown)=>canonicalJson(left)===canonicalJson(right);

export async function saveDecisionPlan(tx:Prisma.TransactionClient,scope:NapRuntimeScope,request:TrustedDecisionRequest,plan:DecisionPlan):Promise<{plan:DecisionPlan;replayed:boolean}>{
  validatePlanRequestConsistency(request,plan);
  if(plan.runtime_id!==scope.runtimeId||request.runtime_id!==scope.runtimeId||request.packets.some(packet=>packet.context.trip_id!==scope.tripId))return fail("STORAGE_INTEGRITY");
  const requestDigest=digest(request),planDigest=digest(plan),revision=plan.basis[0].state_revision;
  const expiresAt=new Date(Math.min(...plan.basis.map(basis=>new Date(basis.expires_at).getTime())));
  const inserted=await tx.$queryRaw<Array<{decision_id:string}>>`INSERT INTO e04_runtime.decisions
    (owner_id,trip_id,workspace_key,decision_id,runtime_id,request_digest,plan_digest,state_revision,expires_at,request_json,plan_json)
    VALUES (${scope.ownerId},${scope.tripId},${scope.workspaceKey},${plan.decision_id},${scope.runtimeId},${requestDigest},${planDigest},${BigInt(revision)},${expiresAt},${JSON.stringify(request)}::jsonb,${JSON.stringify(plan)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING decision_id`;
  if(inserted.length===0){
    const [existing]=await tx.$queryRaw<DecisionRow[]>`SELECT runtime_id,request_digest,plan_digest,state_revision,expires_at,request_json,plan_json,created_at
      FROM e04_runtime.decisions WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${plan.decision_id} FOR UPDATE`;
    if(!existing)return fail("STORAGE_INTEGRITY");
    if(existing.request_digest!==requestDigest||!same(existing.request_json,request))return fail("DECISION_CONFLICT");
    const stored=structuredClone(existing.plan_json) as DecisionPlan;
    if(existing.plan_digest!==digest(stored))return fail("STORAGE_INTEGRITY");
    validatePlanRequestConsistency(existing.request_json,stored);
    return {plan:stored,replayed:true};
  }
  for(const action of plan.actions){
    let phase=nextActionPhase("proposed",{kind:"evaluate",structureValid:true,eligibilityPassed:true}).phase;
    if(action.steps[0]?.kind==="ask")phase=nextActionPhase(phase,{kind:"await_user",userInputRequired:true}).phase;
    await tx.$executeRaw`INSERT INTO e04_runtime.actions(owner_id,trip_id,workspace_key,decision_id,action_id,phase)
      VALUES (${scope.ownerId},${scope.tripId},${scope.workspaceKey},${plan.decision_id},${action.action_id},${phase})`;
    for(let position=0;position<action.steps.length;position++){
      const step=action.steps[position];
      await tx.$executeRaw`INSERT INTO e04_runtime.steps(owner_id,trip_id,workspace_key,decision_id,action_id,step_id,position,kind,depends_on,status)
        VALUES (${scope.ownerId},${scope.tripId},${scope.workspaceKey},${plan.decision_id},${action.action_id},${step.step_id},${position},${step.kind},${JSON.stringify(step.depends_on)}::jsonb,'pending')`;
    }
  }
  return {plan:structuredClone(plan),replayed:false};
}

async function locked(tx:Prisma.TransactionClient,scope:NapRuntimeScope,decisionId:string,actionId:string){
  const [decision]=await tx.$queryRaw<DecisionRow[]>`SELECT runtime_id,request_digest,plan_digest,state_revision,expires_at,request_json,plan_json,created_at
    FROM e04_runtime.decisions WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} FOR UPDATE`;
  const [action]=await tx.$queryRaw<ActionRow[]>`SELECT action_id,phase,receipt_lookup_required,result_json,updated_at FROM e04_runtime.actions
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} FOR UPDATE`;
  const steps=await tx.$queryRaw<StepRow[]>`SELECT action_id,step_id,position,kind,depends_on,status,claim_token,result_json,attempted_at,completed_at
    FROM e04_runtime.steps WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} ORDER BY position FOR UPDATE`;
  if(!decision||!action||steps.length===0)return fail("NOT_FOUND");
  const plan=decision.plan_json as DecisionPlan;
  if(decision.plan_digest!==digest(plan))return fail("STORAGE_INTEGRITY");
  return {decision,action,steps,plan};
}

async function stale(tx:Prisma.TransactionClient,scope:NapRuntimeScope,decisionId:string,actionId:string){
  await tx.$executeRaw`UPDATE e04_runtime.actions SET phase='stale',updated_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} AND phase IN ('eligible','waiting_user')`;
  await tx.$executeRaw`UPDATE e04_runtime.steps SET status='stale'
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} AND status='pending'`;
}

export async function claimDecisionStep(tx:Prisma.TransactionClient,scope:NapRuntimeScope,currentRevision:number,now:Date,
  decisionId:string,actionId:string,stepId:string,claimToken:string):Promise<{disposition:"claimed"|"already_claimed"|"waiting_user"|"dependency_wait"|"stale";plan:DecisionPlan;claim_token:string|null}>{
  const value=await locked(tx,scope,decisionId,actionId),step=value.steps.find(row=>row.step_id===stepId);
  if(!step)return fail("NOT_FOUND");
  if(value.decision.runtime_id!==scope.runtimeId||value.decision.state_revision!==BigInt(currentRevision)||value.decision.expires_at.getTime()<=now.getTime()){
    await stale(tx,scope,decisionId,actionId);return {disposition:"stale",plan:structuredClone(value.plan),claim_token:null};
  }
  if(value.action.phase==="waiting_user")return {disposition:"waiting_user",plan:structuredClone(value.plan),claim_token:null};
  if(step.status==="running")return {disposition:"already_claimed",plan:structuredClone(value.plan),claim_token:null};
  if(value.action.phase!=="eligible"||step.status!=="pending")return fail("CLAIM_CONFLICT");
  const dependencies=Array.isArray(step.depends_on)?step.depends_on:[];
  if(dependencies.some(id=>typeof id!=="string"||value.steps.find(candidate=>candidate.step_id===id)?.status!=="succeeded"))
    return {disposition:"dependency_wait",plan:structuredClone(value.plan),claim_token:null};
  const phase=nextActionPhase(value.action.phase,{kind:"start",dependenciesCurrent:true,authorized:true,stepConditionsMet:true,claimAcquired:true}).phase;
  const changed=await tx.$executeRaw`UPDATE e04_runtime.steps SET status='running',claim_token=${claimToken},attempted_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} AND step_id=${stepId} AND status='pending'`;
  if(changed!==1)return fail("CLAIM_CONFLICT");
  await tx.$executeRaw`UPDATE e04_runtime.actions SET phase=${phase},updated_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId}`;
  return {disposition:"claimed",plan:structuredClone(value.plan),claim_token:claimToken};
}

export async function markExecutionUnknown(tx:Prisma.TransactionClient,scope:NapRuntimeScope,decisionId:string,actionId:string,stepId:string,claimToken:string):Promise<void>{
  const value=await locked(tx,scope,decisionId,actionId),step=value.steps.find(row=>row.step_id===stepId);
  if(!step||step.status!=="running"||step.claim_token!==claimToken)return fail("CLAIM_CONFLICT");
  const transition=nextActionPhase(value.action.phase,{kind:"execution_unknown"});
  await tx.$executeRaw`UPDATE e04_runtime.actions SET receipt_lookup_required=${transition.receiptLookupRequired},updated_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId}`;
}

export async function completeDecisionStep(tx:Prisma.TransactionClient,scope:NapRuntimeScope,decisionId:string,actionId:string,stepId:string,claimToken:string,
  outcome:"success"|"partial"|"failure",basisCurrent:boolean,result:unknown):Promise<void>{
  const value=await locked(tx,scope,decisionId,actionId),step=value.steps.find(row=>row.step_id===stepId);
  if(!step||step.status!=="running"||step.claim_token!==claimToken)return fail("CLAIM_CONFLICT");
  const transition=nextActionPhase(value.action.phase,{kind:"complete",basisCurrent,outcome});
  const stepStatus=transition.phase==="succeeded"?"succeeded":transition.phase==="stale"?"stale":"failed";
  await tx.$executeRaw`UPDATE e04_runtime.steps SET status=${stepStatus},result_json=${JSON.stringify(result)}::jsonb,completed_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} AND step_id=${stepId}`;
  await tx.$executeRaw`UPDATE e04_runtime.actions SET phase=${transition.phase},receipt_lookup_required=FALSE,result_json=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId}`;
}

export async function readDecisionRecord(tx:Prisma.TransactionClient,scope:NapRuntimeScope,decisionId:string){
  const [decision]=await tx.$queryRaw<DecisionRow[]>`SELECT runtime_id,request_digest,plan_digest,state_revision,expires_at,request_json,plan_json,created_at
    FROM e04_runtime.decisions WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId}`;
  if(!decision)return fail("NOT_FOUND");
  const actions=await tx.$queryRaw<ActionRow[]>`SELECT action_id,phase,receipt_lookup_required,result_json,updated_at FROM e04_runtime.actions
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} ORDER BY action_id`;
  const steps=await tx.$queryRaw<StepRow[]>`SELECT action_id,step_id,position,kind,depends_on,status,claim_token,result_json,attempted_at,completed_at FROM e04_runtime.steps
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} ORDER BY action_id,position`;
  if(decision.plan_digest!==digest(decision.plan_json))return fail("STORAGE_INTEGRITY");
  return structuredClone({decision:{...decision,state_revision:Number(decision.state_revision)},actions,steps});
}
