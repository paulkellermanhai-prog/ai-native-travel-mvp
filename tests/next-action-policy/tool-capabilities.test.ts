import http from "node:http";
import {once} from "node:events";
import {afterEach,describe,expect,it} from "vitest";
import {createEgyptMvpCapabilityRegistry,NapCapabilityError} from "../../src/server/next-action-policy/tool-capabilities";

const servers:http.Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});

async function endpoint(body:unknown,delayMs=0){
  const server=http.createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk as Uint8Array));
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({date:"2030-11-14",from_id:"luxor",passengers:1,to_id:"aswan"});
    if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));
    response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(body));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");servers.push(server);
  const address=server.address();if(!address||typeof address==="string")throw new Error("missing socket");
  return `http://127.0.0.1:${address.port}/synthetic/transport`;
}

const transportArguments={from_id:"luxor",to_id:"aswan",date:"2030-11-14",passengers:1};
const transportFact=(service_exists:boolean)=>({id_suffix:"route",subject_ids:["luxor","aswan"],scope:{kind:"date",ids:[] as [],start:"2030-11-14",end:"2030-11-14"},
  query:{date:"2030-11-14",parameters:[]},valid_for:{start:"2030-11-14",end:"2030-11-14"},missing_fields:[],
  value:{kind:"transport",from_id:"luxor",to_id:"aswan",departure:null,arrival:null,duration_minutes:service_exists?180:null,service_exists}});

describe("E04-05 trusted Egypt MVP capability registry",()=>{
  it("calls the registered synthetic transport provider over real local HTTP",async()=>{
    const transportEndpoint=await endpoint({synthetic:true,status:"result",source_ref:"synthetic-egypt-dataset:v1",observed_at:"2030-11-01T00:00:00Z",
      expires_at:"2030-11-02T00:00:00Z",missing_fields:[],facts:[{id_suffix:"route",subject_ids:["luxor","aswan"],
        scope:{kind:"date",ids:[],start:"2030-11-14",end:"2030-11-14"},query:{date:"2030-11-14",parameters:[]},
        valid_for:{start:"2030-11-14",end:"2030-11-14"},missing_fields:[],value:{kind:"transport",from_id:"luxor",to_id:"aswan",
          departure:"2030-11-14T08:00:00Z",arrival:"2030-11-14T11:00:00Z",duration_minutes:180,service_exists:true}}]});
    const registry=createEgyptMvpCapabilityRegistry({transportEndpoint,timeoutMs:1_000});
    const prepared=registry.prepare("query","egypt-transport-synthetic-v1",transportArguments),result=await registry.execute(prepared);
    expect(prepared).toMatchObject({effect:"read_only",provider_ref:"antu-synthetic-egypt-transport",arguments:transportArguments});
    expect(result).toMatchObject({status:"result",synthetic:true,source_ref:"synthetic-egypt-dataset:v1",facts:[{value:{duration_minutes:180}}]});
  });

  it("keeps result, partial, empty, timeout, error and no_service distinct",async()=>{
    for(const status of ["result","partial","empty","error","no_service"] as const){
      const registry=createEgyptMvpCapabilityRegistry({transportEndpoint:await endpoint({synthetic:true,status,source_ref:"synthetic-status",
        observed_at:"2030-11-01T00:00:00Z",expires_at:status==="result"||status==="no_service"?"2030-11-02T00:00:00Z":null,
        missing_fields:status==="partial"?["lodging","food"]:[],
        facts:status==="result"?[transportFact(true)]:status==="no_service"?[transportFact(false)]:[]}),timeoutMs:1_000});
      expect((await registry.execute(registry.prepare("query","egypt-transport-synthetic-v1",transportArguments))).status).toBe(status);
    }
    const timeout=createEgyptMvpCapabilityRegistry({transportEndpoint:await endpoint({},100),timeoutMs:10});
    expect(await timeout.execute(timeout.prepare("query","egypt-transport-synthetic-v1",transportArguments))).toMatchObject({status:"timeout",facts:[]});
  });

  it("calculates only covered cost categories and reports missing budget categories",async()=>{
    const registry=createEgyptMvpCapabilityRegistry({transportEndpoint:"http://127.0.0.1:1",timeoutMs:100});
    const prepared=registry.prepare("calculate","egypt-cost-subtotal-v1",{currency:"EGP",people:1,required_categories:["transport","experience","lodging","food"],items:[
      {item_key:"rail",amount_minor:12000,category:"transport"},{item_key:"temple",amount_minor:8000,category:"experience"},
    ]});
    expect(await registry.execute(prepared)).toMatchObject({status:"partial",synthetic:true,payload:{amount_minor:20000,currency:"EGP",
      covered_categories:["experience","transport"],missing_categories:["food","lodging"],is_full_trip_total:false}});
  });

  it("rejects model-selected capabilities, kinds and malformed parameters outside the host registry",()=>{
    const registry=createEgyptMvpCapabilityRegistry({transportEndpoint:"http://127.0.0.1:1",timeoutMs:100});
    expect(()=>registry.prepare("query","model.dynamic.tool",transportArguments)).toThrow(NapCapabilityError);
    expect(()=>registry.prepare("calculate","egypt-transport-synthetic-v1",transportArguments)).toThrow(NapCapabilityError);
    expect(()=>registry.prepare("query","egypt-transport-synthetic-v1",{...transportArguments,url:"https://unregistered.invalid"})).toThrow(NapCapabilityError);
  });
});
