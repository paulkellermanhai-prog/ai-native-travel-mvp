import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeDCContract, DecisionContextContractError } from "../contracts";
import { runtimeError, RuntimeHttpFault } from "../http-core/response";
import { EvidenceBoundaryError } from "../../interaction-evidence/contracts";
import { recordInputSchema } from "../../interaction-evidence/contracts";
import type { ControlledInterpreter, openEvidenceHost } from "./evidence-host";

type EvidenceHost = Awaited<ReturnType<typeof openEvidenceHost>>;
const identifier=/^[A-Za-z][A-Za-z0-9_-]{0,95}$/;

/**
 * Node HTTP integration route for a host-owned Turn. A server-installed
 * interpreter may create one new Task from a recorded event; callers may also
 * bind an existing trusted Turn. Assemble/page requests use the frozen
 * contracts, and Task text comes from the short-lived private host lease.
 * This is not mounted in the public Next router pending E03-03 acceptance.
 */
export function createPacketHttpCandidate(host:EvidenceHost,origin:string,interpret?:ControlledInterpreter) {
  const turns=new Map<string,{tripId:string;ticket:object;expiresAt:number;timer:NodeJS.Timeout}>();
  const workspaces=new Map<string,Set<object>>();
  const sessionWorkspaces=new Map<string,{ticket:object;expiresAt:number;timer:NodeJS.Timeout}>();
  const packetHandoffs=new Map<object,Set<Promise<void>>>();
  function trackPacketHandoff<T>(ticket:object,operation:Promise<T>):Promise<T> {
    const settled=operation.then(()=>{},()=>{}),pending=packetHandoffs.get(ticket)??new Set<Promise<void>>();
    pending.add(settled);packetHandoffs.set(ticket,pending);
    void settled.then(()=>{pending.delete(settled);if(!pending.size)packetHandoffs.delete(ticket);});
    return operation;
  }
  async function awaitPacketHandoff(ticket:object) {
    const pending=packetHandoffs.get(ticket);
    if(pending)await Promise.all([...pending]);
  }
  function forgetTurn(turnId:string) {
    const prior=turns.get(turnId);if(!prior)return;
    clearTimeout(prior.timer);turns.delete(turnId);
    if(![...turns.values()].some(item=>item.tripId===prior.tripId&&item.ticket===prior.ticket)){
      const set=workspaces.get(prior.tripId);set?.delete(prior.ticket);if(!set?.size)workspaces.delete(prior.tripId);
    }
  }
  function bindTurn(tripId:string,turnId:string,ticket:object) {
    if(!identifier.test(tripId)||!identifier.test(turnId)||!ticket||typeof ticket!=="object")throw new Error("INVALID_TURN_BINDING");
    const old=turns.get(turnId);if(old&&old.ticket!==ticket)throw new Error("TURN_ALREADY_BOUND");
    if(!old&&turns.size>=256)throw new Error("TURN_BINDING_LIMIT");
    if(old)forgetTurn(turnId);
    const expiresAt=Date.now()+300_000,timer=setTimeout(()=>forgetTurn(turnId),300_000);timer.unref();
    turns.set(turnId,{tripId,ticket,expiresAt,timer});const set=workspaces.get(tripId)??new Set<object>();set.add(ticket);workspaces.set(tripId,set);
  }
  function forgetWorkspace(ticket:object) {
    for(const [id,entry] of turns)if(entry.ticket===ticket)forgetTurn(id);
    for(const [key,entry] of sessionWorkspaces)if(entry.ticket===ticket){clearTimeout(entry.timer);sessionWorkspaces.delete(key);}
  }
  function keepWorkspace(key:string,ticket:object) {
    const old=sessionWorkspaces.get(key);if(old)clearTimeout(old.timer);
    const expiresAt=Date.now()+300_000;
    const timer=setTimeout(()=>{const current=sessionWorkspaces.get(key);if(current?.ticket===ticket){forgetWorkspace(ticket);void host.disposeWorkspace(ticket).catch(()=>{});}},300_000);timer.unref();
    sessionWorkspaces.set(key,{ticket,expiresAt,timer});
  }
  return {
    bindTurn,forgetWorkspace,
    awaitPacketHandoffCandidate:awaitPacketHandoff,
    ticketForSessionCandidate(sessionKey:string) {
      const entry=sessionWorkspaces.get(sessionKey);
      return entry&&entry.expiresAt>Date.now()?entry.ticket:undefined;
    },
    bindSessionWorkspaceCandidate(sessionKey:string,ticket:object) {keepWorkspace(sessionKey,ticket);},
    ticketForPacketCandidate(tripId:string,packetId:string) {
      return [...(workspaces.get(tripId)??[])].find(ticket=>host.hasLocalPacketCandidate(ticket,packetId));
    },
    ticketForTurnCandidate(tripId:string,turnId:string) {
      const binding=turns.get(turnId);
      return binding?.tripId===tripId&&binding.expiresAt>Date.now()?binding.ticket:undefined;
    },
    async handle(request:IncomingMessage,response:ServerResponse) {
      try {
        const path=new URL(request.url??"/",origin).pathname;
        const match=/^\/runtime\/trips\/([A-Za-z][A-Za-z0-9_-]{0,95})\/(turns|assemble|pages)$/.exec(path);
        const tripId=match?.[1],candidateTickets=tripId?workspaces.get(tripId):undefined;
        if(!tripId)throw new RuntimeHttpFault("ACCESS_DENIED");
        const credential=new Headers({cookie:request.headers.cookie??""});
        const sessionKey=await host.authorizeTripCandidate(tripId,credential);
        if(match[2]!=="turns"&&!candidateTickets?.size)throw new RuntimeHttpFault("ACCESS_DENIED");
        if(request.method!=="POST")throw new RuntimeHttpFault("METHOD_NOT_ALLOWED");
        if(request.headers.origin!==origin||request.headers["sec-fetch-site"]==="cross-site")throw new RuntimeHttpFault("ACCESS_DENIED");
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers["content-type"]??""))throw new RuntimeHttpFault("CONTRACT_INVALID");
        const length=request.headers["content-length"];
        if(length!==undefined&&(!/^\d+$/.test(length)||BigInt(length)>262_144n))throw new RuntimeHttpFault("CONTRACT_INVALID");
        const chunks:Buffer[]=[];let total=0;
        for await(const chunk of request){const bytes=Buffer.from(chunk as Uint8Array);total+=bytes.length;if(total>262_144)throw new RuntimeHttpFault("CONTRACT_INVALID");chunks.push(bytes);}
        const body=Buffer.concat(chunks).toString("utf8");
        if(match[2]==="turns"){
          if(!interpret)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
          if(turns.size>=256)throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
          let parsed:unknown;try{parsed=JSON.parse(body);}catch{throw new RuntimeHttpFault("CONTRACT_INVALID");}
          const value=recordInputSchema.safeParse(parsed);if(!value.success)throw new RuntimeHttpFault("CONTRACT_INVALID");
          const route=sessionWorkspaces.get(sessionKey);
          if(route&&route.expiresAt<=Date.now()){forgetWorkspace(route.ticket);await host.disposeWorkspace(route.ticket);}
          const ticket=route&&route.expiresAt>Date.now()?route.ticket:await host.createWorkspace(tripId,credential);
          if(!route||route.ticket!==ticket)keepWorkspace(sessionKey,ticket);
          const opened=await host.openInterpretedTurnCandidate(ticket,credential,value.data,interpret);
          const saved=await host.autosaveTurnCandidate(ticket,credential,opened,value.data.entry);
          const turn={...opened,checkpoint_ack:saved.ack};
          bindTurn(tripId,turn.turn_id,ticket);keepWorkspace(sessionKey,ticket);
          await host.sendTurnCandidate(ticket,credential,turn,response);
        } else if(match[2]==="assemble"){
          const value=decodeDCContract("assemble",body),binding=turns.get(value.turn_id);
          if(!binding||binding.tripId!==tripId||binding.expiresAt<=Date.now())throw new RuntimeHttpFault("ACCESS_DENIED");
          await trackPacketHandoff(binding.ticket,host.sendLivePacketCandidate(binding.ticket,credential,value.turn_id,value.task_key,value.body_budget_bytes,undefined,response));
        } else {
          const value=decodeDCContract("page-request",body);
          const ticket=[...candidateTickets!].find(candidate=>host.hasLocalPacketCandidate(candidate,value.packet_id));
          if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
          // The Packet bytes may reach a client before the socket-finish
          // postflight has committed its private delivery ledger. Wait for
          // that local handoff before an independent page request rechecks it.
          await awaitPacketHandoff(ticket);
          await host.sendLivePacketPageCandidate(ticket,credential,value,undefined,response);
        }
      } catch(error) {
        if(response.headersSent||response.destroyed){response.destroy();return;}
        const mapped=error instanceof RuntimeHttpFault?error:
          error instanceof DecisionContextContractError?new RuntimeHttpFault("CONTRACT_INVALID"):
          error instanceof EvidenceBoundaryError&&error.code==="EVIDENCE_ACCESS_DENIED"?new RuntimeHttpFault("ACCESS_DENIED"):
          new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
        const result=runtimeError(mapped),body=Buffer.from(await result.text(),"utf8");
        response.writeHead(result.status,{"content-type":"application/json; charset=utf-8","content-length":body.length,
          "cache-control":"private, no-store, max-age=0","x-content-type-options":"nosniff","vary":"Cookie"});response.end(body);
      }
    },
  };
}
