import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleContextSnapshot } from "../../../src/server/decision-context/context-assembly";
import { buildPacketCandidate, emptyDeliveryLedger, preparePage, recordDelivery } from "../../../src/server/decision-context/packet-core/packet";
import type { State } from "../../../src/server/trip-state/contracts.generated";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";

const dc=path.resolve("specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/90_可运行工程包");
const ts=path.resolve("specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包");
const python = `
import json
from datetime import datetime,timezone
from tripstate.fixtures import initial_state
from tripstate.engine import Store
from context_runtime.runtime import Runtime,Principal,size
now=datetime(2030,1,1,tzinfo=timezone.utc)
state=initial_state()
rows=[]
seed_store=Store(state,clock=lambda:now); seed_runtime=Runtime(seed_store); seed_principal=Principal('synthetic',(state['trip_id'],))
seed_task=dict(task_key='E',question='看看',kind='explore',target_ids=['skeleton-a'],branch='actual',relation='new',related_task_keys=[],certainty='explicit',evidence=[dict(start=0,end=2,quote='看看')],progress='open',progress_evidence=None)
seed_event=dict(event_id='event-1',entry='dialogue',text='看看',reference='synthetic',received_at='2030-01-01T00:00:00Z')
seed_turn=seed_runtime.open_turn(dict(runtime_contract_version='0.1.0',trip_id=state['trip_id'],expected_revision=state['revision'],event=seed_event,tasks=[seed_task],focus_keys=['E']),seed_principal)
full=seed_runtime.assemble(dict(runtime_contract_version='0.1.0',turn_id=seed_turn['turn_id'],task_key='E',body_budget_bytes=10000000),seed_principal)
full_size=size(sorted(full['objects'],key=lambda o:o['id']))
target_size=size([next(o for o in full['objects'] if o['id']=='skeleton-a')])
budgets=sorted(set([2,300,1000,10000000,target_size-1,target_size,target_size+1,full_size-1,full_size,full_size+1]))
for budget in budgets:
 store=Store(state,clock=lambda:now); r=Runtime(store); p=Principal('synthetic',(state['trip_id'],))
 task=dict(task_key='E',question='看看',kind='explore',target_ids=['skeleton-a'],branch='actual',relation='new',related_task_keys=[],certainty='explicit',evidence=[dict(start=0,end=2,quote='看看')],progress='open',progress_evidence=None)
 event=dict(event_id='event-1',entry='dialogue',text='看看',reference='synthetic',received_at='2030-01-01T00:00:00Z')
 turn=r.open_turn(dict(runtime_contract_version='0.1.0',trip_id=state['trip_id'],expected_revision=state['revision'],event=event,tasks=[task],focus_keys=['E']),p)
 packet=r.assemble(dict(runtime_contract_version='0.1.0',turn_id=turn['turn_id'],task_key='E',body_budget_bytes=budget),p)
 pages=[]
 for i in range(0,len(packet['deferred_ids']),2):
  ids=packet['deferred_ids'][i:i+2]
  page=r.page(dict(runtime_contract_version='0.1.0',packet_id=packet['packet_id'],object_ids=ids),p)
  pages.append(dict(objects=page['objects'],remaining=page['remaining_ids']))
 rows.append(dict(budget=budget,objects=packet['objects'],deferred=packet['deferred_ids'],coverage=packet['coverage'],support=packet['support'],pages=pages))
print(json.dumps(dict(state=state,rows=rows),ensure_ascii=False))
`;
describe("R6 packet budget and page reference",()=>{
 it("matches actual R6 runtime on identical synthetic state, target, budgets and page selections",()=>{
  const output=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["-B","-c",python],{encoding:"utf8",timeout:60000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1",PYTHONPATH:[dc,ts].join(path.delimiter)}})) as {state:State;rows:Array<{budget:number;objects:DecisionContextContracts["packet"]["objects"];deferred:string[];coverage:string;support:string;pages:Array<{objects:DecisionContextContracts["page"]["objects"];remaining:string[]}>}>};
  const task:DecisionContextContracts["packet"]["task"]={task_key:"E",question:"看看",kind:"explore",target_ids:["skeleton-a"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"看看"}],progress:"open",progress_evidence:null};
  const pending:DecisionContextContracts["packet"]["pending_input"]={event:{event_id:"event-1",entry:"dialogue",text:"看看",reference:"synthetic",received_at:"2030-01-01T00:00:00Z"},base_revision:output.state.revision,processing_status:"unprocessed",proposal_id:null,result_revision:output.state.revision,errors:[]};
  const now=new Date("2030-01-01T00:00:00Z"), assembly=assembleContextSnapshot(output.state,"E",task.target_ids,now);
  for(const row of output.rows){
   const candidate=buildPacketCandidate({request:{runtime_contract_version:"0.1.0",turn_id:"turn-test",task_key:"E",body_budget_bytes:row.budget},packetId:"packet-test",task,pending,assembly,state:output.state,now,recoveredInput:false,saveUnacknowledged:false});
   expect(candidate.packet.objects).toEqual(row.objects);
   expect(candidate.packet.deferred_ids).toEqual(row.deferred);
   expect(candidate.packet.coverage).toBe(row.coverage); expect(candidate.packet.support).toBe(row.support);
   let delivered=recordDelivery(candidate,emptyDeliveryLedger(candidate),candidate.packet.objects.map(o=>o.id));
   for(let i=0;i<row.pages.length;i++){
    const ids=row.deferred.slice(i*2,i*2+2);
    const page=preparePage(candidate,{runtime_contract_version:"0.1.0",packet_id:"packet-test",object_ids:ids},delivered,{state:output.state,now},{state:output.state,now});
    expect(page.objects).toEqual(row.pages[i].objects);
    expect(page.remaining_ids).toEqual(row.pages[i].remaining);
    delivered=recordDelivery(candidate,delivered,ids);
   }
  }
 }, 60000);
});
