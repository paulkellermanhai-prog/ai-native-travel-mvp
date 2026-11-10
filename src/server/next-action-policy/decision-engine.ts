import type { DecisionContextContracts } from "../decision-context/contracts";
import { validateNapMessage } from "./contracts";
import { validatePlanRequestConsistency } from "./plan-packet-consistency";
import { validatePlanInternalIntegrity } from "./plan-integrity";
import type { TrustedDecisionRequest } from "./trusted-packet-source";

type Packet=DecisionContextContracts["packet"];
export type PlanStep={step_id:string;kind:"read"|"query"|"calculate"|"change"|"ask"|"deliver";depends_on:string[];
  capability_id:string|null;arguments:Record<string,unknown>;change_request:unknown;user_message:string|null};
export type SemanticAction={action_id:string;task_key:string;packet_id:string;request_ids:string[];goal:"D1"|"D2"|"D3"|"D4"|"D5";
  preferred_attention:"primary"|"prepare";reason:string;rank:number;steps:PlanStep[];required_object_ids:string[];reentry_candidate_id:string|null};
export type SemanticDecision={response:{request_ids:string[];disposition:"answered"|"partial"|"clarification"|"blocked"|"deferred"|"no_current_request";
  text:string|null;evidence_refs:Array<{id:string;version:number|null;kind:"object"|"source"|"delivery"}>};candidates:SemanticAction[]};
export type SemanticAdapter={assess(request:TrustedDecisionRequest):Promise<SemanticDecision>};
export type DecisionPlan={nap_contract_version:"0.1.0";decision_id:string;runtime_id:string;
  basis:Array<{packet_id:string;turn_id:string;task_key:string;state_revision:number;snapshot_digest:string;expires_at:string}>;
  response:SemanticDecision["response"];
  actions:Array<Omit<SemanticAction,"preferred_attention"|"rank"|"required_object_ids"|"reentry_candidate_id">&{attention:"primary"|"prepare"}>};

export class NapDecisionError extends Error {
  constructor(readonly code:"INVALID_REQUEST"|"SEMANTIC_OUTPUT"|"NO_CURRENT_PACKET"){
    super(`NAP decision: ${code}`);this.name="NapDecisionError";
  }
}

const fail=(code:NapDecisionError["code"]):never=>{throw new NapDecisionError(code);};
const clone=<T>(value:T):T=>structuredClone(value);
const objectMap=(packet:Packet)=>new Map(packet.objects.map(object=>[object.id,object]));

function actionEligible(candidate:SemanticAction,packet:Packet,responseIds:Set<string>,now:Date):boolean{
  if(candidate.packet_id!==packet.packet_id||candidate.task_key!==packet.task.task_key||
    packet.coverage!=="complete"||packet.support!=="decision_support"||packet.deferred_ids.length!==0||
    packet.context.status!=="active"||new Date(packet.context.expires_at).getTime()<=now.getTime()||
    candidate.request_ids.some(id=>!responseIds.has(id))||!Number.isSafeInteger(candidate.rank))return false;
  const objects=objectMap(packet);
  if(candidate.required_object_ids.some(id=>!objects.has(id)))return false;
  const hasChange=candidate.steps.some(step=>step.kind==="change");
  if(hasChange&&packet.task.branch==="hypothetical")return false;
  if(hasChange&&packet.objects.some(object=>object.type==="OpenIssue"&&object.status==="open"&&object.issue_kind==="conflict"))return false;
  if(candidate.reentry_candidate_id!==null){
    const value=objects.get(candidate.reentry_candidate_id);
    if(!value||value.type!=="Candidate"||["excluded","conditionally_excluded"].includes(value.status))return false;
  }
  return true;
}

function evidenceCurrent(response:SemanticDecision["response"],packets:Packet[]):boolean{
  const objects=new Map(packets.flatMap(packet=>packet.objects).map(object=>[object.id,object]));
  return response.evidence_refs.every(reference=>{
    if(reference.kind!=="object")return true;
    const object=objects.get(reference.id);
    return !!object&&reference.version===object.version;
  });
}

/** G01 → G03 candidates → G02 eligibility → G03/G04 selection. No writes occur here. */
export async function decide(requestValue:TrustedDecisionRequest,adapter:SemanticAdapter,now=new Date()):Promise<DecisionPlan>{
  let request:TrustedDecisionRequest;
  try{request=clone(requestValue);validateNapMessage("DecisionRequest",request);}catch{return fail("INVALID_REQUEST");}
  if(request.trigger.kind!=="user_event"||request.packets.some(packet=>packet.pending_input.event.reference!==request.trigger.reference||
    new Date(packet.context.expires_at).getTime()<=now.getTime()))return fail("NO_CURRENT_PACKET");
  let semantic:SemanticDecision;
  try{semantic=clone(await adapter.assess(clone(request)));}catch{return fail("SEMANTIC_OUTPUT");}
  try{
    const taskKeys=new Set(request.packets.map(packet=>packet.task.task_key));
    if(semantic.response.disposition==="no_current_request"||semantic.response.text===null||semantic.response.request_ids.length===0||
      semantic.response.request_ids.some(id=>!taskKeys.has(id))||!evidenceCurrent(semantic.response,request.packets))return fail("SEMANTIC_OUTPUT");
    const packets=new Map(request.packets.map(packet=>[packet.packet_id,packet])),responseIds=new Set(semantic.response.request_ids);
    const eligible=semantic.candidates.filter(candidate=>{
      const packet=packets.get(candidate.packet_id);
      return !!packet&&actionEligible(candidate,packet,responseIds,now);
    }).sort((left,right)=>right.rank-left.rank);
    const primary=eligible.find(candidate=>candidate.preferred_attention==="primary");
    const selected=[...(primary?[primary]:[]),...eligible.filter(candidate=>candidate!==primary&&candidate.preferred_attention==="prepare").slice(0,2)];
    const actions=selected.map(candidate=>({action_id:candidate.action_id,task_key:candidate.task_key,packet_id:candidate.packet_id,
      request_ids:clone(candidate.request_ids),goal:candidate.goal,attention:candidate===primary?"primary" as const:"prepare" as const,
      reason:candidate.reason,steps:clone(candidate.steps)}));
    const plan:DecisionPlan={nap_contract_version:"0.1.0",decision_id:request.decision_id,runtime_id:request.runtime_id,
      basis:request.packets.map(packet=>({packet_id:packet.packet_id,turn_id:packet.turn_id,task_key:packet.task.task_key,
        state_revision:packet.context.state_revision,snapshot_digest:packet.snapshot_digest,expires_at:packet.context.expires_at})),
      response:clone(semantic.response),actions};
    validatePlanInternalIntegrity(plan);validatePlanRequestConsistency(request,plan);
    return clone(plan);
  }catch(error){if(error instanceof NapDecisionError)throw error;return fail("SEMANTIC_OUTPUT");}
}

/** G05 always reruns semantics and host eligibility from a new trusted request. */
export async function reevaluate(previous:DecisionPlan,request:TrustedDecisionRequest,adapter:SemanticAdapter,now=new Date()):Promise<DecisionPlan>{
  try{validatePlanInternalIntegrity(previous);}catch{return fail("INVALID_REQUEST");}
  if(previous.decision_id===request.decision_id)return fail("INVALID_REQUEST");
  return decide(request,adapter,now);
}
