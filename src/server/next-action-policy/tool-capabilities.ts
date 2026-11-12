import {z} from "zod";
import {canonicalJson,digest} from "../trip-state/command-json";

export type ToolResultStatus="result"|"partial"|"empty"|"timeout"|"error"|"no_service";
type ToolKind="query"|"calculate";
type FactDraft={id_suffix:string;subject_ids:string[];scope:{kind:"trip"|"entity"|"skeleton"|"traveler";ids:string[]}|{kind:"date";ids:[];start:string;end:string};
  query:{date:string|null;parameters:Array<{name:string;value:string|number|boolean|null}>};valid_for:{start:string;end:string};missing_fields:string[];
  value:null|{kind:"transport";from_id:string;to_id:string;departure:string|null;arrival:string|null;duration_minutes:number|null;service_exists:boolean|null}|
  {kind:"cost";amount_minor:number;currency:string;people:number;category:string;item_key:string}|{kind:"condition";value:boolean|null;description:string}};
export type PreparedToolCall={capability_id:string;kind:ToolKind;effect:"read_only";provider_ref:string;timeout_ms:number;query_digest:string;
  arguments:Record<string,unknown>;fact_level:"date_specific"|"deterministic_calculation"};
export type ToolExecutionResult={status:ToolResultStatus;synthetic:true;source_ref:string;observed_at:string;expires_at:string|null;
  missing_fields:string[];facts:FactDraft[];payload:unknown;error:{code:string;message:string}|null};

export class NapCapabilityError extends Error{
  constructor(readonly code:"UNREGISTERED"|"INVALID_ARGUMENTS"|"PROVIDER_RESPONSE"){
    super(`NAP capability: ${code}`);this.name="NapCapabilityError";
  }
}
const fail=(code:NapCapabilityError["code"]):never=>{throw new NapCapabilityError(code);};
const id=z.string().min(1),date=z.iso.date(),timestamp=z.iso.datetime({offset:true});
const egyptMvpTripCostCategories=["experience","food","lodging","transport"] as const;
const transportArguments=z.strictObject({from_id:id,to_id:id,date,passengers:z.number().int().min(1).max(20)});
const costArguments=z.strictObject({currency:z.string().regex(/^[A-Z]{3}$/),people:z.number().int().min(1).max(20),
  required_categories:z.array(id).min(1).max(32),items:z.array(z.strictObject({item_key:id,amount_minor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),category:id})).max(128)});
const scope=z.union([z.strictObject({kind:z.enum(["trip","entity","skeleton","traveler"]),ids:z.array(id)}),
  z.strictObject({kind:z.literal("date"),ids:z.tuple([]),start:date,end:date})]);
const value=z.union([z.null(),z.strictObject({kind:z.literal("transport"),from_id:id,to_id:id,departure:timestamp.nullable(),arrival:timestamp.nullable(),
  duration_minutes:z.number().int().nonnegative().nullable(),service_exists:z.boolean().nullable()}),
z.strictObject({kind:z.literal("cost"),amount_minor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),currency:z.string().regex(/^[A-Z]{3}$/),
  people:z.number().int().min(1),category:id,item_key:id}),z.strictObject({kind:z.literal("condition"),value:z.boolean().nullable(),description:id})]);
const fact=z.strictObject({id_suffix:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/),subject_ids:z.array(id),scope,
  query:z.strictObject({date:date.nullable(),parameters:z.array(z.strictObject({name:id,value:z.union([z.string(),z.number(),z.boolean(),z.null()])}))}),
  valid_for:z.strictObject({start:date,end:date}),missing_fields:z.array(id),value});
const providerResult=z.strictObject({synthetic:z.literal(true),status:z.enum(["result","partial","empty","error","no_service"]),source_ref:id,
  observed_at:timestamp,expires_at:timestamp.nullable(),missing_fields:z.array(id),facts:z.array(fact).max(16)});

export type CapabilityRegistry={
  describe():Array<{capability_id:string;kind:ToolKind;effect:"read_only";provider_ref:string;timeout_ms:number;fact_level:string;input_schema:unknown}>;
  prepare(kind:ToolKind,capabilityId:string|null,args:Record<string,unknown>):PreparedToolCall;
  execute(call:PreparedToolCall):Promise<ToolExecutionResult>;
};

export function createEgyptMvpCapabilityRegistry(options:{transportEndpoint:string;timeoutMs?:number;fetchImpl?:typeof fetch;now?:()=>Date}):CapabilityRegistry{
  const timeoutMs=options.timeoutMs??3_000,fetchImpl=options.fetchImpl??fetch,now=options.now??(()=>new Date());
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw new Error("Invalid capability timeout");
  const definitions=[
    {capability_id:"egypt-transport-synthetic-v1",kind:"query" as const,effect:"read_only" as const,provider_ref:"antu-synthetic-egypt-transport",
      timeout_ms:timeoutMs,fact_level:"date_specific" as const,input_schema:{type:"object",required:["from_id","to_id","date","passengers"],additionalProperties:false}},
    {capability_id:"egypt-cost-subtotal-v1",kind:"calculate" as const,effect:"read_only" as const,provider_ref:"antu-deterministic-calculator",
      timeout_ms:timeoutMs,fact_level:"deterministic_calculation" as const,input_schema:{type:"object",required:["currency","people","required_categories","items"],additionalProperties:false}},
  ];
  function prepare(kind:ToolKind,capabilityId:string|null,args:Record<string,unknown>):PreparedToolCall{
    const definition=definitions.find(value=>value.capability_id===capabilityId&&value.kind===kind);if(!definition)return fail("UNREGISTERED");
    const parsed=(kind==="query"?transportArguments:costArguments).safeParse(structuredClone(args));if(!parsed.success)return fail("INVALID_ARGUMENTS");
    const normalized=JSON.parse(canonicalJson(parsed.data)) as Record<string,unknown>;
    return {...definition,arguments:normalized,query_digest:digest({capability_id:definition.capability_id,arguments:normalized})};
  }
  async function execute(call:PreparedToolCall):Promise<ToolExecutionResult>{
    const expected=definitions.find(value=>value.capability_id===call.capability_id&&value.kind===call.kind&&value.provider_ref===call.provider_ref);
    if(!expected||call.query_digest!==digest({capability_id:call.capability_id,arguments:call.arguments}))return fail("UNREGISTERED");
    if(call.kind==="calculate"){
      const args=costArguments.parse(call.arguments),covered=[...new Set(args.items.map(item=>item.category))].sort(),missing=egyptMvpTripCostCategories.filter(category=>!covered.includes(category));
      const amount=args.items.reduce((sum,item)=>sum+item.amount_minor,0);if(!Number.isSafeInteger(amount))return fail("INVALID_ARGUMENTS");
      return {status:"partial",synthetic:true,source_ref:"deterministic-cost-subtotal:v1",observed_at:now().toISOString(),expires_at:null,
        missing_fields:missing,facts:[],payload:{amount_minor:amount,currency:args.currency,people:args.people,covered_categories:covered,missing_categories:missing,
          coverage_scope:"known_items_only",unknown_parts:["unlisted_trip_costs"],is_full_trip_total:false},error:null};
    }
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),call.timeout_ms);timer.unref();
    try{
      const response=await fetchImpl(options.transportEndpoint,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
        body:canonicalJson(call.arguments),signal:controller.signal});
      if(!response.ok)return {status:"error",synthetic:true,source_ref:call.provider_ref,observed_at:now().toISOString(),expires_at:null,
        missing_fields:[],facts:[],payload:null,error:{code:`HTTP_${response.status}`,message:"Synthetic transport provider failed"}};
      const parsed=providerResult.safeParse(await response.json());if(!parsed.success)return fail("PROVIDER_RESPONSE");
      const args=transportArguments.parse(call.arguments),body=parsed.data;
      if((body.status==="result"&&!body.facts.length)||(["empty","error"].includes(body.status)&&body.facts.length)||
        (body.facts.length>0&&body.expires_at===null)||
        (body.status==="no_service"&&!body.facts.some(item=>item.value?.kind==="transport"&&item.value.service_exists===false))||
        body.expires_at!==null&&Date.parse(body.expires_at)<=Date.parse(body.observed_at)||body.facts.some(item=>item.query.date!==args.date||
          item.scope.kind!=="date"||item.scope.start>args.date||item.scope.end<args.date||item.value?.kind==="transport"&&
          (item.value.from_id!==args.from_id||item.value.to_id!==args.to_id)))return fail("PROVIDER_RESPONSE");
      return {...body,payload:{fact_count:body.facts.length},error:body.status==="error"?{code:"PROVIDER_ERROR",message:"Synthetic provider returned error"}:null};
    }catch(error){
      if(error instanceof NapCapabilityError)throw error;
      const timeout=error instanceof Error&&error.name==="AbortError";
      return {status:timeout?"timeout":"error",synthetic:true,source_ref:call.provider_ref,observed_at:now().toISOString(),expires_at:null,
        missing_fields:[],facts:[],payload:null,error:{code:timeout?"TIMEOUT":"NETWORK_ERROR",message:timeout?"Synthetic transport query timed out":"Synthetic transport query failed"}};
    }finally{clearTimeout(timer);}
  }
  return {describe:()=>structuredClone(definitions),prepare,execute};
}
