import type { createPr29HostHttpCandidate } from "../decision-context/http-adapter/pr29-host-candidate";
import { parseDCContract, type DecisionContextContracts } from "../decision-context/contracts";
import { validateNapMessage } from "./contracts";

type Packet = DecisionContextContracts["packet"];
type PacketSource = Pick<ReturnType<typeof createPr29HostHttpCandidate>,"readTrustedPacketCandidate">;
type Trigger = {kind:"user_event"|"tool_result"|"state_change"|"clock_tick"|"ui_action";reference:string};
export type TrustedDecisionRequest = {
  nap_contract_version:"0.1.0";
  decision_id:string;
  runtime_id:string;
  trigger:Trigger;
  packets:Packet[];
};

export class NapTrustedPacketError extends Error {
  constructor() { super("NAP trusted Packet source: INVALID_OR_STALE"); this.name="NapTrustedPacketError"; }
}

/**
 * Builds a DecisionRequest without accepting Packet JSON from a client or
 * model. The injected E03 adapter resolves private Packet IDs and revalidates
 * their Session, trip, runtime generation, current state and expiry.
 */
export async function buildTrustedDecisionRequest(source:PacketSource,input:{
  tripId:string;
  credential:Headers;
  decisionId:string;
  trigger:Trigger;
  packetIds:readonly string[];
}):Promise<TrustedDecisionRequest> {
  const ids=[...input.packetIds];
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(input.tripId)||
    !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(input.decisionId)||ids.length<1||
    new Set(ids).size!==ids.length||ids.some(id=>!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(id)))throw new NapTrustedPacketError();
  const credential=new Headers({cookie:input.credential.get("cookie")??""});
  let rows:Awaited<ReturnType<PacketSource["readTrustedPacketCandidate"]>>[];
  try {rows=await Promise.all(ids.map(id=>source.readTrustedPacketCandidate(input.tripId,credential,id)));}
  catch {throw new NapTrustedPacketError();}
  const packets=rows.map((row,index)=>{
    const packet=parseDCContract("packet",structuredClone(row.packet));
    if(packet.packet_id!==ids[index]||packet.context.trip_id!==input.tripId)return invalid();
    return packet;
  });
  const runtimeId=rows[0]?.runtime_id;
  const first=packets[0];
  if(!runtimeId||!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(runtimeId)||rows.some(row=>row.runtime_id!==runtimeId)||
    packets.some(packet=>packet.context.state_revision!==first.context.state_revision||packet.snapshot_digest!==first.snapshot_digest))return invalid();
  const request:TrustedDecisionRequest={nap_contract_version:"0.1.0",decision_id:input.decisionId,runtime_id:runtimeId,
    trigger:structuredClone(input.trigger),packets};
  try {validateNapMessage("DecisionRequest",request);} catch {return invalid();}
  return structuredClone(request);
}

function invalid():never {throw new NapTrustedPacketError();}
