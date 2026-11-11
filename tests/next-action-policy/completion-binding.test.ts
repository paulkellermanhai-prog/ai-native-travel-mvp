import {describe,expect,it} from "vitest";
import {NapCompletionBindingError,validateCompletionBinding} from "../../src/server/next-action-policy/completion-binding";

const date="2030-01-01T00:00:00Z",snapshotDigest="a".repeat(64),planDigest="b".repeat(64),queryDigest="c".repeat(64);
const step={step_id:"step",kind:"query",depends_on:[],capability_id:"egypt-transport-synthetic-v1",arguments:{date:"2030-11-14"},change_request:null,user_message:null};
const action={action_id:"action",task_key:"task",packet_id:"packet",request_ids:["task"],goal:"D2",attention:"prepare",reason:"reason",steps:[step]};
const plan={nap_contract_version:"0.1.0",decision_id:"decision",runtime_id:"runtime",basis:[{packet_id:"packet",turn_id:"turn",task_key:"task",
  state_revision:4,snapshot_digest:snapshotDigest,expires_at:"2030-01-02T00:00:00Z"}],response:{request_ids:["task"],disposition:"answered",text:"Answer",evidence_refs:[]},actions:[action]};
const record={nap_contract_version:"0.1.0",decision_id:"decision",action_id:"action",phase:"running",plan_digest:planDigest,completed_step_ids:[],result_refs:[],
  error_ref:null,related_action_ids:[],updated_at:date};
const completion={nap_contract_version:"0.1.0",completion_id:"completion",decision_id:"decision",action_id:"action",step_id:"step",query_digest:queryDigest,
  basis_state_revision:4,result_status:"result",provider_ref:"provider",observed_at:date,expires_at:null,raw_result_ref:"result",validated_fact_ids:[],error:null};
const invocation={decision_id:"decision",runtime_id:"runtime",action_id:"action",step_id:"step",capability_id:"egypt-transport-synthetic-v1",
  provider_ref:"provider",query_digest:queryDigest,plan_digest:planDigest,basis_state_revision:4};

describe("E04-05 tool completion binding",()=>{
  it.each(["result","partial","empty","timeout","error","no_service"])("preserves %s as a distinct status",status=>{
    expect(()=>validateCompletionBinding(plan,record,{...completion,result_status:status},invocation)).not.toThrow();
  });
  it("rejects cross decision, action, step, query, provider, plan, revision and capability bindings",()=>{
    for(const changed of [{...invocation,decision_id:"other"},{...invocation,action_id:"other"},{...invocation,step_id:"other"},
      {...invocation,query_digest:"d".repeat(64)},{...invocation,provider_ref:"other"},{...invocation,plan_digest:"e".repeat(64)},
      {...invocation,basis_state_revision:5},{...invocation,capability_id:"other"}])
      expect(()=>validateCompletionBinding(plan,record,completion,changed)).toThrow(NapCompletionBindingError);
  });
  it("rejects non-tool steps and a stale action record",()=>{
    expect(()=>validateCompletionBinding(plan,{...record,phase:"stale"},completion,invocation)).toThrow(NapCompletionBindingError);
    const read={...plan,actions:[{...action,steps:[{...step,kind:"read",capability_id:null}]}]};
    expect(()=>validateCompletionBinding(read,record,completion,invocation)).toThrow(NapCompletionBindingError);
  });
  it("leaves authentication, currentness and duplicate completion handling to the host store",()=>{
    const historical={...completion,observed_at:"2000-01-01T00:00:00Z",expires_at:"2000-01-02T00:00:00Z"};
    expect(()=>validateCompletionBinding(plan,record,historical,invocation)).not.toThrow();
  });
});
