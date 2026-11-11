import fs from "node:fs";
import { describe,expect,it } from "vitest";
import type { DecisionContextContracts } from "../../src/server/decision-context/contracts";
import { buildTrustedDecisionRequest,NapTrustedPacketError } from "../../src/server/next-action-policy/trusted-packet-source";

const rows=JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json","utf8")) as Array<{schema:string;value:unknown}>;
const packet=rows.find(row=>row.schema==="packet")!.value as DecisionContextContracts["packet"];
const input={tripId:packet.context.trip_id,credential:new Headers({cookie:"session=test"}),decisionId:"decision",
  trigger:{kind:"user_event" as const,reference:packet.pending_input.event.reference},packetIds:[packet.packet_id]};
const sourceFor=(packets:DecisionContextContracts["packet"][],runtimeId="runtime")=>({
  readTrustedPacketBatchCandidate:async()=>({runtime_id:runtimeId,packets:structuredClone(packets)}),
});

describe("E04 trusted E03 Packet source",()=>{
  it("constructs the request only from the host-returned Packet",async()=>{
    const source=sourceFor([packet]);
    const request=await buildTrustedDecisionRequest(source as never,input);
    expect(request).toMatchObject({decision_id:"decision",runtime_id:"runtime",packets:[{packet_id:packet.packet_id}]});
    expect(request.packets[0]).not.toBe(packet);
  });
  it("rejects a host result that does not match the requested ID or trip",async()=>{
    for(const changed of [
      {...packet,packet_id:"forged"},
      {...packet,context:{...packet.context,trip_id:"another-trip"}},
    ]) {
      const source=sourceFor([changed as DecisionContextContracts["packet"]]);
      await expect(buildTrustedDecisionRequest(source as never,input)).rejects.toBeInstanceOf(NapTrustedPacketError);
    }
  });
  it("binds a user_event trigger to the host-registered Packet event",async()=>{
    await expect(buildTrustedDecisionRequest(sourceFor([packet]) as never,{...input,
      trigger:{kind:"user_event",reference:"host-interaction:forged"}})).rejects.toBeInstanceOf(NapTrustedPacketError);
  });
  it("rejects unregistered trigger kinds until the host has a trusted source",async()=>{
    for(const kind of ["tool_result","state_change","clock_tick","ui_action"] as const) {
      await expect(buildTrustedDecisionRequest(sourceFor([packet]) as never,{...input,trigger:{kind,reference:"untrusted"}}))
        .rejects.toBeInstanceOf(NapTrustedPacketError);
    }
  });
  it("rejects mixed revisions but preserves each task Packet's own digest",async()=>{
    const second=structuredClone(packet);second.packet_id="packet-second";
    const pair={...input,packetIds:[packet.packet_id,second.packet_id]};
    await expect(buildTrustedDecisionRequest(sourceFor([packet,{...second,context:{...second.context,state_revision:second.context.state_revision+1}}] as DecisionContextContracts["packet"][]) as never,pair))
      .rejects.toBeInstanceOf(NapTrustedPacketError);
    const otherDigest="b".repeat(64);
    await expect(buildTrustedDecisionRequest(sourceFor([packet,{...second,snapshot_digest:otherDigest}] as DecisionContextContracts["packet"][]) as never,pair))
      .resolves.toMatchObject({packets:[{snapshot_digest:packet.snapshot_digest},{snapshot_digest:otherDigest}]});
  });
  it("does not turn source failure or duplicate IDs into a request",async()=>{
    const source={readTrustedPacketBatchCandidate:async()=>{throw new Error("denied");}};
    await expect(buildTrustedDecisionRequest(source as never,input)).rejects.toBeInstanceOf(NapTrustedPacketError);
    await expect(buildTrustedDecisionRequest(source as never,{...input,packetIds:[packet.packet_id,packet.packet_id]})).rejects.toBeInstanceOf(NapTrustedPacketError);
  });
});
