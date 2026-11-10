import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { openIdentity } from "../../../src/server/auth/config";
import { createInternalHost, issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { openEvidenceHost, type ControlledInterpreter } from "../../../src/server/decision-context/host-runtime/evidence-host";
import { openEvidenceLifecycleAdapter } from "../../../src/server/decision-context/host-runtime/lifecycle-adapter";
import { createPr29HostHttpCandidate } from "../../../src/server/decision-context/http-adapter/pr29-host-candidate";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";
import type { State, TripStateContracts } from "../../../src/server/trip-state/contracts.generated";
import { installE03Candidate } from "../../../scripts/e03-candidate-installer.mjs";
import { base } from "../../support/bcg-fixtures";

const file=process.env.E03_PR29_WRITE_STORAGE_ENV_FILE;
if((process.env.CI||process.env.E03_PR29_REAL_TEST==="1")&&!file)throw new Error("PR29 write bridge test requires isolated E03_PR29_WRITE_STORAGE_ENV_FILE");
const config=file?JSON.parse(fs.readFileSync(file,"utf8")) as {
  migrationUrl:string;runtimeUrl:string;authUrl:string;lifecycleUrl:string;lifecycleRole:string;runtimeRole:string;database:string;
}:null;

describe.skipIf(!config)("E03-04 trusted write bridge with real Session, HTTP and PostgreSQL",()=>{
  it("keeps hypothetical work read-only and atomically applies, proposes, confirms and rejects stale authority",async()=>{
    const cfg=config!,url=new URL(cfg.migrationUrl);
    if(!/^antu_e02_test_[a-f0-9]+$/.test(cfg.database)||!/^antu_e02_runtime_[a-f0-9]+$/.test(cfg.runtimeRole)||
      !/^antu_e03_lifecycle_[a-f0-9]+$/.test(cfg.lifecycleRole)||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||
      decodeURIComponent(url.pathname.slice(1))!==cfg.database)throw new Error("Dedicated disposable local PG database required");

    const owner=new Client({connectionString:cfg.migrationUrl});await owner.connect();
    const resources:Array<{close:()=>Promise<void>}>=[];
    let server:http.Server|undefined,revokeDuringWrite=false,failLifecycleOnce=false,userId="",trip="",writeGuardCalls=0,lifecycleSyncCalls=0;
    try {
      const check=await owner.query("SELECT current_database() AS name,current_setting('server_version_num')::int AS version,to_regclass('public.\"HostEvidenceWorkspace\"') IS NULL AS clean");
      if(check.rows[0]?.name!==cfg.database||check.rows[0]?.version<170000||!check.rows[0]?.clean)throw new Error("Clean dedicated PG 17 required");
      await owner.query("BEGIN");
      try{await installE03Candidate(owner,{runtimeRole:cfg.runtimeRole,lifecycleRole:cfg.lifecycleRole});await owner.query("COMMIT");}
      catch(error){await owner.query("ROLLBACK");throw error;}

      const mounted:{adapter?:ReturnType<typeof createPr29HostHttpCandidate>}={};
      server=http.createServer((request,response)=>{if(!mounted.adapter){response.writeHead(503);response.end();return;}void mounted.adapter.handle(request,response);});
      server.listen(0,"127.0.0.1");await once(server,"listening");
      const address=server.address();if(!address||typeof address==="string")throw new Error("Missing test socket");
      const origin=`http://127.0.0.1:${address.port}`,secret=randomBytes(32).toString("hex");
      const env={...process.env,DATABASE_URL:cfg.runtimeUrl,AUTH_DATABASE_URL:cfg.authUrl,BETTER_AUTH_URL:origin,
        BETTER_AUTH_SECRET:randomBytes(32).toString("hex"),E11_IDEMPOTENCY_SECRET:randomBytes(32).toString("hex")};
      const identity=await openIdentity(env);resources.push(identity);
      const internal=await openInternalTripService(cfg.runtimeUrl,secret);resources.push(internal);
      const lifecycle=await openEvidenceLifecycleAdapter(cfg.lifecycleUrl,createInternalHost(secret));resources.push(lifecycle);
      const host=await openEvidenceHost(env,{beforeWriteGuard:async()=>{
        writeGuardCalls++;
        if(revokeDuringWrite){revokeDuringWrite=false;await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,userId]);}
      }});resources.push(host);

      const email=`${randomUUID()}@example.invalid`,password=randomBytes(24).toString("base64url");
      const created=await identity.auth.api.signUpEmail({body:{name:"E03 isolated test",email,password}});
      const login=await identity.auth.api.signInEmail({body:{email,password},headers:new Headers({origin}),asResponse:true});
      expect(login.status).toBe(200);userId=created.user.id;
      const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");

      trip=`trip_e03_04_${randomBytes(8).toString("hex")}`;
      await internal.createTrip(trip,await issueInternalCapability(secret,trip,{role:"system",id:"test-bootstrap"}));
      await lifecycle.sync(await issueInternalCapability(secret,trip,{role:"system",id:"test-lifecycle"}),{trip_id:trip,source_revision:0,ended_at:null});
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,userId]);
      const snapshot=structuredClone(base);snapshot.trip_id=trip;
      const observed=new Date(Date.now()-60_000).toISOString(),expires=new Date(Date.now()+3_600_000).toISOString();
      for(const object of snapshot.objects){object.trip_id=trip;object.updated_at=observed;object.source.at=observed;if(object.type==="ExternalFact"){object.observed_at=observed;object.expires_at=expires;}}
      await owner.query('UPDATE "TripStateDocument" SET "snapshot"=$2::jsonb,"revision"=0 WHERE "tripId"=$1',[trip,JSON.stringify(snapshot)]);

      const interpret:ControlledInterpreter=async input=>{
        const key=await input.mint_task_key(0),hypothetical=input.event.text.startsWith("如果"),decision=input.event.text.includes("选择阿斯旺");
        return {tasks:[{task_key:key,question:input.event.text,kind:"explore",target_ids:[decision?"candidate-aswan":"constraint-nights"],
          branch:hypothetical?"hypothetical":"actual",relation:"new",related_task_keys:[],certainty:"explicit",
          evidence:[{start:0,end:Array.from(input.event.text).length,quote:input.event.text}],progress:"open",progress_evidence:null}],focus_keys:[key]};
      };
      mounted.adapter=createPr29HostHttpCandidate(host,origin,interpret,async(tripId,revision)=>{
        lifecycleSyncCalls++;
        if(failLifecycleOnce){failLifecycleOnce=false;throw new Error("synthetic lifecycle sync failure");}
        await lifecycle.sync(await issueInternalCapability(secret,tripId,{role:"system",id:"e03-write-lifecycle"}),{trip_id:tripId,source_revision:revision,ended_at:null});
      });
      const post=(operation:string,body:unknown,sessionCookie=cookie)=>fetch(`${origin}/runtime/trips/${trip}/${operation}`,{
        method:"POST",headers:{origin,cookie:sessionCookie,"content-type":"application/json"},body:JSON.stringify(body),
      });
      const readState=async()=>(await owner.query<{snapshot:State}>('SELECT "snapshot" FROM "TripStateDocument" WHERE "tripId"=$1',[trip])).rows[0].snapshot;
      const counts=async()=>(await owner.query('SELECT (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history,(SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals,(SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS receipts',[trip])).rows[0];
      async function packet(text:string,bodyBudgetBytes=1_000_000){
        const opened=await post("turns",{entry:"dialogue",text,idempotency_key:`turn_${randomUUID()}`});expect(opened.status).toBe(200);
        const turn=await opened.json() as DecisionContextContracts["turn"],task=turn.tasks[0];
        const assembled=await post("assemble",{runtime_contract_version:"0.1.0",turn_id:turn.turn_id,task_key:task.task_key,body_budget_bytes:bodyBudgetBytes});
        expect(assembled.status).toBe(200);return await assembled.json() as DecisionContextContracts["packet"];
      }
      function change(packetValue:DecisionContextContracts["packet"],key:string,commands:TripStateContracts["change-request"]["commands"]):DecisionContextContracts["change"]{
        const event=packetValue.pending_input.event;
        return {runtime_contract_version:"0.1.0",turn_id:packetValue.turn_id,packet_id:packetValue.packet_id,request:{
          expected_revision:packetValue.context.state_revision,idempotency_key:key,reason:event.text,
          input:{kind:"dialogue",reference:event.reference,text:event.text,target_ids:packetValue.task.target_ids},commands,
        }};
      }

      const revise=[{op:"revise",object_type:"Constraint",id:"constraint-nights",changes:{value:{kind:"duration",maximum_nights:5}}}] as TripStateContracts["change-request"]["commands"];
      const hypothetical=await packet("如果阿斯旺多住一天会怎样"),hypotheticalChange=change(hypothetical,"egypt-hypothetical",revise),empty=await counts();
      expect((await post("changes",hypotheticalChange)).status).toBe(422);expect(await counts()).toEqual(empty);expect((await readState()).revision).toBe(0);

      const actual=await packet("请把阿斯旺行程实际增加一天"),actualChange=change(actual,"egypt-actual",revise);
      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),actualChange);
      const appliedResponse=await post("changes",actualChange);expect(appliedResponse.status).toBe(200);
      const applied=await appliedResponse.json() as TripStateContracts["response"];expect(applied).toMatchObject({outcome:"applied",revision:1});
      expect((await readState()).objects.find(object=>object.id==="constraint-nights")).toMatchObject({value:{maximum_nights:5}});
      expect(await (await post("changes",actualChange)).json()).toEqual(applied);
      const stale=structuredClone(actualChange);stale.request.idempotency_key="egypt-stale";expect((await post("changes",stale)).status).toBe(409);

      const incomplete=await packet("我明确选择阿斯旺",2),incompleteChange=change(incomplete,"egypt-incomplete",[{op:"decide_candidate",id:"candidate-aswan",value:"accept"}]);
      await expect(mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),incompleteChange)).rejects.toMatchObject({code:"INCOMPLETE_DELIVERY"});
      expect((await readState()).revision).toBe(1);

      const choice=await packet("我想选择阿斯旺"),modelChange=change(choice,"egypt-model-proposal",[{op:"decide_candidate",id:"candidate-aswan",value:"accept"}]);
      const pendingResponse=await post("changes",modelChange);expect(pendingResponse.status).toBe(202);
      const pending=await pendingResponse.json() as TripStateContracts["response"];expect(pending).toMatchObject({outcome:"pending_confirmation",revision:1,confirmation_required:true});
      expect((await readState()).revision).toBe(1);
      const confirmation:DecisionContextContracts["confirm"]={runtime_contract_version:"0.1.0",turn_id:choice.turn_id,proposal_id:pending.proposal_id!,request:{
        expected_revision:1,idempotency_key:"egypt-confirm",proposal_digest:pending.proposal_digest!,accept:true,
      }};
      const confirmedResponse=await post("confirm",confirmation);expect(confirmedResponse.status).toBe(200);
      const confirmed=await confirmedResponse.json() as TripStateContracts["response"];expect(confirmed).toMatchObject({outcome:"applied",revision:2});
      expect(await (await post("confirm",confirmation)).json()).toEqual(confirmed);

      const reviseSix=[{op:"revise",object_type:"Constraint",id:"constraint-nights",changes:{value:{kind:"duration",maximum_nights:6}}}] as TripStateContracts["change-request"]["commands"];
      const syncPacket=await packet("请把阿斯旺行程实际调整为六晚"),syncChange=change(syncPacket,"egypt-sync-retry",reviseSix);
      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),syncChange);
      const beforeSyncFailure=await counts(),syncCallsBefore=lifecycleSyncCalls;failLifecycleOnce=true;
      expect((await post("changes",syncChange)).status).toBe(500);
      expect(await readState()).toMatchObject({revision:3,objects:expect.arrayContaining([expect.objectContaining({id:"constraint-nights",value:{kind:"duration",maximum_nights:6}})])});
      const afterSyncFailure=await counts();expect(afterSyncFailure).toMatchObject({history:beforeSyncFailure.history+1,receipts:beforeSyncFailure.receipts+1});
      expect((await post("turns",{entry:"dialogue",text:"生命周期未同步时读取",idempotency_key:`turn_${randomUUID()}`})).status).toBe(503);
      const syncRetry=await post("changes",syncChange);expect(syncRetry.status).toBe(200);
      expect(await syncRetry.json()).toMatchObject({outcome:"applied",revision:3});expect(await counts()).toEqual(afterSyncFailure);
      expect(lifecycleSyncCalls).toBe(syncCallsBefore+2);

      const revokedPacket=await packet("请再次实际修改阿斯旺天数"),revokedChange=change(revokedPacket,"egypt-revoked",revise);
      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),revokedChange);
      const beforeRevocation={state:await readState(),counts:await counts()};revokeDuringWrite=true;
      expect((await post("changes",revokedChange)).status).toBe(403);expect(writeGuardCalls).toBeGreaterThan(0);
      expect({state:await readState(),counts:await counts()}).toEqual(beforeRevocation);
      expect((await post("changes",revokedChange,"")).status).toBe(403);
    } finally {
      if(server){server.close();await once(server,"close");}
      await Promise.allSettled(resources.reverse().map(resource=>resource.close()));await owner.end();
    }
  },60_000);
});
