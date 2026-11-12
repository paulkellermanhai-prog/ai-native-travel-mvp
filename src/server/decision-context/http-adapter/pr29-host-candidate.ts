import type { IncomingMessage, ServerResponse } from "node:http";
import { createPacketHttpCandidate } from "../host-runtime/packet-http-candidate";
import type { ControlledInterpreter, openEvidenceHost } from "../host-runtime/evidence-host";
import { EvidenceBoundaryError } from "../../interaction-evidence/contracts";
import { createRuntimeHandler } from "./handler";
import { RuntimeHttpFault } from "../http-core/response";
import { DecisionContextContractError, parseDCContract } from "../contracts";
import { confirmChange, submitChange } from "../write-bridge/orchestrator";
import { BridgeRuleError } from "../write-bridge/rules";
import { CheckpointError } from "../checkpoint-core";
import type {DecisionPlan} from "../../next-action-policy/decision-engine";
import type {TrustedDecisionRequest} from "../../next-action-policy/trusted-packet-source";
import {canonicalJson} from "../../trip-state/command-json";
import {validatePlanRequestConsistency} from "../../next-action-policy/plan-packet-consistency";
import {TripStateContractError} from "../../trip-state/contracts";
import type {CapabilityRegistry} from "../../next-action-policy/tool-capabilities";
import {NapCapabilityError} from "../../next-action-policy/tool-capabilities";
import {executeToolStep,NapToolExecutionUnknown,reconcileToolStep,type ToolExecutionRecovery} from "../../next-action-policy/tool-dispatch";
import {NapToolRuntimeError} from "../../next-action-policy/tool-runtime-store";

type EvidenceHost = Awaited<ReturnType<typeof openEvidenceHost>>;

/** Internal MVP candidate. Opaque host tickets and User grants never cross HTTP. */
export function createPr29HostHttpCandidate(host: EvidenceHost, origin: string, interpret?: ControlledInterpreter,
  syncLifecycle?: (tripId:string,revision:number)=>Promise<void>,toolRegistry?:CapabilityRegistry) {
  const packets = createPacketHttpCandidate(host, origin, interpret);
  const writes = createRuntimeHandler({ origin, async authorize(tripId, headers) {
    let sessionKey:string;
    try { sessionKey=await host.authorizeTripCandidate(tripId, headers); }
    catch (error) {
      if (error instanceof EvidenceBoundaryError && error.code === "EVIDENCE_ACCESS_DENIED") throw new RuntimeHttpFault("ACCESS_DENIED");
      throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
    }
    return {
      async "checkpoints/save"(value) {
        const ticket=packets.ticketForSessionCandidate(sessionKey);if(!ticket)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        try{return await host.saveSceneCandidate(ticket,headers,parseDCContract("scene-save",value));}
        catch(error){throw checkpointFault(error);}
      },
      async "checkpoints/status"() {
        const ticket=packets.ticketForSessionCandidate(sessionKey);if(!ticket)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        try{return await host.checkpointStatusCandidate(ticket,headers);}
        catch(error){throw checkpointFault(error);}
      },
      async "checkpoints/restore"(value) {
        const body=parseDCContract("scene-restore",value),prior=packets.ticketForSessionCandidate(sessionKey);
        try{
          const ticket=await host.reopenWorkspace(tripId,headers,body.workspace_key);
          if(prior){packets.forgetWorkspace(prior);await host.disposeWorkspace(prior);}
          packets.bindSessionWorkspaceCandidate(sessionKey,ticket);
          const restored=await host.restoreCheckpoint(ticket,headers,body.body_budget_bytes);
          if(!("scene" in restored))throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
          return restored.scene;
        } catch(error){throw checkpointFault(error);}
      },
      async changes(value) {
        if(!syncLifecycle)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        const body=parseDCContract("change",value),ticket=packets.ticketForPacketCandidate(tripId,body.packet_id);
        if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
        const result=await submitChange(host.createTransactionalBridgeCandidate(ticket,headers),body);
        if(result.outcome==="applied")await syncLifecycle(tripId,result.revision);
        return result;
      },
      async confirm(value) {
        if(!syncLifecycle)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        const body=parseDCContract("confirm",value),ticket=packets.ticketForTurnCandidate(tripId,body.turn_id);
        if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
        const result=await confirmChange(host.createTransactionalBridgeCandidate(ticket,headers),body);
        if(result.outcome==="applied")await syncLifecycle(tripId,result.revision);
        return result;
      },
    };
  } });
  async function readTrustedPacketBatchCandidate(tripId:string,credential:Headers,packetIds:readonly string[]) {
    const tickets=packetIds.map(packetId=>packets.ticketForPacketCandidate(tripId,packetId));
    const ticket=tickets[0];
    if(!ticket||tickets.some(candidate=>candidate!==ticket))throw new RuntimeHttpFault("ACCESS_DENIED");
    // The final page bytes can precede the socket postflight that seals the
    // private delivery ledger. Consume only after every handoff has settled.
    await packets.awaitPacketHandoffCandidate(ticket);
    if(packetIds.some(packetId=>packets.ticketForPacketCandidate(tripId,packetId)!==ticket))throw new RuntimeHttpFault("ACCESS_DENIED");
    return host.readTrustedPacketBatchCandidate(ticket,credential,packetIds);
  }
  async function readTrustedTriggerCandidate(tripId:string,credential:Headers,trigger:{kind:string;reference:string},packetIds:readonly string[]){
    if(!["tool_result","state_change"].includes(trigger.kind))throw new RuntimeHttpFault("ACCESS_DENIED");
    const completionId=trigger.kind==="state_change"&&trigger.reference.startsWith("state-change:")?trigger.reference.slice(13):trigger.reference;
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(completionId))throw new RuntimeHttpFault("ACCESS_DENIED");
    const tickets=packetIds.map(packetId=>packets.ticketForPacketCandidate(tripId,packetId)),ticket=tickets[0];
    if(!ticket||tickets.some(candidate=>candidate!==ticket))throw new RuntimeHttpFault("ACCESS_DENIED");
    const row=await host.readToolTriggerCandidate(ticket,credential,completionId);
    if(trigger.kind==="state_change"&&row.completion.validated_fact_ids.length===0)throw new RuntimeHttpFault("ACCESS_DENIED");
    return {runtime_id:row.runtime_id,state_revision:row.state_revision};
  }

  return {
    bindTurn: packets.bindTurn,
    forgetWorkspace: packets.forgetWorkspace,
    /** Server-side explicit User action; deliberately not an HTTP route. */
    async authorizeUserChange(tripId:string,credential:Headers,value:unknown) {
      const body=parseDCContract("change",value),ticket=packets.ticketForPacketCandidate(tripId,body.packet_id);
      if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.authorizeUserChangeCandidate(ticket,credential,body);
    },
    /** Server-side E11 erasure path; it also redacts NAP records bound to the deleted source event. */
    async deleteEvidenceEventCandidate(tripId:string,credential:Headers,packetId:string,eventId:string) {
      const ticket=packets.ticketForPacketCandidate(tripId,packetId);if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.deleteEvent(ticket,credential,eventId);
    },
    readTrustedPacketBatchCandidate,
    readTrustedTriggerCandidate,
    async saveDecisionPlanCandidate(tripId:string,credential:Headers,request:TrustedDecisionRequest,plan:DecisionPlan){
      for(const action of plan.actions)for(const step of action.steps)if(step.kind==="query"||step.kind==="calculate"){
        if(!toolRegistry)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        try{toolRegistry.prepare(step.kind,step.capability_id,step.arguments);}catch{throw new RuntimeHttpFault("ACCESS_DENIED");}
      }
      const tickets=request.packets.map(packet=>packets.ticketForPacketCandidate(tripId,packet.packet_id)),ticket=tickets[0];
      if(!ticket||tickets.some(candidate=>candidate!==ticket))throw new RuntimeHttpFault("ACCESS_DENIED");
      await packets.awaitPacketHandoffCandidate(ticket);
      return host.saveDecisionPlanCandidate(ticket,credential,request,plan);
    },
    async claimDecisionStepCandidate(tripId:string,credential:Headers,packetId:string,decisionId:string,actionId:string,stepId:string){
      const ticket=packets.ticketForPacketCandidate(tripId,packetId);if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.claimDecisionStepCandidate(ticket,credential,decisionId,actionId,stepId);
    },
    async readDecisionRecordCandidate(tripId:string,credential:Headers,packetId:string,decisionId:string){
      const ticket=packets.ticketForPacketCandidate(tripId,packetId);if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.readDecisionRecordCandidate(ticket,credential,decisionId);
    },
    async markDecisionExecutionUnknownCandidate(tripId:string,credential:Headers,packetId:string,decisionId:string,actionId:string,stepId:string,claimToken:string){
      const ticket=packets.ticketForPacketCandidate(tripId,packetId);if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.markDecisionExecutionUnknownCandidate(ticket,credential,decisionId,actionId,stepId,claimToken);
    },
    async dispatchDecisionStepCandidate(tripId:string,credential:Headers,packetId:string,decisionId:string,actionId:string,stepId:string){
      const ticket=packets.ticketForPacketCandidate(tripId,packetId);if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      const record=await host.readDecisionRecordCandidate(ticket,credential,decisionId),plan=record.decision.plan_json as DecisionPlan;
      const action=plan.actions.find(candidate=>candidate.action_id===actionId),step=action?.steps.find(candidate=>candidate.step_id===stepId);
      const actionRecord=record.actions.find(candidate=>candidate.action_id===actionId),stepRecord=record.steps.find(candidate=>candidate.action_id===actionId&&candidate.step_id===stepId);
      if(!action||!step||!actionRecord||!stepRecord)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
      if(["succeeded","failed","stale"].includes(stepRecord.status))return {disposition:"recorded" as const,result:stepRecord.result_json};
      if(["partial","failed","stale","cancelled","blocked"].includes(actionRecord.phase))return {disposition:"action_terminal" as const,result:null};
      if(!["change","read","ask","query","calculate"].includes(step.kind))return {disposition:"unsupported" as const,result:null};
      if(step.kind==="change"&&!syncLifecycle)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
      if((step.kind==="query"||step.kind==="calculate")&&!toolRegistry)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
      if(step.kind==="query"&&!syncLifecycle)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
      let claimToken:string|null=null,receipt:unknown=null,validatedPackets:Awaited<ReturnType<typeof readTrustedPacketBatchCandidate>>["packets"]=[];
      if(actionRecord.phase==="running"&&actionRecord.receipt_lookup_required&&stepRecord.status==="running"&&stepRecord.claim_token){
        claimToken=stepRecord.claim_token;
        if(step.kind==="change")receipt=await host.lookupChangeReceiptCandidate(ticket,credential,step.change_request);
        else if(step.kind==="query"||step.kind==="calculate"){
          const recovered=await reconcileToolStep({host,ticket,credential:new Headers({cookie:credential.get("cookie")??""}),registry:toolRegistry!,plan,
            action,step,claimToken,recovery:stepRecord.result_json as ToolExecutionRecovery,syncLifecycle,tripId});
          return recovered?{disposition:"receipt_recovered" as const,result:recovered.result}:{disposition:"execution_unknown" as const,result:null};
        }
        if(receipt===null)return {disposition:"execution_unknown" as const,result:null};
      }else{
        const storedRequest=record.decision.request_json as TrustedDecisionRequest,ids=plan.basis.map(basis=>basis.packet_id);
        const batch=await readTrustedPacketBatchCandidate(tripId,credential,ids),current={...storedRequest,runtime_id:batch.runtime_id,packets:batch.packets};
        if(canonicalJson(current)!==canonicalJson(storedRequest))throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        if(storedRequest.trigger.kind!=="user_event")await readTrustedTriggerCandidate(tripId,credential,storedRequest.trigger,ids);
        validatePlanRequestConsistency(current,plan);validatedPackets=batch.packets;
        const claim=await host.claimDecisionStepCandidate(ticket,credential,decisionId,actionId,stepId);
        if(claim.disposition!=="claimed")return {disposition:claim.disposition,result:null};
        claimToken=claim.claim_token;
      }
      if(!claimToken)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
      try{
        if(step.kind==="query"||step.kind==="calculate"){
          const executed=await executeToolStep({host,ticket,credential:new Headers({cookie:credential.get("cookie")??""}),registry:toolRegistry!,plan,
            action,step,claimToken,syncLifecycle,tripId});
          return {disposition:"executed" as const,result:executed.result};
        }
        let result=receipt;
        if(step.kind==="change"&&!result){
          const body=parseDCContract("change",{runtime_contract_version:"0.1.0",turn_id:plan.basis.find(basis=>basis.packet_id===action.packet_id)!.turn_id,
            packet_id:action.packet_id,request:step.change_request});
          result=await submitChange(host.createTransactionalBridgeCandidate(ticket,credential),body);
        }else if(step.kind==="read"){
          const packet=validatedPackets.find(candidate=>candidate.packet_id===action.packet_id);
          if(!packet)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
          result={outcome:"read",step_id:step.step_id,packet_id:packet.packet_id,state_revision:packet.context.state_revision,evidence_checked_at:packet.evidence_checked_at,objects:packet.objects};
        }
        else if(step.kind!=="change")return {disposition:"unsupported" as const,result:null};
        const changeResult=result as {outcome?:string;revision?:number}|null;
        if(changeResult?.outcome==="applied")await syncLifecycle!(tripId,changeResult.revision!);
        // The host derives waiting_user from the preserved pending_confirmation
        // receipt; only applied/pending receipts are successful submissions.
        const outcome=step.kind==="change"&&!["applied","pending_confirmation"].includes(changeResult?.outcome??"")?"failure":"success";
        await host.completeDecisionStepCandidate(ticket,credential,decisionId,actionId,stepId,claimToken,outcome,result);
        return {disposition:receipt?"receipt_recovered" as const:"executed" as const,result};
      }catch(error){
        if(error instanceof NapToolExecutionUnknown){
          try{await host.markDecisionExecutionUnknownCandidate(ticket,credential,decisionId,actionId,stepId,claimToken,error.recovery);}catch{}
        }else if(error instanceof BridgeRuleError||error instanceof TripStateContractError||error instanceof DecisionContextContractError||error instanceof RuntimeHttpFault||
          error instanceof NapCapabilityError||error instanceof NapToolRuntimeError){
          try{await host.completeDecisionStepCandidate(ticket,credential,decisionId,actionId,stepId,claimToken,"failure",{error:{name:error.name,code:"code" in error?error.code:null,message:error.message}});}catch{}
        }else try{await host.markDecisionExecutionUnknownCandidate(ticket,credential,decisionId,actionId,stepId,claimToken);}catch{}
        throw error;
      }
    },
    /** Server-only Packet source for trusted downstream runtimes such as NAP. */
    async readTrustedPacketCandidate(tripId:string,credential:Headers,packetId:string) {
      const batch=await readTrustedPacketBatchCandidate(tripId,credential,[packetId]);
      return {runtime_id:batch.runtime_id,packet:batch.packets[0]};
    },
    async handle(request: IncomingMessage, response: ServerResponse) {
      let path: string;
      try { path = new URL(request.url ?? "/", origin).pathname; }
      catch { path = ""; }
      if (/^\/runtime\/trips\/[A-Za-z][A-Za-z0-9_-]{0,95}\/(changes|confirm|checkpoints\/(?:save|status|restore))$/.test(path)) {
        const webRequest = new Request(new URL(request.url ?? "/", origin), {
          method: request.method,
          headers: request.headers as HeadersInit,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request as never,
          duplex: "half",
        } as RequestInit);
        const result=await writes(webRequest),bytes=Buffer.from(await result.arrayBuffer());
        response.writeHead(result.status,Object.fromEntries(result.headers));response.end(bytes);return;
      }
      await packets.handle(request,response);
    },
  };
}

function checkpointFault(error:unknown):RuntimeHttpFault {
  if(error instanceof RuntimeHttpFault)return error;
  if(error instanceof EvidenceBoundaryError)return new RuntimeHttpFault(error.code==="EVIDENCE_ACCESS_DENIED"?"ACCESS_DENIED":"RECOVERY_UNAVAILABLE");
  if(error instanceof CheckpointError)return new RuntimeHttpFault(error.code,["CHECKPOINT_CONFLICT","CHECKPOINT_STORAGE","CHECKPOINT_ACK_UNKNOWN"].includes(error.code));
  return new RuntimeHttpFault("INTERNAL_FAILURE");
}
