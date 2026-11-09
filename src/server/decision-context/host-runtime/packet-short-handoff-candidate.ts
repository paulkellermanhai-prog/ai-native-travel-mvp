import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ServerResponse } from "node:http";
import { canonicalJson } from "../../trip-state/command-json";
import type { State } from "../../trip-state/contracts.generated";
import { emptyDeliveryLedger, preparePage, type DeliveryLedger, type PacketCandidate } from "../packet-core/packet";

export type HandoffDeadline = { monotonicNs:bigint; wallMs:number };

/**
 * Internal test candidate. The caller MUST hold the real Session, membership,
 * workspace, source and state locks, and perform a final authorization and
 * expiry check immediately before each synchronous begin call. `afterCommit`
 * is valid only after that transaction actually commits. The installed
 * postflight must independently revalidate current authority in a new short
 * transaction. Never expose begin/afterCommit to untrusted clients.
 *
 * Response.finish is local transport handoff, not client receipt. A rollback,
 * disconnect or failed postflight may leave bytes already in flight; the
 * result is unknown and the ledger is invalidated, not falsely acknowledged.
 */
export function createShortPacketHandoffCandidate(candidate:PacketCandidate,postflight:()=>Promise<void>) {
  emptyDeliveryLedger(candidate);
  const secret=randomBytes(32),packetId=candidate.packet.packet_id;
  const hash=(label:string,value:unknown)=>createHmac("sha256",secret).update(label).update("\0").update(canonicalJson(value),"utf8").digest();
  const expected=hash("candidate",candidate),manifest=new Set(candidate.assembly.context.selected_object_ids.map(id=>hash("id",id).toString("hex")));
  const delivered=new Set<string>(); let closed=false,busy=false,initialSent=false,active:ServerResponse|undefined;
  function unavailable():never { throw new Error("DELIVERY_UNAVAILABLE"); }
  function invalidate() { if(closed)return; closed=true; clearTimeout(expiryTimer); active?.destroy(); active=undefined; delivered.clear(); manifest.clear(); secret.fill(0); expected.fill(0); }
  // Do not retain even keyed delivery metadata beyond the original context.
  const ttl=Math.max(0,Math.min(300_000,Date.parse(candidate.packet.context.expires_at)-Date.now()));
  const expiryTimer=setTimeout(invalidate,ttl); expiryTimer.unref();
  function validate(value:PacketCandidate) {
    if(closed) return unavailable();
    const actual=hash("candidate",value); if(!timingSafeEqual(actual,expected)||value.packet.packet_id!==packetId)return unavailable();
  }
  function ledger(value:PacketCandidate):DeliveryLedger {
    return {packetId,deliveredIds:value.assembly.context.selected_object_ids.filter(id=>delivered.has(hash("id",id).toString("hex"))).sort()};
  }
  function begin(response:ServerResponse,body:unknown,ids:readonly string[],isInitial:boolean,deadline?:HandoffDeadline) {
    if(closed||busy||!(response instanceof ServerResponse)||response.headersSent||response.writableEnded||response.destroyed)return unavailable();
    const bytes=Buffer.from(JSON.stringify(body),"utf8"), keys=ids.map(id=>hash("id",id).toString("hex"));
    if(keys.some(key=>!manifest.has(key)))return unavailable();
    // Serialization may consume the remaining authorization window. Check
    // monotonic time immediately before synchronously queuing any bytes.
    if(deadline&&(process.hrtime.bigint()>=deadline.monotonicNs||Date.now()>=deadline.wallMs))return unavailable();
    busy=true; active=response;
    const finished=new Promise<void>((resolve,reject)=> {
      let settled=false;
      const cleanup=()=>{clearTimeout(timer);response.off("finish",done);response.off("close",fail);response.off("error",fail);};
      const done=()=>{if(!settled){settled=true;cleanup();resolve();}};
      const fail=()=>{if(!settled){settled=true;cleanup();response.destroy();reject(new Error("DELIVERY_UNAVAILABLE"));}};
      const timer=setTimeout(fail,10_000);
      response.once("finish",done);response.once("close",fail);response.once("error",fail);
      try {
        response.writeHead(200,{"content-type":"application/json; charset=utf-8","content-length":bytes.length,"cache-control":"no-store","vary":"Cookie"});
        if(deadline&&(process.hrtime.bigint()>=deadline.monotonicNs||Date.now()>=deadline.wallMs)){fail();return;}
        response.end(bytes);
      }
      catch {fail();}
    });
    // A socket error can precede the database commit; attach a handler now.
    void finished.catch(()=>{});
    let settled=false;
    return {
      async afterCommit() {
        if(settled||closed)return unavailable(); settled=true;
        try {
          await finished; await postflight(); if(closed)return unavailable();
          for(const key of keys)delivered.add(key); if(isInitial)initialSent=true;
        } catch(error) {invalidate();throw error;}
        finally {active=undefined;busy=false;}
      },
      abort() { if(settled)return; settled=true; invalidate(); busy=false; },
    };
  }
  return {
    revalidate(value:PacketCandidate) { validate(value); },
    beginPacket(response:ServerResponse,value:PacketCandidate,deadline?:HandoffDeadline) {
      const pinned=structuredClone(value);validate(pinned);return begin(response,pinned.packet,pinned.packet.objects.map(item=>item.id),true,deadline);
    },
    beginPage(response:ServerResponse,value:PacketCandidate,request:unknown,before:{state:State;now:Date},after:{state:State;now:Date},deadline?:HandoffDeadline) {
      const pinned=structuredClone(value),snapshots=structuredClone({before,after});validate(pinned);if(!initialSent)return unavailable();
      let page:ReturnType<typeof preparePage>;
      try {page=preparePage(pinned,structuredClone(request),ledger(pinned),snapshots.before,snapshots.after);}
      catch(error) {if(error&&typeof error==="object"&&"code" in error&&["PACKET_STALE","PACKET_EXPIRED","EVIDENCE_CHANGED","SNAPSHOT_MISMATCH"].includes(String(error.code)))invalidate();throw error;}
      return begin(response,page,page.objects.map(item=>item.id),false,deadline);
    },
    progress(){if(closed)return unavailable();return {initial_sent:initialSent,delivered_count:delivered.size,remaining_count:manifest.size-delivered.size,pending:busy};},
    invalidate,
  };
}
