import type { IncomingMessage, ServerResponse } from "node:http";
import { createPacketHttpCandidate } from "../host-runtime/packet-http-candidate";
import type { ControlledInterpreter, openEvidenceHost } from "../host-runtime/evidence-host";
import { EvidenceBoundaryError } from "../../interaction-evidence/contracts";
import { createRuntimeHandler } from "./handler";
import { RuntimeHttpFault } from "../http-core/response";
import { parseDCContract } from "../contracts";
import { confirmChange, submitChange } from "../write-bridge/orchestrator";
import { CheckpointError } from "../checkpoint-core";

type EvidenceHost = Awaited<ReturnType<typeof openEvidenceHost>>;

/** Internal MVP candidate. Opaque host tickets and User grants never cross HTTP. */
export function createPr29HostHttpCandidate(host: EvidenceHost, origin: string, interpret?: ControlledInterpreter,
  syncLifecycle?: (tripId:string,revision:number)=>Promise<void>) {
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

  return {
    bindTurn: packets.bindTurn,
    forgetWorkspace: packets.forgetWorkspace,
    /** Server-side explicit User action; deliberately not an HTTP route. */
    async authorizeUserChange(tripId:string,credential:Headers,value:unknown) {
      const body=parseDCContract("change",value),ticket=packets.ticketForPacketCandidate(tripId,body.packet_id);
      if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.authorizeUserChangeCandidate(ticket,credential,body);
    },
    readTrustedPacketBatchCandidate,
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
