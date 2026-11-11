import type {Prisma} from "../../generated/prisma/client";
import {canonicalJson,digest} from "../trip-state/command-json";
import type {DecisionPlan} from "./decision-engine";
import {validateCompletionBinding} from "./completion-binding";
import {validateNapMessage} from "./contracts";
import type {NapRuntimeScope} from "./runtime-store";

export type ToolCompletion={nap_contract_version:"0.1.0";completion_id:string;decision_id:string;action_id:string;step_id:string;query_digest:string;
  basis_state_revision:number;result_status:"result"|"partial"|"empty"|"timeout"|"error"|"no_service";provider_ref:string;observed_at:string;
  expires_at:string|null;raw_result_ref:string;validated_fact_ids:string[];error:{code:string;message:string}|null};
type DecisionRow={runtime_id:string;plan_digest:string;state_revision:bigint;expires_at:Date;plan_json:unknown;content_available:boolean};
type ActionRow={phase:string;updated_at:Date};
type StepRow={kind:string;status:string};
type InvocationRow={invocation_id:string;capability_id:string;provider_ref:string;query_digest:string;arguments_digest:string;arguments_json:unknown;
  plan_digest:string;basis_state_revision:bigint;status:"running"|"completed"|"failed"|"stale";attempts:number;completion_id:string|null};

export class NapToolRuntimeError extends Error{
  constructor(readonly code:"BINDING"|"IDEMPOTENCY_CONFLICT"|"STALE"|"NOT_FOUND"){
    super(`NAP tool runtime: ${code}`);this.name="NapToolRuntimeError";
  }
}
const fail=(code:NapToolRuntimeError["code"]):never=>{throw new NapToolRuntimeError(code);};
const same=(left:unknown,right:unknown)=>canonicalJson(left)===canonicalJson(right);

async function records(tx:Prisma.TransactionClient,scope:NapRuntimeScope,decisionId:string,actionId:string,stepId:string){
  const [decision]=await tx.$queryRaw<DecisionRow[]>`SELECT runtime_id,plan_digest,state_revision,expires_at,plan_json,content_available FROM e04_runtime.decisions
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} FOR UPDATE`;
  const [action]=await tx.$queryRaw<ActionRow[]>`SELECT phase,updated_at FROM e04_runtime.actions WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId}
    AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} FOR UPDATE`;
  const [step]=await tx.$queryRaw<StepRow[]>`SELECT kind,status FROM e04_runtime.steps WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId}
    AND workspace_key=${scope.workspaceKey} AND decision_id=${decisionId} AND action_id=${actionId} AND step_id=${stepId} FOR UPDATE`;
  if(!decision||!action||!step)return fail("NOT_FOUND");
  return {decision,action,step,plan:decision.plan_json as DecisionPlan};
}

export async function beginToolInvocation(tx:Prisma.TransactionClient,scope:NapRuntimeScope,input:{decisionId:string;actionId:string;stepId:string;
  invocationId:string;capabilityId:string;providerRef:string;queryDigest:string;arguments:Record<string,unknown>;basisStateRevision:number},currentRevision:number,now:Date){
  const value=await records(tx,scope,input.decisionId,input.actionId,input.stepId),action=value.plan.actions.find(item=>item.action_id===input.actionId);
  const step=action?.steps.find(item=>item.step_id===input.stepId),basis=value.plan.basis.find(item=>item.packet_id===action?.packet_id&&item.task_key===action?.task_key);
  if(!value.decision.content_available||value.decision.runtime_id!==scope.runtimeId||value.decision.state_revision!==BigInt(currentRevision)||
    value.decision.expires_at<=now||value.action.phase!=="running"||value.step.status!=="running"||!step||!["query","calculate"].includes(step.kind)||
    step.capability_id!==input.capabilityId||!same(step.arguments,input.arguments)||!basis||basis.state_revision!==input.basisStateRevision||
    value.decision.plan_digest!==digest(value.plan))return fail("STALE");
  const argumentsDigest=digest(input.arguments);
  await tx.$executeRaw`INSERT INTO e04_runtime.tool_invocations(owner_id,trip_id,workspace_key,decision_id,action_id,step_id,invocation_id,
    capability_id,provider_ref,query_digest,arguments_digest,arguments_json,plan_digest,basis_state_revision,status)
    VALUES(${scope.ownerId},${scope.tripId},${scope.workspaceKey},${input.decisionId},${input.actionId},${input.stepId},${input.invocationId},
      ${input.capabilityId},${input.providerRef},${input.queryDigest},${argumentsDigest},${JSON.stringify(input.arguments)}::jsonb,${value.decision.plan_digest},${BigInt(input.basisStateRevision)},'running')
    ON CONFLICT DO NOTHING`;
  const [stored]=await tx.$queryRaw<InvocationRow[]>`SELECT invocation_id,capability_id,provider_ref,query_digest,arguments_digest,arguments_json,plan_digest,
    basis_state_revision,status,attempts,completion_id FROM e04_runtime.tool_invocations WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId}
    AND workspace_key=${scope.workspaceKey} AND decision_id=${input.decisionId} AND action_id=${input.actionId} AND step_id=${input.stepId} FOR UPDATE`;
  if(!stored)return fail("NOT_FOUND");
  if(stored.invocation_id!==input.invocationId||stored.capability_id!==input.capabilityId||stored.provider_ref!==input.providerRef||
    stored.query_digest!==input.queryDigest||stored.arguments_digest!==argumentsDigest||!same(stored.arguments_json,input.arguments)||
    stored.plan_digest!==value.decision.plan_digest||stored.basis_state_revision!==BigInt(input.basisStateRevision))return fail("IDEMPOTENCY_CONFLICT");
  return structuredClone(stored);
}

export async function recordToolCompletion(tx:Prisma.TransactionClient,scope:NapRuntimeScope,input:{completion:ToolCompletion;rawResult:unknown;
  authoritativeRevision:number|null;currentRevision:number;currentNow:Date}){
  const completion=structuredClone(input.completion);validateNapMessage("ToolCompletion",completion);
  const value=await records(tx,scope,completion.decision_id,completion.action_id,completion.step_id);
  const [invocation]=await tx.$queryRaw<InvocationRow[]>`SELECT invocation_id,capability_id,provider_ref,query_digest,arguments_digest,arguments_json,plan_digest,
    basis_state_revision,status,attempts,completion_id FROM e04_runtime.tool_invocations WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId}
    AND workspace_key=${scope.workspaceKey} AND decision_id=${completion.decision_id} AND action_id=${completion.action_id} AND step_id=${completion.step_id} FOR UPDATE`;
  if(!invocation)return fail("NOT_FOUND");
  const completedSteps=await tx.$queryRaw<Array<{step_id:string}>>`SELECT step_id FROM e04_runtime.steps WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId}
    AND workspace_key=${scope.workspaceKey} AND decision_id=${completion.decision_id} AND action_id=${completion.action_id} AND status='succeeded' ORDER BY position`;
  const actionRecord={nap_contract_version:"0.1.0",decision_id:completion.decision_id,action_id:completion.action_id,phase:value.action.phase,
    plan_digest:value.decision.plan_digest,completed_step_ids:completedSteps.map(row=>row.step_id),result_refs:[],error_ref:null,related_action_ids:[],updated_at:value.action.updated_at.toISOString()};
  validateCompletionBinding(value.plan,actionRecord,completion,{decision_id:completion.decision_id,runtime_id:scope.runtimeId,action_id:completion.action_id,
    step_id:completion.step_id,capability_id:invocation.capability_id,provider_ref:invocation.provider_ref,query_digest:invocation.query_digest,
    plan_digest:invocation.plan_digest,basis_state_revision:Number(invocation.basis_state_revision)});
  const resultCurrent=completion.expires_at===null||new Date(completion.expires_at)>input.currentNow;
  const factObservationCurrent=!completion.error?.code.startsWith("FACT_");
  const basisCurrent=value.decision.runtime_id===scope.runtimeId&&value.decision.content_available&&value.decision.expires_at>input.currentNow&&
    resultCurrent&&factObservationCurrent&&
    (value.decision.state_revision===BigInt(input.currentRevision)||input.authoritativeRevision!==null&&input.authoritativeRevision===input.currentRevision);
  const completionDigest=digest(completion);
  const inserted=await tx.$executeRaw`INSERT INTO e04_runtime.tool_completions(owner_id,trip_id,workspace_key,completion_id,invocation_id,decision_id,action_id,step_id,
    completion_digest,completion_json,raw_result_json,current_usable,state_revision_after)
    VALUES(${scope.ownerId},${scope.tripId},${scope.workspaceKey},${completion.completion_id},${invocation.invocation_id},${completion.decision_id},${completion.action_id},
      ${completion.step_id},${completionDigest},${JSON.stringify(completion)}::jsonb,${JSON.stringify(input.rawResult)}::jsonb,${basisCurrent},${BigInt(input.currentRevision)})
    ON CONFLICT DO NOTHING`;
  if(inserted===0){
    const [existing]=await tx.$queryRaw<Array<{completion_digest:string;completion_json:unknown;raw_result_json:unknown;current_usable:boolean}>>`SELECT completion_digest,
      completion_json,raw_result_json,current_usable FROM e04_runtime.tool_completions WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId}
      AND workspace_key=${scope.workspaceKey} AND completion_id=${completion.completion_id}`;
    if(!existing||existing.completion_digest!==completionDigest||!same(existing.completion_json,completion)||!same(existing.raw_result_json,input.rawResult))return fail("IDEMPOTENCY_CONFLICT");
    return {replayed:true,current_usable:existing.current_usable};
  }
  await tx.$executeRaw`UPDATE e04_runtime.tool_invocations SET status=${basisCurrent?"completed":"stale"},completion_id=${completion.completion_id},updated_at=clock_timestamp()
    WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND decision_id=${completion.decision_id}
    AND action_id=${completion.action_id} AND step_id=${completion.step_id}`;
  return {replayed:false,current_usable:basisCurrent};
}

export async function readToolTrigger(tx:Prisma.TransactionClient,scope:NapRuntimeScope,completionId:string,currentNow:Date){
  const [row]=await tx.$queryRaw<Array<{completion_json:unknown;current_usable:boolean;state_revision_after:bigint}>>`SELECT completion_json,current_usable,state_revision_after
    FROM e04_runtime.tool_completions WHERE owner_id=${scope.ownerId} AND trip_id=${scope.tripId} AND workspace_key=${scope.workspaceKey} AND completion_id=${completionId}`;
  if(!row)return fail("NOT_FOUND");
  const completion=structuredClone(row.completion_json) as ToolCompletion;
  return {completion,current_usable:row.current_usable&&(completion.expires_at===null||new Date(completion.expires_at)>currentNow),
    state_revision_after:Number(row.state_revision_after)};
}
