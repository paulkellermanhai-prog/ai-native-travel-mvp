import {validateNapMessage} from "./contracts";
import {validatePlanInternalIntegrity} from "./plan-integrity";

type Basis={packet_id:string;task_key:string;state_revision:number};
type Step={step_id:string;kind:string;capability_id:string|null};
type Plan={decision_id:string;runtime_id:string;basis:Basis[];actions:Array<{action_id:string;task_key:string;packet_id:string;steps:Step[]}>};
type RecordValue={decision_id:string;action_id:string;phase:string;plan_digest:string};
type Completion={decision_id:string;action_id:string;step_id:string;query_digest:string;basis_state_revision:number;provider_ref:string};
type Invocation={decision_id:string;runtime_id:string;action_id:string;step_id:string;capability_id:string;provider_ref:string;query_digest:string;plan_digest:string;basis_state_revision:number};

export class NapCompletionBindingError extends Error{
  constructor(){super("NAP tool completion: BINDING");this.name="NapCompletionBindingError";}
}
const fail=():never=>{throw new NapCompletionBindingError();};
const keys=["decision_id","runtime_id","action_id","step_id","capability_id","provider_ref","query_digest","plan_digest","basis_state_revision"];
const id=/^[A-Za-z][A-Za-z0-9_-]{0,95}$/,hash=/^[0-9a-f]{64}$/;

/** Structural relationship only. The caller must supply host-read records and separately prove origin/currentness. */
export function validateCompletionBinding(planValue:unknown,recordValue:unknown,completionValue:unknown,invocationValue:unknown):void{
  validatePlanInternalIntegrity(planValue);validateNapMessage("ActionRecord",recordValue);validateNapMessage("ToolCompletion",completionValue);
  if(!invocationValue||typeof invocationValue!=="object"||Array.isArray(invocationValue))return fail();
  const supplied=invocationValue as Record<string,unknown>;
  if(Object.keys(supplied).length!==keys.length||keys.some(key=>!Object.hasOwn(supplied,key)))return fail();
  for(const key of ["decision_id","runtime_id","action_id","step_id","capability_id"])
    if(typeof supplied[key]!=="string"||!id.test(supplied[key]))return fail();
  for(const key of ["query_digest","plan_digest"])if(typeof supplied[key]!=="string"||!hash.test(supplied[key]))return fail();
  if(typeof supplied.provider_ref!=="string"||supplied.provider_ref.length===0||!Number.isSafeInteger(supplied.basis_state_revision)||Number(supplied.basis_state_revision)<0)return fail();
  const plan=planValue as Plan,record=recordValue as RecordValue,completion=completionValue as Completion,invocation=supplied as unknown as Invocation;
  if(plan.decision_id!==invocation.decision_id||plan.runtime_id!==invocation.runtime_id||record.decision_id!==invocation.decision_id||
    completion.decision_id!==invocation.decision_id||record.action_id!==invocation.action_id||completion.action_id!==invocation.action_id||
    completion.step_id!==invocation.step_id||record.phase!=="running"||record.plan_digest!==invocation.plan_digest||
    completion.query_digest!==invocation.query_digest||completion.provider_ref!==invocation.provider_ref||
    completion.basis_state_revision!==invocation.basis_state_revision)return fail();
  const action=plan.actions.find(value=>value.action_id===invocation.action_id),step=action?.steps.find(value=>value.step_id===invocation.step_id);
  const basis=plan.basis.find(value=>value.packet_id===action?.packet_id&&value.task_key===action?.task_key);
  if(!step||!["query","calculate"].includes(step.kind)||step.capability_id!==invocation.capability_id||!basis||basis.state_revision!==invocation.basis_state_revision)return fail();
}
