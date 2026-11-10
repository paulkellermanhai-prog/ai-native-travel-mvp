import fs from "node:fs";
import { describe,expect,it } from "vitest";
import type { DecisionContextContracts } from "../../src/server/decision-context/contracts";
import { buildTrustedDecisionRequest,NapTrustedPacketError } from "../../src/server/next-action-policy/trusted-packet-source";

const rows=JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json","utf8")) as Array<{schema:string;value:unknown}>;
const packet=rows.find(row=>row.schema==="packet")!.value as DecisionContextContracts["packet"];
const input={tripId:packet.context.trip_id,credential:new Headers({cookie:"session=test"}),decisionId:"decision",
  trigger:{kind:"user_event" as const,reference:"event"},packetIds:[packet.packet_id]};

describe("E04 trusted E03 Packet source",()=>{
  it("constructs the request only from the host-returned Packet",async()=>{
    const source={readTrustedPacketCandidate:async()=>({runtime_id:"runtime",packet:structuredClone(packet)})};
    const request=await buildTrustedDecisionRequest(source as never,input);
    expect(request).toMatchObject({decision_id:"decision",runtime_id:"runtime",packets:[{packet_id:packet.packet_id}]});
    expect(request.packets[0]).not.toBe(packet);
  });
  it("rejects a host result that does not match the requested ID or trip",async()=>{
    for(const changed of [
      {...packet,packet_id:"forged"},
      {...packet,context:{...packet.context,trip_id:"another-trip"}},
    ]) {
      const source={readTrustedPacketCandidate:async()=>({runtime_id:"runtime",packet:changed})};
      await expect(buildTrustedDecisionRequest(source as never,input)).rejects.toBeInstanceOf(NapTrustedPacketError);
    }
  });
  it("rejects mixed runtime generations, revisions and digests",async()=>{
    const second=structuredClone(packet);second.packet_id="packet-second";
    const pair={...input,packetIds:[packet.packet_id,second.packet_id]};
    for(const rows of [
      [{runtime_id:"runtime-a",packet},{runtime_id:"runtime-b",packet:second}],
      [{runtime_id:"runtime",packet},{runtime_id:"runtime",packet:{...second,context:{...second.context,state_revision:second.context.state_revision+1}}}],
      [{runtime_id:"runtime",packet},{runtime_id:"runtime",packet:{...second,snapshot_digest:"b".repeat(64)}}],
    ]) {
      let i=0;const source={readTrustedPacketCandidate:async()=>rows[i++]};
      await expect(buildTrustedDecisionRequest(source as never,pair)).rejects.toBeInstanceOf(NapTrustedPacketError);
    }
  });
  it("does not turn source failure or duplicate IDs into a request",async()=>{
    const source={readTrustedPacketCandidate:async()=>{throw new Error("denied");}};
    await expect(buildTrustedDecisionRequest(source as never,input)).rejects.toBeInstanceOf(NapTrustedPacketError);
    await expect(buildTrustedDecisionRequest(source as never,{...input,packetIds:[packet.packet_id,packet.packet_id]})).rejects.toBeInstanceOf(NapTrustedPacketError);
  });
});
