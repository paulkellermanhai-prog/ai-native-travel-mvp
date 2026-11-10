import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { openIdentity } from "../../../src/server/auth/config";
import { createInternalHost, issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { openEvidenceHost, type ControlledInterpreter } from "../../../src/server/decision-context/host-runtime/evidence-host";
import { openEvidenceLifecycleAdapter } from "../../../src/server/decision-context/host-runtime/lifecycle-adapter";
import { createPr29HostHttpCandidate } from "../../../src/server/decision-context/http-adapter/pr29-host-candidate";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";
import type { State, TripStateContracts } from "../../../src/server/trip-state/contracts.generated";
import { buildTrustedDecisionRequest } from "../../../src/server/next-action-policy/trusted-packet-source";
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
    let server:http.Server|undefined,revokeDuringWrite=false,revokeDuringTrustedBatch=false,failLifecycleOnce=false,holdPacketHandoff=false,holdLastPageHandoff=false;
    let userId="",sessionId="",trip="",writeGuardCalls=0,lifecycleSyncCalls=0;
    let signalPacketHandoff!:()=>void,releasePacketHandoff!:()=>void,signalLastPageHandoff!:()=>void,releaseLastPageHandoff!:()=>void;
    const packetHandoffEntered=new Promise<void>(resolve=>{signalPacketHandoff=resolve;});
    const packetHandoffGate=new Promise<void>(resolve=>{releasePacketHandoff=resolve;});
    const lastPageHandoffEntered=new Promise<void>(resolve=>{signalLastPageHandoff=resolve;});
    const lastPageHandoffGate=new Promise<void>(resolve=>{releaseLastPageHandoff=resolve;});
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
      },afterPacketHandoffCommit:async()=>{
        if(holdPacketHandoff){signalPacketHandoff();await packetHandoffGate;}
        if(holdLastPageHandoff){signalLastPageHandoff();await lastPageHandoffGate;}
      },beforeTrustedPacketBatchFinalCheck:async()=>{
        if(revokeDuringTrustedBatch){revokeDuringTrustedBatch=false;await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,userId]);}
      }});resources.push(host);

      const email=`${randomUUID()}@example.invalid`,password=randomBytes(24).toString("base64url");
      const created=await identity.auth.api.signUpEmail({body:{name:"E03 isolated test",email,password}});
      const login=await identity.auth.api.signInEmail({body:{email,password},headers:new Headers({origin}),asResponse:true});
      expect(login.status).toBe(200);userId=created.user.id;
      const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      const originalSession=await identity.auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true}});
      if(!originalSession)throw new Error("Missing original Session");sessionId=originalSession.session.id;

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
      async function packetWithTurn(text:string,bodyBudgetBytes=1_000_000){
        const opened=await post("turns",{entry:"dialogue",text,idempotency_key:`turn_${randomUUID()}`});
        expect(opened.status,await opened.clone().text()).toBe(200);
        const turn=await opened.json() as DecisionContextContracts["turn"],task=turn.tasks[0];
        const assembled=await post("assemble",{runtime_contract_version:"0.1.0",turn_id:turn.turn_id,task_key:task.task_key,body_budget_bytes:bodyBudgetBytes});
        expect(assembled.status).toBe(200);return {turn,packet:await assembled.json() as DecisionContextContracts["packet"]};
      }
      async function packet(text:string,bodyBudgetBytes=1_000_000){return (await packetWithTurn(text,bodyBudgetBytes)).packet;}
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

      holdPacketHandoff=true;
      const actual=await packet("请把阿斯旺行程实际增加一天"),actualChange=change(actual,"egypt-actual",revise);
      await packetHandoffEntered;
      const trustedRequestPending=buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-decision",
        trigger:{kind:"user_event",reference:actual.pending_input.event.reference},packetIds:[actual.packet_id]});
      expect(await Promise.race([trustedRequestPending.then(()=>false,()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),250))])).toBe(true);
      holdPacketHandoff=false;releasePacketHandoff();
      const trustedRequest=await trustedRequestPending;
      expect(trustedRequest).toMatchObject({runtime_id:expect.stringMatching(/^runtime-/),packets:[{packet_id:actual.packet_id,turn_id:actual.turn_id}]});
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-forged-reference",
        trigger:{kind:"user_event",reference:"host-interaction:forged"},packetIds:[actual.packet_id]})).rejects.toThrow();
      const secondLogin=await identity.auth.api.signInEmail({body:{email,password},headers:new Headers({origin}),asResponse:true});
      expect(secondLogin.status).toBe(200);const secondCookie=secondLogin.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie:secondCookie}),decisionId:"egypt-wrong-session",
        trigger:{kind:"user_event",reference:actual.pending_input.event.reference},packetIds:[actual.packet_id]})).rejects.toThrow();
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers(),decisionId:"egypt-denied",
        trigger:{kind:"user_event",reference:actual.pending_input.event.reference},packetIds:[actual.packet_id]})).rejects.toThrow();
      const now=vi.spyOn(Date,"now").mockReturnValue(Date.now()+301_000);
      try {
        await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-expired-packet",
          trigger:{kind:"user_event",reference:actual.pending_input.event.reference},packetIds:[actual.packet_id]})).rejects.toThrow();
      } finally {now.mockRestore();}

      const partial=await packet("请完整比较阿斯旺与卢克索",2);
      expect(partial.deferred_ids.length).toBeGreaterThan(0);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-missing-pages",
        trigger:{kind:"user_event",reference:partial.pending_input.event.reference},packetIds:[partial.packet_id]})).rejects.toThrow();
      holdLastPageHandoff=true;
      const lastPage=await post("pages",{runtime_contract_version:"0.1.0",packet_id:partial.packet_id,object_ids:partial.deferred_ids});
      expect(lastPage.status,await lastPage.clone().text()).toBe(200);expect(await lastPage.json()).toMatchObject({remaining_ids:[]});
      await lastPageHandoffEntered;
      const completeAfterPostflight=buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-complete-pages",
        trigger:{kind:"user_event",reference:partial.pending_input.event.reference},packetIds:[partial.packet_id]});
      expect(await Promise.race([completeAfterPostflight.then(()=>false,()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),250))])).toBe(true);
      holdLastPageHandoff=false;releaseLastPageHandoff();await expect(completeAfterPostflight).resolves.toMatchObject({packets:[{packet_id:partial.packet_id}]});

      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,userId]);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-revoked-read",
        trigger:{kind:"state_change",reference:"membership-revoked"},packetIds:[actual.packet_id,partial.packet_id]})).rejects.toThrow();
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,userId]);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-batch-current",
        trigger:{kind:"state_change",reference:"batch-current"},packetIds:[actual.packet_id,partial.packet_id]})).resolves.toMatchObject({packets:expect.any(Array)});
      revokeDuringTrustedBatch=true;
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-batch-concurrent-revoke",
        trigger:{kind:"state_change",reference:"batch-concurrent-revoke"},packetIds:[actual.packet_id,partial.packet_id]})).rejects.toThrow();
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,userId]);

      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),actualChange);
      const appliedResponse=await post("changes",actualChange);expect(appliedResponse.status).toBe(200);
      const applied=await appliedResponse.json() as TripStateContracts["response"];expect(applied).toMatchObject({outcome:"applied",revision:1});
      expect((await readState()).objects.find(object=>object.id==="constraint-nights")).toMatchObject({value:{maximum_nights:5}});
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-stale",
        trigger:{kind:"state_change",reference:"revision-1"},packetIds:[actual.packet_id]})).rejects.toThrow();
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

      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,userId]);
      const recoverySource=await packetWithTurn("保存当前埃及比较并恢复");
      const beforeRecovery=await buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-before-recovery",
        trigger:{kind:"user_event",reference:recoverySource.packet.pending_input.event.reference},packetIds:[recoverySource.packet.packet_id]});
      if(!recoverySource.turn.checkpoint_ack)throw new Error("Missing recovery checkpoint");
      const restored=await post("checkpoints/restore",{runtime_contract_version:"0.1.0",workspace_key:recoverySource.turn.checkpoint_ack.workspace_key,body_budget_bytes:1_000_000});
      expect(restored.status,await restored.clone().text()).toBe(200);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-old-runtime",
        trigger:{kind:"user_event",reference:recoverySource.packet.pending_input.event.reference},packetIds:[recoverySource.packet.packet_id]})).rejects.toThrow();
      const recoveredPacket=await packet("恢复后继续比较阿斯旺与卢克索");
      const afterRecovery=await buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-new-runtime",
        trigger:{kind:"user_event",reference:recoveredPacket.pending_input.event.reference},packetIds:[recoveredPacket.packet_id]});
      expect(afterRecovery.runtime_id).not.toBe(beforeRecovery.runtime_id);
      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`,[sessionId]);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-expired-session",
        trigger:{kind:"user_event",reference:recoveredPacket.pending_input.event.reference},packetIds:[recoveredPacket.packet_id]})).rejects.toThrow();
    } finally {
      releasePacketHandoff();
      releaseLastPageHandoff();
      if(server){server.close();await once(server,"close");}
      await Promise.allSettled(resources.reverse().map(resource=>resource.close()));await owner.end();
    }
  },90_000);

  it("saves and restores the Egypt workspace through a new HTTP process without reviving old authority",async()=>{
    const cfg=config!,owner=new Client({connectionString:cfg.migrationUrl});await owner.connect();
    const resources:Array<{close:()=>Promise<void>}>=[];let server:http.Server|undefined,child:ChildProcess|undefined;
    let trip="",otherTrip="";
    try {
      expect((await owner.query("SELECT to_regclass('public.\"HostEvidenceScene\"') IS NOT NULL AS installed")).rows[0].installed).toBe(true);
      server=http.createServer();server.listen(0,"127.0.0.1");await once(server,"listening");
      const address=server.address();if(!address||typeof address==="string")throw new Error("Missing test socket");
      const origin=`http://127.0.0.1:${address.port}`,secret=randomBytes(32).toString("hex");
      const env={...process.env,DATABASE_URL:cfg.runtimeUrl,AUTH_DATABASE_URL:cfg.authUrl,BETTER_AUTH_URL:origin,
        BETTER_AUTH_SECRET:randomBytes(32).toString("hex"),E11_IDEMPOTENCY_SECRET:randomBytes(32).toString("hex")};
      const identity=await openIdentity(env);resources.push(identity);
      const internal=await openInternalTripService(cfg.runtimeUrl,secret);resources.push(internal);
      const lifecycle=await openEvidenceLifecycleAdapter(cfg.lifecycleUrl,createInternalHost(secret));resources.push(lifecycle);
      const host=await openEvidenceHost(env);resources.push(host);
      async function account(label:string){
        const email=`${randomUUID()}@example.invalid`,password=randomBytes(24).toString("base64url");
        const user=(await identity.auth.api.signUpEmail({body:{name:label,email,password}})).user;
        const login=await identity.auth.api.signInEmail({body:{email,password},headers:new Headers({origin}),asResponse:true});
        expect(login.status).toBe(200);const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
        const session=await identity.auth.api.getSession({headers:new Headers({cookie})});if(!session)throw new Error("Missing test Session");
        return {user,email,password,cookie,sessionId:session.session.id};
      }
      const primary=await account("E03-07 owner"),other=await account("E03-07 other user");
      trip=`trip_e03_07_${randomBytes(8).toString("hex")}`;otherTrip=`trip_e03_07_other_${randomBytes(8).toString("hex")}`;
      for(const value of [trip,otherTrip]){
        await internal.createTrip(value,await issueInternalCapability(secret,value,{role:"system",id:"e03-07-bootstrap"}));
        await lifecycle.sync(await issueInternalCapability(secret,value,{role:"system",id:"e03-07-lifecycle"}),{trip_id:value,source_revision:0,ended_at:null});
        const snapshot=structuredClone(base);snapshot.trip_id=value;
        const observed=new Date(Date.now()-60_000).toISOString(),expires=new Date(Date.now()+3_600_000).toISOString();
        for(const object of snapshot.objects){object.trip_id=value;object.updated_at=observed;object.source.at=observed;if(object.type==="ExternalFact"){object.observed_at=observed;object.expires_at=expires;}}
        await owner.query('UPDATE "TripStateDocument" SET "snapshot"=$2::jsonb,"revision"=0 WHERE "tripId"=$1',[value,JSON.stringify(snapshot)]);
      }
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3),($4,$2)',[trip,primary.user.id,other.user.id,otherTrip]);
      const interpret:ControlledInterpreter=async input=>{
        const hypothetical=input.event.text.startsWith("如果"),prior=input.runtime_focus.tasks.find(task=>input.runtime_focus.focus_keys.includes(task.task_key)&&task.branch===(hypothetical?"hypothetical":"actual"));
        const key=prior?.task_key??await input.mint_task_key(0);
        return {tasks:[{task_key:key,question:input.event.text,kind:"explore",target_ids:["constraint-nights"],branch:hypothetical?"hypothetical":"actual",
          relation:prior?"continue":"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(input.event.text).length,quote:input.event.text}],
          progress:"open",progress_evidence:null}],focus_keys:[key]};
      };
      const adapter=createPr29HostHttpCandidate(host,origin,interpret,async(tripId,revision)=>{
        await lifecycle.sync(await issueInternalCapability(secret,tripId,{role:"system",id:"e03-07-write"}),{trip_id:tripId,source_revision:revision,ended_at:null});
      });
      server.removeAllListeners("request");server.on("request",(request,response)=>{void adapter.handle(request,response);});
      const post=(baseUrl:string,targetTrip:string,operation:string,body:unknown,cookie:string)=>fetch(`${baseUrl}/runtime/trips/${targetTrip}/${operation}`,{
        method:"POST",headers:{origin:baseUrl,cookie,"content-type":"application/json"},body:JSON.stringify(body),
      });
      const readBusiness=async()=> (await owner.query('SELECT "revision",snapshot,(SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) history FROM "TripStateDocument" WHERE "tripId"=$1',[trip])).rows[0];
      const open=await post(origin,trip,"turns",{entry:"dialogue",text:"如果阿斯旺多住一天，再与卢克索比较会怎样",idempotency_key:`turn_${randomUUID()}`},primary.cookie);
      expect(open.status,await open.clone().text()).toBe(200);const firstTurn=await open.json() as DecisionContextContracts["turn"];
      expect(firstTurn.checkpoint_ack).toMatchObject({checkpoint_revision:1,durable:true,deleted:false});
      const assembled=await post(origin,trip,"assemble",{runtime_contract_version:"0.1.0",turn_id:firstTurn.turn_id,task_key:firstTurn.tasks[0].task_key,body_budget_bytes:1_000_000},primary.cookie);
      expect(assembled.status).toBe(200);const firstPacket=await assembled.json() as DecisionContextContracts["packet"];
      const hypothetical:DecisionContextContracts["change"]={runtime_contract_version:"0.1.0",turn_id:firstTurn.turn_id,packet_id:firstPacket.packet_id,request:{
        expected_revision:0,idempotency_key:"egypt-e03-07-hypothetical",reason:"只做假设比较",input:{kind:"dialogue",reference:firstPacket.pending_input.event.reference,
          text:firstPacket.pending_input.event.text,target_ids:firstPacket.task.target_ids},commands:[{op:"revise",object_type:"Constraint",id:"constraint-nights",changes:{value:{kind:"duration",maximum_nights:5}}}]}};
      const beforeHypothetical=await readBusiness();expect((await post(origin,trip,"changes",hypothetical,primary.cookie)).status).toBe(422);expect(await readBusiness()).toEqual(beforeHypothetical);
      const actualOpened=await post(origin,trip,"turns",{entry:"dialogue",text:"明确将埃及行程调整为五晚",idempotency_key:`turn_${randomUUID()}`},primary.cookie);
      expect(actualOpened.status).toBe(200);const actualTurn=await actualOpened.json() as DecisionContextContracts["turn"];
      const actualAssembled=await post(origin,trip,"assemble",{runtime_contract_version:"0.1.0",turn_id:actualTurn.turn_id,task_key:actualTurn.tasks[0].task_key,body_budget_bytes:1_000_000},primary.cookie);
      expect(actualAssembled.status).toBe(200);const actualPacket=await actualAssembled.json() as DecisionContextContracts["packet"];
      const actual=structuredClone(hypothetical);actual.turn_id=actualTurn.turn_id;actual.packet_id=actualPacket.packet_id;
      actual.request.idempotency_key="egypt-e03-07-actual";actual.request.reason="明确将埃及行程调整为五晚";
      actual.request.input={kind:"dialogue",reference:actualPacket.pending_input.event.reference,text:actualPacket.pending_input.event.text,target_ids:actualPacket.task.target_ids};
      await adapter.authorizeUserChange(trip,new Headers({cookie:primary.cookie}),actual);
      const applied=await post(origin,trip,"changes",actual,primary.cookie);expect(applied.status).toBe(200);expect(await applied.json()).toMatchObject({outcome:"applied",revision:1});
      expect((await readBusiness()).revision).toBe("1");
      const continued=await post(origin,trip,"turns",{entry:"comparison",text:"保存当前卢克索和阿斯旺比较，稍后继续",idempotency_key:`turn_${randomUUID()}`},primary.cookie);
      expect(continued.status,await continued.clone().text()).toBe(200);const continuedTurn=await continued.json() as DecisionContextContracts["turn"];
      expect(continuedTurn.tasks[0].relation).toBe("continue");expect(continuedTurn.checkpoint_ack?.checkpoint_revision).toBe(3);
      const candidateVersion=(await readBusiness()).snapshot.objects.find((object:{id:string;version:number})=>object.id==="candidate-aswan").version;
      const saveBody={runtime_contract_version:"0.1.0",workspace_key:continuedTurn.checkpoint_ack!.workspace_key,
        expected_checkpoint_revision:3,idempotency_key:"egypt-e03-07-explicit-save",focus_keys:continuedTurn.focus_keys,
        view:{entry:"comparison",comparison_refs:[{id:"candidate-aswan",version:candidateVersion}],selected_id:"candidate-aswan",expanded_task_keys:continuedTurn.focus_keys},
        drafts:[{draft_id:"draft-aswan-extra-night",draft_kind:"hypothetical",base_revision:1,target_ids:["constraint-nights"],text:"如果阿斯旺再多住一天",
          source_reference:"synthetic-egypt-internal-mvp",proposal:null}]};
      const saved=await post(origin,trip,"checkpoints/save",saveBody,primary.cookie);expect(saved.status,await saved.clone().text()).toBe(200);
      const saveAck=await saved.json() as DecisionContextContracts["scene-ack"];expect(saveAck.ack.checkpoint_revision).toBe(4);
      expect(await (await post(origin,trip,"checkpoints/save",saveBody,primary.cookie)).json()).toEqual(saveAck);
      const status=await post(origin,trip,"checkpoints/status",{runtime_contract_version:"0.1.0"},primary.cookie);
      expect(await status.json()).toMatchObject({current_checkpoint_revision:4,save_pending:false,last_error:null});
      const newLogin=await identity.auth.api.signInEmail({body:{email:primary.email,password:primary.password},headers:new Headers({origin}),asResponse:true});
      const newCookie=newLogin.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      await owner.query('DELETE FROM "AuthSession" WHERE id=$1',[primary.sessionId]);
      server.close();await once(server,"close");server=undefined;
      await Promise.all(resources.reverse().map(resource=>resource.close()));resources.length=0;

      const childEnv={...env,BETTER_AUTH_URL:undefined,INTERNAL_SERVICE_SECRET:secret,E03_CHILD_LIFECYCLE_URL:cfg.lifecycleUrl};
      child=spawn(process.execPath,["--import","tsx","tests/support/e03-http-recovery-process.ts"],{cwd:process.cwd(),env:childEnv,stdio:["pipe","pipe","pipe"]});
      const childOrigin=await new Promise<string>((resolve,reject)=>{let stdout="",stderr="";
        child!.stdout!.setEncoding("utf8");child!.stderr!.setEncoding("utf8");child!.stderr!.on("data",chunk=>{stderr+=chunk;});
        child!.stdout!.on("data",chunk=>{stdout+=chunk;const end=stdout.indexOf("\n");if(end>=0){try{resolve((JSON.parse(stdout.slice(0,end)) as {origin:string}).origin);}catch(error){reject(error);}}});
        child!.once("exit",code=>reject(new Error(`Recovery child exited ${code}: ${stderr}`)));
      });
      const restoreBody={runtime_contract_version:"0.1.0",workspace_key:saveAck.ack.workspace_key,body_budget_bytes:1_000_000};
      expect((await post(childOrigin,trip,"checkpoints/restore",restoreBody,primary.cookie)).status).toBe(403);
      expect([403,503]).toContain((await post(childOrigin,trip,"checkpoints/restore",restoreBody,other.cookie)).status);
      expect([403,503]).toContain((await post(childOrigin,otherTrip,"checkpoints/restore",restoreBody,newCookie)).status);
      const restoredResponse=await post(childOrigin,trip,"checkpoints/restore",restoreBody,newCookie);expect(restoredResponse.status,await restoredResponse.clone().text()).toBe(200);
      const restored=await restoredResponse.json() as DecisionContextContracts["scene-restored"];
      expect(restored).toMatchObject({workspace_key:saveAck.ack.workspace_key,checkpoint_revision:4,saved_state_revision:1,current_state_revision:1,
        recovery_requires_new_authorization:true,drafts:[expect.objectContaining({draft_id:"draft-aswan-extra-night"})]});
      expect(restored.runtime_id).not.toBe(continuedTurn.runtime_id);
      expect((await post(childOrigin,trip,"changes",actual,newCookie)).status).toBe(403);
      const next=await post(childOrigin,trip,"turns",{entry:"dialogue",text:"继续规划阿斯旺和卢克索",idempotency_key:`turn_${randomUUID()}`},newCookie);
      expect(next.status,await next.clone().text()).toBe(200);const nextTurn=await next.json() as DecisionContextContracts["turn"];
      expect(nextTurn).toMatchObject({runtime_id:restored.runtime_id,tasks:[expect.objectContaining({relation:"continue"})]});
      const nextPacketResponse=await post(childOrigin,trip,"assemble",{runtime_contract_version:"0.1.0",turn_id:nextTurn.turn_id,task_key:nextTurn.tasks[0].task_key,body_budget_bytes:1_000_000},newCookie);
      expect(nextPacketResponse.status).toBe(200);const nextPacket=await nextPacketResponse.json() as DecisionContextContracts["packet"];
      const stale=structuredClone(actual);stale.turn_id=nextTurn.turn_id;stale.packet_id=nextPacket.packet_id;stale.request.idempotency_key="egypt-e03-07-stale-after-restore";
      stale.request.input={kind:"dialogue",reference:nextPacket.pending_input.event.reference,text:nextPacket.pending_input.event.text,target_ids:nextPacket.task.target_ids};
      expect((await post(childOrigin,trip,"changes",stale,newCookie)).status).toBe(409);
      const businessBeforeBarrier=await readBusiness();
      const source=(await owner.query<{event_id:string;recorded_at:string}>('SELECT event_id,recorded_at::text FROM "HostEvidenceEvent" WHERE owner_id=$1 AND trip_id=$2 ORDER BY sequence LIMIT 1',[primary.user.id,trip])).rows[0];
      await owner.query('UPDATE "HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval \'180 days\' WHERE event_id=$1',[source.event_id]);
      expect((await post(childOrigin,trip,"checkpoints/restore",restoreBody,newCookie)).status).toBe(503);expect(await readBusiness()).toEqual(businessBeforeBarrier);
      await owner.query('UPDATE "HostEvidenceEvent" SET recorded_at=$2::timestamptz WHERE event_id=$1',[source.event_id,source.recorded_at]);
      const scope=(await owner.query<{session_ref:string;capability_token:string}>('SELECT session_ref,capability_token FROM "HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[primary.user.id,trip,saveAck.ack.workspace_key])).rows[0];
      expect((await owner.query('SELECT * FROM public.host_evidence_delete_candidate($1,$2,$3,$4,$5,$6)',[scope.session_ref,primary.user.id,trip,saveAck.ack.workspace_key,scope.capability_token,source.event_id])).rows[0].disposition).toBe("deleted");
      expect((await post(childOrigin,trip,"checkpoints/restore",restoreBody,newCookie)).status).toBe(503);expect(await readBusiness()).toEqual(businessBeforeBarrier);
    } finally {
      if(child&&!child.killed){child.stdin?.end();await Promise.race([once(child,"exit"),new Promise(resolve=>setTimeout(resolve,5_000))]);if(child.exitCode===null)child.kill();}
      if(server){server.close();await once(server,"close");}
      await Promise.allSettled(resources.reverse().map(resource=>resource.close()));await owner.end();
    }
  },90_000);
});
