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
import {installE04Runtime} from "../../../scripts/e04-candidate-installer.mjs";
import { base } from "../../support/bcg-fixtures";
import {decide,type SemanticAdapter} from "../../../src/server/next-action-policy/decision-engine";
import {runEvidenceMaintenanceCandidate} from "../../../src/server/decision-context/host-runtime/expiry-maintenance-candidate";

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
    let server:http.Server|undefined,revokeDuringWrite=false,failLifecycleOnce=false,createConflictingReceipt:TripStateContracts["change-request"]|null=null,
      holdPacketHandoff=false,holdLastPageHandoff=false,holdTrustedBatch=false,holdExpiringBatch=false,holdSourceDeadlineBatch=false;
    let userId="",sessionId="",trip="",writeGuardCalls=0,lifecycleSyncCalls=0;
    let signalPacketHandoff!:()=>void,releasePacketHandoff!:()=>void,signalLastPageHandoff!:()=>void,releaseLastPageHandoff!:()=>void;
    let signalTrustedBatch!:()=>void,releaseTrustedBatch!:()=>void;
    let signalExpiringBatch!:()=>void,releaseExpiringBatch!:()=>void;
    let signalSourceDeadlineBatch!:()=>void,releaseSourceDeadlineBatch!:()=>void;
    const packetHandoffEntered=new Promise<void>(resolve=>{signalPacketHandoff=resolve;});
    const packetHandoffGate=new Promise<void>(resolve=>{releasePacketHandoff=resolve;});
    const lastPageHandoffEntered=new Promise<void>(resolve=>{signalLastPageHandoff=resolve;});
    const lastPageHandoffGate=new Promise<void>(resolve=>{releaseLastPageHandoff=resolve;});
    const trustedBatchEntered=new Promise<void>(resolve=>{signalTrustedBatch=resolve;});
    const trustedBatchGate=new Promise<void>(resolve=>{releaseTrustedBatch=resolve;});
    const expiringBatchEntered=new Promise<void>(resolve=>{signalExpiringBatch=resolve;});
    const expiringBatchGate=new Promise<void>(resolve=>{releaseExpiringBatch=resolve;});
    const sourceDeadlineBatchEntered=new Promise<void>(resolve=>{signalSourceDeadlineBatch=resolve;});
    const sourceDeadlineBatchGate=new Promise<void>(resolve=>{releaseSourceDeadlineBatch=resolve;});
    try {
      const check=await owner.query("SELECT current_database() AS name,current_setting('server_version_num')::int AS version,to_regclass('public.\"HostEvidenceWorkspace\"') IS NULL AS clean");
      if(check.rows[0]?.name!==cfg.database||check.rows[0]?.version<170000||!check.rows[0]?.clean)throw new Error("Clean dedicated PG 17 required");
      await owner.query("BEGIN");
      try{await installE03Candidate(owner,{runtimeRole:cfg.runtimeRole,lifecycleRole:cfg.lifecycleRole});await installE04Runtime(owner,{runtimeRole:cfg.runtimeRole});await owner.query("COMMIT");}
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
        if(holdTrustedBatch){signalTrustedBatch();await trustedBatchGate;}
        if(holdExpiringBatch){signalExpiringBatch();await expiringBatchGate;}
        if(holdSourceDeadlineBatch){signalSourceDeadlineBatch();await sourceDeadlineBatchGate;}
      },beforeExecuteWrite:async()=>{
        if(createConflictingReceipt){
          const request=createConflictingReceipt;createConflictingReceipt=null;
          await expect(internal.submit(trip,request,await issueInternalCapability(secret,trip,{role:"model",id:"model-e03-runtime"})))
            .resolves.toMatchObject({outcome:"pending_confirmation",revision:0});
        }
      },trustedPacketBatchLockTimeoutMs:500});resources.push(host);

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
        const hypothetical=input.event.text.startsWith("如果"),decision=input.event.text.includes("选择阿斯旺");
        const targets=input.event.text==="同轮比较阿斯旺与卢克索"?["constraint-nights","candidate-aswan"]:[decision?"candidate-aswan":"constraint-nights"];
        const tasks:Array<DecisionContextContracts["turn"]["tasks"][number]>=[];
        for(let ordinal=0;ordinal<targets.length;ordinal++){
          const key=await input.mint_task_key(ordinal);
          tasks.push({task_key:key,question:input.event.text,kind:"explore" as const,target_ids:[targets[ordinal]],
            branch:hypothetical?"hypothetical" as const:"actual" as const,relation:"new" as const,related_task_keys:[],certainty:"explicit" as const,
            evidence:[{start:0,end:Array.from(input.event.text).length,quote:input.event.text}],progress:"open" as const,progress_evidence:null});
        }
        return {tasks,focus_keys:tasks.map(task=>task.task_key)};
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
      async function packetsWithTurn(text:string,bodyBudgetBytes=1_000_000){
        const opened=await post("turns",{entry:"dialogue",text,idempotency_key:`turn_${randomUUID()}`});
        expect(opened.status,await opened.clone().text()).toBe(200);
        const turn=await opened.json() as DecisionContextContracts["turn"],packets:DecisionContextContracts["packet"][]=[];
        for(const task of turn.tasks){
          const assembled=await post("assemble",{runtime_contract_version:"0.1.0",turn_id:turn.turn_id,task_key:task.task_key,body_budget_bytes:bodyBudgetBytes});
          expect(assembled.status,await assembled.clone().text()).toBe(200);packets.push(await assembled.json() as DecisionContextContracts["packet"]);
        }
        return {turn,packets};
      }
      async function packetWithTurn(text:string,bodyBudgetBytes=1_000_000){const result=await packetsWithTurn(text,bodyBudgetBytes);return {turn:result.turn,packet:result.packets[0]};}
      async function packet(text:string,bodyBudgetBytes=1_000_000){return (await packetWithTurn(text,bodyBudgetBytes)).packet;}
      function change(packetValue:DecisionContextContracts["packet"],key:string,commands:TripStateContracts["change-request"]["commands"]):DecisionContextContracts["change"]{
        const event=packetValue.pending_input.event;
        return {runtime_contract_version:"0.1.0",turn_id:packetValue.turn_id,packet_id:packetValue.packet_id,request:{
          expected_revision:packetValue.context.state_revision,idempotency_key:key,reason:event.text,
          input:{kind:"dialogue",reference:event.reference,text:event.text,target_ids:packetValue.task.target_ids},commands,
        }};
      }
      async function saveChangePlan(packetValue:DecisionContextContracts["packet"],decisionId:string,body:DecisionContextContracts["change"]){
        const decisionRequest=await buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId,
          trigger:{kind:"user_event",reference:packetValue.pending_input.event.reference},packetIds:[packetValue.packet_id]});
        const plan=await decide(decisionRequest,{assess:async()=>({response:{request_ids:[packetValue.task.task_key],disposition:"answered",
          text:"已按当前请求生成受控变更步骤",evidence_refs:[]},candidates:[{action_id:"action-change",task_key:packetValue.task.task_key,
          packet_id:packetValue.packet_id,request_ids:[packetValue.task.task_key],goal:"D5",preferred_attention:"primary",reason:"通过原 E03 写桥提交",rank:100,
          steps:[{step_id:"step-change",kind:"change",depends_on:[],capability_id:null,arguments:{},change_request:body.request,user_message:null}],
          required_object_ids:packetValue.task.target_ids,reentry_candidate_id:null}]})});
        await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),decisionRequest,plan);
        return {decisionRequest,plan};
      }

      const revise=[{op:"revise",object_type:"Constraint",id:"constraint-nights",changes:{value:{kind:"duration",maximum_nights:5}}}] as TripStateContracts["change-request"]["commands"];
      const hypothetical=await packet("如果阿斯旺多住一天会怎样"),hypotheticalChange=change(hypothetical,"egypt-hypothetical",revise),empty=await counts();
      const hypotheticalPlan=await saveChangePlan(hypothetical,"egypt-hypothetical-plan",hypotheticalChange);
      expect(hypotheticalPlan.plan.actions).toEqual([]);
      const forgedHypothetical=structuredClone(hypotheticalPlan.plan);
      forgedHypothetical.actions=[{action_id:"forged-change",task_key:hypothetical.task.task_key,packet_id:hypothetical.packet_id,
        request_ids:[hypothetical.task.task_key],goal:"D5",attention:"primary",reason:"伪造通过的 G02 结论",
        steps:[{step_id:"forged-step",kind:"change",depends_on:[],capability_id:null,arguments:{},change_request:hypotheticalChange.request,user_message:null}]}];
      await expect(mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),hypotheticalPlan.decisionRequest,forgedHypothetical)).rejects.toThrow();
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
      holdLastPageHandoff=false;releaseLastPageHandoff();
      const hydrated=await completeAfterPostflight;
      expect(hydrated.packets[0]).toMatchObject({packet_id:partial.packet_id,turn_id:partial.turn_id,task:partial.task,context:partial.context,
        pending_input:partial.pending_input,evidence_checked_at:partial.evidence_checked_at,snapshot_digest:partial.snapshot_digest,
        annotations:partial.annotations,deferred_ids:[],coverage:"complete",support:"decision_support"});
      expect(hydrated.packets[0].objects.map(object=>object.id)).toEqual(partial.context.selected_object_ids);

      const sameTurn=await packetsWithTurn("同轮比较阿斯旺与卢克索",2);
      expect(sameTurn.packets).toHaveLength(2);
      const pairInput={tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-two-task-batch",
        trigger:{kind:"user_event" as const,reference:sameTurn.packets[0].pending_input.event.reference},packetIds:sameTurn.packets.map(value=>value.packet_id)};
      for(const sourcePacket of sameTurn.packets){expect(sourcePacket.turn_id).toBe(sameTurn.turn.turn_id);expect(sourcePacket.deferred_ids.length).toBeGreaterThan(0);}
      const firstDelivered=await post("pages",{runtime_contract_version:"0.1.0",packet_id:sameTurn.packets[0].packet_id,object_ids:sameTurn.packets[0].deferred_ids});
      expect(firstDelivered.status,await firstDelivered.clone().text()).toBe(200);expect(await firstDelivered.json()).toMatchObject({remaining_ids:[]});
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{...pairInput,decisionId:"egypt-batch-one-incomplete"})).rejects.toThrow();
      const secondDelivered=await post("pages",{runtime_contract_version:"0.1.0",packet_id:sameTurn.packets[1].packet_id,object_ids:sameTurn.packets[1].deferred_ids});
      expect(secondDelivered.status,await secondDelivered.clone().text()).toBe(200);expect(await secondDelivered.json()).toMatchObject({remaining_ids:[]});
      const pair=await buildTrustedDecisionRequest(mounted.adapter!,pairInput);
      expect(pair.packets.map(value=>[value.packet_id,value.turn_id,value.task.task_key])).toEqual(sameTurn.packets.map(value=>[value.packet_id,sameTurn.turn.turn_id,value.task.task_key]));
      for(let index=0;index<pair.packets.length;index++){
        expect(pair.packets[index].objects.map(object=>object.id)).toEqual(pair.packets[index].context.selected_object_ids);
        expect(pair.packets[index]).toMatchObject({evidence_checked_at:sameTurn.packets[index].evidence_checked_at,context:{expires_at:sameTurn.packets[index].context.expires_at}});
      }

      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,userId]);
      await expect(mounted.adapter!.readTrustedPacketBatchCandidate(trip,new Headers({cookie}),pairInput.packetIds)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,userId]);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{...pairInput,decisionId:"egypt-batch-current"})).resolves.toMatchObject({packets:expect.any(Array)});
      holdTrustedBatch=true;
      const concurrentRevocation=buildTrustedDecisionRequest(mounted.adapter!,{...pairInput,decisionId:"egypt-batch-concurrent-revoke"});
      await trustedBatchEntered;
      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,userId]);
      holdTrustedBatch=false;releaseTrustedBatch();
      await expect(concurrentRevocation).rejects.toThrow();
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,userId]);

      await owner.query("BEGIN");
      await owner.query('SELECT 1 FROM "TripStateDocument" WHERE "tripId"=$1 FOR UPDATE',[trip]);
      const waitsForLock=mounted.adapter!.readTrustedPacketBatchCandidate(trip,new Headers({cookie}),pairInput.packetIds);
      expect(await Promise.race([waitsForLock.then(()=>false,()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),150))])).toBe(true);
      await owner.query("COMMIT");
      await expect(waitsForLock).resolves.toMatchObject({packets:expect.any(Array)});
      await owner.query("BEGIN");
      await owner.query('SELECT 1 FROM "TripStateDocument" WHERE "tripId"=$1 FOR UPDATE',[trip]);
      const lockTimeout=mounted.adapter!.readTrustedPacketBatchCandidate(trip,new Headers({cookie}),pairInput.packetIds);
      await expect(lockTimeout).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query("ROLLBACK");

      const runtimeAdapter:SemanticAdapter={assess:async request=>{
        const source=request.packets[0],evidence=source.objects.find(object=>object.id==="constraint-nights");
        if(!evidence)throw new Error("Missing runtime evidence");
        return {response:{request_ids:request.packets.map(packet=>packet.task.task_key),disposition:"answered",text:"已形成可执行前的读取计划",
          evidence_refs:[{id:evidence.id,version:evidence.version,kind:"object"}]},candidates:[{action_id:"action-runtime",task_key:source.task.task_key,
          packet_id:source.packet_id,request_ids:[source.task.task_key],goal:"D2",preferred_attention:"primary",reason:"读取当前交通依据",rank:100,
          steps:[{step_id:"step-runtime",kind:"read",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:null}],
          required_object_ids:[evidence.id],reentry_candidate_id:null}]};
      }};
      const runtimePlan=await decide(pair,runtimeAdapter);
      const stored=await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),pair,runtimePlan);
      expect(stored).toMatchObject({replayed:false,plan:{decision_id:pair.decision_id}});
      const changedPlan=structuredClone(runtimePlan);changedPlan.response.text="重试时的不同语义文本";
      await expect(mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),pair,changedPlan)).resolves.toEqual({plan:runtimePlan,replayed:true});
      const concurrentClaims=await Promise.all([
        mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),pair.packets[0].packet_id,pair.decision_id,"action-runtime","step-runtime"),
        mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),pair.packets[0].packet_id,pair.decision_id,"action-runtime","step-runtime"),
      ]);
      expect(concurrentClaims.map(result=>result.disposition).sort()).toEqual(["already_claimed","claimed"]);
      const claimed=concurrentClaims.find(result=>result.disposition==="claimed");if(!claimed?.claim_token)throw new Error("Missing atomic claim token");
      await mounted.adapter!.markDecisionExecutionUnknownCandidate(trip,new Headers({cookie}),pair.packets[0].packet_id,pair.decision_id,"action-runtime","step-runtime",claimed.claim_token);
      const runningRecord=await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),pair.packets[0].packet_id,pair.decision_id);
      expect(runningRecord).toMatchObject({actions:[{phase:"running",receipt_lookup_required:true}],steps:[{status:"running"}]});

      const conflictPacket=await packet("同一 decision 的不同请求"),conflictRequest=await buildTrustedDecisionRequest(mounted.adapter!,{
        tripId:trip,credential:new Headers({cookie}),decisionId:pair.decision_id,trigger:{kind:"user_event",reference:conflictPacket.pending_input.event.reference},packetIds:[conflictPacket.packet_id]});
      const conflictPlan=await decide(conflictRequest,runtimeAdapter);
      await expect(mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),conflictRequest,conflictPlan)).rejects.toMatchObject({code:"DECISION_CONFLICT"});
      const staleRequest={...conflictRequest,decision_id:"egypt-runtime-stale"},stalePlan=await decide(staleRequest,runtimeAdapter);
      await expect(mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),staleRequest,stalePlan)).resolves.toMatchObject({replayed:false});
      const dependencyRequest={...conflictRequest,decision_id:"egypt-runtime-dependencies"};
      const dependencyPlan=await decide(dependencyRequest,{assess:async request=>{
        const source=request.packets[0];return {response:{request_ids:[source.task.task_key],disposition:"answered",text:"依赖顺序测试",
          evidence_refs:[]},candidates:[{action_id:"action-dependencies",task_key:source.task.task_key,packet_id:source.packet_id,request_ids:[source.task.task_key],
          goal:"D2",preferred_attention:"primary",reason:"先读取再交付",rank:100,required_object_ids:[],reentry_candidate_id:null,steps:[
            {step_id:"step-first",kind:"read",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:null},
            {step_id:"step-second",kind:"read",depends_on:["step-first"],capability_id:null,arguments:{},change_request:null,user_message:null},
          ]}]};
      }},new Date());
      await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),dependencyRequest,dependencyPlan);
      await expect(mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,dependencyRequest.decision_id,"action-dependencies","step-second"))
        .resolves.toMatchObject({disposition:"dependency_wait"});
      const firstStep=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,dependencyRequest.decision_id,"action-dependencies","step-first");
      expect(firstStep).toMatchObject({disposition:"executed",result:{outcome:"read",step_id:"step-first"}});
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,dependencyRequest.decision_id))
        .toMatchObject({actions:[{phase:"running"}],steps:[{step_id:"step-first",status:"succeeded"},{step_id:"step-second",status:"pending",result_json:null}]});
      const secondStep=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,dependencyRequest.decision_id,"action-dependencies","step-second");
      expect(secondStep).toMatchObject({disposition:"executed",result:{outcome:"read",step_id:"step-second"}});
      const waitingRequest={...conflictRequest,decision_id:"egypt-runtime-waiting"};
      const waitingPlan=await decide(waitingRequest,{assess:async request=>{
        const source=request.packets[0];return {response:{request_ids:[source.task.task_key],disposition:"clarification",text:"只询问真正阻断条件",evidence_refs:[]},
          candidates:[{action_id:"action-waiting",task_key:source.task.task_key,packet_id:source.packet_id,request_ids:[source.task.task_key],goal:"D4",
            preferred_attention:"primary",reason:"等待用户输入",rank:100,required_object_ids:[],reentry_candidate_id:null,
            steps:[{step_id:"step-waiting",kind:"ask",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:"请补充起止城市"}]}]};
      }},new Date());
      await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),waitingRequest,waitingPlan);
      await expect(mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,waitingRequest.decision_id,"action-waiting","step-waiting"))
        .resolves.toMatchObject({disposition:"waiting_user"});
      const readRequest={...conflictRequest,decision_id:"egypt-runtime-read"},readPlan=await decide(readRequest,runtimeAdapter);
      await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),readRequest,readPlan);
      const beforeReadDispatch=await counts();
      const readDispatch=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,readRequest.decision_id,"action-runtime","step-runtime");
      expect(readDispatch).toMatchObject({disposition:"executed",result:{outcome:"read",packet_id:conflictPacket.packet_id,state_revision:0,objects:expect.any(Array)}});
      expect((readDispatch.result as {objects:unknown[]}).objects.length).toBeGreaterThan(0);expect(await counts()).toEqual(beforeReadDispatch);
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,readRequest.decision_id))
        .toMatchObject({actions:[{phase:"succeeded"}],steps:[{status:"succeeded"}]});

      const noSyncAdapter=createPr29HostHttpCandidate(host,origin,interpret),syncedAdapter=mounted.adapter!;
      mounted.adapter=noSyncAdapter;
      try{
        const noSyncPacket=await packet("没有 lifecycle 同步能力时不得先写入"),noSyncChange=change(noSyncPacket,"egypt-no-sync",revise);
        const noSyncPlan=await saveChangePlan(noSyncPacket,"egypt-change-no-sync",noSyncChange),beforeNoSync={state:await readState(),counts:await counts()};
        await noSyncAdapter.authorizeUserChange(trip,new Headers({cookie}),noSyncChange);
        await expect(noSyncAdapter.dispatchDecisionStepCandidate(trip,new Headers({cookie}),noSyncPacket.packet_id,noSyncPlan.decisionRequest.decision_id,"action-change","step-change"))
          .rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
        expect({state:await readState(),counts:await counts()}).toEqual(beforeNoSync);
      }finally{mounted.adapter=syncedAdapter;}

      const rejectedPacket=await packet("无效业务对象必须明确拒绝"),rejectedChange=change(rejectedPacket,"egypt-business-rejected",
        [{op:"revise",object_type:"Constraint",id:"constraint-does-not-exist",changes:{value:{kind:"duration",maximum_nights:5}}}]);
      const rejectedPlan=await saveChangePlan(rejectedPacket,"egypt-change-rejected",rejectedChange),beforeRejected={state:await readState(),counts:await counts()};
      const rejectedDispatch=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),rejectedPacket.packet_id,rejectedPlan.decisionRequest.decision_id,"action-change","step-change");
      expect(rejectedDispatch).toMatchObject({disposition:"executed",result:{outcome:"rejected",revision:0,errors:expect.any(Array)}});
      expect(await readState()).toEqual(beforeRejected.state);
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),rejectedPacket.packet_id,rejectedPlan.decisionRequest.decision_id))
        .toMatchObject({actions:[{phase:"failed",result_json:{outcome:"rejected"}}],steps:[{status:"failed",result_json:{outcome:"rejected"}}]});

      const conflictWritePacket=await packet("幂等冲突必须明确失败"),conflictWriteChange=change(conflictWritePacket,"egypt-business-conflict",revise);
      const conflictingReceipt=structuredClone(conflictWriteChange.request);conflictingReceipt.commands=[{op:"revise",object_type:"Constraint",id:"constraint-nights",changes:{value:{kind:"duration",maximum_nights:4}}}];
      const conflictWritePlan=await saveChangePlan(conflictWritePacket,"egypt-change-conflict",conflictWriteChange);createConflictingReceipt=conflictingReceipt;
      const conflictDispatch=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),conflictWritePacket.packet_id,conflictWritePlan.decisionRequest.decision_id,"action-change","step-change");
      expect(conflictDispatch).toMatchObject({disposition:"executed",result:{outcome:"conflict",revision:0,errors:expect.any(Array)}});
      expect((await readState()).revision).toBe(0);
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),conflictWritePacket.packet_id,conflictWritePlan.decisionRequest.decision_id))
        .toMatchObject({actions:[{phase:"failed",result_json:{outcome:"conflict"}}],steps:[{status:"failed",result_json:{outcome:"conflict"}}]});

      const unknownPacket=await packet("执行结果未知时不要重提业务写入"),unknownChange=change(unknownPacket,"egypt-unknown-no-receipt",[{op:"decide_candidate",id:"candidate-aswan",value:"accept"}]);
      const unknownPlan=await saveChangePlan(unknownPacket,"egypt-change-unknown-no-receipt",unknownChange);
      const unknownClaim=await mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),unknownPacket.packet_id,unknownPlan.decisionRequest.decision_id,"action-change","step-change");
      if(unknownClaim.disposition!=="claimed"||!unknownClaim.claim_token)throw new Error("Missing unknown-outcome claim");
      await mounted.adapter!.markDecisionExecutionUnknownCandidate(trip,new Headers({cookie}),unknownPacket.packet_id,unknownPlan.decisionRequest.decision_id,"action-change","step-change",unknownClaim.claim_token);
      const beforeUnknownLookup=await counts();
      await expect(mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),unknownPacket.packet_id,unknownPlan.decisionRequest.decision_id,"action-change","step-change"))
        .resolves.toEqual({disposition:"execution_unknown",result:null});
      expect(await counts()).toEqual(beforeUnknownLookup);

      const actualPlan=await saveChangePlan(actual,"egypt-change-actual",actualChange);
      const staleNapChange=change(conflictPacket,"egypt-nap-stale",revise);await saveChangePlan(conflictPacket,"egypt-change-stale",staleNapChange);
      const staleDependencyRequest={...conflictRequest,decision_id:"egypt-runtime-running-stale"};
      const staleDependencyPlan=await decide(staleDependencyRequest,{assess:async request=>{
        const source=request.packets[0];return {response:{request_ids:[source.task.task_key],disposition:"answered",text:"多步骤失效测试",evidence_refs:[]},
          candidates:[{action_id:"action-running-stale",task_key:source.task.task_key,packet_id:source.packet_id,request_ids:[source.task.task_key],
            goal:"D2",preferred_attention:"primary",reason:"第一步完成后保留结果",rank:100,required_object_ids:[],reentry_candidate_id:null,steps:[
              {step_id:"step-running-first",kind:"read",depends_on:[],capability_id:null,arguments:{},change_request:null,user_message:null},
              {step_id:"step-running-second",kind:"read",depends_on:["step-running-first"],capability_id:null,arguments:{},change_request:null,user_message:null},
            ]}]};
      }});await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),staleDependencyRequest,staleDependencyPlan);
      const runningFirst=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,staleDependencyRequest.decision_id,"action-running-stale","step-running-first");
      expect(runningFirst).toMatchObject({disposition:"executed",result:{outcome:"read",step_id:"step-running-first"}});
      const beforeWrongSession=await counts();
      await expect(mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie:secondCookie}),actual.packet_id,actualPlan.decisionRequest.decision_id,"action-change","step-change"))
        .rejects.toThrow();
      expect(await counts()).toEqual(beforeWrongSession);
      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),actualChange);
      const appliedDispatch=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),actual.packet_id,actualPlan.decisionRequest.decision_id,"action-change","step-change");
      expect(appliedDispatch.disposition).toBe("executed");
      const applied=appliedDispatch.result as TripStateContracts["response"];expect(applied).toMatchObject({outcome:"applied",revision:1});
      expect((await readState()).objects.find(object=>object.id==="constraint-nights")).toMatchObject({value:{maximum_nights:5}});
      const afterAppliedCounts=await counts();
      await expect(mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,staleDependencyRequest.decision_id,"action-running-stale","step-running-second"))
        .resolves.toMatchObject({disposition:"stale"});
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,staleDependencyRequest.decision_id))
        .toMatchObject({actions:[{phase:"stale",receipt_lookup_required:false}],steps:[
          {step_id:"step-running-first",status:"succeeded",result_json:{outcome:"read",step_id:"step-running-first"}},
          {step_id:"step-running-second",status:"stale",result_json:null},
        ]});
      await expect(mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),conflictPacket.packet_id,"egypt-change-stale","action-change","step-change"))
        .rejects.toThrow();
      expect(await counts()).toEqual(afterAppliedCounts);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-stale",
        trigger:{kind:"user_event",reference:actual.pending_input.event.reference},packetIds:[actual.packet_id]})).rejects.toThrow();
      await expect(mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),actual.packet_id,actualPlan.decisionRequest.decision_id,"action-change","step-change"))
        .resolves.toEqual({disposition:"recorded",result:applied});
      expect(await (await post("changes",actualChange)).json()).toEqual(applied);
      const stale=structuredClone(actualChange);stale.request.idempotency_key="egypt-stale";expect((await post("changes",stale)).status).toBe(409);

      const incomplete=await packet("我明确选择阿斯旺",2),incompleteChange=change(incomplete,"egypt-incomplete",[{op:"decide_candidate",id:"candidate-aswan",value:"accept"}]);
      await expect(mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),incompleteChange)).rejects.toMatchObject({code:"INCOMPLETE_DELIVERY"});
      expect((await readState()).revision).toBe(1);

      const choice=await packet("我想选择阿斯旺"),modelChange=change(choice,"egypt-model-proposal",[{op:"decide_candidate",id:"candidate-aswan",value:"accept"}]);
      const choicePlan=await saveChangePlan(choice,"egypt-change-choice",modelChange);
      const pendingDispatch=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),choice.packet_id,choicePlan.decisionRequest.decision_id,"action-change","step-change");
      expect(pendingDispatch.disposition).toBe("executed");
      const pending=pendingDispatch.result as TripStateContracts["response"];expect(pending).toMatchObject({outcome:"pending_confirmation",revision:1,confirmation_required:true});
      expect((await readState()).revision).toBe(1);
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),choice.packet_id,choicePlan.decisionRequest.decision_id))
        .toMatchObject({actions:[{phase:"waiting_user",result_json:null}],steps:[{status:"succeeded",result_json:{outcome:"pending_confirmation"}}]});
      const confirmation:DecisionContextContracts["confirm"]={runtime_contract_version:"0.1.0",turn_id:choice.turn_id,proposal_id:pending.proposal_id!,request:{
        expected_revision:1,idempotency_key:"egypt-confirm",proposal_digest:pending.proposal_digest!,accept:true,
      }};
      const confirmedResponse=await post("confirm",confirmation);expect(confirmedResponse.status).toBe(200);
      const confirmed=await confirmedResponse.json() as TripStateContracts["response"];expect(confirmed).toMatchObject({outcome:"applied",revision:2});
      expect(await (await post("confirm",confirmation)).json()).toEqual(confirmed);

      const reviseSix=[{op:"revise",object_type:"Constraint",id:"constraint-nights",changes:{value:{kind:"duration",maximum_nights:6}}}] as TripStateContracts["change-request"]["commands"];
      const syncPacket=await packet("请把阿斯旺行程实际调整为六晚"),syncChange=change(syncPacket,"egypt-sync-retry",reviseSix);
      const syncPlan=await saveChangePlan(syncPacket,"egypt-change-receipt-recovery",syncChange);
      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),syncChange);
      const beforeSyncFailure=await counts(),syncCallsBefore=lifecycleSyncCalls;failLifecycleOnce=true;
      await expect(mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),syncPacket.packet_id,syncPlan.decisionRequest.decision_id,"action-change","step-change")).rejects.toThrow();
      expect(await readState()).toMatchObject({revision:3,objects:expect.arrayContaining([expect.objectContaining({id:"constraint-nights",value:{kind:"duration",maximum_nights:6}})])});
      const afterSyncFailure=await counts();expect(afterSyncFailure).toMatchObject({history:beforeSyncFailure.history+1,receipts:beforeSyncFailure.receipts+1});
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),syncPacket.packet_id,syncPlan.decisionRequest.decision_id))
        .toMatchObject({actions:[{phase:"running",receipt_lookup_required:true}],steps:[{status:"running"}]});
      expect((await post("turns",{entry:"dialogue",text:"生命周期未同步时读取",idempotency_key:`turn_${randomUUID()}`})).status).toBe(503);
      const syncRetry=await mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),syncPacket.packet_id,syncPlan.decisionRequest.decision_id,"action-change","step-change");
      expect(syncRetry).toMatchObject({disposition:"receipt_recovered",result:{outcome:"applied",revision:3}});expect(await counts()).toEqual(afterSyncFailure);
      expect(lifecycleSyncCalls).toBe(syncCallsBefore+2);

      const revokedPacket=await packet("请再次实际修改阿斯旺天数"),revokedChange=change(revokedPacket,"egypt-revoked",revise);
      const revokedPlan=await saveChangePlan(revokedPacket,"egypt-change-revoked",revokedChange);
      await mounted.adapter.authorizeUserChange(trip,new Headers({cookie}),revokedChange);
      const beforeRevocation={state:await readState(),counts:await counts()};revokeDuringWrite=true;
      await expect(mounted.adapter!.dispatchDecisionStepCandidate(trip,new Headers({cookie}),revokedPacket.packet_id,revokedPlan.decisionRequest.decision_id,"action-change","step-change")).rejects.toThrow();
      expect(writeGuardCalls).toBeGreaterThan(0);
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
      const recoveredRecord=await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),recoveredPacket.packet_id,"egypt-runtime-stale");
      expect(recoveredRecord.decision.runtime_id).not.toBe(afterRecovery.runtime_id);
      await expect(mounted.adapter!.claimDecisionStepCandidate(trip,new Headers({cookie}),recoveredPacket.packet_id,"egypt-runtime-stale","action-runtime","step-runtime"))
        .resolves.toMatchObject({disposition:"stale"});
      expect(await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),recoveredPacket.packet_id,"egypt-runtime-stale"))
        .toMatchObject({actions:[{phase:"stale"}],steps:[{status:"stale"}]});

      const privateText="这是一段删除后不得由 NAP 运行记录返回的用户原文",privatePacket=await packet(privateText);
      const privateRequest=await buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-private-source",
        trigger:{kind:"user_event",reference:privatePacket.pending_input.event.reference},packetIds:[privatePacket.packet_id]});
      const privatePlan=await decide(privateRequest,runtimeAdapter);await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),privateRequest,privatePlan);
      const beforeDelete=(await owner.query<{request_json:string;plan_json:string;content_available:boolean}>('SELECT request_json::text,plan_json::text,content_available FROM e04_runtime.decisions WHERE decision_id=$1',[privateRequest.decision_id])).rows[0];
      expect(beforeDelete.content_available).toBe(true);expect(beforeDelete.request_json).toContain(privateText);

      const expiryPacket=await packet("到期后不得返回这段用户原文"),expiryRequest=await buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,
        credential:new Headers({cookie}),decisionId:"egypt-expired-source",trigger:{kind:"user_event",reference:expiryPacket.pending_input.event.reference},packetIds:[expiryPacket.packet_id]});
      const expiryPlan=await decide(expiryRequest,runtimeAdapter);await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),expiryRequest,expiryPlan);
      await owner.query("UPDATE e04_runtime.decisions SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE decision_id=$1",[expiryRequest.decision_id]);
      const expiredRecord=await mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),expiryPacket.packet_id,expiryRequest.decision_id);
      expect(expiredRecord.decision).toMatchObject({content_available:false,request_json:null,plan_json:null});
      expect((await owner.query<{request_json:string;plan_json:string}>('SELECT request_json::text,plan_json::text FROM e04_runtime.decisions WHERE decision_id=$1',[expiryRequest.decision_id])).rows[0])
        .toEqual({request_json:'{"redacted": true}',plan_json:'{"redacted": true}'});

      const maintainedText="自然到期维护必须主动删除的独特用户原文",maintainedPacket=await packet(maintainedText);
      const maintainedRequest=await buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-maintained-expiry",
        trigger:{kind:"user_event",reference:maintainedPacket.pending_input.event.reference},packetIds:[maintainedPacket.packet_id]});
      const maintainedPlan=await decide(maintainedRequest,runtimeAdapter);await mounted.adapter!.saveDecisionPlanCandidate(trip,new Headers({cookie}),maintainedRequest,maintainedPlan);
      await owner.query("UPDATE e04_runtime.decisions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE decision_id=$1",[maintainedRequest.decision_id]);
      await new Promise(resolve=>setTimeout(resolve,350));
      const maintenance=await runEvidenceMaintenanceCandidate(owner,0,64);expect(maintenance).toMatchObject({redacted:expect.any(Number)});expect(maintenance.redacted).toBeGreaterThan(0);
      const maintainedRow=(await owner.query<{request_json:string;plan_json:string;content_available:boolean;decision_id:string;request_digest:string}>(
        'SELECT decision_id,request_digest,request_json::text,plan_json::text,content_available FROM e04_runtime.decisions WHERE decision_id=$1',[maintainedRequest.decision_id])).rows[0];
      expect(maintainedRow).toMatchObject({decision_id:maintainedRequest.decision_id,request_digest:expect.stringMatching(/^[a-f0-9]{64}$/),
        request_json:'{"redacted": true}',plan_json:'{"redacted": true}',content_available:false});
      expect(JSON.stringify(maintainedRow)).not.toContain(maintainedText);

      const sourceDeadlineBatch=await packetsWithTurn("来源精确期限必须进入整批最终复验");
      await owner.query(`UPDATE public."HostEvidenceTripLifecycle" SET ended_at=clock_timestamp()-interval '30 days'+interval '2 seconds' WHERE trip_id=$1`,[trip]);
      expect(Date.parse(sourceDeadlineBatch.packets[0].context.expires_at)).toBeGreaterThan(Date.now()+2_000);
      holdSourceDeadlineBatch=true;
      const sourceDeadlineRead=buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-batch-source-deadline",
        trigger:{kind:"user_event",reference:sourceDeadlineBatch.packets[0].pending_input.event.reference},packetIds:sourceDeadlineBatch.packets.map(value=>value.packet_id)});
      await sourceDeadlineBatchEntered;await new Promise(resolve=>setTimeout(resolve,2_100));holdSourceDeadlineBatch=false;releaseSourceDeadlineBatch();
      try{await expect(sourceDeadlineRead).rejects.toThrow();}finally{
        await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET ended_at=NULL WHERE trip_id=$1',[trip]);
      }

      const expiringState=await readState(),batchExpiry=new Date(Date.now()+2_000).toISOString();
      for(const object of expiringState.objects)if(object.type==="ExternalFact")object.expires_at=batchExpiry;
      await owner.query('UPDATE "TripStateDocument" SET "snapshot"=$2::jsonb WHERE "tripId"=$1',[trip,JSON.stringify(expiringState)]);
      const expiringBatch=await packetsWithTurn("同轮比较阿斯旺与卢克索");
      expect(Date.parse(expiringBatch.packets[0].context.expires_at)).toBeLessThanOrEqual(Date.parse(batchExpiry));
      holdExpiringBatch=true;
      const expiringRead=buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-batch-expired-final-check",
        trigger:{kind:"user_event",reference:expiringBatch.packets[0].pending_input.event.reference},packetIds:expiringBatch.packets.map(value=>value.packet_id)});
      await expiringBatchEntered;await new Promise(resolve=>setTimeout(resolve,2_100));holdExpiringBatch=false;releaseExpiringBatch();
      await expect(expiringRead).rejects.toThrow();

      await mounted.adapter!.deleteEvidenceEventCandidate(trip,new Headers({cookie}),privatePacket.packet_id,privatePacket.pending_input.event.event_id);
      const afterDelete=(await owner.query<{request_json:string;plan_json:string;content_available:boolean}>('SELECT request_json::text,plan_json::text,content_available FROM e04_runtime.decisions WHERE decision_id=$1',[privateRequest.decision_id])).rows[0];
      expect(afterDelete).toEqual({request_json:'{"redacted": true}',plan_json:'{"redacted": true}',content_available:false});
      await expect(mounted.adapter!.readDecisionRecordCandidate(trip,new Headers({cookie}),privatePacket.packet_id,privateRequest.decision_id)).rejects.toThrow();

      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`,[sessionId]);
      await expect(buildTrustedDecisionRequest(mounted.adapter!,{tripId:trip,credential:new Headers({cookie}),decisionId:"egypt-expired-session",
        trigger:{kind:"user_event",reference:recoveredPacket.pending_input.event.reference},packetIds:[recoveredPacket.packet_id]})).rejects.toThrow();
    } finally {
      releasePacketHandoff();
      releaseLastPageHandoff();
      releaseTrustedBatch();
      releaseExpiringBatch();
      releaseSourceDeadlineBatch();
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
