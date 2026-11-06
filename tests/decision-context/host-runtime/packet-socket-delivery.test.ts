import http, { type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { assembleContextSnapshot } from "../../../src/server/decision-context/context-assembly";
import { buildPacketCandidate } from "../../../src/server/decision-context/packet-core/packet";
import { createPacketSocketDeliveryCandidate } from "../../../src/server/decision-context/host-runtime/packet-socket-delivery-candidate";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";
import { base } from "../../support/bcg-fixtures";

function fixture() {
  const state=structuredClone(base),now=new Date("2030-01-01T00:00:00Z");
  const task:DecisionContextContracts["packet"]["task"]={task_key:"E",question:"看看",kind:"explore",target_ids:["skeleton-a"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"看看"}],progress:"open",progress_evidence:null};
  const pending:DecisionContextContracts["packet"]["pending_input"]={event:{event_id:"e1",entry:"dialogue",text:"看看",reference:"synthetic",received_at:now.toISOString()},base_revision:0,processing_status:"unprocessed",proposal_id:null,result_revision:0,errors:[]};
  const assembly=assembleContextSnapshot(state,"E",task.target_ids,now);
  const candidate=buildPacketCandidate({request:{runtime_contract_version:"0.1.0",turn_id:"turn-test",task_key:"E",body_budget_bytes:2},packetId:"packet-test",task,pending,assembly,state,now,recoveredInput:false,saveUnacknowledged:false});
  return {state,now,candidate};
}
async function serverRun(handler:(path:string,response:ServerResponse)=>Promise<void>,run:(origin:string)=>Promise<void>) {
  const server=http.createServer((request,response)=>{void handler(request.url??"",response).catch(()=>{if(!response.headersSent&&!response.destroyed){response.writeHead(500);response.end();}});});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address(); if(!address||typeof address==="string") throw new Error("missing socket");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
}

describe("isolated Packet socket and private delivery ledger",()=> {
  it("hands a Packet to a real socket and serializes concurrent page ledger updates",async()=> {
    const {candidate,state,now}=fixture(), ids=candidate.packet.deferred_ids; expect(ids.length).toBeGreaterThan(2);
    let checks=0; const delivery=createPacketSocketDeliveryCandidate(candidate,async()=>{checks++;});
    const snapshots={state,now};
    await serverRun(async(path,res)=> {
      if(path==="/packet") return delivery.sendPacket(res,candidate);
      const id=path==="/a"?ids[0]:path==="/b"?ids[1]:"not-in-manifest";
      return delivery.sendPage(res,candidate,{runtime_contract_version:"0.1.0",packet_id:candidate.packet.packet_id,object_ids:[id]},snapshots,snapshots);
    },async origin=> {
      expect(delivery.progress()).toEqual({initial_sent:false,delivered_count:0,remaining_count:ids.length});
      const initial=await fetch(`${origin}/packet`); expect(initial.status).toBe(200); expect(await initial.json()).toEqual(candidate.packet);
      expect(delivery.progress()).toEqual({initial_sent:true,delivered_count:0,remaining_count:ids.length});
      const pages=await Promise.all([fetch(`${origin}/a`),fetch(`${origin}/b`)]);
      expect(pages.map(p=>p.status)).toEqual([200,200]);
      const values=await Promise.all(pages.map(p=>p.json() as Promise<{objects:Array<{id:string}>;remaining_ids:string[]}>));
      expect(values.flatMap(page=>page.objects.map(object=>object.id)).sort()).toEqual([ids[0],ids[1]].sort());
      expect(values.map(page=>page.remaining_ids.length).sort()).toEqual([ids.length-2,ids.length-1]);
      expect(delivery.progress()).toEqual({initial_sent:true,delivered_count:2,remaining_count:ids.length-2});
      expect((await fetch(`${origin}/bad`)).status).toBe(500);
      expect(delivery.progress().delivered_count).toBe(2);
      expect(checks).toBeGreaterThanOrEqual(6);
    });
    delivery.invalidate(); expect(()=>delivery.progress()).toThrow("DELIVERY_UNAVAILABLE");
  },30000);
  it("does not record a socket that closes before handoff, or an altered candidate",async()=> {
    const {candidate}=fixture(),delivery=createPacketSocketDeliveryCandidate(candidate,async()=>{});
    await serverRun(async(path,res)=> {
      if(path==="/abort") {res.destroy(); return delivery.sendPacket(res,candidate);}
      const changed=structuredClone(candidate); changed.packet.pending_input.event.text="forged";
      return delivery.sendPacket(res,changed);
    },async origin=> {
      await expect(fetch(`${origin}/abort`)).rejects.toThrow();
      expect(delivery.progress().initial_sent).toBe(false);
      expect((await fetch(`${origin}/forged`)).status).toBe(500);
      expect(delivery.progress()).toMatchObject({initial_sent:false,delivered_count:0});
    });
    delivery.invalidate();
  },30000);
  it("closes the ledger if postflight fails, even though sent bytes cannot be recalled",async()=> {
    const {candidate}=fixture(); let checks=0;
    const delivery=createPacketSocketDeliveryCandidate(candidate,async()=>{if(++checks===2) throw new Error("revoked");});
    await serverRun(async(_path,res)=>delivery.sendPacket(res,candidate),async origin=> {
      const response=await fetch(origin); expect(response.status).toBe(200); expect(await response.json()).toEqual(candidate.packet);
      expect(()=>delivery.progress()).toThrow("DELIVERY_UNAVAILABLE");
    });
  },30000);
  it("invalidates the private ledger on revoked authorization or expired context",async()=> {
    const {candidate,state,now}=fixture(), id=candidate.packet.deferred_ids[0],snapshots={state,now};
    let revoked=false; const delivery=createPacketSocketDeliveryCandidate(candidate,async()=>{if(revoked) throw new Error("revoked");});
    const request={runtime_contract_version:"0.1.0",packet_id:candidate.packet.packet_id,object_ids:[id]};
    await serverRun(async(path,res)=>path==="/packet"?delivery.sendPacket(res,candidate):delivery.sendPage(res,candidate,request,snapshots,snapshots),async origin=> {
      expect((await fetch(`${origin}/page`)).status).toBe(500);
      expect(delivery.progress().initial_sent).toBe(false);
      expect((await fetch(`${origin}/packet`)).status).toBe(200);
      revoked=true; expect((await fetch(`${origin}/page`)).status).toBe(500);
      expect(()=>delivery.progress()).toThrow("DELIVERY_UNAVAILABLE");
    });
    const expired=createPacketSocketDeliveryCandidate(candidate,async()=>{});
    await serverRun(async(path,res)=>path==="/packet"?expired.sendPacket(res,candidate):expired.sendPage(res,candidate,request,snapshots,{state,now:new Date(candidate.packet.context.expires_at)}),async origin=> {
      expect((await fetch(`${origin}/packet`)).status).toBe(200);
      expect((await fetch(`${origin}/page`)).status).toBe(500);
      expect(()=>expired.progress()).toThrow("DELIVERY_UNAVAILABLE");
    });
  },30000);
});
