import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIdentity, type Identity } from "../../../src/server/auth/config";
import { openEvidenceHost, type ControlledInterpreter } from "../../../src/server/decision-context/host-runtime/evidence-host";
import { createPacketHttpCandidate } from "../../../src/server/decision-context/host-runtime/packet-http-candidate";
import { createSameOriginE03Gateway } from "../../../src/server/decision-context/host-runtime/same-origin-gateway-candidate";
import { runEvidenceMaintenanceCandidate } from "../../../src/server/decision-context/host-runtime/expiry-maintenance-candidate";
import { createPacketSocketDeliveryCandidate } from "../../../src/server/decision-context/host-runtime/packet-socket-delivery-candidate";
import { createShortPacketHandoffCandidate } from "../../../src/server/decision-context/host-runtime/packet-short-handoff-candidate";
import type { PacketCandidate } from "../../../src/server/decision-context/packet-core/packet";
import type { State } from "../../../src/server/trip-state/contracts.generated";
import { issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { base } from "../../support/bcg-fixtures";
import { checkpointDigest, validateCheckpoint } from "../../../src/server/decision-context/checkpoint-core";
import { digest } from "../../../src/server/trip-state/command-json";

const file = process.env.E02_STORAGE_ENV_FILE;
const config = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { migrationUrl: string; runtimeUrl: string; authUrl: string; runtimeRole: string; database: string } : null;
if (process.env.CI && !config?.authUrl) throw new Error("CI requires disposable PostgreSQL and actual Session");

describe.skipIf(!config?.authUrl)("E11 host recording and deletion with real Session and PostgreSQL", () => {
  let owner: Client, runtime: Client, identity: Identity;
  let host: Awaited<ReturnType<typeof openEvidenceHost>>;
  let internal: Awaited<ReturnType<typeof openInternalTripService>>;
  let created = false, capturedWarnings:string[]=[];
  const secret = randomBytes(32).toString("hex"), trip = `trip_e11_${randomBytes(8).toString("hex")}`;
  const env = { ...process.env, DATABASE_URL: config?.runtimeUrl, AUTH_DATABASE_URL: config?.authUrl,
    BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), E11_IDEMPOTENCY_SECRET: randomBytes(32).toString("hex") };
  async function account() {
    const email = `${randomUUID()}@example.invalid`, password = randomBytes(24).toString("base64url");
    const user = (await identity.auth.api.signUpEmail({ body: { name: "E11 test", email, password } })).user;
    const response = await identity.auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin: identity.config.origin }), asResponse: true });
    expect(response.status).toBe(200);
    const headers = new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
    const session = await identity.auth.api.getSession({ headers });
    if (!session) throw new Error("Expected authenticated session");
    return { user, headers, session, email, password };
  }
  beforeAll(async () => {
    if (!config || !/^antu_e02_test_[a-f0-9]+$/.test(config.database) || !/^antu_e02_runtime_[a-f0-9]+$/.test(config.runtimeRole)) throw new Error("Requires provisioned disposable E02 test database");
    owner = new Client({ connectionString: config.migrationUrl }); await owner.connect();
    const db = await owner.query<{ db: string }>("SELECT current_database() AS db");
    if (db.rows[0]?.db !== config.database) throw new Error("Unexpected database");
    const existing = await owner.query<{ relation: string | null }>("SELECT to_regclass('public.\"HostEvidenceEvent\"')::text AS relation");
    if (existing.rows[0]?.relation) throw new Error("Refusing to replace existing evidence tables");
    await owner.query(fs.readFileSync("src/server/decision-context/host-runtime/sql/001-evidence-record-candidate.sql", "utf8")); created = true;
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT pg_advisory_xact_lock(hashtext('e03_checkpoint_test_migration'))");
      await owner.query(fs.readFileSync("src/server/decision-context/checkpoint-store/migration.sql", "utf8"));
      await owner.query("COMMIT");
    } catch (error) { await owner.query("ROLLBACK"); throw error; }
    await owner.query(fs.readFileSync("src/server/decision-context/integration/checkpoint-evidence-candidate.sql", "utf8"));
    const role = `"${config.runtimeRole}"`;
    await owner.query(`GRANT EXECUTE ON FUNCTION public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT), public.host_evidence_for_turn_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN), public.host_evidence_checkpoint_probe_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT), public.host_evidence_bind_task_source_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT), public.host_evidence_mint_task_key_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT), public.host_checkpoint_save_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT), public.host_checkpoint_inspect_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_checkpoint_read_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_checkpoint_delete_event_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO ${role}`);
    runtime = new Client({ connectionString: config.runtimeUrl }); await runtime.connect();
    identity = await openIdentity(env);
    internal = await openInternalTripService(config.runtimeUrl, secret);
    await internal.createTrip(trip, await issueInternalCapability(secret, trip, { role: "system", id: "e11-bootstrap" }));
    // Synthetic lifecycle evidence is test-only; no trusted lifecycle adapter exists yet.
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[trip]);
    host = await openEvidenceHost(env,{onCandidatePacketWarnings:warnings=>{capturedWarnings=[...warnings];}});
  }, 30000);
  afterAll(async () => {
    await host?.close(); await internal?.close(); await identity?.close(); await runtime?.end();
    if (created) {
      await owner.query('DROP FUNCTION public.host_checkpoint_expire_batch_candidate(BIGINT,INTEGER), public.host_checkpoint_expire_event_candidate(TEXT), public.host_checkpoint_save_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT), public.host_checkpoint_inspect_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_checkpoint_read_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_checkpoint_delete_event_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT), public.host_checkpoint_sources_valid_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,BOOLEAN), public.host_checkpoint_view_valid_candidate(TEXT,TEXT,TEXT,JSONB), public.host_checkpoint_scope_candidate(TEXT,TEXT,TEXT,TEXT,TEXT)');
      await owner.query('DROP FUNCTION public.host_evidence_mint_task_key_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT), public.host_evidence_bind_task_source_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT), public.host_evidence_delete_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT), public.host_evidence_checkpoint_probe_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT), public.host_evidence_cleanup_candidate(TEXT), public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT), public.host_evidence_for_turn_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN), public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT,TEXT)');
      await owner.query('DROP TABLE public."HostEvidenceSceneEventWitness", public."HostEvidenceScene", public."HostEvidenceTaskKey", public."HostEvidenceTaskSource", public."HostEvidenceCleanup", public."HostEvidenceEvent", public."HostEvidenceWorkspace", public."HostEvidenceTripLifecycle"');
    }
    await owner?.end();
  }, 30000);
  it("binds actual sessions, persists concurrent idempotent records, denies cross-session access, and keeps deletion after failed cleanup", async () => {
    const a = await account(), b = await account();
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)', [trip, a.user.id, b.user.id]);
    const workspace = await host.createWorkspace(trip, a.headers);
    const input = { entry: "dialogue", text: "原话 🌏", idempotency_key: `key_含个人原话_${randomUUID()}` };
    const [first, second] = await Promise.all([host.record(workspace, a.headers, input), host.record(workspace, a.headers, input)]);
    expect(first.event_id).toBe(second.event_id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.durable).toBe(true);
    const replay=first.replayed?first:second;
    for(let i=0;i<10;i++) expect(await host.record(workspace,a.headers,input)).toBe(replay);
    const login = await identity.auth.api.signInEmail({ body: { email: a.email, password: a.password }, headers: new Headers({ origin: identity.config.origin }), asResponse: true });
    const otherHeaders = new Headers({ cookie: login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
    const otherSession = await identity.auth.api.getSession({ headers: otherHeaders });
    if (!otherSession) throw new Error("Expected second authenticated Session");
    expect(otherSession.session.id).not.toBe(a.session.session.id);
    await expect(host.record(workspace, otherHeaders, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
    const direct = await runtime.query("SELECT * FROM public.host_evidence_record_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [otherSession.session.id, a.user.id, trip, first.workspace_key, "0".repeat(64), 0, "event_direct", "dialogue", "x", new Date(), "b".repeat(64), "a".repeat(64)]);
    expect(direct.rows).toMatchObject([{ disposition: "denied", out_event_id: null, out_sequence: null }]);
    const directDelete = await runtime.query("SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)",
      [otherSession.session.id, a.user.id, trip, first.workspace_key, "0".repeat(64), first.event_id]);
    expect(directDelete.rows).toMatchObject([{ disposition: "denied", deletion_revision: null }]);
    const guessed = await runtime.query("SELECT * FROM public.host_evidence_for_turn_candidate($1,$2,$3,$4,$5,$6,$7,$8)",
      [a.session.session.id,a.user.id,trip,first.workspace_key,"0".repeat(64),first.event_id,"0".repeat(64),false]);
    expect(guessed.rows).toMatchObject([{allowed:false,out_body:null}]);
    const interpretation = { expected_revision:0, tasks:[{ task_key:"task-a", question:"原话", kind:"explore", target_ids:[], branch:"actual", relation:"new", related_task_keys:[], certainty:"explicit", evidence:[{start:0,end:2,quote:"原话"}], progress:"open", progress_evidence:null }], focus_keys:["task-a"] };
    const [turn, duplicate] = await Promise.all([host.registerTaskIdentity(workspace,a.headers,first,interpretation),host.registerTaskIdentity(workspace,a.headers,first,interpretation)]);
    expect(duplicate).toEqual(turn); expect(turn).toMatchObject({ revision:0, task_keys:["task-a"], focus_keys:["task-a"] });
    await expect(host.registerTaskIdentity(workspace,a.headers,{...first},interpretation)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(host.registerTaskIdentity(workspace,otherHeaders,first,interpretation)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(host.registerTaskIdentity(workspace,a.headers,first,{...interpretation,tasks:[{...interpretation.tasks[0],question:"修改"}]})).rejects.toMatchObject({code:"EVENT_REUSE"});
    const next = await host.record(workspace,a.headers,{entry:"dialogue",text:"下一条",idempotency_key:`next_${randomUUID()}`});
    const badTarget={expected_revision:0,tasks:[{...interpretation.tasks[0],task_key:"task-b",target_ids:["missing"],evidence:[{start:0,end:2,quote:"下一"}]}],focus_keys:["task-b"]};
    await expect(host.registerTaskIdentity(workspace,a.headers,next,badTarget)).rejects.toMatchObject({code:"TARGET_NOT_FOUND"});
    const continued={expected_revision:0,tasks:[{...interpretation.tasks[0],relation:"continue",evidence:[{start:0,end:2,quote:"下一"}]}],focus_keys:["task-a"]};
    await host.registerTaskIdentity(workspace,a.headers,next,continued);
    await expect(host.record(workspace, a.headers, { ...input, text: "不同正文" })).rejects.toMatchObject({ code: "EVENT_KEY_CONFLICT" });
    await expect(host.record(workspace, b.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
    await expect(host.record({ ...workspace }, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
    await expect(runtime.query('SELECT body FROM public."HostEvidenceEvent"')).rejects.toThrow();
    const deleted = await host.deleteEvent(workspace, a.headers, first.event_id);
    expect(deleted).toMatchObject({ durable: true, cleanup_pending: true });
    expect(await host.deleteEvent(workspace, a.headers, first.event_id)).toEqual(deleted);
    await expect(host.record(workspace, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_DELETED" });
    await expect(host.registerTaskIdentity(workspace,a.headers,first,interpretation)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(host.registerTaskIdentity(workspace,a.headers,next,continued)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    const independent=await host.record(workspace,a.headers,{entry:"dialogue",text:"下一条",idempotency_key:`independent_${randomUUID()}`});
    await expect(host.registerTaskIdentity(workspace,a.headers,independent,{...badTarget,tasks:[{...badTarget.tasks[0],target_ids:[]}]})).resolves.toMatchObject({task_keys:["task-b"]});
    await owner.query("BEGIN");
    await owner.query("SELECT public.host_evidence_cleanup_candidate($1)", [first.event_id]);
    await owner.query("ROLLBACK");
    const pending = await owner.query('SELECT body,deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1', [first.event_id]);
    expect(pending.rows[0]).toMatchObject({ body: input.text }); expect(pending.rows[0].deleted_at).toBeTruthy();
    await expect(host.record(workspace, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_DELETED" });
    await owner.query("SELECT public.host_evidence_cleanup_candidate($1)", [first.event_id]);
    await owner.query("SELECT public.host_evidence_cleanup_candidate($1)", [first.event_id]);
    const cleaned = await owner.query('SELECT body,input_digest,session_ref,key_token,deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1', [first.event_id]);
    expect(cleaned.rows[0]).toMatchObject({ body: null, input_digest: null, session_ref: null }); expect(cleaned.rows[0].deleted_at).toBeTruthy();
    expect(cleaned.rows[0].key_token).toMatch(/^[0-9a-f]{64}$/);
    expect(cleaned.rows[0].key_token).not.toContain(input.idempotency_key);
    expect((await host.deleteEvent(workspace, a.headers, first.event_id)).cleanup_pending).toBe(false);
    await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [trip, a.user.id]);
    await expect(host.record(workspace, a.headers, input)).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
  }, 30000);
  it("binds same-session workspaces to distinct database capabilities and invalidates stale deletion revisions", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const wa=await host.createWorkspace(trip,a.headers), wb=await host.createWorkspace(trip,a.headers);
    const ea=await host.record(wa,a.headers,{entry:"dialogue",text:"A secret",idempotency_key:`a_${randomUUID()}`});
    const eb=await host.record(wb,a.headers,{entry:"dialogue",text:"B secret",idempotency_key:`b_${randomUUID()}`});
    const caps=await owner.query<{workspace_key:string;capability_token:string}>('SELECT workspace_key,capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=ANY($3::text[])',[a.user.id,trip,[ea.workspace_key,eb.workspace_key]]);
    const ca=caps.rows.find(r=>r.workspace_key===ea.workspace_key)!.capability_token;
    const cb=caps.rows.find(r=>r.workspace_key===eb.workspace_key)!.capability_token;
    expect(ca).not.toBe(cb); expect(ca).toMatch(/^[0-9a-f]{64}$/);
    const probe=async (workspace:string,capability:string,revision:number) => (await runtime.query<{ok:boolean}>('SELECT public.host_evidence_checkpoint_probe_candidate($1,$2,$3,$4,$5,$6) AS ok',[a.session.session.id,a.user.id,trip,workspace,capability,revision])).rows[0].ok;
    expect(await probe(ea.workspace_key,ca,0)).toBe(true);
    expect(await probe(eb.workspace_key,cb,0)).toBe(true);
    expect(await probe(eb.workspace_key,ca,0)).toBe(false);
    expect(await probe(ea.workspace_key,cb,0)).toBe(false);
    const wrongDelete=await runtime.query('SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,trip,eb.workspace_key,ca,eb.event_id]);
    expect(wrongDelete.rows).toMatchObject([{disposition:"denied",deletion_revision:null,accepted_at:null}]);
    const wrongRead=await runtime.query('SELECT * FROM public.host_evidence_for_turn_candidate($1,$2,$3,$4,$5,$6,$7,$8)',[a.session.session.id,a.user.id,trip,eb.workspace_key,ca,eb.event_id,"0".repeat(64),false]);
    expect(wrongRead.rows).toMatchObject([{allowed:false,out_entry:null,out_body:null,out_received_at:null}]);
    await expect(runtime.query('SELECT capability_token FROM public."HostEvidenceWorkspace"')).rejects.toThrow();
    await host.deleteEvent(wa,a.headers,ea.event_id);
    expect(await probe(ea.workspace_key,ca,0)).toBe(false);
    expect(await probe(ea.workspace_key,ca,1)).toBe(true);
    expect(await probe(eb.workspace_key,cb,0)).toBe(true);
    await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,a.user.id]);
    expect(await probe(ea.workspace_key,ca,1)).toBe(false);
  },30000);
  it("extends an old source only through a verified related interaction, within its twelve-month cap",async()=>{
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),key=await host.mintTaskKey(ticket,a.headers,"retention-task");
    const firstText="阿斯旺交通",nextText="继续比较交通",unrelatedText="无关联聊天";
    const first=await host.record(ticket,a.headers,{entry:"dialogue",text:firstText,idempotency_key:`retention_${randomUUID()}`});
    const task=(text:string,relation:"new"|"continue")=>({task_key:key,question:text,kind:"explore",target_ids:[],branch:"actual",relation,related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null});
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '179 days' WHERE event_id=$1`,[first.event_id]);
    await host.registerTaskIdentity(ticket,a.headers,first,{expected_revision:0,tasks:[task(firstText,"new")],focus_keys:[key]});
    await host.record(ticket,a.headers,{entry:"dialogue",text:unrelatedText,idempotency_key:`unrelated_${randomUUID()}`});
    const scope=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,first.workspace_key])).rows[0].capability_token;
    const token=(await owner.query<{key_token:string}>('SELECT key_token FROM public."HostEvidenceEvent" WHERE event_id=$1',[first.event_id])).rows[0].key_token;
    const read=async()=> (await runtime.query<{allowed:boolean}>('SELECT allowed FROM public.host_evidence_for_turn_candidate($1,$2,$3,$4,$5,$6,$7,FALSE)',[a.session.session.id,a.user.id,trip,first.workspace_key,scope,first.event_id,token])).rows[0].allowed;
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '181 days' WHERE event_id=$1`,[first.event_id]);
    expect(await read()).toBe(false); // a later unlinked message cannot renew this source
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '179 days' WHERE event_id=$1`,[first.event_id]);
    const related=await host.record(ticket,a.headers,{entry:"dialogue",text:nextText,idempotency_key:`related_${randomUUID()}`});
    await host.registerTaskIdentity(ticket,a.headers,related,{expected_revision:0,tasks:[task(nextText,"continue")],focus_keys:[key]});
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '181 days' WHERE event_id=$1`,[first.event_id]);
    expect(await read()).toBe(true);
    expect((await owner.query<{disposition:string}>('SELECT public.host_checkpoint_expire_event_candidate($1) AS disposition',[first.event_id])).rows[0].disposition).toBe("retained");
    await owner.query(`UPDATE public."HostEvidenceEvent" SET deleted_at=clock_timestamp() WHERE event_id=$1`,[related.event_id]);
    expect(await read()).toBe(false); // a deleted peer cannot renew the old source
    await owner.query(`UPDATE public."HostEvidenceEvent" SET deleted_at=NULL WHERE event_id=$1`,[related.event_id]);
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '13 months' WHERE event_id=$1`,[first.event_id]);
    expect(await read()).toBe(false); // the event's own twelve-month cap remains absolute
    expect((await owner.query<{disposition:string}>('SELECT public.host_checkpoint_expire_event_candidate($1) AS disposition',[first.event_id])).rows[0].disposition).toBe("expired");
  },30000);
  it("marks natural expiry before physical cleanup and invalidates a live host across the database boundary",async()=>{
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),key=await host.mintTaskKey(ticket,a.headers,"expiry-maintenance-task");
    const text="阿斯旺原话",event=await host.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`expiry_maintenance_${randomUUID()}`});
    const task={task_key:key,question:text,kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null};
    const input={expected_revision:0,tasks:[task],focus_keys:[key]};
    const turn=await host.registerTaskIdentity(ticket,a.headers,event,input);
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,turn.turn_id,key,4096,input)).resolves.toMatchObject({state_revision:0});
    await expect(runtime.query('SELECT public.host_checkpoint_expire_event_candidate($1)',[event.event_id])).rejects.toThrow();
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '181 days' WHERE event_id=$1`,[event.event_id]);
    const scope=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rows[0].capability_token;
    const token=(await owner.query<{key_token:string}>('SELECT key_token FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].key_token;
    const read=async()=> (await runtime.query<{allowed:boolean}>('SELECT allowed FROM public.host_evidence_for_turn_candidate($1,$2,$3,$4,$5,$6,$7,FALSE)',[a.session.session.id,a.user.id,trip,event.workspace_key,scope,event.event_id,token])).rows[0].allowed;
    expect(await read()).toBe(false); // strict DB-clock stop-read precedes the scheduled sweep
    const scanned=await owner.query<{out_sequence:string;out_event_id:string;disposition:string}>('SELECT * FROM public.host_checkpoint_expire_batch_candidate($1,$2)',[event.sequence-1,1]);
    expect(scanned.rows).toEqual([{out_sequence:String(event.sequence),out_event_id:event.event_id,disposition:"expired"}]);
    expect((await owner.query('SELECT body,deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0]).toMatchObject({body:text,deleted_at:expect.any(Date)});
    expect((await owner.query('SELECT completed_at,cutoff_sequence FROM public."HostEvidenceCleanup" WHERE event_id=$1',[event.event_id])).rows[0]).toMatchObject({completed_at:null,cutoff_sequence:String(event.sequence)});
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,turn.turn_id,key,4096,input)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    expect(await read()).toBe(false);
    await owner.query('SELECT public.host_evidence_cleanup_candidate($1)',[event.event_id]);
    expect((await owner.query('SELECT body,input_digest,session_ref FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0]).toEqual({body:null,input_digest:null,session_ref:null});
    expect((await owner.query('SELECT completed_at FROM public."HostEvidenceCleanup" WHERE event_id=$1',[event.event_id])).rows[0].completed_at).toBeInstanceOf(Date);
    expect((await owner.query<{disposition:string}>('SELECT public.host_checkpoint_expire_event_candidate($1) AS disposition',[event.event_id])).rows[0].disposition).toBe("already_deleted");
  },30000);
  it("uses a matching trusted trip lifecycle for the thirty-day expiry cutoff",async()=>{
    const t=`trip_expiry_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(t,await issueInternalCapability(secret,t,{role:"system",id:"expiry-test"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle"(trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[t]);
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[t,a.user.id]);
    const ticket=await host.createWorkspace(t,a.headers),event=await host.record(ticket,a.headers,{entry:"dialogue",text:"旅行原话",idempotency_key:`trip_expiry_${randomUUID()}`});
    await owner.query(`UPDATE public."HostEvidenceTripLifecycle" SET source_revision=1,ended_at=clock_timestamp()-interval '31 days' WHERE trip_id=$1`,[t]);
    expect((await owner.query<{disposition:string}>('SELECT public.host_checkpoint_expire_event_candidate($1) AS disposition',[event.event_id])).rows[0].disposition).toBe("retained");
    await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET source_revision=0 WHERE trip_id=$1',[t]);
    expect((await owner.query<{disposition:string}>('SELECT public.host_checkpoint_expire_event_candidate($1) AS disposition',[event.event_id])).rows[0].disposition).toBe("expired");
    const row=(await owner.query<{deleted_at:Date;completed_at:Date|null}>('SELECT e.deleted_at,c.completed_at FROM public."HostEvidenceEvent" e JOIN public."HostEvidenceCleanup" c USING(event_id) WHERE e.event_id=$1',[event.event_id])).rows[0];
    expect(row.deleted_at).toBeInstanceOf(Date);expect(row.completed_at).toBeNull();
  },30000);
  it("runs a bounded maintenance pass with separate durable marker and physical cleanup statements",async()=>{
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),event=await host.record(ticket,a.headers,{entry:"dialogue",text:"自动清理原话",idempotency_key:`auto_expiry_${randomUUID()}`});
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '181 days' WHERE event_id=$1`,[event.event_id]);
    await owner.query(`CREATE FUNCTION public.e11_cleanup_failure_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_id=current_setting('e11.cleanup_test_event',true) AND NEW.body IS NULL THEN RAISE EXCEPTION 'injected cleanup failure'; END IF;
      RETURN NEW; END $$`);
    await owner.query('CREATE TRIGGER e11_cleanup_failure_test BEFORE UPDATE ON public."HostEvidenceEvent" FOR EACH ROW EXECUTE FUNCTION public.e11_cleanup_failure_test()');
    try {
      await owner.query("SELECT set_config('e11.cleanup_test_event',$1,FALSE)",[event.event_id]);
      const failed=await runEvidenceMaintenanceCandidate(owner,event.sequence-1,1);
      expect(failed).toMatchObject({scanned:1,expired:1,cleaned:0,cleanupFailed:1,nextSequence:event.sequence});
      expect((await owner.query('SELECT body,deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0]).toMatchObject({body:"自动清理原话",deleted_at:expect.any(Date)});
    } finally {
      await owner.query('DROP TRIGGER e11_cleanup_failure_test ON public."HostEvidenceEvent"');
      await owner.query('DROP FUNCTION public.e11_cleanup_failure_test()');
    }
    const retried=await runEvidenceMaintenanceCandidate(owner,event.sequence,256);
    expect(retried.expired).toBe(0);expect(retried.cleaned).toBeGreaterThanOrEqual(1);expect(retried.cleanupFailed).toBe(0);
    const row=(await owner.query<{body:string|null;deleted_at:Date;completed_at:Date}>('SELECT e.body,e.deleted_at,c.completed_at FROM public."HostEvidenceEvent" e JOIN public."HostEvidenceCleanup" c USING(event_id) WHERE e.event_id=$1',[event.event_id])).rows[0];
    expect(row).toMatchObject({body:null,deleted_at:expect.any(Date),completed_at:expect.any(Date)});
    expect((await runEvidenceMaintenanceCandidate(owner,event.sequence-1,1)).expired).toBe(0);
  },30000);
  it("rechecks deletion revision after waiting for the workspace lock", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers);
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"serialized",idempotency_key:`lock_${randomUUID()}`});
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rows[0].capability_token;
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN"); let committed=false;
    try {
      await owner.query('SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 FOR UPDATE',[a.user.id,trip,event.workspace_key]);
      const pending=runtime.query<{ok:boolean}>('SELECT public.host_evidence_checkpoint_probe_candidate($1,$2,$3,$4,$5,$6) AS ok',[a.session.session.id,a.user.id,trip,event.workspace_key,cap,0]);
      let blocked=false;
      for(let i=0;i<100;i++) {
        const r=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_evidence_checkpoint_probe_candidate%') AS blocked",[pid]);
        if(r.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      const deleted=await owner.query('SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,trip,event.workspace_key,cap,event.event_id]);
      expect(deleted.rows).toMatchObject([{disposition:"deleted"}]);
      await owner.query("COMMIT"); committed=true;
      expect((await pending).rows).toEqual([{ok:false}]);
    } finally { if(!committed) await owner.query("ROLLBACK"); await observer.end(); }
  },30000);
  it("rechecks session expiry after waiting for the workspace lock", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers);
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"deadline",idempotency_key:`deadline_${randomUUID()}`});
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rows[0].capability_token;
    await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[a.session.session.id]);
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN"); let committed=false;
    try {
      await owner.query('SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 FOR UPDATE',[a.user.id,trip,event.workspace_key]);
      const pending=runtime.query<{ok:boolean}>('SELECT public.host_evidence_checkpoint_probe_candidate($1,$2,$3,$4,$5,$6) AS ok',[a.session.session.id,a.user.id,trip,event.workspace_key,cap,0]);
      let blocked=false,expired=false;
      for(let i=0;i<150 && !(blocked && expired);i++) {
        const r=await observer.query<{blocked:boolean;expired:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_evidence_checkpoint_probe_candidate%') AS blocked, (SELECT "expiresAt"<=clock_timestamp() FROM "AuthSession" WHERE id=$2) AS expired`,[pid,a.session.session.id]);
        blocked ||= r.rows[0].blocked; expired ||= r.rows[0].expired;
        if(!(blocked && expired)) await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true); expect(expired).toBe(true);
      await owner.query("COMMIT"); committed=true;
      expect((await pending).rows).toEqual([{ok:false}]);
    } finally { if(!committed) await owner.query("ROLLBACK"); await observer.end(); }
  },30000);
  it("refuses to start if its runtime role can bypass E11 through checkpoint Session SQL", async () => {
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT pg_advisory_xact_lock(hashtext('e03_checkpoint_test_migration'))");
      await owner.query(fs.readFileSync("src/server/decision-context/checkpoint-store/migration.sql", "utf8"));
      await owner.query("COMMIT");
    } catch (error) { await owner.query("ROLLBACK"); throw error; }
    const role=`"${config!.runtimeRole}"`;
    await owner.query(`GRANT USAGE ON SCHEMA e03_checkpoint TO ${role}`);
    await owner.query(`GRANT EXECUTE ON FUNCTION e03_checkpoint.session_read_scene(text,text,text,text,text) TO ${role}`);
    try { await expect(openEvidenceHost(env)).rejects.toThrow("without checkpoint access"); }
    finally {
      await owner.query(`REVOKE EXECUTE ON FUNCTION e03_checkpoint.session_read_scene(text,text,text,text,text) FROM ${role}`);
      await owner.query(`REVOKE USAGE ON SCHEMA e03_checkpoint FROM ${role}`);
    }
    const rawDelete="public.host_evidence_delete_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)";
    await owner.query(`GRANT EXECUTE ON FUNCTION ${rawDelete} TO ${role}`);
    try { await expect(openEvidenceHost(env)).rejects.toThrow("without checkpoint access"); }
    finally { await owner.query(`REVOKE EXECUTE ON FUNCTION ${rawDelete} FROM ${role}`); }
    await owner.query(`GRANT EXECUTE ON FUNCTION ${rawDelete} TO PUBLIC`);
    try { await expect(openEvidenceHost(env)).rejects.toThrow("without checkpoint access"); }
    finally { await owner.query(`REVOKE EXECUTE ON FUNCTION ${rawDelete} FROM PUBLIC`); }
    const inherited=`"e11_parent_${randomBytes(8).toString("hex")}"`;
    await owner.query(`CREATE ROLE ${inherited} NOLOGIN`);
    try {
      await owner.query(`GRANT EXECUTE ON FUNCTION ${rawDelete} TO ${inherited}`);
      await owner.query(`GRANT ${inherited} TO ${role}`);
      await expect(openEvidenceHost(env)).rejects.toThrow("without checkpoint access");
    } finally {
      await owner.query(`REVOKE ${inherited} FROM ${role}`);
      await owner.query(`REVOKE EXECUTE ON FUNCTION ${rawDelete} FROM ${inherited}`);
      await owner.query(`DROP ROLE ${inherited}`);
    }
  },30000);
  it("saves and inspects a source-bound checkpoint without exposing its payload; cross-workspace, tamper and deletion fail closed", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const wa=await host.createWorkspace(trip,a.headers), wb=await host.createWorkspace(trip,a.headers);
    const keyA=await host.mintTaskKey(wa,a.headers,"task-key-a"),keyB=await host.mintTaskKey(wb,a.headers,"task-key-b");
    const firstInput={entry:"dialogue",text:"trusted source",idempotency_key:`checkpoint_${randomUUID()}`};
    const ea=await host.record(wa,a.headers,firstInput);
    const ebInput={entry:"dialogue",text:"other source",idempotency_key:`checkpoint_${randomUUID()}`};
    const eb=await host.record(wb,a.headers,ebInput);
    const task={task_key:keyA,question:"trusted",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:7,quote:"trusted"}],progress:"open",progress_evidence:null};
    const originalTurn=await host.registerTaskIdentity(wa,a.headers,ea,{expected_revision:0,tasks:[task],focus_keys:[keyA]});
    const priorUnrelatedInput={entry:"dialogue",text:"unsaved old event",idempotency_key:`unsaved_${randomUUID()}`};
    const priorUnrelated=await host.record(wa,a.headers,priorUnrelatedInput);
    const caps=await owner.query<{workspace_key:string;capability_token:string}>('SELECT workspace_key,capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=ANY($3::text[])',[a.user.id,trip,[ea.workspace_key,eb.workspace_key]]);
    const ca=caps.rows.find(r=>r.workspace_key===ea.workspace_key)!.capability_token, cb=caps.rows.find(r=>r.workspace_key===eb.workspace_key)!.capability_token;
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[ea.event_id])).rows[0].received_at.toISOString();
    const input={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],
      tasks:[{task,event:{event_id:ea.event_id,entry:"dialogue",text:"trusted source",reference:`host-interaction:${ea.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],
      focus_keys:[keyA],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    const payload=validateCheckpoint(input,trip,0), now=new Date().toISOString();
    const save=async (workspace:string,cap:string,value:unknown,key:string) => {
      const req=digest({expected_revision:0,payload:value,deleted:false});
      return (await runtime.query<{value:{fault?:string;ack?:{checkpoint_revision:number}}}>(
        'SELECT public.host_checkpoint_save_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) AS value',
        [a.session.session.id,a.user.id,trip,workspace,cap,0,key,req,JSON.stringify(value),checkpointDigest(payload),now,null])).rows[0].value;
    };
    const inspect=async (workspace:string,cap:string) => (await runtime.query<{value:Record<string,unknown>}>(
      'SELECT public.host_checkpoint_inspect_candidate($1,$2,$3,$4,$5) AS value',[a.session.session.id,a.user.id,trip,workspace,cap])).rows[0].value;
    expect(await save(ea.workspace_key,cb,payload,"wrong-cap")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    expect(await save(eb.workspace_key,ca,payload,"wrong-workspace")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    expect(await save(ea.workspace_key,ca,{...payload,drafts:[{}]},"draft")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    expect(await save(ea.workspace_key,ca,{...payload,captured_object_versions:[{id:"fake",version:1}]},"fake-versions")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    const missingView=structuredClone(payload); missingView.view.selected_id="missing-object";
    expect(await save(ea.workspace_key,ca,missingView,"missing-view")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    const missingComparison=structuredClone(payload); missingComparison.view.comparison_refs=[{id:"missing-object",version:1}];
    expect(await save(ea.workspace_key,ca,missingComparison,"missing-comparison")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    await expect(runtime.query('SELECT * FROM public.host_evidence_delete_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,trip,ea.workspace_key,ca,ea.event_id])).rejects.toThrow();
    const altered=structuredClone(payload); altered.tasks[0].task.question="forged";
    expect(await save(ea.workspace_key,ca,altered,"forged")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    const forgedEvent=structuredClone(payload); forgedEvent.tasks[0].event.reference=`host-interaction:${eb.event_id}`;
    expect(await save(ea.workspace_key,ca,forgedEvent,"forged-reference")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    const forgedText=structuredClone(payload); forgedText.tasks[0].event.text="different body";
    expect(await save(ea.workspace_key,ca,forgedText,"forged-text")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    expect(await host.saveCheckpoint(wa,a.headers,payload,0,"save")).toMatchObject({checkpoint_revision:1});
    expect(await host.saveCheckpoint(wa,a.headers,payload,0,"save")).toMatchObject({checkpoint_revision:1});
    const witness=await owner.query<{event_id:string}>(`SELECT w.event_id FROM public."HostEvidenceSceneEventWitness" w JOIN public."HostEvidenceScene" s ON s.scene_ref=w.scene_ref WHERE s.owner_id=$1 AND s.trip_id=$2 AND s.workspace_key=$3`,[a.user.id,trip,ea.workspace_key]);
    expect(witness.rows).toEqual([{event_id:ea.event_id}]);
    // The other event may still have contributed to question: omission from
    // the positive witness is not evidence of independence.
    expect(witness.rows.some(row=>row.event_id===priorUnrelated.event_id)).toBe(false);
    await expect(runtime.query('SELECT * FROM public."HostEvidenceSceneEventWitness"')).rejects.toThrow();
    await owner.query(`GRANT SELECT ON public."HostEvidenceSceneEventWitness" TO "${config!.runtimeRole}"`);
    try { await expect(openEvidenceHost(env)).rejects.toThrow("without checkpoint access"); }
    finally { await owner.query(`REVOKE SELECT ON public."HostEvidenceSceneEventWitness" FROM "${config!.runtimeRole}"`); }
    expect(await host.inspectCheckpoint(wa,a.headers)).toMatchObject({revision:1});
    // An event not declared in TaskSource is still a possible source. Its
    // expiry closes the whole candidate, even while the selected event is live.
    const priorStamp=(await owner.query<{recorded_at:string}>('SELECT recorded_at::text FROM public."HostEvidenceEvent" WHERE event_id=$1',[priorUnrelated.event_id])).rows[0].recorded_at;
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days' WHERE event_id=$1`,[priorUnrelated.event_id]);
    await expect(host.restoreCheckpoint(wa,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=$2::timestamptz WHERE event_id=$1',[priorUnrelated.event_id,priorStamp]);
    expect(await inspect(ea.workspace_key,ca)).toMatchObject({revision:1});
    expect(await inspect(ea.workspace_key,ca)).not.toHaveProperty("payload");
    expect(await inspect(ea.workspace_key,ca)).not.toHaveProperty("event_highwater");
    // The companion may be corrupted by an administrator or failed restore.
    // Internal recovery must reject it without installing any partial state.
    await owner.query(`UPDATE public."HostEvidenceScene" SET payload=jsonb_set(payload,'{tasks,0,task,question}',to_jsonb('forged'::text)) WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3`,[a.user.id,trip,ea.workspace_key]);
    await expect(host.restoreCheckpoint(wa,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    await owner.query('UPDATE public."HostEvidenceScene" SET payload=$4::jsonb WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,ea.workspace_key,JSON.stringify(payload)]);
    await owner.query(`UPDATE public."HostEvidenceScene" SET payload=jsonb_set(payload,'{view,entry}',to_jsonb('map'::text)) WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3`,[a.user.id,trip,ea.workspace_key]);
    await expect(host.restoreCheckpoint(wa,a.headers)).rejects.toMatchObject({code:"CHECKPOINT_CORRUPT"});
    await owner.query('UPDATE public."HostEvidenceScene" SET payload=$4::jsonb WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,ea.workspace_key,JSON.stringify(payload)]);
    const businessSnapshot=async()=> (await owner.query(`SELECT d."revision",d.snapshot,
      (SELECT count(*) FROM "TripStateHistory" WHERE "tripId"=$1) AS history_count,
      (SELECT count(*) FROM "TripStateProposal" WHERE "tripId"=$1) AS proposal_count,
      (SELECT count(*) FROM "TripStateIdempotency" WHERE "tripId"=$1) AS request_count
      FROM "TripStateDocument" d WHERE d."tripId"=$1`,[trip])).rows[0];
    const businessBefore=await businessSnapshot();
    const restored=await host.restoreCheckpoint(wa,a.headers,2);
    expect(await businessSnapshot()).toEqual(businessBefore);
    expect(restored).toMatchObject({checkpoint_revision:1,saved_state_revision:0,current_state_revision:0,restored_task_count:1,candidate_turn_count:1,candidate_packet_count:1,candidate_save_unacknowledged:false});
    expect(restored.runtime_id).not.toBe(originalTurn.runtime_id);
    expect(restored).not.toHaveProperty("payload");
    await expect(host.saveCheckpoint(wa,a.headers,payload,7,"conflict-save")).rejects.toMatchObject({code:"CHECKPOINT_CONFLICT"});
    await host.restoreCheckpoint(wa,a.headers,2);
    expect(capturedWarnings).toContain("scene_save_unacknowledged_business_state_is_separate");
    // Replaying an older success must not erase a distinct failed request.
    expect(await host.saveCheckpoint(wa,a.headers,payload,0,"save")).toMatchObject({checkpoint_revision:1});
    const pendingRestore=await host.restoreCheckpoint(wa,a.headers,2);
    expect(pendingRestore).toMatchObject({candidate_save_unacknowledged:true});
    expect(capturedWarnings).toContain("scene_save_unacknowledged_business_state_is_separate");
    await expect(host.registerTaskIdentity(wa,a.headers,ea,{expected_revision:0,tasks:[task],focus_keys:[keyA]})).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    const replayed=await host.record(wa,a.headers,firstInput);
    expect(replayed.event_id).toBe(ea.event_id);
    await expect(host.registerTaskIdentity(wa,a.headers,replayed,{expected_revision:0,tasks:[task],focus_keys:[keyA]})).rejects.toMatchObject({code:"RECOVERED_EVENT_REPLAY"});
    const unsavedReplay=await host.record(wa,a.headers,priorUnrelatedInput);
    await expect(host.registerTaskIdentity(wa,a.headers,unsavedReplay,{expected_revision:0,tasks:[task],focus_keys:[keyA]})).rejects.toMatchObject({code:"RECOVERED_EVENT_REPLAY"});
    // Recovery holds a workspace share lock while computing its sequence
    // watermark; a concurrent event insert must wait and get a later sequence.
    const observerRecord=new Client({connectionString:config!.migrationUrl}); await observerRecord.connect();
    const runtimePid=(await runtime.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await runtime.query("BEGIN"); let snapshotCommitted=false;
    try {
      const snapshot=(await runtime.query<{value:{event_highwater:number}}>('SELECT public.host_checkpoint_read_candidate($1,$2,$3,$4,$5) AS value',[a.session.session.id,a.user.id,trip,ea.workspace_key,ca])).rows[0].value;
      const freshInput={entry:"dialogue",text:"fresh",idempotency_key:`fresh_${randomUUID()}`};
      const pending=host.record(wa,a.headers,freshInput); let blocked=false;
      for(let i=0;i<100;i++) {
        const r=await observerRecord.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_evidence_record_candidate%') AS blocked",[runtimePid]);
        if(r.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      await runtime.query("COMMIT"); snapshotCommitted=true;
      const fresh=await pending; expect(fresh.sequence).toBeGreaterThan(snapshot.event_highwater);
      const freshTask={...task,task_key:"fresh-task",question:"fresh",evidence:[{start:0,end:5,quote:"fresh"}]};
      expect((await host.registerTaskIdentity(wa,a.headers,fresh,{expected_revision:0,tasks:[freshTask],focus_keys:["fresh-task"]})).runtime_id).toBe(pendingRestore.runtime_id);
    } finally { if(!snapshotCommitted) await runtime.query("ROLLBACK"); await observerRecord.end(); }
    const childCode=`import {openEvidenceHost} from './src/server/decision-context/host-runtime/evidence-host.ts';
      const host=await openEvidenceHost(process.env); try { await host.restoreCheckpoint({},new Headers({cookie:process.env.E03_TEST_COOKIE})); process.exitCode=2; }
      catch(e){ process.stdout.write(e.code||'unexpected'); } finally { await host.close(); }`;
    const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","--eval",childCode],{cwd:process.cwd(),encoding:"utf8",timeout:15000,env:{...env,E03_TEST_COOKIE:a.headers.get("cookie")!}});
    expect(child.status).toBe(0); expect(child.stdout).toBe("EVIDENCE_ACCESS_DENIED");
    const login=await identity.auth.api.signInEmail({body:{email:a.email,password:a.password},headers:new Headers({origin:identity.config.origin}),asResponse:true});
    const newHeaders=new Headers({cookie:login.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ")});
    await expect(host.restoreCheckpoint(wa,newHeaders)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    const otherHost=await openEvidenceHost(env);
    try { await expect(otherHost.restoreCheckpoint(wa,a.headers)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"}); }
    finally { await otherHost.close(); }
    // Synthetic owner-controlled revision update tests that an older checkpoint
    // is compared against the newest held TS snapshot, not written back to it.
    await owner.query(`UPDATE public."TripStateDocument" SET "revision"=1,snapshot=jsonb_set(snapshot,'{revision}','1'::jsonb) WHERE "tripId"=$1`,[trip]);
    await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET source_revision=1 WHERE trip_id=$1',[trip]);
    expect(await host.restoreCheckpoint(wa,a.headers)).toMatchObject({saved_state_revision:0,current_state_revision:1});
    await owner.query(`UPDATE public."TripStateDocument" SET "revision"=0,snapshot=jsonb_set(snapshot,'{revision}','0'::jsonb) WHERE "tripId"=$1`,[trip]);
    await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET source_revision=0 WHERE trip_id=$1',[trip]);
    const stored=(await owner.query<{payload:unknown}>('SELECT payload FROM e03_checkpoint.heads WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3',[`user-${a.user.id}`,trip,ea.workspace_key])).rows[0].payload;
    expect(stored).toEqual({e11_scene_ref:expect.stringMatching(/^[0-9a-f]{64}$/)});
    expect(JSON.stringify(stored)).not.toContain("trusted source");
    const receiptKey=(await owner.query<{operation_key:string}>('SELECT operation_key FROM e03_checkpoint.receipts WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3',[`user-${a.user.id}`,trip,ea.workspace_key])).rows[0].operation_key;
    expect(receiptKey).toMatch(/^[0-9a-f]{64}$/); expect(receiptKey).not.toBe("save");
    const scene=(await owner.query<{payload:unknown}>('SELECT payload FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,ea.workspace_key])).rows[0].payload;
    expect(scene).toEqual(payload);
    await expect(runtime.query('SELECT payload FROM public."HostEvidenceScene"')).rejects.toThrow();
    // Isolated owner fixture exercises R6's view rule against one held TS
    // snapshot, including the exact unchanged historical-view exception.
    await owner.query("BEGIN");
    try {
      await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}', $2::jsonb) WHERE "tripId"=$1`,[trip,JSON.stringify([{id:"known",version:2}])]);
      const view=async (value:unknown) => (await owner.query<{ok:boolean}>('SELECT public.host_checkpoint_view_valid_candidate($1,$2,$3,$4::jsonb) AS ok',[a.user.id,trip,ea.workspace_key,JSON.stringify(value)])).rows[0].ok;
      const oldVersion={...payload.view,selected_id:"known",comparison_refs:[{id:"known",version:1}]};
      expect(await view(oldVersion)).toBe(true);
      expect(await view({...oldVersion,comparison_refs:[{id:"known",version:3}]})).toBe(false);
      const historical={...payload.view,selected_id:"removed"};
      expect(await view(historical)).toBe(false);
      await owner.query(`UPDATE public."HostEvidenceScene" SET payload=jsonb_set(payload,'{view}',$4::jsonb) WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3`,[a.user.id,trip,ea.workspace_key,JSON.stringify(historical)]);
      expect(await view(historical)).toBe(true);
    } finally { await owner.query("ROLLBACK"); }
    // A continuation also depends on the original event. A fresh latest event
    // cannot rescue an expired earlier source in the same Task's lineage.
    const bTask={...task,task_key:keyB,question:"other",evidence:[{start:0,end:5,quote:"other"}]};
    await host.registerTaskIdentity(wb,a.headers,eb,{expected_revision:0,tasks:[bTask],focus_keys:[keyB]});
    const bNextInput={entry:"dialogue",text:"follow",idempotency_key:`continue_${randomUUID()}`};
    const bNext=await host.record(wb,a.headers,bNextInput);
    const bContinue={...bTask,relation:"continue",evidence:[{start:0,end:6,quote:"follow"}]};
    await host.registerTaskIdentity(wb,a.headers,bNext,{expected_revision:0,tasks:[bContinue],focus_keys:[keyB]});
    const bReceived=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[bNext.event_id])).rows[0].received_at.toISOString();
    const bInput={...input,tasks:[{task:bContinue,event:{event_id:bNext.event_id,entry:"dialogue",text:"follow",reference:`host-interaction:${bNext.event_id}`,received_at:bReceived},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],focus_keys:[keyB]};
    const before=(await owner.query<{recorded_at:string}>('SELECT recorded_at::text FROM public."HostEvidenceEvent" WHERE event_id=$1',[eb.event_id])).rows[0].recorded_at;
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days' WHERE event_id=$1`,[eb.event_id]);
    await expect(host.saveCheckpoint(wb,a.headers,bInput,0,"expired-dependency")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    expect((await owner.query('SELECT 1 FROM e03_checkpoint.heads WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3',[`user-${a.user.id}`,trip,eb.workspace_key])).rowCount).toBe(0);
    await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=$2::timestamptz WHERE event_id=$1',[eb.event_id,before]);
    await expect(host.saveCheckpoint(wb,a.headers,bInput,0,"fresh-dependency")).resolves.toMatchObject({checkpoint_revision:1});
    const bRestored=await host.restoreCheckpoint(wb,a.headers);
    expect(bRestored.restored_task_count).toBe(1);
    const olderReplay=await host.record(wb,a.headers,ebInput);
    await expect(host.registerTaskIdentity(wb,a.headers,olderReplay,{expected_revision:0,tasks:[bTask],focus_keys:[keyB]})).rejects.toMatchObject({code:"RECOVERED_EVENT_REPLAY"});
    const newerReplay=await host.record(wb,a.headers,bNextInput);
    await expect(host.registerTaskIdentity(wb,a.headers,newerReplay,{expected_revision:0,tasks:[bContinue],focus_keys:[keyB]})).rejects.toMatchObject({code:"RECOVERED_EVENT_REPLAY"});
    // The dependency can cross its deadline while the checkpoint advisory lock
    // is held. Inspection must use the clock after the wait, not before it.
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days'+interval '2 seconds' WHERE event_id=$1`,[eb.event_id]);
    const watcher=new Client({connectionString:config!.migrationUrl}); await watcher.connect();
    const ownerPid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN"); let lockCommitted=false;
    try {
      await owner.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))",[`user-${a.user.id}`,trip,eb.workspace_key]);
      const pending=inspect(eb.workspace_key,cb); let blocked=false,expired=false;
      for(let i=0;i<150 && !(blocked && expired);i++) {
        const r=await watcher.query<{blocked:boolean;expired:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_inspect_candidate%') AS blocked, (SELECT clock_timestamp()>=recorded_at+interval '180 days' FROM public."HostEvidenceEvent" WHERE event_id=$2) AS expired`,[ownerPid,eb.event_id]);
        blocked ||= r.rows[0].blocked; expired ||= r.rows[0].expired;
        if(!(blocked && expired)) await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true); expect(expired).toBe(true);
      await owner.query("COMMIT"); lockCommitted=true;
      expect(await pending).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    } finally { if(!lockCommitted) await owner.query("ROLLBACK"); await watcher.end(); }
    await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=$2::timestamptz WHERE event_id=$1',[eb.event_id,before]);
    expect(await inspect(eb.workspace_key,cb)).toMatchObject({revision:1});
    // Reverse ordering: committed deletion before a waiting inspection wins.
    const observerB=new Client({connectionString:config!.migrationUrl}); await observerB.connect();
    await owner.query("BEGIN"); let deleteCommitted=false;
    try {
      await owner.query('SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 FOR UPDATE',[a.user.id,trip,eb.workspace_key]);
      const pending=host.restoreCheckpoint(wb,a.headers); let blocked=false;
      for(let i=0;i<100;i++) {
        const r=await observerB.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_read_candidate%') AS blocked",[ownerPid]);
        if(r.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      const deleted=await owner.query('SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,trip,eb.workspace_key,cb,eb.event_id]);
      expect(deleted.rows).toMatchObject([{disposition:"deleted"}]);
      await owner.query("COMMIT"); deleteCommitted=true;
      await expect(pending).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    } finally { if(!deleteCommitted) await owner.query("ROLLBACK"); await observerB.end(); }
    await host.deleteEvent(wb,a.headers,eb.event_id);
    await expect(runtime.query('SELECT e03_checkpoint.session_read_scene($1,$2,$3,$4,$5)',[a.session.session.id,a.user.id,trip,ea.workspace_key,now])).rejects.toThrow();
    const recorded=(await owner.query<{recorded_at:Date}>('SELECT recorded_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[ea.event_id])).rows[0].recorded_at;
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days' WHERE event_id=$1`,[ea.event_id]);
    expect(await inspect(ea.workspace_key,ca)).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=$2 WHERE event_id=$1',[ea.event_id,recorded]);
    expect(await inspect(ea.workspace_key,ca)).toMatchObject({revision:1});
    // Real metadata inspection holds the workspace lock until commit; a deletion
    // that starts after it must wait, then all future inspections fail closed.
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    const pid=(await runtime.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await runtime.query("BEGIN"); let committed=false;
    try {
      expect(await inspect(ea.workspace_key,ca)).toMatchObject({revision:1});
      const deleting=host.deleteEvent(wa,a.headers,ea.event_id);
      let blocked=false;
      for(let i=0;i<100;i++) {
        const r=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_delete_event_candidate%') AS blocked",[pid]);
        if(r.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      await runtime.query("COMMIT"); committed=true;
      await expect(deleting).resolves.toMatchObject({durable:true});
    } finally { if(!committed) await runtime.query("ROLLBACK"); await observer.end(); }
    expect(await inspect(ea.workspace_key,ca)).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    await expect(host.inspectCheckpoint(wa,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    await expect(host.saveCheckpoint(wa,a.headers,payload,0,"after-delete-host")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    expect(await save(ea.workspace_key,ca,payload,"after-delete")).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    const heads=await owner.query<{revision:string;payload:unknown;payload_digest:unknown;deleted:boolean}>('SELECT revision,payload,payload_digest,deleted FROM e03_checkpoint.heads WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3',[`user-${a.user.id}`,trip,ea.workspace_key]);
    expect(heads.rows).toEqual([{revision:"1",payload:null,payload_digest:null,deleted:true}]);
    expect((await owner.query('SELECT 1 FROM e03_checkpoint.receipts WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3',[`user-${a.user.id}`,trip,ea.workspace_key])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,ea.workspace_key])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM public."HostEvidenceSceneEventWitness" WHERE event_id=$1',[ea.event_id])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM public."HostEvidenceTaskSource" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 AND event_id=$4',[a.user.id,trip,ea.workspace_key,ea.event_id])).rowCount).toBe(0);
  },30000);
  it("assembles registered Egypt exploration Tasks against real Session and current PG state without delivering a Packet", async () => {
    const a=await account(),b=await account();
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[trip,a.user.id,b.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),other=await host.createWorkspace(trip,b.headers);
    const key=await host.mintTaskKey(ticket,a.headers,"egypt-task"), firstText="想去埃及";
    const first=await host.record(ticket,a.headers,{entry:"dialogue",text:firstText,idempotency_key:`egypt_${randomUUID()}`});
    const task={task_key:key,question:firstText,kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(firstText).length,quote:firstText}],progress:"open",progress_evidence:null};
    const firstInput={expected_revision:0,tasks:[task],focus_keys:[key]};
    const firstTurn=await host.registerTaskIdentity(ticket,a.headers,first,firstInput);
    const candidate=await host.inspectLivePacketCandidate(ticket,a.headers,firstTurn.turn_id,key,4096,firstInput);
    expect(candidate).toEqual({state_revision:0,selected_count:0,body_count:0,deferred_count:0,coverage:"complete"});
    expect(JSON.stringify(candidate)).not.toContain(firstText);
    await expect(host.inspectLivePacketCandidate(ticket,b.headers,firstTurn.turn_id,key,4096,firstInput)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(host.inspectLivePacketCandidate(other,b.headers,firstTurn.turn_id,key,4096,firstInput)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    const forged={...firstInput,tasks:[{...task,question:"伪造"}]};
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,firstTurn.turn_id,key,4096,forged)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    const secondText="还想了解阿斯旺";
    const second=await host.record(ticket,a.headers,{entry:"dialogue",text:secondText,idempotency_key:`egypt_${randomUUID()}`});
    const nextTask={...task,question:secondText,relation:"continue",evidence:[{start:0,end:Array.from(secondText).length,quote:secondText}]};
    const nextInput={expected_revision:0,tasks:[nextTask],focus_keys:[key]};
    const next=await host.registerTaskIdentity(ticket,a.headers,second,nextInput);
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,firstTurn.turn_id,key,4096,firstInput)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    expect(await host.inspectLivePacketCandidate(ticket,a.headers,next.turn_id,key,4096,nextInput)).toMatchObject({state_revision:0,selected_count:0});
    const prior=(await owner.query<{recorded_at:Date}>('SELECT recorded_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[first.event_id])).rows[0].recorded_at;
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days' WHERE event_id=$1`,[first.event_id]);
    // The verified continuation is a related interaction, so its live source
    // renews the 180-day read window (but not the original twelve-month cap).
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,next.turn_id,key,4096,nextInput)).resolves.toMatchObject({state_revision:0,selected_count:0});
    await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=$2 WHERE event_id=$1',[first.event_id,prior]);
    await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,a.user.id]);
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,next.turn_id,key,4096,nextInput)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,first.workspace_key])).rows[0].capability_token;
    const watcher=new Client({connectionString:config!.migrationUrl}); await watcher.connect();
    const pid=(await owner.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await owner.query('BEGIN'); let committed=false;
    try {
      await owner.query('SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 FOR UPDATE',[a.user.id,trip,first.workspace_key]);
      const pending=host.inspectLivePacketCandidate(ticket,a.headers,next.turn_id,key,4096,nextInput).then(()=>"unexpected",(error:{code?:string})=>error.code); let blocked=false;
      for(let i=0;i<100;i++) {
        const row=await watcher.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_evidence_for_turn_candidate%') AS blocked",[pid]);
        if(row.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      const deleted=await owner.query('SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,trip,first.workspace_key,cap,first.event_id]);
      expect(deleted.rows).toMatchObject([{disposition:"deleted"}]);
      await owner.query('COMMIT'); committed=true;
      expect(await pending).toBe("EVIDENCE_UNAVAILABLE");
    } finally { if(!committed) await owner.query('ROLLBACK'); await watcher.end(); }
    await host.deleteEvent(ticket,a.headers,first.event_id);
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,next.turn_id,key,4096,nextInput)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
  },30000);
  it("selects a real PG-held Egypt fixture for a registered target without business writes", async () => {
    const egyptTrip=`trip_egypt_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(egyptTrip,await issueInternalCapability(secret,egyptTrip,{role:"system",id:"egypt-fixture"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[egyptTrip]);
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[egyptTrip,a.user.id]);
    const aswan=structuredClone(base.objects.find(item=>item.id==="aswan")!); aswan.trip_id=egyptTrip;
    const egypt=structuredClone(base.objects.find(item=>item.id==="egypt")!); egypt.trip_id=egyptTrip;
    // Owner fixture: this is synthetic destination data, not a supplier or
    // an accepted TS write. The Packet path must only read this held state.
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[egyptTrip,JSON.stringify([egypt,aswan])]);
    const before=(await owner.query<{snapshot:unknown;revision:string}>('SELECT snapshot,"revision" FROM public."TripStateDocument" WHERE "tripId"=$1',[egyptTrip])).rows[0];
    const ticket=await host.createWorkspace(egyptTrip,a.headers),key=await host.mintTaskKey(ticket,a.headers,"aswan-task");
    const text="了解阿斯旺",event=await host.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`aswan_${randomUUID()}`});
    const task={task_key:key,question:text,kind:"explore",target_ids:["aswan"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null};
    const input={expected_revision:0,tasks:[task],focus_keys:[key]};
    const turn=await host.registerTaskIdentity(ticket,a.headers,event,input);
    expect(await host.inspectLivePacketCandidate(ticket,a.headers,turn.turn_id,key,4096,input)).toEqual({state_revision:0,selected_count:1,body_count:1,deferred_count:0,coverage:"complete"});
    expect((await owner.query<{snapshot:unknown;revision:string}>('SELECT snapshot,"revision" FROM public."TripStateDocument" WHERE "tripId"=$1',[egyptTrip])).rows[0]).toEqual(before);
    await owner.query(`UPDATE public."TripStateDocument" SET "revision"=1,snapshot=jsonb_set(snapshot,'{revision}','1'::jsonb) WHERE "tripId"=$1`,[egyptTrip]);
    await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET source_revision=1 WHERE trip_id=$1',[egyptTrip]);
    await expect(host.inspectLivePacketCandidate(ticket,a.headers,turn.turn_id,key,4096,input)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await host.disposeWorkspace(ticket);
  },30000);
  it("hands a real Session and PostgreSQL Packet to a real socket in an isolated test host", async () => {
    const egyptTrip=`trip_socket_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(egyptTrip,await issueInternalCapability(secret,egyptTrip,{role:"system",id:"socket-fixture"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[egyptTrip]);
    const a=await account(),b=await account();
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[egyptTrip,a.user.id,b.user.id]);
    const egypt=structuredClone(base.objects.find(item=>item.id==="egypt")!),aswan=structuredClone(base.objects.find(item=>item.id==="aswan")!);
    egypt.trip_id=egyptTrip; aswan.trip_id=egyptTrip;
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[egyptTrip,JSON.stringify([egypt,aswan])]);
    let response:http.ServerResponse|undefined, progress:{initial_sent:boolean;delivered_count:number;remaining_count:number}|undefined;
    const wired=await openEvidenceHost(env,{onLivePacketCandidate:async(candidate,recheck)=> {
      if(!response) throw new Error("test socket missing");
      const transport=createPacketSocketDeliveryCandidate(candidate,recheck);
      try { await transport.sendPacket(response,candidate); progress=transport.progress(); } finally { transport.invalidate(); }
    }});
    const ticket=await wired.createWorkspace(egyptTrip,a.headers),key=await wired.mintTaskKey(ticket,a.headers,"socket-task"),text="了解阿斯旺";
    const event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`socket_${randomUUID()}`});
    const task={task_key:key,question:text,kind:"explore",target_ids:["aswan"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null};
    const input={expected_revision:0,tasks:[task],focus_keys:[key]},turn=await wired.registerTaskIdentity(ticket,a.headers,event,input);
    let done:Promise<void>=Promise.resolve();
    const server=http.createServer((req,res)=> {
      response=res;
      done=wired.inspectLivePacketCandidate(ticket,new Headers({cookie:req.headers.cookie??""}),turn.turn_id,key,4096,input)
        .then(()=>undefined,()=>{if(!res.headersSent&&!res.destroyed){res.writeHead(403);res.end();}});
    });
    try {
      server.listen(0,"127.0.0.1"); await once(server,"listening");
      const address=server.address(); if(!address||typeof address==="string") throw new Error("test socket missing");
      const origin=`http://127.0.0.1:${address.port}`;
      const ok=await fetch(origin,{headers:{cookie:a.headers.get("cookie")??""}});
      expect(ok.status).toBe(200); const packet=await ok.json() as {task:{task_key:string};pending_input:{event:{text:string}};objects:Array<{id:string}>};
      await done;
      expect(packet.task.task_key).toBe(key); expect(packet.pending_input.event.text).toBe(text);
      expect(packet.objects.map(item=>item.id)).toEqual(["aswan"]);
      expect(progress).toEqual({initial_sent:true,delivered_count:1,remaining_count:0});
      expect((await fetch(origin,{headers:{cookie:b.headers.get("cookie")??""}})).status).toBe(403); await done;
      await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[egyptTrip,a.user.id]);
      expect((await fetch(origin,{headers:{cookie:a.headers.get("cookie")??""}})).status).toBe(403); await done;
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[egyptTrip,a.user.id]);
      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`,[a.session.session.id]);
      expect((await fetch(origin,{headers:{cookie:a.headers.get("cookie")??""}})).status).toBe(403); await done;
    } finally {
      if(server.listening) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await wired.close();
    }
  },30000);
  it("revalidates separate socket pages in short real Session/PG transactions", async () => {
    const t=`trip_page_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(t,await issueInternalCapability(secret,t,{role:"system",id:"short-fixture"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[t]);
    const a=await account(),b=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[t,a.user.id,b.user.id]);
    const objects=structuredClone(base.objects.filter(item=>["egypt","aswan"].includes(item.id))); for(const item of objects)item.trip_id=t;
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[t,JSON.stringify(objects)]);
    const state=(await owner.query<{snapshot:State}>('SELECT snapshot FROM public."TripStateDocument" WHERE "tripId"=$1',[t])).rows[0].snapshot;
    let response:http.ServerResponse|undefined,first:PacketCandidate|undefined;
    let tracker:ReturnType<typeof createShortPacketHandoffCandidate>|undefined;
    const handoff:{value?:ReturnType<ReturnType<typeof createShortPacketHandoffCandidate>["beginPacket"]>}={};
    let phase:"packet"|"page"|"hold"|"postflight"="packet";
    let markHeld!:()=>void,releaseHeld!:()=>void;
    const held=new Promise<void>(resolve=>{markHeld=resolve;}),release=new Promise<void>(resolve=>{releaseHeld=resolve;});
    let deletionDone:Promise<unknown>|undefined; const order:string[]=[];
    let turnId="",key="";
    const text="了解阿斯旺",taskInput=()=>({expected_revision:0,tasks:[{task_key:key,question:text,kind:"explore",target_ids:["aswan"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null}],focus_keys:[key]});
    const wired=await openEvidenceHost(env,{onLivePacketCandidate:async(candidate,recheck,bind)=> {
      if(phase==="postflight")return;
      if(!response)throw new Error("missing test response");
      await recheck(); // held DB locks; begin below is synchronous
      if(phase==="packet") {
        first=structuredClone(candidate); // synthetic fixture only, not a production cache
        tracker=createShortPacketHandoffCandidate(first,async()=> {
          const before=phase; phase="postflight";
          try {if(before==="hold"&&deletionDone)await deletionDone;await wired.inspectLivePacketCandidate(ticket,a.headers,turnId,key,2,taskInput());} finally {phase=before;}
        });
        bind(tracker.invalidate);
        handoff.value=tracker.beginPacket(response,first);
      } else {
        if(!first||!tracker||candidate.assembly.snapshot_digest!==first.assembly.snapshot_digest||digest(state)!==first.assembly.snapshot_digest)throw new Error("stale snapshot");
        if(phase==="hold"){markHeld();await release;await recheck();order.push("send-start");}
        const now=new Date();
        handoff.value=tracker.beginPage(response,first,{runtime_contract_version:"0.1.0",packet_id:first.packet.packet_id,object_ids:["aswan"]},{state,now},{state,now});
      }
    }});
    const ticket=await wired.createWorkspace(t,a.headers); key=await wired.mintTaskKey(ticket,a.headers,"short-task");
    const event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`short_${randomUUID()}`});
    turnId=(await wired.registerTaskIdentity(ticket,a.headers,event,taskInput())).turn_id;
    let done:Promise<void>=Promise.resolve();
    const server=http.createServer((req,res)=> {
      response=res; phase=req.url==="/hold"?"hold":req.url==="/page"?"page":"packet"; handoff.value=undefined;
      done=(async()=> {
        try {
          await wired.inspectLivePacketCandidate(ticket,new Headers({cookie:req.headers.cookie??""}),turnId,key,2,taskInput());
          if(!handoff.value)throw new Error("handoff missing");
          await handoff.value.afterCommit(); // inspect transaction already ended
        } catch {handoff.value?.abort(); if(!res.headersSent&&!res.destroyed){res.writeHead(403);res.end();}}
      })();
    });
    try {
      server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("missing socket");
      const origin=`http://127.0.0.1:${address.port}`,cookie=a.headers.get("cookie")??"";
      const packet=await fetch(`${origin}/packet`,{headers:{cookie}}); expect(packet.status).toBe(200);
      expect((await packet.json() as {deferred_ids:string[]}).deferred_ids).toEqual(["aswan"]);await done;
      expect(tracker?.progress()).toEqual({initial_sent:true,delivered_count:0,remaining_count:1,pending:false});
      const page=await fetch(`${origin}/page`,{headers:{cookie}});expect(page.status).toBe(200);
      expect((await page.json() as {objects:Array<{id:string}>}).objects.map(o=>o.id)).toEqual(["aswan"]);await done;
      expect(tracker?.progress()).toEqual({initial_sent:true,delivered_count:1,remaining_count:0,pending:false});
      expect((await fetch(`${origin}/page`,{headers:{cookie:b.headers.get("cookie")??""}})).status).toBe(403);await done;
      expect(tracker?.progress().delivered_count).toBe(1);
      const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,t,event.workspace_key])).rows[0].capability_token;
      const pid=(await owner.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
      try {
        const inFlight=fetch(`${origin}/hold`,{headers:{cookie}});await held;
        deletionDone=owner.query('SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,t,event.workspace_key,cap,event.event_id]).then(result=>{order.push("delete-committed");return result;});
        let blocked=false;for(let i=0;i<100;i++) {
          const wait=await observer.query<{waiting:boolean}>('SELECT wait_event_type=\'Lock\' AS waiting FROM pg_stat_activity WHERE pid=$1',[pid]);
          if(wait.rows[0]?.waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
        }
        expect(blocked).toBe(true);releaseHeld();
        expect((await inFlight).status).toBe(200);await deletionDone;await done;
        expect(order).toEqual(["send-start","delete-committed"]);
      } finally {releaseHeld();await observer.end();}
      await wired.deleteEvent(ticket,a.headers,event.event_id); // synchronize already committed deletion
      expect(()=>tracker?.progress()).toThrow("DELIVERY_UNAVAILABLE");
      expect((await fetch(`${origin}/page`,{headers:{cookie}})).status).toBe(403);await done;
    } finally {tracker?.invalidate();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await wired.close();}
  },30000);
  it("runs record, controlled interpretation, Turn and Packet beside a same-origin Next proxy",async()=>{
    const t=`trip_gateway_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(t,await issueInternalCapability(secret,t,{role:"system",id:"gateway-test"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[t]);
    const a=await account(),b=await account();
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[t,a.user.id,b.user.id]);
    const objects=structuredClone(base.objects.filter(item=>["egypt","aswan"].includes(item.id)));
    for(const item of objects)item.trip_id=t;
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[t,JSON.stringify(objects)]);
    let signalSlowClose!:()=>void;const slowClosed=new Promise<void>(resolve=>{signalSlowClose=resolve;});
    const next=http.createServer((req,res)=>{if(req.url==="/slow"){res.on("close",signalSlowClose);res.writeHead(200);res.write("started");return;}res.writeHead(200,{"content-type":"application/json","x-upstream":"next"});res.end(JSON.stringify({path:req.url}));});
    next.listen(0,"127.0.0.1");await once(next,"listening");
    const nextAddress=next.address();if(!nextAddress||typeof nextAddress==="string")throw new Error("missing upstream");
    const wired=await openEvidenceHost(env);
    let gateway!:http.Server,origin="",interpretCalls=0;
    try {
      const multiText="阿斯旺和埃及",continueText="继续阿斯旺",focusText="回到埃及",badText="冒充旧任务";
      let firstKey="",secondKey="";
      const interpreter:ControlledInterpreter=async({event,state,runtime_focus,mint_task_key})=>{
        interpretCalls++;expect(state.trip_id).toBe(t);expect(state.objects.some(item=>item.id==="aswan")).toBe(true);
        const task=(key:string,question:string,relation:"new"|"continue"|"focus",target:string,span:{start:number;end:number;quote:string})=>({
          task_key:key,question,kind:"explore",target_ids:[target],branch:"actual",relation,related_task_keys:[],certainty:"explicit",evidence:[span],progress:"open",progress_evidence:null});
        if(event.text===multiText){
          expect(runtime_focus.complete).toBe(true);expect(runtime_focus.tasks.map(item=>item.task_key)).toContain(firstKey);
          const aKey=await mint_task_key(0),bKey=await mint_task_key(1);secondKey=bKey;
          return {tasks:[task(aKey,"阿斯旺","new","aswan",{start:0,end:3,quote:"阿斯旺"}),task(bKey,"埃及","new","egypt",{start:4,end:6,quote:"埃及"})],focus_keys:[aKey,bKey]};
        }
        if(event.text===continueText||event.text===focusText||event.text===badText){
          expect(runtime_focus.complete).toBe(true);
          const key=event.text===focusText?secondKey:event.text===badText?"task_forged":firstKey;
          const target=event.text===focusText?"egypt":"aswan";
          const relation=event.text===focusText?"focus":"continue";
          return {tasks:[task(key,event.text,relation,target,{start:0,end:Array.from(event.text).length,quote:event.text})],focus_keys:[key]};
        }
        const new_task_key=await mint_task_key(0);
        firstKey=new_task_key;
        return {tasks:[task(new_task_key,event.text,"new","aswan",{start:0,end:Array.from(event.text).length,quote:event.text})],focus_keys:[new_task_key]};
      };
      const adapterHolder:{current?:ReturnType<typeof createPacketHttpCandidate>}={};
      const gatewayHandler=createSameOriginE03Gateway((req,res)=>adapterHolder.current!.handle(req,res),`http://127.0.0.1:${nextAddress.port}`);
      gateway=http.createServer(gatewayHandler);
      gateway.listen(0,"127.0.0.1");await once(gateway,"listening");
      const address=gateway.address();if(!address||typeof address==="string")throw new Error("missing gateway");
      origin=`http://127.0.0.1:${address.port}`;adapterHolder.current=createPacketHttpCandidate(wired,origin,interpreter);
      const proxied=await fetch(`${origin}/api/health`);expect(proxied.status).toBe(200);expect(proxied.headers.get("x-upstream")).toBe("next");expect(await proxied.json()).toEqual({path:"/api/health"});
      const cookie=a.headers.get("cookie")??"";
      const post=(operation:string,body:unknown,auth=cookie)=>fetch(`${origin}/runtime/trips/${t}/${operation}`,{method:"POST",headers:{cookie:auth,origin,"content-type":"application/json"},body:JSON.stringify(body)});
      const text="阿斯旺体验";
      const turnResponse=await post("turns",{entry:"dialogue",text,idempotency_key:`gateway_${randomUUID()}`});expect(turnResponse.status).toBe(200);
      const turn=await turnResponse.json() as {turn_id:string;tasks:Array<{task_key:string}>};expect(interpretCalls).toBe(1);expect(turn.tasks).toHaveLength(1);
      const denied=await post("assemble",{runtime_contract_version:"0.1.0",turn_id:turn.turn_id,task_key:turn.tasks[0].task_key,body_budget_bytes:2},b.headers.get("cookie")??"");
      expect(denied.status).toBe(403);expect(await denied.text()).not.toContain(text);
      const open=await post("assemble",{runtime_contract_version:"0.1.0",turn_id:turn.turn_id,task_key:turn.tasks[0].task_key,body_budget_bytes:2});expect(open.status).toBe(200);
      const packet=await open.json() as {packet_id:string;deferred_ids:string[]};expect(packet.deferred_ids).toEqual(["aswan"]);
      const page=await post("pages",{runtime_contract_version:"0.1.0",packet_id:packet.packet_id,object_ids:["aswan"]});expect(page.status).toBe(200);
      expect((await page.json() as {objects:Array<{id:string}>}).objects.map(item=>item.id)).toEqual(["aswan"]);
      const multi=await post("turns",{entry:"dialogue",text:multiText,idempotency_key:`multi_${randomUUID()}`});expect(multi.status).toBe(200);
      const multiTurn=await multi.json() as {tasks:Array<{task_key:string}>;focus_keys:string[]};expect(multiTurn.tasks).toHaveLength(2);expect(multiTurn.focus_keys).toEqual(multiTurn.tasks.map(item=>item.task_key));
      const continued=await post("turns",{entry:"dialogue",text:continueText,idempotency_key:`continue_${randomUUID()}`});expect(continued.status).toBe(200);
      const continuedTurn=await continued.json() as {tasks:Array<{task_key:string;relation:string}>;focus_keys:string[]};expect(continuedTurn.tasks[0]).toMatchObject({task_key:firstKey,relation:"continue"});
      const focused=await post("turns",{entry:"dialogue",text:focusText,idempotency_key:`focus_${randomUUID()}`});expect(focused.status).toBe(200);
      const focusedTurn=await focused.json() as {tasks:Array<{task_key:string;relation:string}>;focus_keys:string[]};expect(focusedTurn.tasks[0]).toMatchObject({task_key:secondKey,relation:"focus"});expect(focusedTurn.focus_keys).toEqual([secondKey]);
      const forged=await post("turns",{entry:"dialogue",text:badText,idempotency_key:`forged_${randomUUID()}`});expect(forged.status).toBe(503);
      expect(await forged.text()).not.toContain(badText);
      const afterFailure=await post("turns",{entry:"dialogue",text:focusText,idempotency_key:`after_failure_${randomUUID()}`});
      expect(afterFailure.status).toBe(200);expect((await afterFailure.json() as {focus_keys:string[]}).focus_keys).toEqual([secondKey]);
      const sources=await owner.query<{event_id:string;body:string;workspace_key:string}>('SELECT event_id,body,workspace_key FROM public."HostEvidenceEvent" WHERE trip_id=$1 AND body=ANY($2::text[])',[t,[text,multiText,continueText,focusText,badText]]);
      expect(new Set(sources.rows.map(row=>row.workspace_key)).size).toBe(1);
      const firstEvent=sources.rows.find(row=>row.body===text)!,continuationEvent=sources.rows.find(row=>row.body===continueText)!;
      const bound=await owner.query<{event_id:string}>('SELECT event_id FROM public."HostEvidenceTaskSource" WHERE event_id=ANY($1::text[])',[ [firstEvent.event_id,continuationEvent.event_id] ]);
      expect(new Set(bound.rows.map(row=>row.event_id))).toEqual(new Set([firstEvent.event_id,continuationEvent.event_id]));
      const controller=new AbortController();const slow=await fetch(`${origin}/slow`,{signal:controller.signal});expect(slow.status).toBe(200);controller.abort();
      await expect(slow.text()).rejects.toThrow();
      await expect(Promise.race([slowClosed.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1500))])).resolves.toBe(true);
      const noInterpreter=createPacketHttpCandidate(wired,origin);
      const failureServer=http.createServer((req,res)=>{void noInterpreter.handle(req,res);});failureServer.listen(0,"127.0.0.1");await once(failureServer,"listening");
      try {const failureAddress=failureServer.address();if(!failureAddress||typeof failureAddress==="string")throw new Error("missing failure route");
        const unavailable=await fetch(`http://127.0.0.1:${failureAddress.port}/runtime/trips/${t}/turns`,{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify({entry:"dialogue",text,idempotency_key:`unavailable_${randomUUID()}`})});
        expect(unavailable.status).toBe(503);expect(await unavailable.text()).not.toContain(text);
      } finally {await new Promise<void>((resolve,reject)=>failureServer.close(error=>error?reject(error):resolve()));}
      const rejectedText="解释器失败的原话";
      const failingAdapter=createPacketHttpCandidate(wired,origin,async()=>{throw new Error("INTERPRETER_FAILED");});
      const failingServer=http.createServer((req,res)=>{void failingAdapter.handle(req,res);});failingServer.listen(0,"127.0.0.1");await once(failingServer,"listening");
      try {const failureAddress=failingServer.address();if(!failureAddress||typeof failureAddress==="string")throw new Error("missing interpreter failure route");
        const failed=await fetch(`http://127.0.0.1:${failureAddress.port}/runtime/trips/${t}/turns`,{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify({entry:"dialogue",text:rejectedText,idempotency_key:`throw_${randomUUID()}`})});
        expect(failed.status).toBe(503);expect(await failed.text()).not.toContain(rejectedText);
        const unlinked=await owner.query<{event_id:string;deleted_at:Date|null}>('SELECT event_id,deleted_at FROM public."HostEvidenceEvent" WHERE trip_id=$1 AND body=$2 ORDER BY sequence DESC LIMIT 1',[t,rejectedText]);
        expect(unlinked.rows[0]?.deleted_at).toBeNull();
        const links=await owner.query('SELECT event_id FROM public."HostEvidenceTaskSource" WHERE event_id=$1',[unlinked.rows[0].event_id]);
        expect(links.rowCount).toBe(0);
      } finally {await new Promise<void>((resolve,reject)=>failingServer.close(error=>error?reject(error):resolve()));}
    } finally {if(gateway?.listening)await new Promise<void>((resolve,reject)=>gateway.close(error=>error?reject(error):resolve()));await wired.close();await new Promise<void>((resolve,reject)=>next.close(error=>error?reject(error):resolve()));}
  },30000);
  it("routes registered Turn and independent pages using only the private task lease",async()=>{
    const t=`trip_route_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(t,await issueInternalCapability(secret,t,{role:"system",id:"packet-route-test"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[t]);
    const a=await account(),b=await account();
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[t,a.user.id,b.user.id]);
    const objects=structuredClone(base.objects.filter(item=>["egypt","aswan"].includes(item.id)));
    for(const item of objects)item.trip_id=t;
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[t,JSON.stringify(objects)]);
    const wired=await openEvidenceHost(env),ticket=await wired.createWorkspace(t,a.headers);
    const key=await wired.mintTaskKey(ticket,a.headers,"route-task"),text="阿斯旺体验";
    const event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`route_${randomUUID()}`});
    const raw={expected_revision:0,tasks:[{task_key:key,question:text,kind:"explore",target_ids:["aswan"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null}],focus_keys:[key]};
    const turn=await wired.registerTaskIdentity(ticket,a.headers,event,raw);
    let adapter!:ReturnType<typeof createPacketHttpCandidate>;
    const server=http.createServer((req,res)=>{void adapter.handle(req,res);});
    try {
      server.listen(0,"127.0.0.1");await once(server,"listening");
      const address=server.address();if(!address||typeof address==="string")throw new Error("missing socket");
      const origin=`http://127.0.0.1:${address.port}`;adapter=createPacketHttpCandidate(wired,origin);adapter.bindTurn(t,turn.turn_id,ticket);
      const endpoint=(operation:string)=>`${origin}/runtime/trips/${t}/${operation}`;
      const post=(operation:string,body:unknown,cookie=a.headers.get("cookie")??"")=>fetch(endpoint(operation),{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify(body)});
      const assemble={runtime_contract_version:"0.1.0",turn_id:turn.turn_id,task_key:key,body_budget_bytes:2};
      const denied=await post("assemble",assemble,b.headers.get("cookie")??"");expect(denied.status).toBe(403);expect(await denied.text()).not.toContain(text);
      const noOrigin=await fetch(endpoint("assemble"),{method:"POST",headers:{cookie:a.headers.get("cookie")??"","content-type":"application/json"},body:JSON.stringify(assemble)});
      expect(noOrigin.status).toBe(403);expect(await noOrigin.text()).not.toContain(text);
      const opened=await post("assemble",assemble);expect(opened.status).toBe(200);
      const packet=await opened.json() as {packet_id:string;deferred_ids:string[]};expect(packet.deferred_ids).toEqual(["aswan"]);
      const page={runtime_contract_version:"0.1.0",packet_id:packet.packet_id,object_ids:["aswan"]};
      const delivered=await post("pages",page);expect(delivered.status).toBe(200);
      expect((await delivered.json() as {objects:Array<{id:string}>}).objects.map(item=>item.id)).toEqual(["aswan"]);
      const forged=await post("pages",{...page,delivered_ids:["aswan"]});expect(forged.status).toBe(422);
      await wired.deleteEvent(ticket,a.headers,event.event_id);
      const stale=await post("pages",page);expect(stale.status).toBe(403);expect(await stale.text()).not.toContain(text);
      const reopen=await post("assemble",assemble);expect(reopen.status).not.toBe(200);expect(await reopen.text()).not.toContain(text);
    } finally {adapter?.forgetWorkspace(ticket);if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await wired.close();}
  },30000);
  it("uses host-owned packet and page state across separate real Session/PG/socket requests", async()=> {
    const t=`trip_formal_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(t,await issueInternalCapability(secret,t,{role:"system",id:"host-packet-fixture"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[t]);
    const a=await account(),b=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[t,a.user.id,b.user.id]);
    const objects=structuredClone(base.objects.filter(item=>["egypt","aswan"].includes(item.id)));for(const item of objects)item.trip_id=t;
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[t,JSON.stringify(objects)]);
    let holdAfter=false,holdBefore=false,holdFinal=false,signalAfter!:()=>void,releaseAfter!:()=>void,signalBefore!:()=>void,releaseBefore!:()=>void,signalFinal!:()=>void,releaseFinal!:()=>void;
    const afterEntered=new Promise<void>(resolve=>{signalAfter=resolve;}),afterGate=new Promise<void>(resolve=>{releaseAfter=resolve;});
    const beforeEntered=new Promise<void>(resolve=>{signalBefore=resolve;}),beforeGate=new Promise<void>(resolve=>{releaseBefore=resolve;});
    const finalEntered=new Promise<void>(resolve=>{signalFinal=resolve;}),finalGate=new Promise<void>(resolve=>{releaseFinal=resolve;});
    const wired=await openEvidenceHost(env,{beforePacketHandoff:async()=>{if(holdBefore){signalBefore();await beforeGate;}},afterFinalPacketCheck:async()=>{if(holdFinal){signalFinal();await finalGate;}},afterPacketHandoffCommit:async()=>{if(holdAfter){signalAfter();await afterGate;}}});
    let ticket=await wired.createWorkspace(t,a.headers),key=await wired.mintTaskKey(ticket,a.headers,"formal-task");
    const otherTicket=await wired.createWorkspace(t,a.headers);
    const text="了解阿斯旺",makeInput=()=>({expected_revision:0,tasks:[{task_key:key,question:text,kind:"explore",target_ids:["aswan"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:Array.from(text).length,quote:text}],progress:"open",progress_evidence:null}],focus_keys:[key]});
    let event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`formal_${randomUUID()}`});
    let turnId=(await wired.registerTaskIdentity(ticket,a.headers,event,makeInput())).turn_id;
    let done:Promise<void>=Promise.resolve(),lastError="";
    const server=http.createServer((req,res)=> {done=(async()=> {
      try {
        const headers=new Headers({cookie:req.headers.cookie??""});
        if(req.url==="/open")await wired.sendLivePacketCandidate(ticket,headers,turnId,key,2,makeInput(),res);
        else {const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));await wired.sendLivePacketPageCandidate(req.url==="/wrong-scope"?otherTicket:ticket,headers,JSON.parse(Buffer.concat(chunks).toString("utf8")),makeInput(),res);}
      } catch(error) {lastError=error&&typeof error==="object"&&"code" in error?String(error.code):"internal";if(!res.headersSent&&!res.destroyed){res.writeHead(403);res.end();}}
    })();});
    try {
      server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("missing socket");
      const origin=`http://127.0.0.1:${address.port}`,cookie=a.headers.get("cookie")??"";
      const open=await fetch(`${origin}/open`,{headers:{cookie}});expect(open.status).toBe(200);
      let packet=await open.json() as {packet_id:string;deferred_ids:string[]};await done;expect(packet.deferred_ids).toEqual(["aswan"]);
      let page={runtime_contract_version:"0.1.0",packet_id:packet.packet_id,object_ids:["aswan"]};
      const call=(value:unknown,auth=cookie)=>fetch(`${origin}/page`,{method:"POST",headers:{cookie:auth},body:JSON.stringify(value)});
      expect((await fetch(`${origin}/wrong-scope`,{method:"POST",headers:{cookie},body:JSON.stringify(page)})).status).toBe(403);await done;
      expect((await call({...page,delivered_ids:["aswan"]})).status).toBe(403);await done;
      const result=await call(page);expect(result.status).toBe(200);expect((await result.json() as {objects:Array<{id:string}>}).objects.map(item=>item.id)).toEqual(["aswan"]);await done;
      await wired.deleteEvent(ticket,a.headers,event.event_id);
      expect((await call(page)).status).toBe(403);await done;
      // Fresh unrelated work gets a new workspace and private ledger; the
      // deleted packet cannot be revived by retaining its packet ID.
      ticket=await wired.createWorkspace(t,a.headers);key=await wired.mintTaskKey(ticket,a.headers,"formal-fresh-task");
      event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`fresh_${randomUUID()}`});
      turnId=(await wired.registerTaskIdentity(ticket,a.headers,event,makeInput())).turn_id;
      const nextPacket=await fetch(`${origin}/open`,{headers:{cookie}});expect(nextPacket.status).toBe(200);
      packet=await nextPacket.json() as {packet_id:string;deferred_ids:string[]};await done;
      page={runtime_contract_version:"0.1.0",packet_id:packet.packet_id,object_ids:["aswan"]};
      expect((await call(page,b.headers.get("cookie")??"")).status).toBe(403);await done;
      // Pause after the read transaction committed: revoke must not wait on
      // the subsequent network completion or postflight work.
      holdAfter=true;const inflight=call(page);await afterEntered;
      try {
        const revoked=owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[t,a.user.id]);
        expect(await Promise.race([revoked.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1500))])).toBe(true);
      } finally {holdAfter=false;releaseAfter();}
      expect((await inflight).status).toBe(200);await done;expect(lastError).toBe("EVIDENCE_ACCESS_DENIED");
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[t,a.user.id]);
      expect((await call(page)).status).toBe(403);await done; // old ledger did not revive
      ticket=await wired.createWorkspace(t,a.headers);key=await wired.mintTaskKey(ticket,a.headers,"expiry-task");
      event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`expiry_${randomUUID()}`});
      turnId=(await wired.registerTaskIdentity(ticket,a.headers,event,makeInput())).turn_id;
      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[a.session.session.id]);
      holdBefore=true;const expired=fetch(`${origin}/open`,{headers:{cookie}});await beforeEntered;
      try {
        let crossed=false;for(let i=0;i<100;i++) {
          const check=await owner.query<{expired:boolean}>(`SELECT "expiresAt"<=clock_timestamp() AS expired FROM "AuthSession" WHERE id=$1`,[a.session.session.id]);
          if(check.rows[0].expired){crossed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
        }
        expect(crossed).toBe(true);
      } finally {holdBefore=false;releaseBefore();}
      const rejected=await expired;expect(rejected.status).toBe(403);expect(await rejected.text()).not.toContain(text);await done;
      // A process pause after the final database check can cross the exact
      // session deadline. The monotonic handoff budget must reject before
      // writeHead/end, not rely on the later postflight.
      const c=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[t,c.user.id]);
      ticket=await wired.createWorkspace(t,c.headers);key=await wired.mintTaskKey(ticket,c.headers,"final-gap-task");
      event=await wired.record(ticket,c.headers,{entry:"dialogue",text,idempotency_key:`final_gap_${randomUUID()}`});
      turnId=(await wired.registerTaskIdentity(ticket,c.headers,event,makeInput())).turn_id;
      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[c.session.session.id]);
      holdFinal=true;const gap=fetch(`${origin}/open`,{headers:{cookie:c.headers.get("cookie")??""}});await finalEntered;
      try {
        let crossed=false;for(let i=0;i<100;i++) {
          const check=await owner.query<{expired:boolean}>(`SELECT "expiresAt"<=clock_timestamp() AS expired FROM "AuthSession" WHERE id=$1`,[c.session.session.id]);
          if(check.rows[0].expired){crossed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
        }
        expect(crossed).toBe(true);
      } finally {holdFinal=false;releaseFinal();}
      const gapRejected=await gap;expect(gapRejected.status).toBe(403);expect(await gapRejected.text()).not.toContain(text);await done;
    } finally {releaseAfter();releaseBefore();releaseFinal();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await wired.close();}
  },30000);
  it("does not start a socket response if its source expires after the final database check",async()=> {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{signal=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const wired=await openEvidenceHost(env,{afterFinalPacketCheck:async()=>{signal();await gate;}});
    const ticket=await wired.createWorkspace(trip,a.headers),key=await wired.mintTaskKey(ticket,a.headers,"source-expiry-gap"),text="原话";
    const event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`source_gap_${randomUUID()}`});
    const task={task_key:key,question:text,kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:text}],progress:"open",progress_evidence:null};
    const input={expected_revision:0,tasks:[task],focus_keys:[key]},turn=await wired.registerTaskIdentity(ticket,a.headers,event,input);
    await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days'+interval '3 seconds' WHERE event_id=$1`,[event.event_id]);
    let done:Promise<void>=Promise.resolve();
    const server=http.createServer((req,res)=>{done=wired.sendLivePacketCandidate(ticket,new Headers({cookie:req.headers.cookie??""}),turn.turn_id,key,2,input,res).then(()=>undefined,()=>{if(!res.headersSent&&!res.destroyed){res.writeHead(403);res.end();}});});
    try {
      server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("missing socket");
      const request=fetch(`http://127.0.0.1:${address.port}`,{headers:{cookie:a.headers.get("cookie")??""}});await entered;
      try {
        let crossed=false;for(let i=0;i<120;i++) {
          const row=await owner.query<{expired:boolean}>(`SELECT clock_timestamp()>=recorded_at+interval '180 days' AS expired FROM public."HostEvidenceEvent" WHERE event_id=$1`,[event.event_id]);
          if(row.rows[0].expired){crossed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
        }
        expect(crossed).toBe(true);
      } finally {release();}
      const rejected=await request;expect(rejected.status).toBe(403);expect(await rejected.text()).not.toContain(text);await done;
    } finally {release();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await wired.close();}
  },30000);
  it("does not send across an unselected fact's activation after the final check",async()=> {
    const t=`trip_fact_gap_${randomBytes(8).toString("hex")}`;
    await internal.createTrip(t,await issueInternalCapability(secret,t,{role:"system",id:"fact-gap-fixture"}));
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[t]);
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[t,a.user.id]);
    const boundary=(await owner.query<{at:Date}>("SELECT clock_timestamp()+interval '3 seconds' AS at")).rows[0].at;
    const objects=structuredClone(base.objects.filter(item=>["egypt","aswan","cairo","luxor","fact-cairo-luxor"].includes(item.id)));
    for(const item of objects) {item.trip_id=t;if(item.type==="ExternalFact"){item.observed_at=boundary.toISOString();item.expires_at=new Date(boundary.getTime()+3_600_000).toISOString();}}
    await owner.query(`UPDATE public."TripStateDocument" SET snapshot=jsonb_set(snapshot,'{objects}',$2::jsonb) WHERE "tripId"=$1`,[t,JSON.stringify(objects)]);
    let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{signal=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const wired=await openEvidenceHost(env,{afterFinalPacketCheck:async()=>{signal();await gate;}});
    const ticket=await wired.createWorkspace(t,a.headers),key=await wired.mintTaskKey(ticket,a.headers,"fact-gap"),text="阿斯旺";
    const event=await wired.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`fact_gap_${randomUUID()}`});
    const task={task_key:key,question:text,kind:"explore",target_ids:["aswan"],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:text}],progress:"open",progress_evidence:null};
    const input={expected_revision:0,tasks:[task],focus_keys:[key]},turn=await wired.registerTaskIdentity(ticket,a.headers,event,input);
    let done:Promise<void>=Promise.resolve();const server=http.createServer((req,res)=>{done=wired.sendLivePacketCandidate(ticket,new Headers({cookie:req.headers.cookie??""}),turn.turn_id,key,4096,input,res).then(()=>undefined,()=>{if(!res.headersSent&&!res.destroyed){res.writeHead(403);res.end();}});});
    try {
      server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("missing socket");
      const request=fetch(`http://127.0.0.1:${address.port}`,{headers:{cookie:a.headers.get("cookie")??""}});await entered;
      try {let crossed=false;for(let i=0;i<120;i++){const row=await owner.query<{crossed:boolean}>("SELECT clock_timestamp()>=$1::timestamptz AS crossed",[boundary]);if(row.rows[0].crossed){crossed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}expect(crossed).toBe(true);} finally {release();}
      const rejected=await request;expect(rejected.status).toBe(403);expect(await rejected.text()).not.toContain(text);await done;
    } finally {release();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await wired.close();}
  },30000);
  it("atomically records verified scene events and serializes their removal with deletion", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers);
    const key=await host.mintTaskKey(ticket,a.headers,"witness-key");
    const unlisted=await host.record(ticket,a.headers,{entry:"dialogue",text:"unlisted event",idempotency_key:`unlisted_${randomUUID()}`});
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"visible event",idempotency_key:`witness_${randomUUID()}`});
    const task={task_key:key,question:"visible",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:7,quote:"visible"}],progress:"open",progress_evidence:null};
    await host.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rows[0].capability_token;
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
    const payload=validateCheckpoint({checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],
      tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"visible event",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],
      focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]},trip,0);
    const save=async (expected=0,operation="witness-save") => (await runtime.query<{value:Record<string,unknown>}>('SELECT public.host_checkpoint_save_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,NULL) AS value',
      [a.session.session.id,a.user.id,trip,event.workspace_key,cap,expected,operation,digest({expected_revision:expected,payload,deleted:false}),JSON.stringify(payload),checkpointDigest(payload),new Date().toISOString()])).rows[0].value;
    const witnesses=async()=> (await owner.query('SELECT event_id FROM public."HostEvidenceSceneEventWitness" WHERE event_id=$1',[event.event_id])).rows;
    await runtime.query('BEGIN');
    try {
      expect(await save()).toHaveProperty("ack");
      expect(await witnesses()).toEqual([]); // no visibility before commit
    } finally { await runtime.query('ROLLBACK'); }
    expect(await witnesses()).toEqual([]);
    expect((await owner.query('SELECT 1 FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rowCount).toBe(0);
    expect(await save()).toHaveProperty("ack");
    expect(await witnesses()).toEqual([{event_id:event.event_id}]);
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await runtime.query('BEGIN'); let committed=false;
    try {
      expect(await save(1,"witness-update")).toHaveProperty("ack");
      // The unlisted input may still be a model dependency. Its deletion must
      // quarantine the scene rather than using the partial witness as proof.
      const deletion=host.deleteEvent(ticket,a.headers,unlisted.event_id); let blocked=false;
      for(let i=0;i<100;i++) {
        const status=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_delete_event_candidate%') AS blocked",[pid]);
        if(status.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      // A concurrent observer still sees the previously committed witness.
      expect(await witnesses()).toEqual([{event_id:event.event_id}]);
      await runtime.query('COMMIT'); committed=true;
      await expect(deletion).resolves.toMatchObject({durable:true});
      expect(await witnesses()).toEqual([]);
      expect((await owner.query('SELECT 1 FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rowCount).toBe(0);
      expect((await owner.query<{deleted_at:Date|null}>('SELECT deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows).toEqual([{deleted_at:null}]);
      await expect(host.restoreCheckpoint(ticket,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    } finally { if(!committed) await runtime.query('ROLLBACK'); await observer.end(); }
  },30000);
  it("removes a scene when an unlisted deleted event is copied into another task question", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers), secret=`old-secret-${randomUUID()}`;
    const older=await host.record(ticket,a.headers,{entry:"dialogue",text:secret,idempotency_key:`old_${randomUUID()}`});
    const taskKey=await host.mintTaskKey(ticket,a.headers,"task-key");
    const newerInput={entry:"dialogue",text:"new",idempotency_key:`new_${randomUUID()}`};
    const newer=await host.record(ticket,a.headers,newerInput);
    const task={task_key:taskKey,question:`What about ${secret}?`,kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:"new"}],progress:"open",progress_evidence:null};
    await host.registerTaskIdentity(ticket,a.headers,newer,{expected_revision:0,tasks:[task],focus_keys:[taskKey]});
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[newer.event_id])).rows[0].received_at.toISOString();
    const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],
      tasks:[{task,event:{event_id:newer.event_id,entry:"dialogue",text:"new",reference:`host-interaction:${newer.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],
      focus_keys:[taskKey],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    // The previous candidate accepted this. The new source gate must reject
    // it even if the copied text originated in another workspace.
    await expect(host.saveCheckpoint(ticket,a.headers,payload,0,"source-gap-save")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    const otherTicket=await host.createWorkspace(trip,a.headers);
    const otherKey=await host.mintTaskKey(otherTicket,a.headers,"other-key"),otherTask={...task,task_key:otherKey};
    const otherEvent=await host.record(otherTicket,a.headers,{entry:"dialogue",text:"new",idempotency_key:`other_${randomUUID()}`});
    await host.registerTaskIdentity(otherTicket,a.headers,otherEvent,{expected_revision:0,tasks:[otherTask],focus_keys:[otherKey]});
    const otherReceived=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[otherEvent.event_id])).rows[0].received_at.toISOString();
    const crossPayload={...payload,focus_keys:[otherKey],tasks:[{...payload.tasks[0],task:otherTask,event:{...payload.tasks[0].event,event_id:otherEvent.event_id,reference:`host-interaction:${otherEvent.event_id}`,received_at:otherReceived}}]};
    await expect(host.saveCheckpoint(otherTicket,a.headers,crossPayload,0,"cross-workspace-gap")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    // Even a question copied from its own event cannot smuggle deleted text
    // through a caller-chosen task/focus identifier.
    const maliciousEvent=await host.record(otherTicket,a.headers,{entry:"dialogue",text:"new",idempotency_key:`malicious_${randomUUID()}`});
    const maliciousTask={...task,task_key:secret,question:"new"};
    await host.registerTaskIdentity(otherTicket,a.headers,maliciousEvent,{expected_revision:0,tasks:[maliciousTask],focus_keys:[secret]});
    const maliciousReceived=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[maliciousEvent.event_id])).rows[0].received_at.toISOString();
    const maliciousPayload={...payload,focus_keys:[secret],tasks:[{...payload.tasks[0],task:maliciousTask,event:{...payload.tasks[0].event,event_id:maliciousEvent.event_id,reference:`host-interaction:${maliciousEvent.event_id}`,received_at:maliciousReceived}}]};
    await expect(host.saveCheckpoint(otherTicket,a.headers,maliciousPayload,0,"unminted-key-gap")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    // Owner-only fixture seeds a legacy scene matching the previously observed
    // vulnerable state, to verify deletion cleans already persisted copies.
    const legacy=validateCheckpoint(payload,trip,0), ref="a".repeat(64), savedAt=new Date().toISOString();
    await owner.query("BEGIN");
    try {
      const write=await owner.query<{value:{ack?:unknown}}>('SELECT e03_checkpoint.write_scene($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) AS value',
        [`user-${a.user.id}`,trip,newer.workspace_key,0,"legacy-key",digest(legacy),JSON.stringify({e11_scene_ref:ref}),checkpointDigest(legacy),savedAt,null,false]);
      expect(write.rows[0].value).toHaveProperty("ack");
      await owner.query('INSERT INTO public."HostEvidenceScene" (owner_id,trip_id,workspace_key,scene_ref,checkpoint_revision,payload_digest,payload) VALUES ($1,$2,$3,$4,1,$5,$6::jsonb)',
        [a.user.id,trip,newer.workspace_key,ref,checkpointDigest(legacy),JSON.stringify(legacy)]);
      await owner.query("COMMIT");
    } catch(error) { await owner.query("ROLLBACK"); throw error; }
    const scene=await owner.query<{body:string}>('SELECT payload::text AS body FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,newer.workspace_key]);
    expect(scene.rows[0].body).toContain(secret);
    const binds=await owner.query<{event_id:string}>('SELECT event_id FROM public."HostEvidenceTaskSource" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,newer.workspace_key]);
    expect(binds.rows.map(row=>row.event_id)).toEqual([newer.event_id]);
    await host.deleteEvent(ticket,a.headers,older.event_id);
    expect((await owner.query('SELECT 1 FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,newer.workspace_key])).rowCount).toBe(0);
    await expect(host.restoreCheckpoint(ticket,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    await expect(host.saveCheckpoint(ticket,a.headers,payload,0,"source-gap-retry")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    const replayed=await host.record(ticket,a.headers,newerInput);
    await expect(host.registerTaskIdentity(ticket,a.headers,replayed,{expected_revision:0,tasks:[task],focus_keys:[taskKey]})).rejects.toMatchObject({code:"RECOVERED_EVENT_REPLAY"});
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,newer.workspace_key])).rows[0].capability_token;
    const validPayload=validateCheckpoint(payload,trip,0);
    const direct=(await runtime.query<{value:unknown}>('SELECT public.host_checkpoint_save_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) AS value',
      [a.session.session.id,a.user.id,trip,newer.workspace_key,cap,0,"direct-retry",digest({expected_revision:0,payload:validPayload,deleted:false}),JSON.stringify(validPayload),checkpointDigest(validPayload),new Date().toISOString(),null])).rows[0].value;
    expect(direct).toEqual({fault:"RECOVERY_UNAVAILABLE"});
    const retained=await owner.query<{deleted_at:Date|null}>('SELECT deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[newer.event_id]);
    expect(retained.rows).toEqual([{deleted_at:null}]);
  },30000);
  it("fails closed on authoritative TS object identifiers without source proof", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),key=await host.mintTaskKey(ticket,a.headers,"task-key");
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"new",idempotency_key:`ts-id_${randomUUID()}`});
    const task={task_key:key,question:"new",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:"new"}],progress:"open",progress_evidence:null};
    await host.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
    const before=(await owner.query<{snapshot:typeof base}>('SELECT snapshot FROM public."TripStateDocument" WHERE "tripId"=$1',[trip])).rows[0].snapshot;
    const object=structuredClone(base.objects[0]);object.id=`old-text-${randomUUID()}`;object.trip_id=trip;
    const changed={...before,objects:[object]};
    const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[{id:object.id,version:object.version}],
      tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"new",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],
      focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    await owner.query('UPDATE public."TripStateDocument" SET snapshot=$2::jsonb WHERE "tripId"=$1',[trip,JSON.stringify(changed)]);
    try {
      await expect(host.saveCheckpoint(ticket,a.headers,payload,0,"ts-id")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
      expect((await owner.query('SELECT 1 FROM public."HostEvidenceScene" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rowCount).toBe(0);
    } finally { await owner.query('UPDATE public."TripStateDocument" SET snapshot=$2::jsonb WHERE "tripId"=$1',[trip,JSON.stringify(before)]); }
  },30000);
  it("recovers an uncertain key receipt by the same request without minting twice", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    let failOnce=true;
    const candidate=await openEvidenceHost(env,{afterMintCommit:async()=>{if(failOnce){failOnce=false;throw new Error("simulated lost receipt");}}});
    try {
      const ticket=await candidate.createWorkspace(trip,a.headers);
      await expect(candidate.mintTaskKey(ticket,a.headers,"stable-request")).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      const rows=await owner.query<{task_key:string}>('SELECT task_key FROM public."HostEvidenceTaskKey" WHERE owner_id=$1 AND trip_id=$2',[a.user.id,trip]);
      expect(rows.rows).toHaveLength(1);
      expect(await candidate.mintTaskKey(ticket,a.headers,"stable-request")).toBe(rows.rows[0].task_key);
      expect(await candidate.mintTaskKey(ticket,a.headers,"stable-request")).toBe(rows.rows[0].task_key);
      expect((await owner.query('SELECT 1 FROM public."HostEvidenceTaskKey" WHERE owner_id=$1 AND trip_id=$2',[a.user.id,trip])).rowCount).toBe(1);
    } finally {await candidate.close();}
  },30000);
  it("fails closed at bounded key and potential-source event limits", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),key=await host.mintTaskKey(ticket,a.headers,"bounded-key");
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"ok",idempotency_key:`bounded_${randomUUID()}`});
    const task={task_key:key,question:"ok",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"ok"}],progress:"open",progress_evidence:null};
    await host.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
    await owner.query(`INSERT INTO public."HostEvidenceTaskKey"(owner_id,trip_id,workspace_key,task_key,request_token)
      SELECT $1,$2,$3,'task-'||replace(gen_random_uuid()::text,'-',''),encode(sha256(convert_to('fixture-key-'||i::text,'UTF8')),'hex') FROM generate_series(1,255) i`,[a.user.id,trip,event.workspace_key]);
    expect(await host.mintTaskKey(ticket,a.headers,"bounded-key")).toBe(key);
    await expect(host.mintTaskKey(ticket,a.headers,"overflow-key")).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await owner.query(`INSERT INTO public."HostEvidenceEvent"(owner_id,trip_id,workspace_key,event_id,session_ref,entry,body,received_at,key_token,input_digest,policy)
      SELECT $1,$2,$3,'event_'||replace(gen_random_uuid()::text,'-',''),$4,'dialogue','x',clock_timestamp(),
        encode(sha256(convert_to('fixture-event-'||i::text,'UTF8')),'hex'),encode(sha256(convert_to('fixture-digest-'||i::text,'UTF8')),'hex'),'DC-AC8-PRIVACY-01' FROM generate_series(1,255) i`,[a.user.id,trip,event.workspace_key,a.session.session.id]);
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
    const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"ok",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    expect(await host.saveCheckpoint(ticket,a.headers,payload,0,"at-event-limit")).toMatchObject({checkpoint_revision:1});
    await owner.query(`INSERT INTO public."HostEvidenceEvent"(owner_id,trip_id,workspace_key,event_id,session_ref,entry,body,received_at,key_token,input_digest,policy)
      VALUES($1,$2,$3,'event_'||replace(gen_random_uuid()::text,'-',''),$4,'dialogue','x',clock_timestamp(),
        encode(sha256(convert_to('fixture-event-overflow','UTF8')),'hex'),encode(sha256(convert_to('fixture-digest-overflow','UTF8')),'hex'),'DC-AC8-PRIVACY-01')`,[a.user.id,trip,event.workspace_key,a.session.session.id]);
    await expect(host.restoreCheckpoint(ticket,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    await expect(host.saveCheckpoint(ticket,a.headers,payload,1,"over-event-limit")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    const saved=await owner.query<{revision:string}>('SELECT revision FROM e03_checkpoint.heads WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3',[`user-${a.user.id}`,trip,event.workspace_key]);
    expect(saved.rows).toEqual([{revision:"1"}]);
  },30000);
  it("keeps early invalid save attempts visible without letting another user alter the status", async () => {
    const a=await account(),b=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[trip,a.user.id,b.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers),key=await host.mintTaskKey(ticket,a.headers,"status-key");
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"status",idempotency_key:`status_${randomUUID()}`});
    const task={task_key:key,question:"status",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:6,quote:"status"}],progress:"open",progress_evidence:null};
    await host.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
    const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"status",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    await host.saveCheckpoint(ticket,a.headers,payload,0,"status-save");
    await expect(host.saveCheckpoint(ticket,b.headers,payload,0,"unauthorized")).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    expect(await host.restoreCheckpoint(ticket,a.headers,2)).toMatchObject({candidate_save_unacknowledged:false});
    const unsupported={...payload,drafts:[{draft_id:"draft",draft_kind:"unsubmitted",base_revision:0,target_ids:[],text:"draft",source_reference:"draft",proposal:null}]};
    await expect(host.saveCheckpoint(ticket,a.headers,unsupported,1,"unsupported-draft")).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
    expect(await host.restoreCheckpoint(ticket,a.headers,2)).toMatchObject({candidate_save_unacknowledged:true});
    expect(capturedWarnings).toContain("scene_save_unacknowledged_business_state_is_separate");
  },30000);
  it("reports a save queued during recovery as unacknowledged before and after generation rotation", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    let watch=false,entered!:()=>void,release!:()=>void,queued!:()=>void,warnings:string[]=[];
    const inRestore=new Promise<void>(resolve=>{entered=resolve;}),allowRestore=new Promise<void>(resolve=>{release=resolve;}),saveQueued=new Promise<void>(resolve=>{queued=resolve;});
    const candidate=await openEvidenceHost(env,{afterCandidateBeforeRecheck:async()=>{if(watch){entered();await allowRestore;}},
      onSaveQueued:()=>{if(watch) queued();},onCandidatePacketWarnings:value=>{warnings=[...value];}});
    try {
      const ticket=await candidate.createWorkspace(trip,a.headers),key=await candidate.mintTaskKey(ticket,a.headers,"queue-key");
      const event=await candidate.record(ticket,a.headers,{entry:"dialogue",text:"queue",idempotency_key:`queue_${randomUUID()}`});
      const task={task_key:key,question:"queue",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:5,quote:"queue"}],progress:"open",progress_evidence:null};
      await candidate.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
      const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
      const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"queue",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
      await candidate.saveCheckpoint(ticket,a.headers,payload,0,"first-save");
      watch=true;const restoring=candidate.restoreCheckpoint(ticket,a.headers,2);await inRestore;
      const saving=candidate.saveCheckpoint(ticket,a.headers,payload,0,"queued-save");
      const rejected=expect(saving).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
      await saveQueued;release();
      expect(await restoring).toMatchObject({candidate_save_unacknowledged:true});
      expect(warnings).toContain("scene_save_unacknowledged_business_state_is_separate");
      await rejected;watch=false;
      expect(await candidate.restoreCheckpoint(ticket,a.headers,2)).toMatchObject({candidate_save_unacknowledged:true});
    } finally {release();await candidate.close();}
  },30000);
  it.each([["conflicting",0,"CHECKPOINT_CONFLICT",true],["valid",1,2,false]] as const)("rejects a stale packet candidate and continues a %s save after the commit window", async (_label,expectedRevision,expectedResult,pendingAfter) => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    let watch=false,queued!:()=>void,lateSave:Promise<string|number>|undefined;
    const saveQueued=new Promise<void>(resolve=>{queued=resolve;});
    let ticket:object,payload:unknown;
    const candidate:Awaited<ReturnType<typeof openEvidenceHost>>=await openEvidenceHost(env,{
      onSaveQueued:()=>{if(watch) queued();},
      afterRestoreCommit:async()=>{if(watch){lateSave=candidate.saveCheckpoint(ticket,a.headers,payload,expectedRevision,"late-save").then(ack=>ack.checkpoint_revision,(e:{code?:string})=>e.code||"unknown");await saveQueued;}},
    });
    try {
      ticket=await candidate.createWorkspace(trip,a.headers);const key=await candidate.mintTaskKey(ticket,a.headers,"late-key");
      const event=await candidate.record(ticket,a.headers,{entry:"dialogue",text:"late",idempotency_key:`late_${randomUUID()}`});
      const task={task_key:key,question:"late",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:4,quote:"late"}],progress:"open",progress_evidence:null};
      await candidate.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
      const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
      payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"late",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
      await candidate.saveCheckpoint(ticket,a.headers,payload,0,"first-save");watch=true;
      await expect(candidate.restoreCheckpoint(ticket,a.headers,2)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
      expect(await lateSave).toBe(expectedResult);watch=false;
      expect(await candidate.restoreCheckpoint(ticket,a.headers,2)).toMatchObject({candidate_save_unacknowledged:pendingAfter});
    } finally {await candidate.close();}
  },30000);
  it("replays a deletion without invalidating work created after its persisted cutoff", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers);
    const old=await host.record(ticket,a.headers,{entry:"dialogue",text:"old",idempotency_key:`old_${randomUUID()}`});
    const beforeKey=await host.mintTaskKey(ticket,a.headers,"old-key");
    expect(beforeKey).toMatch(/^task-[0-9a-f]{32}$/);
    const deleted=await host.deleteEvent(ticket,a.headers,old.event_id);
    await expect(host.mintTaskKey(ticket,a.headers,"old-key")).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    const key=await host.mintTaskKey(ticket,a.headers,"task-key");
    const next=await host.record(ticket,a.headers,{entry:"dialogue",text:"new",idempotency_key:`next_${randomUUID()}`});
    const task={task_key:key,question:"new",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:"new"}],progress:"open",progress_evidence:null};
    const raw={expected_revision:0,tasks:[task],focus_keys:[key]};
    const before=await host.registerTaskIdentity(ticket,a.headers,next,raw);
    const bindings=async()=> (await owner.query('SELECT task_token,task_digest,event_id,event_token FROM public."HostEvidenceTaskSource" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 ORDER BY event_id',[a.user.id,trip,next.workspace_key])).rows;
    const original=await bindings(); expect(original).toHaveLength(1);
    expect(await host.deleteEvent(ticket,a.headers,old.event_id)).toEqual(deleted);
    expect(await bindings()).toEqual(original);
    expect((await owner.query('SELECT 1 FROM public."HostEvidenceTaskKey" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 AND task_key=$4',[a.user.id,trip,next.workspace_key,key])).rowCount).toBe(1);
    expect(await host.registerTaskIdentity(ticket,a.headers,next,raw)).toEqual(before);
    const cutoff=await owner.query<{cutoff_sequence:string}>('SELECT cutoff_sequence FROM public."HostEvidenceCleanup" WHERE event_id=$1',[old.event_id]);
    expect(cutoff.rows).toEqual([{cutoff_sequence:String(old.sequence)}]);
  },30000);
  it("fails closed after an independently committed deletion until its original receipt is synchronized", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers);
    const old=await host.record(ticket,a.headers,{entry:"dialogue",text:"old",idempotency_key:`old_${randomUUID()}`});
    const b=await host.record(ticket,a.headers,{entry:"dialogue",text:"new",idempotency_key:`new_${randomUUID()}`});
    const task={task_key:"sync-task",question:"new",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:"new"}],progress:"open",progress_evidence:null};
    const raw={expected_revision:0,tasks:[task],focus_keys:["sync-task"]}; await host.registerTaskIdentity(ticket,a.headers,b,raw);
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,old.workspace_key])).rows[0].capability_token;
    const direct=await runtime.query('SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)',[a.session.session.id,a.user.id,trip,old.workspace_key,cap,old.event_id]);
    expect(direct.rows).toMatchObject([{disposition:"deleted"}]);
    await expect(host.registerTaskIdentity(ticket,a.headers,b,raw)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    await expect(host.record(ticket,a.headers,{entry:"dialogue",text:"after",idempotency_key:`after_${randomUUID()}`})).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await host.deleteEvent(ticket,a.headers,old.event_id);
    const fresh=await host.record(ticket,a.headers,{entry:"dialogue",text:"after",idempotency_key:`fresh_${randomUUID()}`});
    const freshTask={...task,task_key:"fresh-sync",question:"after",evidence:[{start:0,end:5,quote:"after"}]};
    await expect(host.registerTaskIdentity(ticket,a.headers,fresh,{expected_revision:0,tasks:[freshTask],focus_keys:["fresh-sync"]})).resolves.toMatchObject({task_keys:["fresh-sync"]});
  },30000);
  it("rejects a record queued before a deletion and does not reinsert its body", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers), text=`queued-secret-${randomUUID()}`;
    const old=await host.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`old_${randomUUID()}`});
    const observer=new Client({connectionString:config!.migrationUrl});await observer.connect();
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN");let committed=false;
    try {
      await owner.query('SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 FOR UPDATE',[a.user.id,trip,old.workspace_key]);
      const deleting=host.deleteEvent(ticket,a.headers,old.event_id);let blocked=false;
      for(let i=0;i<100;i++){
        const r=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_delete_event_candidate%') AS blocked",[pid]);
        if(r.rows[0].blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      const pending=host.record(ticket,a.headers,{entry:"dialogue",text,idempotency_key:`queued_${randomUUID()}`});
      const rejected=expect(pending).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query("COMMIT");committed=true;await deleting;await rejected;
      expect((await owner.query('SELECT 1 FROM public."HostEvidenceEvent" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 AND body=$4',[a.user.id,trip,old.workspace_key,text])).rowCount).toBe(1);
    } finally {if(!committed) await owner.query("ROLLBACK");await observer.end();}
  },30000);
  it("rolls back all deletion effects when the session expires while cleanup waits", async () => {
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers), key=await host.mintTaskKey(ticket,a.headers,"task-key");
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"keep",idempotency_key:`keep_${randomUUID()}`});
    const task={task_key:key,question:"keep",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:4,quote:"keep"}],progress:"open",progress_evidence:null};
    await host.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
    const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"keep",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    await host.saveCheckpoint(ticket,a.headers,payload,0,"rollback-save");
    await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '3 seconds' WHERE id=$1`,[a.session.session.id]);
    const observer=new Client({connectionString:config!.migrationUrl});await observer.connect();const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN");let committed=false;
    try {
      await owner.query('LOCK TABLE public."HostEvidenceTaskSource" IN ACCESS EXCLUSIVE MODE');
      const pending=host.deleteEvent(ticket,a.headers,event.event_id);const outcome=pending.then(()=>"unexpected",(e:{code?:string})=>e.code);let blocked=false,expired=false;
      for(let i=0;i<160 && !(blocked&&expired);i++){
        const r=await observer.query<{blocked:boolean;expired:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_delete_event_candidate%') AS blocked,(SELECT "expiresAt"<=clock_timestamp() FROM "AuthSession" WHERE id=$2) AS expired`,[pid,a.session.session.id]);
        blocked ||= r.rows[0].blocked;expired ||= r.rows[0].expired;if(!(blocked&&expired)) await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);expect(expired).toBe(true);await owner.query("COMMIT");committed=true;
      expect(await outcome).toBe("EVIDENCE_UNAVAILABLE");
    } finally {if(!committed)await owner.query("ROLLBACK");await observer.end();}
    const row=await owner.query<{deleted_at:Date|null;retention_revision:string;scenes:string;receipts:string;sources:string}>(`SELECT e.deleted_at,w.retention_revision,
      (SELECT count(*) FROM public."HostEvidenceScene" WHERE owner_id=$2 AND trip_id=$3 AND workspace_key=$4) AS scenes,
      (SELECT count(*) FROM e03_checkpoint.receipts WHERE owner_id=$5 AND trip_id=$3 AND workspace=$4) AS receipts,
      (SELECT count(*) FROM public."HostEvidenceTaskSource" WHERE owner_id=$2 AND trip_id=$3 AND workspace_key=$4) AS sources
      FROM public."HostEvidenceEvent" e JOIN public."HostEvidenceWorkspace" w USING(owner_id,trip_id,workspace_key) WHERE e.event_id=$1`,[event.event_id,a.user.id,trip,event.workspace_key,`user-${a.user.id}`]);
    expect(row.rows).toEqual([{deleted_at:null,retention_revision:"0",scenes:"1",receipts:"1",sources:"1"}]);
    await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=$1`,[a.session.session.id]);
    await expect(host.deleteEvent(ticket,a.headers,event.event_id)).resolves.toMatchObject({durable:true});
  },30000);
  it("snapshots mutable Task input before waiting for a real database lock", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers), key=await host.mintTaskKey(ticket,a.headers,"task-key");
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"one two",idempotency_key:`clone_${randomUUID()}`});
    const first={task_key:"one",question:"one",kind:"explore",target_ids:[] as string[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:"one"}],progress:"open",progress_evidence:null};
    const second={...first,task_key:key,question:"two",target_ids:[] as string[],evidence:[{start:4,end:7,quote:"two"}]};
    const original=structuredClone(second), raw={expected_revision:0,tasks:[first,second],focus_keys:[key]};
    const received=(await owner.query<{received_at:Date}>('SELECT received_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0].received_at.toISOString();
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN"); let committed=false;
    try {
      await owner.query('LOCK TABLE public."HostEvidenceTaskSource" IN ACCESS EXCLUSIVE MODE');
      const pending=host.registerTaskIdentity(ticket,a.headers,event,raw); let blocked=false;
      for(let i=0;i<100;i++) {
        const r=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND (query LIKE '%host_evidence_for_turn_candidate%' OR query LIKE '%host_evidence_bind_task_source_candidate%')) AS blocked",[pid]);
        if(r.rows[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true); second.target_ids.push("missing");
      await owner.query("COMMIT"); committed=true;
      expect((await pending).task_keys).toEqual(["one",key]);
    } finally { if(!committed) await owner.query("ROLLBACK"); await observer.end(); }
    const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],
      tasks:[{task:original,event:{event_id:event.event_id,entry:"dialogue",text:"one two",reference:`host-interaction:${event.event_id}`,received_at:received},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],
      focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
    await expect(host.saveCheckpoint(ticket,a.headers,payload,0,"clone-save")).resolves.toMatchObject({checkpoint_revision:1});
  },30000);
  it("does not expose a missing checkpoint fault when the session expires while waiting", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const ticket=await host.createWorkspace(trip,a.headers);
    const event=await host.record(ticket,a.headers,{entry:"dialogue",text:"empty",idempotency_key:`missing_${randomUUID()}`});
    const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rows[0].capability_token;
    await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[a.session.session.id]);
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN"); let committed=false;
    try {
      await owner.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))",[`user-${a.user.id}`,trip,event.workspace_key]);
      const pending=runtime.query<{value:unknown}>('SELECT public.host_checkpoint_inspect_candidate($1,$2,$3,$4,$5) AS value',[a.session.session.id,a.user.id,trip,event.workspace_key,cap]);
      let blocked=false,expired=false;
      for(let i=0;i<150 && !(blocked && expired);i++) {
        const r=await observer.query<{blocked:boolean;expired:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_checkpoint_inspect_candidate%') AS blocked, (SELECT "expiresAt"<=clock_timestamp() FROM "AuthSession" WHERE id=$2) AS expired`,[pid,a.session.session.id]);
        blocked ||= r.rows[0].blocked; expired ||= r.rows[0].expired;
        if(!(blocked && expired)) await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true); expect(expired).toBe(true);
      await owner.query("COMMIT"); committed=true;
      expect((await pending).rows).toEqual([{value:{fault:"RECOVERY_UNAVAILABLE"}}]);
    } finally { if(!committed) await owner.query("ROLLBACK"); await observer.end(); }
  },30000);
  it("rechecks natural deadlines after recovery computation and refuses installation after close", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    let mode:"idle"|"wait"|"queue"|"close"="idle", hits=0;
    let entered!:()=>void,release!:()=>void;
    const inRestore=new Promise<void>(resolve=>{entered=resolve;}), allowRestore=new Promise<void>(resolve=>{release=resolve;});
    const candidate:Awaited<ReturnType<typeof openEvidenceHost>>=await openEvidenceHost(env,{beforeRestoreRecheck:async()=>{if(mode==="wait"){hits++;await new Promise(resolve=>setTimeout(resolve,3300));} if(mode==="queue"){entered();await allowRestore;}},
      afterRestoreCommit:async()=>{if(mode==="close") await candidate.close();}});
    try {
      const ticket=await candidate.createWorkspace(trip,a.headers), key=await candidate.mintTaskKey(ticket,a.headers,"task-key");
      const event=await candidate.record(ticket,a.headers,{entry:"dialogue",text:"time",idempotency_key:`expiry_${randomUUID()}`});
      const task={task_key:key,question:"time",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:4,quote:"time"}],progress:"open",progress_evidence:null};
      await candidate.registerTaskIdentity(ticket,a.headers,event,{expected_revision:0,tasks:[task],focus_keys:[key]});
      const source=(await owner.query<{received_at:Date;recorded_at:string}>('SELECT received_at,recorded_at::text FROM public."HostEvidenceEvent" WHERE event_id=$1',[event.event_id])).rows[0];
      const payload={checkpoint_format_version:1,trip_id:trip,captured_state_revision:0,captured_object_versions:[],
        tasks:[{task,event:{event_id:event.event_id,entry:"dialogue",text:"time",reference:`host-interaction:${event.event_id}`,received_at:source.received_at.toISOString()},base_revision:0,processing_status:"unprocessed",result_revision:0,errors:[]}],
        focus_keys:[key],view:{entry:"dialogue",comparison_refs:[],selected_id:null,expanded_task_keys:[]},drafts:[],deferred_issue_ids:[]};
      await candidate.saveCheckpoint(ticket,a.headers,payload,0,"time-save");
      mode="wait";
      await owner.query(`UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval '180 days'+interval '3 seconds' WHERE event_id=$1`,[event.event_id]);
      await expect(candidate.restoreCheckpoint(ticket,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
      expect(hits).toBe(1);
      await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=$2::timestamptz WHERE event_id=$1',[event.event_id,source.recorded_at]);
      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '3 seconds' WHERE id=$1`,[a.session.session.id]);
      await expect(candidate.restoreCheckpoint(ticket,a.headers)).rejects.toMatchObject({code:"RECOVERY_UNAVAILABLE"});
      expect(hits).toBe(2);
      await owner.query(`UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=$1`,[a.session.session.id]);
      mode="queue";
      const restoring=candidate.restoreCheckpoint(ticket,a.headers); await inRestore;
      const queued=candidate.record(ticket,a.headers,{entry:"dialogue",text:"queued before restore",idempotency_key:`queued_${randomUUID()}`});
      const rejected=expect(queued).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      release(); await restoring; await rejected;
      expect((await owner.query('SELECT 1 FROM public."HostEvidenceEvent" WHERE owner_id=$1 AND trip_id=$2 AND body=$3',[a.user.id,trip,"queued before restore"])).rowCount).toBe(0);
      mode="close";
      await expect(candidate.restoreCheckpoint(ticket,a.headers)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    } finally { await candidate.close(); }
  },30000);
  it("rejects an expired session after a workspace was issued", async () => {
    const a = await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, a.user.id]);
    const workspace = await host.createWorkspace(trip, a.headers);
    await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [a.session.session.id]);
    await expect(host.record(workspace, a.headers, { entry: "dialogue", text: "x", idempotency_key: "expired" })).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DENIED" });
  }, 30000);
  it("releases a process-local workspace without deleting its stored evidence",async()=>{
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const workspace=await host.createWorkspace(trip,a.headers), input={entry:"dialogue",text:"保留",idempotency_key:`dispose_${randomUUID()}`};
    const receipt=await host.record(workspace,a.headers,input); await host.disposeWorkspace(workspace);
    await expect(host.record(workspace,a.headers,input)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    const row=await owner.query('SELECT deleted_at FROM public."HostEvidenceEvent" WHERE event_id=$1',[receipt.event_id]);
    expect(row.rows).toEqual([{deleted_at:null}]);
  },30000);
  it("invalidates a task whose key repeats deleted user text while allowing an unrelated task",async()=>{
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const workspace=await host.createWorkspace(trip,a.headers), sensitive="passport123456";
    const original=await host.record(workspace,a.headers,{entry:"dialogue",text:sensitive,idempotency_key:`sensitive_${randomUUID()}`});
    const initial={expected_revision:0,tasks:[{task_key:sensitive,question:sensitive,kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:sensitive.length,quote:sensitive}],progress:"open",progress_evidence:null}],focus_keys:[sensitive]};
    await host.registerTaskIdentity(workspace,a.headers,original,initial);
    await host.deleteEvent(workspace,a.headers,original.event_id);
    const next=await host.record(workspace,a.headers,{entry:"dialogue",text:"new",idempotency_key:`new_${randomUUID()}`});
    const continued={...initial,tasks:[{...initial.tasks[0],relation:"continue",evidence:[{start:0,end:3,quote:"new"}]}]};
    await expect(host.registerTaskIdentity(workspace,a.headers,next,continued)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    const unrelated={...continued,tasks:[{...continued.tasks[0],task_key:"independent",relation:"new"}],focus_keys:["independent"]};
    await expect(host.registerTaskIdentity(workspace,a.headers,next,unrelated)).resolves.toMatchObject({task_keys:["independent"]});
  },30000);
  it("preserves same-turn and cross-turn identity guards while isolating identical keys by workspace",async()=>{
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const workspace=await host.createWorkspace(trip,a.headers), another=await host.createWorkspace(trip,a.headers);
    const event=await host.record(workspace,a.headers,{entry:"dialogue",text:"one two",idempotency_key:`batch_${randomUUID()}`});
    const one={task_key:"task-one",question:"one",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:3,quote:"one"}],progress:"open",progress_evidence:null};
    const two={...one,task_key:"task-two",question:"two",relation:"refine",related_task_keys:["task-one"],evidence:[{start:4,end:7,quote:"two"}]};
    const batch={expected_revision:0,tasks:[one,two],focus_keys:["task-two"]};
    const first=await host.registerTaskIdentity(workspace,a.headers,event,batch);
    expect(first.task_keys).toEqual(["task-one","task-two"]);
    expect(await host.registerTaskIdentity(workspace,a.headers,event,batch)).toEqual(first);
    const next=await host.record(workspace,a.headers,{entry:"dialogue",text:"again",idempotency_key:`continue_${randomUUID()}`});
    const continuation={expected_revision:0,tasks:[{...one,relation:"continue",evidence:[{start:0,end:5,quote:"again"}]}],focus_keys:["task-one"]};
    expect((await host.registerTaskIdentity(workspace,a.headers,next,continuation)).task_keys).toEqual(["task-one"]);
    const bad=await host.record(workspace,a.headers,{entry:"dialogue",text:"again",idempotency_key:`mismatch_${randomUUID()}`});
    await expect(host.registerTaskIdentity(workspace,a.headers,bad,{...continuation,tasks:[{...continuation.tasks[0],branch:"hypothetical"}]})).rejects.toMatchObject({code:"TASK_IDENTITY"});
    const other=await host.record(another,a.headers,{entry:"dialogue",text:"one",idempotency_key:`other_${randomUUID()}`});
    await expect(host.registerTaskIdentity(another,a.headers,other,{expected_revision:0,tasks:[one],focus_keys:["task-one"]})).resolves.toMatchObject({task_keys:["task-one"]});
  },30000);
  it("serializes replay publication with deletion and invalidates the returned proof",async()=>{
    const a=await account();await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const workspace=await host.createWorkspace(trip,a.headers), input={entry:"dialogue",text:"原话",idempotency_key:`serial_${randomUUID()}`};
    const receipt=await host.record(workspace,a.headers,input), pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const observer=new Client({connectionString:config!.migrationUrl});await observer.connect();await owner.query("BEGIN");let committed=false;
    try {
      await owner.query('SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3 FOR UPDATE',[a.user.id,trip,receipt.workspace_key]);
      const replayPromise=host.record(workspace,a.headers,input);
      let blocked=false;
      for(let i=0;i<100;i++){
        const row=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_evidence_record_candidate%') AS blocked",[pid]);
        if(row.rows[0].blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      const deletion=host.deleteEvent(workspace,a.headers,receipt.event_id);
      await owner.query("COMMIT");committed=true;
      const replay=await replayPromise; await deletion;
      const interpretation={expected_revision:0,tasks:[{task_key:"task-replay",question:"原话",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"原话"}],progress:"open",progress_evidence:null}],focus_keys:["task-replay"]};
      await expect(host.registerTaskIdentity(workspace,a.headers,replay,interpretation)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
      await expect(host.record(workspace,a.headers,input)).rejects.toMatchObject({code:"EVIDENCE_DELETED"});
    }finally{if(!committed)await owner.query("ROLLBACK");await observer.end();}
  },30000);
  it("fails closed for absent, stale or ended lifecycle evidence and corrupted state references", async () => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const workspace=await host.createWorkspace(trip,a.headers);
    const receipt=await host.record(workspace,a.headers,{entry:"dialogue",text:"原话",idempotency_key:`lifecycle_${randomUUID()}`});
    const interpretation={expected_revision:0,tasks:[{task_key:"task-lifecycle",question:"原话",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"原话"}],progress:"open",progress_evidence:null}],focus_keys:["task-lifecycle"]};
    try {
      await owner.query('DELETE FROM public."HostEvidenceTripLifecycle" WHERE trip_id=$1',[trip]);
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,1,NULL)',[trip]);
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET source_revision=0,ended_at=clock_timestamp()-interval \'31 days\' WHERE trip_id=$1',[trip]);
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET ended_at=clock_timestamp()+interval \'1 day\' WHERE trip_id=$1',[trip]);
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query('UPDATE public."HostEvidenceTripLifecycle" SET ended_at=NULL WHERE trip_id=$1',[trip]);
      await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()+interval \'1 day\' WHERE event_id=$1',[receipt.event_id]);
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
      await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp() WHERE event_id=$1',[receipt.event_id]);
      const row=await owner.query<{snapshot:typeof base}>('SELECT snapshot FROM "TripStateDocument" WHERE "tripId"=$1',[trip]);
      const original=row.rows[0].snapshot, corrupted=structuredClone(original), item=structuredClone(base.objects[0]);
      item.trip_id=trip; corrupted.objects=[item,structuredClone(item)];
      try {
        await owner.query('UPDATE "TripStateDocument" SET snapshot=$2::jsonb WHERE "tripId"=$1',[trip,JSON.stringify(corrupted)]);
        await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).rejects.toMatchObject({code:"DUPLICATE_ID"});
      } finally { await owner.query('UPDATE "TripStateDocument" SET snapshot=$2::jsonb WHERE "tripId"=$1',[trip,JSON.stringify(original)]); }
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).resolves.toMatchObject({task_keys:["task-lifecycle"]});
    } finally { await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL) ON CONFLICT (trip_id) DO UPDATE SET source_revision=0,ended_at=NULL',[trip]); }
  },30000);
  it.each(["revoke", "expire"] as const)("rechecks %s while registering task identity and leaves no partial result", async mode => {
    const a=await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
    const workspace=await host.createWorkspace(trip,a.headers);
    const receipt=await host.record(workspace,a.headers,{entry:"dialogue",text:"原话",idempotency_key:`register_${randomUUID()}`});
    const interpretation={expected_revision:0,tasks:[{task_key:"task-guard",question:"原话",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"原话"}],progress:"open",progress_evidence:null}],focus_keys:["task-guard"]};
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    await owner.query("BEGIN"); let committed=false;
    try {
      if(mode==="revoke")await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,a.user.id]);
      else await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[a.session.session.id]);
      const pending=host.registerTaskIdentity(workspace,a.headers,receipt,interpretation).then(()=>({code:"unexpected-success"}),error=>({code:error?.code as string}));
      let blocked=false;
      for(let i=0;i<100;i++) {
        const row=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%authorize_trip_session%') AS blocked",[pid]);
        if(row.rows[0].blocked){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true); await owner.query("COMMIT"); committed=true;
      expect(await pending).toEqual({code:"EVIDENCE_ACCESS_DENIED"});
      if(mode==="revoke")await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,a.user.id]);
      else await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[a.session.session.id]);
      await expect(host.registerTaskIdentity(workspace,a.headers,receipt,interpretation)).resolves.toMatchObject({task_keys:["task-guard"]});
    } finally {if(!committed)await owner.query("ROLLBACK");await observer.end();}
  },30000);
  it("does not register an expired event and serializes registration against a committed deletion", async () => {
    const a = await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip,a.user.id]);
    const workspace = await host.createWorkspace(trip,a.headers);
    const interpretation = {expected_revision:0,tasks:[{task_key:"task-race",question:"原话",kind:"explore",target_ids:[],branch:"actual",relation:"new",related_task_keys:[],certainty:"explicit",evidence:[{start:0,end:2,quote:"原话"}],progress:"open",progress_evidence:null}],focus_keys:["task-race"]};
    const expired=await host.record(workspace,a.headers,{entry:"dialogue",text:"原话",idempotency_key:`expired_${randomUUID()}`});
    await owner.query('UPDATE public."HostEvidenceEvent" SET recorded_at=clock_timestamp()-interval \'180 days\' WHERE event_id=$1',[expired.event_id]);
    await expect(host.registerTaskIdentity(workspace,a.headers,expired,interpretation)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
    const event=await host.record(workspace,a.headers,{entry:"dialogue",text:"原话",idempotency_key:`delete_${randomUUID()}`});
    const pid=(await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const observer=new Client({connectionString:config!.migrationUrl}); await observer.connect();
    await owner.query("BEGIN"); let committed=false;
    try {
      const cap=(await owner.query<{capability_token:string}>('SELECT capability_token FROM public."HostEvidenceWorkspace" WHERE owner_id=$1 AND trip_id=$2 AND workspace_key=$3',[a.user.id,trip,event.workspace_key])).rows[0].capability_token;
      const deleted=await owner.query("SELECT * FROM public.host_checkpoint_delete_event_candidate($1,$2,$3,$4,$5,$6)",[a.session.session.id,a.user.id,trip,event.workspace_key,cap,event.event_id]);
      expect(deleted.rows[0].disposition).toBe("deleted");
      const pending=host.registerTaskIdentity(workspace,a.headers,event,interpretation).then(()=>({code:"unexpected-success"}),error=>({code:error?.code as string}));
      let blocked=false;
      for(let i=0;i<100;i++) {
        const row=await observer.query<{blocked:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%host_evidence_for_turn_candidate%') AS blocked",[pid]);
        if(row.rows[0].blocked) {blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(blocked).toBe(true);
      await owner.query("COMMIT"); committed=true;
      expect(await pending).toEqual({code:"EVIDENCE_UNAVAILABLE"});
    } finally {if(!committed)await owner.query("ROLLBACK");await observer.end();}
  },30000);
  it.each(["revoke", "expire"] as const)("rechecks %s inside the record transaction", async mode => {
    const a = await account(); await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)', [trip, a.user.id]);
    const workspace = await host.createWorkspace(trip, a.headers);
    const pid = (await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const observer = new Client({ connectionString: config!.migrationUrl }); await observer.connect();
    await owner.query("BEGIN");
    let committed = false;
    try {
      if (mode === "revoke") await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [trip, a.user.id]);
      else await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [a.session.session.id]);
      const pending = host.record(workspace, a.headers, { entry: "dialogue", text: "never persisted", idempotency_key: `race_${randomUUID()}` })
        .then(() => ({ code: "unexpected-success" }), error => ({ code: error?.code as string }));
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await observer.query<{ blocked: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%authorize_trip_session%') AS blocked", [pid]);
        if (result.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      await owner.query("COMMIT"); committed = true;
      expect(await pending).toEqual({ code: "EVIDENCE_ACCESS_DENIED" });
      const records = await owner.query<{ count: string }>('SELECT count(*)::text AS count FROM public."HostEvidenceEvent" WHERE owner_id=$1 AND body=$2', [a.user.id, "never persisted"]);
      expect(records.rows[0].count).toBe("0");
    } finally { if (!committed) await owner.query("ROLLBACK"); await observer.end(); }
  }, 30000);
});
