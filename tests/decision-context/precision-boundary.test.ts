import { describe, expect, it } from "vitest";
import { assembleContextSnapshot, validateContextSnapshot } from "../../src/server/decision-context/context-assembly";
import { buildPacketCandidate, checkConsumption, preparePage } from "../../src/server/decision-context/packet-core/packet";
import type { DecisionContextContracts } from "../../src/server/decision-context/contracts";
import { base, object } from "../support/bcg-fixtures";

const before = new Date("2029-12-31T23:59:59.999Z");
const uncertain = new Date("2030-01-01T00:00:00.000Z");
const after = new Date("2030-01-01T00:00:00.001Z");
const task: DecisionContextContracts["packet"]["task"] = { task_key:"E", question:"看看", kind:"explore", target_ids:["skeleton-a"], branch:"actual", relation:"new", related_task_keys:[], certainty:"explicit", evidence:[{start:0,end:2,quote:"看看"}], progress:"open", progress_evidence:null };
const pending: DecisionContextContracts["packet"]["pending_input"] = {event:{event_id:"e1",entry:"dialogue",text:"看看",reference:"synthetic",received_at:before.toISOString()},base_revision:0,processing_status:"unprocessed",proposal_id:null,result_revision:0,errors:[]};

function setup(expiry: string) {
  const state=structuredClone(base), fact=object(state,"fact-cairo-luxor","ExternalFact");
  for (const item of state.objects) if (item.type === "ExternalFact") item.observed_at="2029-12-31T23:00:00Z";
  fact.observed_at="2029-12-31T23:00:00Z"; fact.expires_at=expiry;
  const created=new Date("2029-12-31T23:59:59.998Z");
  const assembly=assembleContextSnapshot(state,"E",task.target_ids,created);
  const candidate=buildPacketCandidate({request:{runtime_contract_version:"0.1.0",turn_id:"turn-test",task_key:"E",body_budget_bytes:2},packetId:"packet-test",task,pending,assembly,state,now:created,recoveredInput:false,saveUnacknowledged:false});
  return {state,assembly,candidate};
}

describe("millisecond clocks and microsecond expiry",()=>{
  it("rejects a selected fact that may already have expired inside the current millisecond",()=>{
    const {state,assembly,candidate}=setup("2030-01-01T00:00:00.000500Z");
    expect(assembly.context.expires_at).toBe("2030-01-01T00:00:00.000500Z");
    expect(()=>validateContextSnapshot(assembly,state,before)).not.toThrow();
    expect(()=>validateContextSnapshot(assembly,state,uncertain)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    expect(()=>checkConsumption(candidate,state,uncertain,[])).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    expect(()=>validateContextSnapshot(assembly,state,after)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
  });
  it("rejects at equality and after an aligned deadline, while allowing the preceding millisecond",()=>{
    const {state,assembly}=setup("2030-01-01T00:00:00Z");
    expect(()=>validateContextSnapshot(assembly,state,before)).not.toThrow();
    for(const now of [uncertain,after]) expect(()=>validateContextSnapshot(assembly,state,now)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
  });
  it("applies the same conservative boundary to an equivalent timezone offset",()=>{
    for (const expiry of ["2030-01-01T02:00:00.000500+02:00","2030-01-01T02:00:00.000500+0200","2030-01-01T02:00:00.000500+02","2029-12-31T19:00:00.000500-05:00","2029-12-31T19:00:00.000500-0500","2029-12-31T19:00:00.000500-05","2030-01-01t00:00:00.000500z"]) {
      const {state,assembly}=setup(expiry);
      expect(assembly.context.expires_at).toBe("2030-01-01T00:00:00.000500Z");
      expect(()=>validateContextSnapshot(assembly,state,before)).not.toThrow();
      expect(()=>validateContextSnapshot(assembly,state,uncertain)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    }
  });
  it("uses the full millisecond interval at its left and right edges",()=>{
    for (const expiry of ["2030-01-01T00:00:00.000001Z","2030-01-01T00:00:00.000999Z"]) {
      const {state,assembly}=setup(expiry);
      expect(()=>validateContextSnapshot(assembly,state,uncertain)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    }
    const {state,assembly}=setup("2030-01-01T00:00:00.001000Z");
    expect(()=>validateContextSnapshot(assembly,state,uncertain)).not.toThrow();
    expect(()=>validateContextSnapshot(assembly,state,after)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
  });
  it("rejects a page whose second check may cross the submillisecond deadline and leaves its ledger unchanged",()=>{
    const {state,candidate}=setup("2030-01-01T00:00:00.000500Z"), ledger:string[]=[];
    expect(()=>preparePage(candidate,{runtime_contract_version:"0.1.0",packet_id:"packet-test",object_ids:candidate.packet.deferred_ids.slice(0,1)},ledger,{state,now:before},{state,now:uncertain})).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    expect(ledger).toEqual([]);
  });
});
