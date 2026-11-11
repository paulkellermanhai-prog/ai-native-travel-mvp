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
  completeDecisionStepCandidate(ticket:object,credential:Headers,decisionId:string,actionId:string,stepId:string,claimToken:string,
    outcome:"success"|"partial"|"failure",result:unknown):Promise<void>;
};

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
  let authoritativeRevision:number|null=null,validatedFactIds:string[]=[],observationError:ToolCompletion["error"]=raw.error;
  if(request){
    const response=await input.host.submitToolObservationCandidate(input.ticket,input.credential,{decisionId:input.plan.decision_id,
      actionId:input.action.action_id,stepId:input.step.step_id,invocationId,providerRef:prepared.provider_ref,request});
    if(response.outcome==="applied"){
      authoritativeRevision=response.revision;validatedFactIds=request.commands.flatMap(command=>command.op==="ingest_fact"?[command.id]:[]);
      if(input.syncLifecycle)await input.syncLifecycle(input.tripId,response.revision);
    }else observationError={code:`FACT_${response.outcome.toUpperCase()}`,message:"Trusted fact observation was not applied"};
  }
  const completion:ToolCompletion={nap_contract_version:"0.1.0",completion_id:`completion-${invocationId.slice(4)}`,decision_id:input.plan.decision_id,
    action_id:input.action.action_id,step_id:input.step.step_id,query_digest:prepared.query_digest,basis_state_revision:basis.state_revision,
    result_status:raw.status,provider_ref:prepared.provider_ref,observed_at:raw.observed_at,expires_at:raw.expires_at,
    raw_result_ref:`nap-tool-result:${invocationId}`,validated_fact_ids:validatedFactIds,error:observationError};
  const recorded=await input.host.recordToolCompletionCandidate(input.ticket,input.credential,{completion,rawResult:raw,authoritativeRevision});
  const outcome=observationError?.code.startsWith("FACT_")||raw.status==="timeout"||raw.status==="error"?"failure":raw.status==="partial"?"partial":"success";
  const result={outcome:authoritativeRevision===null?"tool_completion":"applied",revision:authoritativeRevision??basis.state_revision,
    completion,current_usable:recorded.current_usable,synthetic:true};
  await input.host.completeDecisionStepCandidate(input.ticket,input.credential,input.plan.decision_id,input.action.action_id,input.step.step_id,
    input.claimToken,outcome,result);
  return {completion,result,raw,replayed:recorded.replayed};
}
