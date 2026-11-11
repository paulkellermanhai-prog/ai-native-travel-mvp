import fs from "node:fs";
import {describe,expect,it} from "vitest";
import type {DecisionContextContracts} from "../../src/server/decision-context/contracts";
import {decide,reevaluate,validateDecisionPlanHostEligibility,type SemanticAction,type SemanticAdapter,type SemanticDecision} from "../../src/server/next-action-policy/decision-engine";
import type {TrustedDecisionRequest} from "../../src/server/next-action-policy/trusted-packet-source";

const rows=JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json","utf8")) as Array<{schema:string;value:unknown}>;
const sourcePacket=rows.find(row=>row.schema==="packet")!.value as DecisionContextContracts["packet"];
const changeRequest=(rows.find(row=>row.schema==="change")!.value as DecisionContextContracts["change"])["request"];
const now=new Date("2029-12-31T00:00:00Z");
const request=(packet=sourcePacket,decisionId="decision"):TrustedDecisionRequest=>({nap_contract_version:"0.1.0",decision_id:decisionId,runtime_id:"runtime",
  trigger:{kind:"user_event",reference:packet.pending_input.event.reference},packets:[structuredClone(packet)]});
const response=(packet=sourcePacket,text="已根据当前依据回应"):SemanticDecision["response"]=>({request_ids:[packet.task.task_key],disposition:"answered",text,
  evidence_refs:[{id:"constraint-nights",version:packet.objects.find(object=>object.id==="constraint-nights")!.version,kind:"object"}]});
const deliver=(packet=sourcePacket,patch:Partial<SemanticAction>={}):SemanticAction=>({action_id:"action-deliver",task_key:packet.task.task_key,packet_id:packet.packet_id,
  request_ids:[packet.task.task_key],goal:"D3",preferred_attention:"primary",reason:"说明阿斯旺与转场取舍",rank:100,
  steps:[{step_id:"step-deliver",kind:"deliver",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:"阿斯旺增加体验，也增加转场；未覆盖的疲劳保持未知。"}],
  required_object_ids:["constraint-nights"],reentry_candidate_id:null,...patch});
const fixed=(value:SemanticDecision):SemanticAdapter=>({assess:async()=>structuredClone(value)});

describe("E04-02 deterministic orchestration fixtures",()=>{
  it("S03 runs G01 → G03 → G02 → G03/G04 for the Aswan transfer concern",async()=>{
    const packet=structuredClone(sourcePacket);packet.task.question="阿斯旺值得加吗，我担心转场";
    const prepare:SemanticAction={...deliver(packet),action_id:"action-prepare",preferred_attention:"prepare",goal:"D2",rank:90,
      reason:"核对已有合成交通依据",required_object_ids:["fact-cairo-luxor"],
      steps:[{step_id:"step-read",kind:"read",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:null}]};
    const plan=await decide(request(packet),fixed({response:response(packet),candidates:[prepare,deliver(packet)]}),now);
    expect(plan.actions.map(action=>[action.action_id,action.attention,action.goal])).toEqual([
      ["action-deliver","primary","D3"],["action-prepare","prepare","D2"],
    ]);
    expect(plan.basis[0]).toEqual({packet_id:packet.packet_id,turn_id:packet.turn_id,task_key:packet.task.task_key,
      state_revision:packet.context.state_revision,snapshot_digest:packet.snapshot_digest,expires_at:packet.context.expires_at});
  });

  it("N05/C12 keeps conflicting transport facts unresolved and rejects a change candidate",async()=>{
    const packet=structuredClone(sourcePacket),issue=packet.objects.find(object=>object.type==="OpenIssue");
    if(!issue||issue.type!=="OpenIssue")throw new Error("OpenIssue fixture missing");
    issue.issue_kind="conflict";issue.status="open";
    const change:SemanticAction={...deliver(packet),action_id:"action-change",rank:200,reason:"错误地把冲突事实当成已解决",
      steps:[{step_id:"step-change",kind:"change",depends_on:[],capability_id:null,arguments:{},change_request:changeRequest,user_message:null}]};
    const safe=deliver(packet,{reason:"列明冲突与不能确认的部分"});
    const plan=await decide(request(packet),fixed({response:response(packet,"两份可靠来源相互冲突，当前不能确认班次事实。"),candidates:[change,safe]}),now);
    expect(plan.actions).toHaveLength(1);expect(plan.actions[0].action_id).toBe("action-deliver");
    expect(plan.actions[0].steps.every(step=>step.kind!=="change")).toBe(true);
  });

  it("F04-A keeps a hypothetical branch read-only",async()=>{
    const packet=structuredClone(sourcePacket);packet.task.branch="hypothetical";
    const change:SemanticAction={...deliver(packet),action_id:"action-change",rank:200,
      steps:[{step_id:"step-change",kind:"change",depends_on:[],capability_id:null,arguments:{},change_request:changeRequest,user_message:null}]};
    const plan=await decide(request(packet),fixed({response:response(packet),candidates:[change,deliver(packet)]}),now);
    expect(plan.actions.map(action=>action.action_id)).toEqual(["action-deliver"]);
    expect(plan.actions.flatMap(action=>action.steps).every(step=>step.kind!=="change")).toBe(true);
  });

  it("X03/X05 allows renewed exploration without illegally reentering a rejected candidate",async()=>{
    const packet=structuredClone(sourcePacket),candidate=packet.objects.find(object=>object.type==="Candidate");
    if(!candidate||candidate.type!=="Candidate")throw new Error("Candidate fixture missing");
    candidate.status="excluded";candidate.exclusion_reason="用户先前拒绝";
    const reentry=deliver(packet,{action_id:"action-reentry",rank:200,reentry_candidate_id:candidate.id});
    const explore=deliver(packet,{reason:"响应用户主动重开的只读探索"});
    const plan=await decide(request(packet),fixed({response:response(packet),candidates:[reentry,explore]}),now);
    expect(plan.actions.map(action=>action.action_id)).toEqual(["action-deliver"]);
    expect(plan.actions[0].steps.every(step=>step.kind==="deliver")).toBe(true);
  });

  it("J12 can directly answer without manufacturing an extra recommendation",async()=>{
    const plan=await decide(request(),fixed({response:response(),candidates:[]}),now);
    expect(plan.response.disposition).toBe("answered");expect(plan.actions).toEqual([]);
  });

  it("uses only a genuinely blocking clarification when evidence is insufficient",async()=>{
    const ask=deliver(sourcePacket,{action_id:"action-ask",goal:"D4",reason:"缺少必要的起止城市",
      steps:[{step_id:"step-ask",kind:"ask",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:"你的起点和终点城市是哪里？"}]});
    const plan=await decide(request(),fixed({response:{...response(),disposition:"clarification",text:"只缺一个会改变转场结论的条件。"},candidates:[ask]}),now);
    expect(plan.actions).toMatchObject([{goal:"D4",steps:[{kind:"ask"}]}]);
  });

  it("G05 reruns semantics for a newly trusted event instead of carrying old actions forward",async()=>{
    const firstRequest=request(),first=await decide(firstRequest,fixed({response:response(),candidates:[deliver()]}),now);
    const packet=structuredClone(sourcePacket);packet.pending_input.event.reference="host-interaction:new";
    const next=request(packet,"decision-next"),adapter:SemanticAdapter={assess:async()=>({response:response(packet,"新请求只需直接回答"),candidates:[]})};
    const second=await reevaluate(first,firstRequest,next,adapter,now);
    expect(second.decision_id).toBe("decision-next");expect(second.actions).toEqual([]);
  });

  it("G05 rejects a new decision id when the trusted event did not change",async()=>{
    const firstRequest=request(),first=await decide(firstRequest,fixed({response:response(),candidates:[deliver()]}),now);
    await expect(reevaluate(first,firstRequest,request(sourcePacket,"decision-renamed"),fixed({response:response(),candidates:[]}),now))
      .rejects.toMatchObject({code:"INVALID_REQUEST"});
  });

  it("G02 prevents prepare attention from carrying user-facing or business side effects",async()=>{
    const unsafe=deliver(sourcePacket,{action_id:"action-unsafe-prepare",preferred_attention:"prepare",rank:200,
      steps:[{step_id:"step-unsafe",kind:"change",depends_on:[],capability_id:null,arguments:{},change_request:changeRequest,user_message:null}]});
    const plan=await decide(request(),fixed({response:response(),candidates:[unsafe]}),now);
    expect(plan.actions).toEqual([]);
  });

  it("returns explicit errors for stale packets and invalid semantic evidence",async()=>{
    await expect(decide(request(),fixed({response:response(),candidates:[]}),new Date("2031-01-01T00:00:00Z")))
      .rejects.toMatchObject({code:"NO_CURRENT_PACKET"});
    const bad={...response(),evidence_refs:[{id:"missing",version:1,kind:"object" as const}]};
    await expect(decide(request(),fixed({response:bad,candidates:[]}),now)).rejects.toMatchObject({code:"SEMANTIC_OUTPUT"});
  });

  it("accepts only evidence references proved by the trusted Packet",async()=>{
    const trustedSource={...response(),evidence_refs:[{id:sourcePacket.pending_input.event.reference,version:null,kind:"source" as const}]};
    await expect(decide(request(),fixed({response:trustedSource,candidates:[]}),now)).resolves.toMatchObject({response:trustedSource});
    for(const evidence_refs of [
      [{id:"host-interaction:forged",version:null,kind:"source" as const}],
      [{id:"delivery-forged",version:null,kind:"delivery" as const}],
      [{id:"constraint-nights",version:999,kind:"object" as const}],
    ])await expect(decide(request(),fixed({response:{...response(),evidence_refs},candidates:[]}),now))
      .rejects.toMatchObject({code:"SEMANTIC_OUTPUT"});
  });

  it("derives excluded Candidate reentry from the change command instead of trusting the adapter field",async()=>{
    const packet=structuredClone(sourcePacket),candidate=packet.objects.find(object=>object.type==="Candidate");
    if(!candidate||candidate.type!=="Candidate")throw new Error("Candidate fixture missing");
    const event=packet.pending_input.event,change=structuredClone(changeRequest);
    change.expected_revision=packet.context.state_revision;
    change.input={kind:event.entry as typeof change.input.kind,reference:event.reference,text:event.text,target_ids:[...packet.task.target_ids]};
    change.commands=[{op:"decide_candidate",id:candidate.id,value:"accept"}];
    const action=deliver(packet,{action_id:"action-candidate-change",rank:200,reentry_candidate_id:null,required_object_ids:[candidate.id],
      steps:[{step_id:"step-candidate-change",kind:"change",depends_on:[],capability_id:null,arguments:{},change_request:change,user_message:null}]});
    const legalRequest=request(packet,"decision-candidate-legal"),legal=await decide(legalRequest,fixed({response:response(packet),candidates:[action]}),now);
    expect(legal.actions).toHaveLength(1);
    const excludedRequest=structuredClone(legalRequest),excluded=excludedRequest.packets[0].objects.find(object=>object.id===candidate.id);
    if(!excluded||excluded.type!=="Candidate")throw new Error("Candidate fixture missing");
    excluded.status="excluded";excluded.exclusion_reason="用户已拒绝";
    await expect(decide(excludedRequest,fixed({response:response(excludedRequest.packets[0]),candidates:[action]}),now))
      .resolves.toMatchObject({actions:[]});
    expect(()=>validateDecisionPlanHostEligibility(excludedRequest,legal,now)).toThrow();
  });
});
