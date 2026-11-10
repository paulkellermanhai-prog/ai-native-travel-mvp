import type { IncomingMessage, ServerResponse } from "node:http";
import { createPacketHttpCandidate } from "../host-runtime/packet-http-candidate";
import type { ControlledInterpreter, openEvidenceHost } from "../host-runtime/evidence-host";
import { EvidenceBoundaryError } from "../../interaction-evidence/contracts";
import { createRuntimeHandler } from "./handler";
import { RuntimeHttpFault } from "../http-core/response";
import { parseDCContract } from "../contracts";
import { confirmChange, submitChange } from "../write-bridge/orchestrator";

type EvidenceHost = Awaited<ReturnType<typeof openEvidenceHost>>;

/** Internal MVP candidate. Opaque host tickets and User grants never cross HTTP. */
export function createPr29HostHttpCandidate(host: EvidenceHost, origin: string, interpret?: ControlledInterpreter,
  syncLifecycle?: (tripId:string,revision:number)=>Promise<void>) {
  const packets = createPacketHttpCandidate(host, origin, interpret);
  const writes = createRuntimeHandler({ origin, async authorize(tripId, headers) {
    try { await host.authorizeTripCandidate(tripId, headers); }
    catch (error) {
      if (error instanceof EvidenceBoundaryError && error.code === "EVIDENCE_ACCESS_DENIED") throw new RuntimeHttpFault("ACCESS_DENIED");
      throw new RuntimeHttpFault("RECOVERY_UNAVAILABLE");
    }
    return {
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

  return {
    bindTurn: packets.bindTurn,
    forgetWorkspace: packets.forgetWorkspace,
    /** Server-side explicit User action; deliberately not an HTTP route. */
    async authorizeUserChange(tripId:string,credential:Headers,value:unknown) {
      const body=parseDCContract("change",value),ticket=packets.ticketForPacketCandidate(tripId,body.packet_id);
      if(!ticket)throw new RuntimeHttpFault("ACCESS_DENIED");
      return host.authorizeUserChangeCandidate(ticket,credential,body);
    },
    async handle(request: IncomingMessage, response: ServerResponse) {
      let path: string;
      try { path = new URL(request.url ?? "/", origin).pathname; }
      catch { path = ""; }
      if (/^\/runtime\/trips\/[A-Za-z][A-Za-z0-9_-]{0,95}\/(changes|confirm)$/.test(path)) {
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
