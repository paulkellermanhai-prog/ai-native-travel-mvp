import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ServerResponse } from "node:http";
import { canonicalJson } from "../../trip-state/command-json";
import type { State } from "../../trip-state/contracts.generated";
import { emptyDeliveryLedger, preparePage, type DeliveryLedger, type PacketCandidate } from "../packet-core/packet";

/**
 * Isolated transport/ledger candidate, NOT an authenticated runtime endpoint.
 * The installer must provide a server-owned candidate and recheck which holds
 * the real Session, workspace, source, deletion and current-state barriers.
 * A socket `finish` proves only handoff to the local transport, not receipt,
 * comprehension, or a durable acknowledgement by a remote client.
 * Never connect this candidate to a production route without that barrier.
 */
export function createPacketSocketDeliveryCandidate(candidate: PacketCandidate, recheck: () => Promise<void>) {
  emptyDeliveryLedger(candidate); // validates the exact initial core candidate
  const secret=randomBytes(32), packetId=candidate.packet.packet_id;
  const hash=(label:string,value:unknown)=>createHmac("sha256",secret).update(label).update("\0").update(canonicalJson(value),"utf8").digest();
  const expected=hash("candidate",candidate);
  const manifest=new Set(candidate.assembly.context.selected_object_ids.map(id=>hash("object-id",id).toString("hex")));
  const delivered=new Set<string>(), inflight=new Set<ServerResponse>();
  let closed=false, initialSent=false, tail:Promise<void>=Promise.resolve();
  function invalid(): never { throw new Error("DELIVERY_UNAVAILABLE"); }
  function invalidate() { if(closed) return; closed=true; for(const response of inflight) response.destroy(); inflight.clear(); delivered.clear(); manifest.clear(); secret.fill(0); expected.fill(0); }
  function validate(value:PacketCandidate):void {
    if (closed) return invalid();
    const actual=hash("candidate",value);
    if (actual.length!==expected.length || !timingSafeEqual(actual,expected) || value.packet.packet_id!==packetId) return invalid();
  }
  async function guard(value:PacketCandidate):Promise<void> {
    try { await recheck(); validate(value); } catch(error) { invalidate(); throw error; }
  }
  function ledger(value:PacketCandidate):DeliveryLedger {
    return {packetId,deliveredIds:value.assembly.context.selected_object_ids.filter(id=>delivered.has(hash("object-id",id).toString("hex"))).sort()};
  }
  async function exclusive<T>(action:()=>Promise<T>):Promise<T> {
    const previous=tail; let release!:()=>void;
    tail=new Promise<void>(resolve=>{release=resolve;});
    try { await previous; if(closed) return invalid(); return await action(); } finally { release(); }
  }
  async function send(response:ServerResponse,body:unknown):Promise<void> {
    if (!(response instanceof ServerResponse) || response.headersSent || response.writableEnded || response.destroyed || closed) return invalid();
    const bytes=Buffer.from(JSON.stringify(body),"utf8");
    inflight.add(response);
    try {
      await new Promise<void>((resolve,reject)=> {
        let settled=false;
        const cleanup=()=>{ clearTimeout(timer); response.off("finish",finish); response.off("close",failure); response.off("error",failure); };
        const finish=()=>{if(!settled){settled=true;cleanup();resolve();}};
        const failure=()=>{if(!settled){settled=true;cleanup();response.destroy();reject(new Error("DELIVERY_UNAVAILABLE"));}};
        const timer=setTimeout(failure,10_000);
        response.once("finish",finish); response.once("close",failure); response.once("error",failure);
        try {
          response.writeHead(200,{"content-type":"application/json; charset=utf-8","content-length":bytes.length,"cache-control":"no-store","vary":"Cookie"});
          response.end(bytes);
        } catch { failure(); }
      });
    } finally { inflight.delete(response); }
  }
  return {
    async sendPacket(response:ServerResponse,value:PacketCandidate):Promise<void> {
      await exclusive(async()=> {
        const pinned=structuredClone(value);
        validate(pinned); await guard(pinned);
        await send(response,pinned.packet);
        // A failed postflight cannot recall sent bytes. Close the candidate
        // and never record them as safely delivered.
        await guard(pinned);
        for (const object of pinned.packet.objects) delivered.add(hash("object-id",object.id).toString("hex"));
        initialSent=true;
      });
    },
    async sendPage(response:ServerResponse,value:PacketCandidate,request:unknown,before:{state:State;now:Date},after:{state:State;now:Date}):Promise<void> {
      await exclusive(async()=> {
        const pinned=structuredClone(value),pageRequest=structuredClone(request),snapshots=structuredClone({before,after});
        validate(pinned); if (!initialSent) return invalid();
        await guard(pinned);
        let page:ReturnType<typeof preparePage>;
        try { page=preparePage(pinned,pageRequest,ledger(pinned),snapshots.before,snapshots.after); }
        catch(error) {
          if (error && typeof error==="object" && "code" in error && ["PACKET_STALE","PACKET_EXPIRED","EVIDENCE_CHANGED","SNAPSHOT_MISMATCH"].includes(String(error.code))) invalidate();
          throw error;
        }
        await send(response,page);
        await guard(pinned);
        for (const object of page.objects) {
          const key=hash("object-id",object.id).toString("hex"); if (!manifest.has(key)) return invalid(); delivered.add(key);
        }
      });
    },
    progress() { if(closed) return invalid(); return {initial_sent:initialSent,delivered_count:delivered.size,remaining_count:manifest.size-delivered.size}; },
    invalidate,
  };
}
