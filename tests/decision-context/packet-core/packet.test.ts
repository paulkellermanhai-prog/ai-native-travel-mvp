import { describe, expect, it } from "vitest";
import { assembleContextSnapshot } from "../../../src/server/decision-context/context-assembly";
import { buildPacketCandidate, checkConsumption, checkPacketTurn, preparePage, recordDelivery } from "../../../src/server/decision-context/packet-core/packet";
import { canonicalJson } from "../../../src/server/trip-state/command-json";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";
import { base } from "../../support/bcg-fixtures";

type Task = DecisionContextContracts["packet"]["task"];
const now = () => new Date("2030-01-01T00:00:00Z");
const task: Task = { task_key:"E", question:"看看", kind:"explore", target_ids:["skeleton-a"], branch:"actual", relation:"new", related_task_keys:[], certainty:"explicit", evidence:[{start:0,end:2,quote:"看看"}], progress:"open", progress_evidence:null };
const pending: DecisionContextContracts["packet"]["pending_input"] = { event:{event_id:"e1",entry:"dialogue",text:"看看",reference:"synthetic",received_at:"2030-01-01T00:00:00Z"}, base_revision:0, processing_status:"unprocessed",proposal_id:null,result_revision:0,errors:[] };
function setup(budget: number) {
  const state = structuredClone(base), assembly = assembleContextSnapshot(state, "E", task.target_ids, now());
  const request = { runtime_contract_version:"0.1.0" as const, turn_id:"turn-test", task_key:"E", body_budget_bytes:budget };
  const input = {request, packetId:"packet-test", task:structuredClone(task), pending:structuredClone(pending), assembly, state, now:now(), recoveredInput:false, saveUnacknowledged:false};
  return {input, candidate:buildPacketCandidate(input)};
}
const request = (ids: string[]) => ({runtime_contract_version:"0.1.0",packet_id:"packet-test",object_ids:ids});
const moment = (state: typeof base, date = now()) => ({state,now:date});

describe("E03-03 packet core (synthetic host inputs)", () => {
  it("creates complete or limited candidate without mutating source and retains full manifest", () => {
    const full = setup(10_000_000); const snapshot = structuredClone(full.input);
    expect(full.candidate.packet.coverage).toBe("complete");
    expect(full.candidate.packet.support).toBe("decision_support");
    expect(full.candidate.packet.deferred_ids).toEqual([]);
    expect(full.candidate.packet.objects.map(o=>o.id).sort()).toEqual([...full.input.assembly.context.selected_object_ids].sort());
    buildPacketCandidate(full.input); expect(full.input).toEqual(snapshot);
    const limited = setup(2);
    expect(limited.candidate.packet).toMatchObject({coverage:"limited",support:"information_only",objects:[]});
    expect(limited.candidate.packet.deferred_ids).toEqual(limited.input.assembly.context.selected_object_ids);
  });
  it("uses exact deterministic UTF-8 budget, target first, and never truncates bodies", () => {
    const reference = setup(10_000_000), target = reference.input.assembly.objects.find(o=>o.id === "skeleton-a")!;
    const budget = Buffer.byteLength(canonicalJson([target]), "utf8");
    const at = setup(budget), below = setup(budget - 1);
    expect(at.candidate.packet.objects[0]).toEqual(target);
    expect(below.candidate.packet.objects.some(o=>o.id === target.id)).toBe(false);
    expect(Buffer.byteLength(canonicalJson(at.candidate.packet.objects), "utf8")).toBeLessThanOrEqual(budget);
    expect(at.candidate.packet.coverage).toBe("layered");
    for (const item of at.candidate.packet.objects) expect(item).toEqual(at.input.assembly.objects.find(o=>o.id === item.id));
    expect(()=>setup(1)).toThrow();
  });
  it("pages only the manifest, leaves initial candidate untouched, and requires host ledger update", () => {
    const {candidate,input} = setup(2), before = structuredClone(candidate), ids=candidate.packet.deferred_ids;
    const first = ids.slice(0,2), p = preparePage(candidate,request(first),[],moment(input.state),moment(input.state));
    expect(p.objects.map(o=>o.id)).toEqual(first);
    expect(p.remaining_ids).toEqual(ids.filter(id=>!first.includes(id)));
    expect(p.delivery_only_not_model_comprehension).toBe(true);
    expect(checkConsumption(candidate,input.state,now(),[]).remainingIds).toEqual(ids);
    const ledger = recordDelivery(candidate,[],first);
    expect(checkConsumption(candidate,input.state,now(),ledger).remainingIds).toEqual(p.remaining_ids);
    expect(candidate).toEqual(before);
    expect(()=>preparePage(candidate,request(["not-in-manifest"]),[],moment(input.state),moment(input.state))).toThrowError(expect.objectContaining({code:"PAGE_SCOPE"}));
    expect(()=>recordDelivery(candidate,[],["not-in-manifest"])).toThrowError(expect.objectContaining({code:"DELIVERY_SCOPE"}));
  });
  it("rejects changed revisions, altered bodies, and expiry on either side of a page", () => {
    const {candidate,input} = setup(2), ids=candidate.packet.deferred_ids.slice(0,1), changed=structuredClone(input.state);
    changed.revision++;
    expect(()=>preparePage(candidate,request(ids),[],moment(input.state),moment(changed))).toThrowError(expect.objectContaining({code:"PACKET_STALE"}));
    const expired = new Date(candidate.packet.context.expires_at);
    expect(()=>preparePage(candidate,request(ids),[],moment(input.state),moment(input.state,expired))).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    const tampered=structuredClone(candidate); tampered.packet.deferred_ids.pop();
    expect(()=>checkConsumption(tampered,input.state,now(),[])).toThrowError(expect.objectContaining({code:"PACKET_MISMATCH"}));
    expect(checkConsumption(candidate,input.state,now(),[]).remainingIds).toEqual(candidate.packet.deferred_ids);
  });
  it("does not advance the ledger after a failed page or accept changed bodies without a revision bump", () => {
    const {candidate,input} = setup(2), ids=candidate.packet.deferred_ids, ledger: string[]=[];
    const changed=structuredClone(input.state); changed.objects[0].version++;
    expect(()=>preparePage(candidate,request(ids.slice(0,1)),ledger,moment(input.state),moment(changed))).toThrowError(expect.objectContaining({code:"PACKET_STALE"}));
    expect(ledger).toEqual([]);
    expect(()=>preparePage(candidate,request(ids.slice(0,1)),ledger,moment(input.state,new Date(candidate.packet.context.expires_at)),moment(input.state))).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    expect(()=>preparePage(candidate,{...request(ids.slice(0,1)),packet_id:"another"},ledger,moment(input.state),moment(input.state))).toThrowError(expect.objectContaining({code:"PACKET_MISMATCH"}));
  });
  it("preserves delivery idempotency, requires all manifest IDs, and rejects tampered primary bodies", () => {
    const {candidate,input}=setup(10_000_000), ids=candidate.packet.objects.map(o=>o.id);
    const ledger=recordDelivery(candidate,[],ids);
    expect(recordDelivery(candidate,ledger,ids)).toEqual(ledger);
    expect(checkConsumption(candidate,input.state,now(),ledger).remainingIds).toEqual([]);
    const broken=structuredClone(candidate); broken.packet.objects[0].version++;
    expect(()=>checkConsumption(broken,input.state,now(),ledger)).toThrowError(expect.objectContaining({code:"PACKET_MISMATCH"}));
    expect(()=>checkConsumption(candidate,input.state,now(),["forged-id"])).toThrowError(expect.objectContaining({code:"DELIVERY_SCOPE"}));
  });
  it("rejects a page crossing selected fact expiry even when the state revision does not change", () => {
    const state=structuredClone(base), fact=state.objects.find(o=>o.id==="fact-cairo-luxor");
    if (!fact || fact.type!=="ExternalFact") throw new Error("synthetic fact missing");
    fact.expires_at="2030-01-01T00:00:00.001Z";
    const assembly=assembleContextSnapshot(state,"E",task.target_ids,now());
    const candidate=buildPacketCandidate({request:{runtime_contract_version:"0.1.0",turn_id:"turn-test",task_key:"E",body_budget_bytes:2},packetId:"packet-test",task,pending,assembly,state,now:now(),recoveredInput:false,saveUnacknowledged:false});
    const ledger: string[]=[], requested=candidate.packet.deferred_ids.slice(0,1);
    expect(candidate.packet.context.expires_at).toBe("2030-01-01T00:00:00.001000Z");
    expect(()=>preparePage(candidate,request(requested),ledger,moment(state),moment(state,new Date("2030-01-01T00:00:00.001Z")))).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
    expect(ledger).toEqual([]);
    expect(()=>checkConsumption(candidate,state,new Date("2030-01-01T00:00:00.001Z"),ledger)).toThrowError(expect.objectContaining({code:"PACKET_EXPIRED"}));
  });
  it("shows why untrusted client delivery claims cannot be passed as the host ledger", () => {
    const {candidate,input}=setup(2), forged=candidate.packet.deferred_ids;
    expect(candidate.packet.objects).toEqual([]);
    // This pure function compares the supplied values; it cannot authenticate who supplied them.
    expect(checkConsumption(candidate,input.state,now(),forged).remainingIds).toEqual([]);
    expect(checkConsumption(candidate,input.state,now(),[]).remainingIds).toEqual(forged);
    expect(preparePage(candidate,request(forged.slice(0,1)),[],moment(input.state),moment(input.state)).remaining_ids.length).toBe(forged.length-1);
    // Preparing a response did not deliver anything or mutate the authoritative host ledger.
    expect(checkConsumption(candidate,input.state,now(),[]).remainingIds).toEqual(forged);
  });
  it("exposes the lost-update risk when concurrent pages use an old ledger snapshot", () => {
    const {candidate,input}=setup(2), ids=candidate.packet.deferred_ids;
    const pageA=recordDelivery(candidate,[],[ids[0]]), pageB=recordDelivery(candidate,[],[ids[1]]);
    expect(checkConsumption(candidate,input.state,now(),pageB).remainingIds).toContain(ids[0]);
    const merged=recordDelivery(candidate,pageA,[ids[1]]);
    expect(merged).toEqual([ids[0],ids[1]].sort());
    expect(checkConsumption(candidate,input.state,now(),merged).remainingIds).not.toContain(ids[0]);
    expect(checkConsumption(candidate,input.state,now(),merged).remainingIds).not.toContain(ids[1]);
  });
  it("compares a Packet to its original turn and task without claiming owner authorization", () => {
    const {candidate}=setup(2);
    const turn: DecisionContextContracts["turn"]={runtime_contract_version:"0.1.0",runtime_id:"runtime-test",turn_id:"turn-test",revision:0,tasks:[structuredClone(task)],focus_keys:["E"],checkpoint_ack:null};
    expect(()=>checkPacketTurn(candidate,turn)).not.toThrow();
    expect(()=>checkPacketTurn(candidate,{...turn,turn_id:"another-turn"})).toThrowError(expect.objectContaining({code:"TASK_MISMATCH"}));
    const missing=structuredClone(turn); missing.tasks[0].task_key="another-task"; missing.focus_keys=["another-task"];
    expect(()=>checkPacketTurn(candidate,missing)).toThrowError(expect.objectContaining({code:"TASK_MISMATCH"}));
    const altered=structuredClone(turn); altered.tasks[0].question="另一解释";
    expect(()=>checkPacketTurn(candidate,altered)).toThrowError(expect.objectContaining({code:"TASK_MISMATCH"}));
    const duplicated=structuredClone(turn); duplicated.tasks.push(structuredClone(task));
    expect(()=>checkPacketTurn(candidate,duplicated)).toThrowError(expect.objectContaining({code:"TASK_MISMATCH"}));
  });
  it("requires explicit host scene status and preserves restored/save warnings", () => {
    const {input}=setup(2);
    const restored=buildPacketCandidate({...input,recoveredInput:true,saveUnacknowledged:true});
    expect(restored.packet.warnings).toEqual(expect.arrayContaining(["restored_input_read_only_repreview_required","scene_save_unacknowledged_business_state_is_separate"]));
    expect(()=>buildPacketCandidate({...input,recoveredInput:undefined as unknown as boolean})).toThrowError(expect.objectContaining({code:"SCENE_STATUS_UNAVAILABLE"}));
  });
  it("rejects mismatched tasks and unverified or altered snapshot contents", () => {
    const {input} = setup(2), wrong=structuredClone(input); wrong.task.task_key="different";
    expect(()=>buildPacketCandidate(wrong)).toThrowError(expect.objectContaining({code:"TASK_MISMATCH"}));
    const modified=structuredClone(input); modified.assembly.objects[0].version++;
    expect(()=>buildPacketCandidate(modified)).toThrow();
    const modifiedState=structuredClone(input); modifiedState.state.objects[0].version++;
    expect(()=>buildPacketCandidate(modifiedState)).toThrowError(expect.objectContaining({code:"PACKET_STALE"}));
  });
});
