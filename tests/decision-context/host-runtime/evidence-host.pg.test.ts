import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIdentity, type Identity } from "../../../src/server/auth/config";
import { openEvidenceHost } from "../../../src/server/decision-context/host-runtime/evidence-host";
import { issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { base } from "../../support/bcg-fixtures";

const file = process.env.E02_STORAGE_ENV_FILE;
const config = file ? JSON.parse(fs.readFileSync(file, "utf8")) as { migrationUrl: string; runtimeUrl: string; authUrl: string; runtimeRole: string; database: string } : null;
if (process.env.CI && !config?.authUrl) throw new Error("CI requires disposable PostgreSQL and actual Session");

describe.skipIf(!config?.authUrl)("E11 host recording and deletion with real Session and PostgreSQL", () => {
  let owner: Client, runtime: Client, identity: Identity;
  let host: Awaited<ReturnType<typeof openEvidenceHost>>;
  let internal: Awaited<ReturnType<typeof openInternalTripService>>;
  let created = false;
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
    const role = `"${config.runtimeRole}"`;
    await owner.query(`GRANT EXECUTE ON FUNCTION public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT), public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT), public.host_evidence_delete_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_evidence_for_turn_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO ${role}`);
    runtime = new Client({ connectionString: config.runtimeUrl }); await runtime.connect();
    identity = await openIdentity(env);
    internal = await openInternalTripService(config.runtimeUrl, secret);
    await internal.createTrip(trip, await issueInternalCapability(secret, trip, { role: "system", id: "e11-bootstrap" }));
    // Synthetic lifecycle evidence is test-only; no trusted lifecycle adapter exists yet.
    await owner.query('INSERT INTO public."HostEvidenceTripLifecycle" (trip_id,source_revision,ended_at) VALUES ($1,0,NULL)',[trip]);
    host = await openEvidenceHost(env);
  }, 30000);
  afterAll(async () => {
    await host?.close(); await internal?.close(); await identity?.close(); await runtime?.end();
    if (created) {
      await owner.query('DROP FUNCTION public.host_evidence_cleanup_candidate(TEXT), public.host_evidence_delete_candidate(TEXT,TEXT,TEXT,TEXT,TEXT), public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT), public.host_evidence_for_turn_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN), public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT)');
      await owner.query('DROP TABLE public."HostEvidenceCleanup", public."HostEvidenceEvent", public."HostEvidenceWorkspace", public."HostEvidenceTripLifecycle"');
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
    const direct = await runtime.query("SELECT * FROM public.host_evidence_record_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [otherSession.session.id, a.user.id, trip, first.workspace_key, "event_direct", "dialogue", "x", new Date(), "b".repeat(64), "a".repeat(64)]);
    expect(direct.rows).toMatchObject([{ disposition: "denied", out_event_id: null, out_sequence: null }]);
    const directDelete = await runtime.query("SELECT * FROM public.host_evidence_delete_candidate($1,$2,$3,$4,$5)",
      [otherSession.session.id, a.user.id, trip, first.workspace_key, first.event_id]);
    expect(directDelete.rows).toMatchObject([{ disposition: "denied", deletion_revision: null }]);
    const guessed = await runtime.query("SELECT * FROM public.host_evidence_for_turn_candidate($1,$2,$3,$4,$5,$6,$7)",
      [a.session.session.id,a.user.id,trip,first.workspace_key,first.event_id,"0".repeat(64),false]);
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
    await expect(host.registerTaskIdentity(workspace,a.headers,next,continued)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
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
      const deleted=await owner.query("SELECT * FROM public.host_evidence_delete_candidate($1,$2,$3,$4,$5)",[a.session.session.id,a.user.id,trip,event.workspace_key,event.event_id]);
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
