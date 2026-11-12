import {randomUUID} from "node:crypto";
import type {TripStateContracts} from "../trip-state/contracts.generated";
import type {DecisionPlan,PlanStep} from "./decision-engine";
import type {CapabilityRegistry,ToolExecutionResult} from "./tool-capabilities";
import type {ToolCompletion} from "./tool-runtime-store";

type ToolHost={
  beginToolInvocationCandidate(ticket:object,credential:Headers,input:{decisionId:string;actionId:string;stepId:string;invocationId:string;capabilityId:string;
    providerRef:string;queryDigest:string;arguments:Record<string,unknown>;basisStateRevision:number}):Promise<{invocation_id:string;status:string}>;
  submitToolObservationCandidate(ticket:object,credential:Headers,input:{decisionId:string;actionId:string;stepId:string;invocationId:string;providerRef:string;request:unknown}):Promise<TripStateContracts["response"]>;
  recordToolCompletionCandidate(ticket:object,credential:Headers,input:{completion:ToolCompletion;rawResult:unknown;authoritativeRevision:number|null}):Promise<{replayed:boolean;current_usable:boolean}>;
  readToolInvocationCandidate(ticket:object,credential:Headers,input:{decisionId:string;actionId:string;stepId:string;invocationId:string}):Promise<{
    invocation_id:string;capability_id:string;provider_ref:string;query_digest:string;arguments_json:unknown;basis_state_revision:number;status:string}>;
  lookupToolObservationReceiptCandidate(ticket:object,credential:Headers,input:{invocationId:string;providerRef:string;request:unknown}):Promise<TripStateContracts["response"]|null>;
  completeDecisionStepCandidate(ticket:object,credential:Headers,decisionId:string,actionId:string,stepId:string,claimToken:string,
    outcome:"success"|"partial"|"failure",result:unknown):Promise<void>;
};

export type ToolExecutionRecovery={kind:"tool_execution_recovery";version:1;decision_id:string;action_id:string;step_id:string;invocation_id:string;
  capability_id:string;provider_ref:string;query_digest:string;basis_state_revision:number;raw_result:ToolExecutionResult;observation_request:TripStateContracts["change-request"]|null};

export class NapToolExecutionUnknown extends Error{
  constructor(readonly recovery:ToolExecutionRecovery,reason:unknown){super(`NAP tool execution result requires receipt reconciliation: ${reason instanceof Error?reason.message:"unknown"}`);
    this.name="NapToolExecutionUnknown";}
}

function factRequest(result:ToolExecutionResult,invocationId:string,basisRevision:number):TripStateContracts["change-request"]|null{
  if(!["result","partial","no_service"].includes(result.status)||!result.facts.length||!result.expires_at)return null;
  const expiresAt=result.expires_at;
  const values:Array<TripStateContracts["change-request"]["commands"][number]>=result.facts.map(fact=>({op:"ingest_fact",id:`fact-${invocationId.slice(4,44)}-${fact.id_suffix}`,
    scope:fact.scope,dependencies:[],data:{subject_ids:fact.subject_ids,query:fact.query,provider:result.source_ref,query_status:result.status,
      observed_at:result.observed_at,expires_at:expiresAt,valid_for:fact.valid_for,missing_fields:fact.missing_fields,value:fact.value}}));
  const first=values[0];if(!first)return null;const commands:TripStateContracts["change-request"]["commands"]=[first,...values.slice(1)];
  return {expected_revision:basisRevision,idempotency_key:`nap_tool_${invocationId}`,reason:"Record a controlled synthetic Egypt MVP tool observation",
    input:{kind:"tool",reference:`nap-tool-invocation:${invocationId}`,text:`synthetic:${result.source_ref}`,target_ids:[...new Set(result.facts.flatMap(fact=>fact.subject_ids))].sort()},commands};
}

function finishValues(input:{plan:DecisionPlan;action:DecisionPlan["actions"][number];step:PlanStep;invocationId:string;prepared:{query_digest:string;provider_ref:string};
  raw:ToolExecutionResult;request:TripStateContracts["change-request"]|null;receipt:TripStateContracts["response"]|null}){
  const basis=input.plan.basis.find(value=>value.packet_id===input.action.packet_id&&value.task_key===input.action.task_key);if(!basis)throw new Error("Tool step basis missing");
  const authoritativeRevision=input.receipt?.outcome==="applied"?input.receipt.revision:null,applied=authoritativeRevision!==null;
  const validatedFactIds=applied&&input.request?input.request.commands.flatMap(command=>command.op==="ingest_fact"?[command.id]:[]):[];
  const observationError:ToolCompletion["error"]=input.request&&input.receipt?.outcome!=="applied"?
    {code:`FACT_${(input.receipt?.outcome??"unknown").toUpperCase()}`,message:"Trusted fact observation was not applied"}:input.raw.error;
  const completion:ToolCompletion={nap_contract_version:"0.1.0",completion_id:`completion-${input.invocationId.slice(4)}`,decision_id:input.plan.decision_id,
    action_id:input.action.action_id,step_id:input.step.step_id,query_digest:input.prepared.query_digest,basis_state_revision:basis.state_revision,
    result_status:input.raw.status,provider_ref:input.prepared.provider_ref,observed_at:input.raw.observed_at,expires_at:input.raw.expires_at,
    raw_result_ref:`nap-tool-result:${input.invocationId}`,validated_fact_ids:validatedFactIds,error:observationError};
  return {basis,completion,authoritativeRevision,observationError};
}

async function finish(input:{host:ToolHost;ticket:object;credential:Headers;plan:DecisionPlan;action:DecisionPlan["actions"][number];step:PlanStep;claimToken:string;
  invocationId:string;prepared:{query_digest:string;provider_ref:string};raw:ToolExecutionResult;request:TripStateContracts["change-request"]|null;
  receipt:TripStateContracts["response"]|null;syncLifecycle?:(tripId:string,revision:number)=>Promise<void>;tripId:string}){
  const values=finishValues(input);
  if(values.authoritativeRevision!==null&&input.syncLifecycle)await input.syncLifecycle(input.tripId,values.authoritativeRevision);
  const recorded=await input.host.recordToolCompletionCandidate(input.ticket,input.credential,{completion:values.completion,rawResult:input.raw,
    authoritativeRevision:values.authoritativeRevision});
  const outcome=values.observationError?.code.startsWith("FACT_")||input.raw.status==="timeout"||input.raw.status==="error"?"failure":
    input.raw.status==="partial"?"partial":"success";
  const result={outcome:values.authoritativeRevision===null?"tool_completion":"applied",revision:values.authoritativeRevision??values.basis.state_revision,
    completion:values.completion,current_usable:recorded.current_usable,synthetic:true};
  await input.host.completeDecisionStepCandidate(input.ticket,input.credential,input.plan.decision_id,input.action.action_id,input.step.step_id,
    input.claimToken,outcome,result);
  return {completion:values.completion,result,raw:input.raw,replayed:recorded.replayed};
}

export async function executeToolStep(input:{host:ToolHost;ticket:object;credential:Headers;registry:CapabilityRegistry;plan:DecisionPlan;
  action:DecisionPlan["actions"][number];step:PlanStep;claimToken:string;syncLifecycle?:(tripId:string,revision:number)=>Promise<void>;tripId:string}){
  if(!["query","calculate"].includes(input.step.kind)||!input.step.capability_id)throw new Error("Tool step required");
  const prepared=input.registry.prepare(input.step.kind as "query"|"calculate",input.step.capability_id,input.step.arguments);
  const basis=input.plan.basis.find(value=>value.packet_id===input.action.packet_id&&value.task_key===input.action.task_key);
  if(!basis)throw new Error("Tool step basis missing");
  const invocationId=`inv-${randomUUID().replaceAll("-","")}`;
  const invocation=await input.host.beginToolInvocationCandidate(input.ticket,input.credential,{decisionId:input.plan.decision_id,actionId:input.action.action_id,
    stepId:input.step.step_id,invocationId,capabilityId:prepared.capability_id,providerRef:prepared.provider_ref,queryDigest:prepared.query_digest,
    arguments:prepared.arguments,basisStateRevision:basis.state_revision});
  if(invocation.invocation_id!==invocationId||invocation.status!=="running")throw new Error("Tool invocation was not admitted");
  const raw=await input.registry.execute(prepared),request=factRequest(raw,invocationId,basis.state_revision);
  let receipt:TripStateContracts["response"]|null=null;
  if(request){
    receipt=await input.host.submitToolObservationCandidate(input.ticket,input.credential,{decisionId:input.plan.decision_id,
      actionId:input.action.action_id,stepId:input.step.step_id,invocationId,providerRef:prepared.provider_ref,request});
  }
  const recovery:ToolExecutionRecovery={kind:"tool_execution_recovery",version:1,decision_id:input.plan.decision_id,action_id:input.action.action_id,
    step_id:input.step.step_id,invocation_id:invocationId,capability_id:prepared.capability_id,provider_ref:prepared.provider_ref,
    query_digest:prepared.query_digest,basis_state_revision:basis.state_revision,raw_result:structuredClone(raw),observation_request:request};
  try{return await finish({...input,invocationId,prepared,raw,request,receipt});}
  catch(error){throw new NapToolExecutionUnknown(recovery,error);}
}

export async function reconcileToolStep(input:{host:ToolHost;ticket:object;credential:Headers;registry:CapabilityRegistry;plan:DecisionPlan;
  action:DecisionPlan["actions"][number];step:PlanStep;claimToken:string;recovery:unknown;syncLifecycle?:(tripId:string,revision:number)=>Promise<void>;tripId:string}){
  if(!input.recovery||typeof input.recovery!=="object"||Array.isArray(input.recovery))return null;
  const recovery=input.recovery as ToolExecutionRecovery;
  if(recovery.kind!=="tool_execution_recovery"||recovery.version!==1||recovery.decision_id!==input.plan.decision_id||
    recovery.action_id!==input.action.action_id||recovery.step_id!==input.step.step_id)return null;
  const prepared=input.registry.prepare(input.step.kind as "query"|"calculate",input.step.capability_id,input.step.arguments);
  const invocation=await input.host.readToolInvocationCandidate(input.ticket,input.credential,{decisionId:input.plan.decision_id,actionId:input.action.action_id,
    stepId:input.step.step_id,invocationId:recovery.invocation_id});
  if(invocation.capability_id!==prepared.capability_id||invocation.provider_ref!==prepared.provider_ref||invocation.query_digest!==prepared.query_digest||
    invocation.basis_state_revision!==recovery.basis_state_revision||recovery.capability_id!==prepared.capability_id||recovery.provider_ref!==prepared.provider_ref||
    recovery.query_digest!==prepared.query_digest)return null;
  let receipt:TripStateContracts["response"]|null=null;
  if(recovery.observation_request){
    receipt=await input.host.lookupToolObservationReceiptCandidate(input.ticket,input.credential,{invocationId:recovery.invocation_id,
      providerRef:prepared.provider_ref,request:recovery.observation_request});
    if(receipt===null)return null;
  }
  try{return await finish({...input,invocationId:recovery.invocation_id,prepared,raw:recovery.raw_result,request:recovery.observation_request,receipt});}
  catch{return null;}
}
