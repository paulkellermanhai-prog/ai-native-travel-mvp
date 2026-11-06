import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openIdentity, type Identity } from "../../src/server/auth/config";
import { sessionHost } from "../../src/server/auth/authorization";
import { issueInternalCapability, openInternalTripService } from "../../src/server/auth/internal-service";
import { openSyntheticStorageHarness, openTripCommandService } from "../../src/server/trip-state/internal/persistence";
import { openSessionContextService } from "../../src/server/decision-context/session-context";
import * as assembly from "../../src/server/decision-context/context-assembly";
import { requestAt } from "../support/command-fixtures";
import { base, change, object } from "../support/bcg-fixtures";
import { ingest } from "../support/fact-fixtures";

const path = process.env.E02_STORAGE_ENV_FILE;
const cfg = path ? JSON.parse(fs.readFileSync(path, "utf8")) as { authUrl: string; migrationUrl: string; runtimeUrl: string } : null;
if (process.env.CI && !cfg?.authUrl) throw new Error("CI requires real Session and PostgreSQL");
const resources: Array<{ close: () => Promise<void> }> = [];
let owner: Client;
function config() { return { ...process.env, DATABASE_URL: cfg!.runtimeUrl, AUTH_DATABASE_URL: cfg!.authUrl,
  BETTER_AUTH_URL: "http://127.0.0.1:3117", BETTER_AUTH_SECRET: crypto.randomBytes(32).toString("hex") }; }
async function account(identity: Identity) {
  const password = crypto.randomBytes(24).toString("base64url"), email = `${crypto.randomUUID()}@example.invalid`;
  const created = await identity.auth.api.signUpEmail({ body: { name: "DC Session test", email, password } });
  const login = await identity.auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin: identity.config.origin }), asResponse: true });
  expect(login.status).toBe(200);
  const headers = new Headers({ cookie: login.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ") });
  const session = await identity.auth.api.getSession({ headers }); if (!session) throw new Error("Login must establish a Session");
  return { user: created.user, headers, session, email, password };
}
async function setup() {
  const env = config(), identity = await openIdentity(env); resources.push(identity);
  const a = await account(identity), b = await account(identity), trip = `trip-dc-${crypto.randomBytes(8).toString("hex")}`,
    other = `trip-dc-${crypto.randomBytes(8).toString("hex")}`, secret = crypto.randomBytes(32).toString("hex");
  const internal = await openInternalTripService(cfg!.runtimeUrl,secret); resources.push(internal);
  for (const id of [trip,other]) await internal.createTrip(id,await issueInternalCapability(secret,id,{role:"system",id:"dc-test-bootstrap"}));
  await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3),($4,$3)',[trip,a.user.id,b.user.id,other]);
  const trips = await openTripCommandService(cfg!.runtimeUrl,sessionHost(identity)); resources.push(trips);
  const dc = await openSessionContextService(env); resources.push(dc);
  return { a,b,trip,other,trips,dc,internal,secret,identity };
}
async function fingerprint(trip: string) {
  const rows=[];
  for (const table of ["TripStateDocument","TripStateHistory","TripStateProposal","TripStateIdempotency"])
    rows.push((await owner.query(`SELECT row_to_json(t)::text AS row FROM "${table}" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text`,[trip])).rows);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function goal() { const r=requestAt(1,0,`dc-goal-${crypto.randomUUID()}`);r.input.target_ids=[];const c=r.commands[0];
  if(c.op!=="create"||c.object_type!=="TripGoal")throw new Error("Source fixture");c.data.destination_ids=[];return r; }

describe.skipIf(!cfg?.authUrl)("DC Session-bound read and consumption using PostgreSQL",()=>{
  beforeAll(async()=>{owner=new Client({connectionString:cfg!.migrationUrl});await owner.connect();});
  afterEach(async()=>{await Promise.all(resources.splice(0).map(r=>r.close()));});
  afterAll(async()=>{await owner?.end();});

  it("binds opaque tickets to the live authenticated Session, member and trip without business writes",async()=>{
    const f=await setup(), before=await fingerprint(f.trip), beforeOther=await fingerprint(f.other);
    const ticket=await f.dc.assemble(f.trip,f.a.headers,"task-auth",[]);
    expect(Object.keys(ticket)).toEqual([]);
    const first=await f.dc.consume(f.trip,f.a.headers,ticket);
    expect(first.context.state_revision).toBe(0);expect(first.context.selected_object_ids).toEqual([]);expect(first.objects).toEqual([]);
    await expect(f.dc.assemble(f.other,f.a.headers,"task-auth",[])).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.consume(f.trip,f.b.headers,ticket)).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.consume(f.other,f.b.headers,ticket)).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.consume(f.trip,f.a.headers,{...ticket})).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.assemble(f.trip,new Headers({"x-user-id":f.a.user.id}),"task-auth",[])).rejects.toMatchObject({code:"PERMISSION"});
    await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[f.trip,f.a.user.id]);
    await expect(f.dc.consume(f.trip,f.a.headers,ticket)).rejects.toMatchObject({code:"PERMISSION"});
    const live=await f.dc.assemble(f.trip,f.b.headers,"task-close",[]);await f.dc.close();
    await expect(f.dc.consume(f.trip,f.b.headers,live)).rejects.toMatchObject({code:"PERMISSION"});
    expect(await fingerprint(f.trip)).toBe(before);expect(await fingerprint(f.other)).toBe(beforeOther);
  });

  it("rejects expired Session and copied credentials cannot change the original principal across concurrent requests",async()=>{
    const f=await setup(), before=await fingerprint(f.trip), shared=new Headers(f.a.headers), pendingA=f.dc.assemble(f.trip,shared,"task-a",[]);
    shared.set("cookie",f.b.headers.get("cookie")!);
    const pendingB=f.dc.assemble(f.trip,shared,"task-b",[]), [a,b]=await Promise.all([pendingA,pendingB]);
    await expect(f.dc.consume(f.trip,f.b.headers,a)).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.consume(f.trip,f.a.headers,b)).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.consume(f.trip,f.b.headers,b)).resolves.toBeTruthy();
    const otherLogin=await f.identity.auth.api.signInEmail({body:{email:f.a.email,password:f.a.password},headers:new Headers({origin:f.identity.config.origin}),asResponse:true});
    expect(otherLogin.status).toBe(200);const sameUser=new Headers({cookie:otherLogin.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ")});
    await expect(f.dc.consume(f.trip,sameUser,a)).rejects.toMatchObject({code:"PERMISSION"});
    await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[f.a.session.session.id]);
    await expect(f.dc.consume(f.trip,f.a.headers,a)).rejects.toMatchObject({code:"PERMISSION"});
    await expect(f.dc.consume(f.trip,f.b.headers,b)).resolves.toBeTruthy();
    expect(await fingerprint(f.trip)).toBe(before);
  });

  it("fails closed when another member advances revision after assembly; fresh read consumes the new state",async()=>{
    const f=await setup();
    expect(await f.trips.submit(f.trip,goal(),f.a.headers)).toMatchObject({outcome:"applied",revision:1});
    const ticket=await f.dc.assemble(f.trip,f.a.headers,"task-race",[]);
    expect(await f.trips.submit(f.trip,requestAt(2,1,`dc-activate-${crypto.randomUUID()}`),f.b.headers)).toMatchObject({outcome:"applied",revision:2});
    const afterWrite=await fingerprint(f.trip);
    await expect(f.dc.consume(f.trip,f.a.headers,ticket)).rejects.toThrow();
    const latest=await f.dc.assemble(f.trip,f.a.headers,"task-race",[]);
    const result=await f.dc.consume(f.trip,f.a.headers,latest), state=await f.trips.state(f.trip,f.a.headers);
    expect(result.context.state_revision).toBe(2);expect(result.context.selected_object_ids).toContain("goal-new");
    expect(result.context.assembled_from_versions).toContainEqual({id:"goal-new",version:2});
    expect(result.objects).toEqual([state!.objects.find(o=>o.id==="goal-new")]);
    expect(await fingerprint(f.trip)).toBe(afterWrite);
  });
  it("C12 contested facts reach DC from the same real Session/PG state and preserve all selected bodies",async()=>{
    const f=await setup(), trip=`trip-dc-c12-${crypto.randomBytes(8).toString("hex")}`, initial=structuredClone(base);
    const observed=new Date(Date.now()-60_000).toISOString(),expires=new Date(Date.now()+60_000).toISOString();
    initial.trip_id=trip;for(const o of initial.objects){o.trip_id=trip;if(o.type==="ExternalFact"){o.observed_at=observed;o.expires_at=expires;}}
    const seed=await openSyntheticStorageHarness(cfg!.runtimeUrl);resources.push(seed);await seed.seedSyntheticSnapshot(initial);
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,f.a.user.id]);
    const adopted=await f.trips.submit(trip,change(initial,[{op:"adopt_skeleton",id:"skeleton-a",acknowledge_unknowns:true,confirmation_scope:["cities","order","stays","connections"]}],`dc-adopt-${crypto.randomUUID()}`),f.a.headers);
    expect(adopted.outcome).toBe("applied");const before=(await f.trips.state(trip,f.a.headers))!;
    const opposite=ingest("dc-opposite-service");opposite.data.query_status="no_service";opposite.data.observed_at=observed;opposite.data.expires_at=expires;
    if(opposite.data.value?.kind!=="transport")throw new Error("fixture");Object.assign(opposite.data.value,{service_exists:false,departure:null,arrival:null,duration_minutes:null});
    const tool=await issueInternalCapability(f.secret,trip,{role:"tool",id:"dc-tool"});
    expect(await f.internal.submit(trip,change(before,[opposite],`dc-opposite-${crypto.randomUUID()}`),tool)).toMatchObject({outcome:"applied"});
    const actual=(await f.trips.state(trip,f.a.headers))!, afterWrite=await fingerprint(trip);
    const ticket=await f.dc.assemble(trip,f.a.headers,"task-c12",["skeleton-a"]), consumed=await f.dc.consume(trip,f.a.headers,ticket);
    expect(consumed.context.state_revision).toBe(actual.revision);expect(consumed.context.stale_fact_ids).toContain("fact-cairo-luxor");
    expect(consumed.annotations.find(a=>a.id==="fact-cairo-luxor")?.reason_codes).toContain("fact_contested");
    const decision=actual.objects.find(o=>o.type==="Decision"&&o.status==="confirmed");
    expect(decision).toMatchObject({review_state:"stale"});expect(consumed.context.active_decisions).toContain(decision!.id);
    expect(object(actual,"skeleton-a","Skeleton").assessment.status).toBe("stale");
    for(const item of consumed.objects){expect(item).toEqual(actual.objects.find(o=>o.id===item.id));expect(consumed.context.assembled_from_versions).toContainEqual({id:item.id,version:item.version});}
    expect(consumed.objects.map(o=>o.id).sort()).toEqual([...consumed.context.selected_object_ids].sort());
    await expect(f.dc.assemble(trip,f.a.headers,"task-missing",["missing-object"])).rejects.toThrow();
    expect(await fingerprint(trip)).toBe(afterWrite);
  },30000);

  it("rechecks expiration on consume even when the database revision never changes",async()=>{
    const f=await setup(), trip=`trip-dc-expire-${crypto.randomBytes(8).toString("hex")}`, initial=structuredClone(base);
    const deadline=Date.now()+8000, observed=new Date(Date.now()-60_000).toISOString(),expires=new Date(deadline).toISOString();
    initial.trip_id=trip;for(const o of initial.objects){o.trip_id=trip;if(o.type==="ExternalFact"){o.observed_at=observed;o.expires_at=expires;}}
    const seed=await openSyntheticStorageHarness(cfg!.runtimeUrl);resources.push(seed);await seed.seedSyntheticSnapshot(initial);
    await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2)',[trip,f.a.user.id]);
    const before=await fingerprint(trip), ticket=await f.dc.assemble(trip,f.a.headers,"task-expiry",["skeleton-a"]);
    const valid=await f.dc.consume(trip,f.a.headers,ticket);expect(valid.context.stale_fact_ids).not.toContain("fact-cairo-luxor");
    await new Promise(r=>setTimeout(r,Math.max(0,deadline-Date.now()+100)));
    await expect(f.dc.consume(trip,f.a.headers,ticket)).rejects.toThrow();
    const fresh=await f.dc.assemble(trip,f.a.headers,"task-expiry",["skeleton-a"]), stale=await f.dc.consume(trip,f.a.headers,fresh);
    expect(stale.context.state_revision).toBe(initial.revision);expect(stale.context.stale_fact_ids).toContain("fact-cairo-luxor");
    expect(stale.annotations.find(a=>a.id==="fact-cairo-luxor")?.reason_codes).toContain("fact_unusable");
    expect(await fingerprint(trip)).toBe(before);
  },30000);

  it.each(["revoke", "expire", "advance"] as const)("revalidates after deterministic between-checks %s through real PostgreSQL",async mode=>{
    const f=await setup();
    expect(await f.trips.submit(f.trip,goal(),f.a.headers)).toMatchObject({outcome:"applied",revision:1});
    const ticket=await f.dc.assemble(f.trip,f.a.headers,"task-delivery-race",[]);
    const baseline=await fingerprint(f.trip), original=assembly.validateContextSnapshot;
    let checks=0, afterMutation="";
    // The child receives secrets over stdin only. The test synchronously waits for a
    // real DB operation between the first and final validation; production has no hook.
    const child=`
      import fs from "node:fs";
      import crypto from "node:crypto";
      import pg from "pg";
      import {openIdentity} from "./src/server/auth/config.ts";
      import {sessionHost} from "./src/server/auth/authorization.ts";
      import {openTripCommandService} from "./src/server/trip-state/internal/persistence.ts";
      const p=JSON.parse(fs.readFileSync(0,"utf8"));
      const owner=new pg.Client({connectionString:p.migrationUrl}); await owner.connect();
      try {
        if(p.mode==="revoke") {
          const r=await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[p.trip,p.user]);
          if(r.rowCount!==1)throw Error("membership was not revoked");
        } else if(p.mode==="expire") {
          const r=await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-make_interval(secs => 1) WHERE id=$1',[p.session]);
          if(r.rowCount!==1)throw Error("session was not expired");
        } else {
          const identity=await openIdentity(p.env);let service;
          try {
            service=await openTripCommandService(p.env.DATABASE_URL,sessionHost(identity));
            const r=await service.submit(p.trip,p.command,new Headers({cookie:p.cookie}));
            if(r.outcome!=="applied"||r.revision!==2)throw Error("member did not advance revision");
          } finally {if(service)await service.close();await identity.close();}
        }
        const rows=[];
        for(const table of ["TripStateDocument","TripStateHistory","TripStateProposal","TripStateIdempotency"])
          rows.push((await owner.query('SELECT row_to_json(t)::text AS row FROM "'+table+'" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text',[p.trip])).rows);
        process.stdout.write(crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"));
      } finally {await owner.end();}
    `;
    const env={DATABASE_URL:cfg!.runtimeUrl,AUTH_DATABASE_URL:cfg!.authUrl,BETTER_AUTH_URL:f.identity.config.origin,BETTER_AUTH_SECRET:f.identity.config.secret};
    const payload={mode,migrationUrl:cfg!.migrationUrl,trip:f.trip,user:f.a.user.id,session:f.a.session.session.id,env,cookie:f.b.headers.get("cookie"),command:requestAt(2,1,`dc-between-${crypto.randomUUID()}`)};
    const spy=vi.spyOn(assembly,"validateContextSnapshot").mockImplementation((...args)=>{
      checks++;original(...args);
      if(checks===1) {
        try { afterMutation=execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",child],{input:JSON.stringify(payload),encoding:"utf8",timeout:15000,stdio:["pipe","pipe","pipe"]}).trim(); }
        catch { throw new Error("Isolated PostgreSQL mutation subprocess failed; details suppressed"); }
      }
    });
    try {
      await expect(f.dc.consume(f.trip,f.a.headers,ticket)).rejects.toMatchObject({code:mode==="advance"?"PACKET_STALE":"PERMISSION"});
      expect(checks).toBe(mode==="advance"?2:1);expect(afterMutation).toMatch(/^[a-f0-9]{64}$/);
      expect(await fingerprint(f.trip)).toBe(afterMutation);
      if(mode==="advance")expect(afterMutation).not.toBe(baseline);else expect(afterMutation).toBe(baseline);
    } finally {spy.mockRestore();}
  },30000);

});
