import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIdentity } from "../../../src/server/auth/config";
import { userActorId } from "../../../src/server/auth/authorization";
import { issueInternalCapability, openInternalTripService } from "../../../src/server/auth/internal-service";
import { PgCheckpointRepository } from "../../../src/server/decision-context/checkpoint-store/repository";
import type { CheckpointPayload } from "../../../src/server/decision-context/contracts.generated";

const file = process.env.E02_STORAGE_ENV_FILE;
const cfg = file ? JSON.parse(readFileSync(file, "utf8")) as { migrationUrl:string; runtimeUrl:string; authUrl:string } : null;
if (process.env.CI && !cfg) throw new Error("CI requires a disposable E02 database for real Session checkpoint tests");
const role = `e03_session_${randomUUID().replaceAll("-", "")}`, password = randomUUID();
let owner: Client, pool: Pool, roleCreated = false;

describe.skipIf(!cfg)("checkpoint Session wrapper in real PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(cfg!.migrationUrl), db = url.pathname.slice(1);
    if (!["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !db.startsWith("antu_e02_test_"))
      throw new Error("Only a provisioned local E02 disposable test database is allowed");
    owner = new Client({ connectionString:cfg!.migrationUrl }); await owner.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT pg_advisory_xact_lock(hashtext('e03_checkpoint_test_migration'))");
      await owner.query(readFileSync("src/server/decision-context/checkpoint-store/migration.sql", "utf8"));
      await owner.query("COMMIT");
    } catch (error) { await owner.query("ROLLBACK"); throw error; }
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    roleCreated = true;
    await owner.query(`GRANT CONNECT ON DATABASE "${db.replaceAll('"','""')}" TO "${role}"`);
    await owner.query(`GRANT USAGE ON SCHEMA e03_checkpoint TO "${role}"`);
    await owner.query(`GRANT EXECUTE ON FUNCTION e03_checkpoint.session_write_scene(text,text,text,text,bigint,text,text,jsonb,text,text,text,boolean), e03_checkpoint.session_read_scene(text,text,text,text,text), e03_checkpoint.session_list_scenes(text,text,text,text) TO "${role}"`);
    url.username = role; url.password = password; pool = new Pool({ connectionString:url.toString() });
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { if (roleCreated) { await owner.query(`DROP OWNED BY "${role}"`); await owner.query(`DROP ROLE "${role}"`); } await owner.end(); }
  });
  it("revalidates real Session/membership and isolates another user and workspace", async () => {
    const env = { ...process.env, DATABASE_URL:cfg!.runtimeUrl, AUTH_DATABASE_URL:cfg!.authUrl,
      BETTER_AUTH_URL:"http://127.0.0.1:3117", BETTER_AUTH_SECRET:randomBytes(32).toString("hex") };
    const identity = await openIdentity(env), secret = randomBytes(32).toString("hex");
    const trips = await openInternalTripService(cfg!.runtimeUrl,secret);
    try {
      async function account() {
        const email = `${randomUUID()}@example.invalid`, pw = randomBytes(24).toString("base64url");
        const user = (await identity.auth.api.signUpEmail({ body:{name:"Checkpoint test",email,password:pw} })).user;
        const login = await identity.auth.api.signInEmail({ body:{email,password:pw}, headers:new Headers({origin:identity.config.origin}), asResponse:true });
        expect(login.status).toBe(200);
        const headers = new Headers({cookie:login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")});
        const session = await identity.auth.api.getSession({headers});
        if (!session) throw new Error("Synthetic account must have a real Session");
        return {user,session};
      }
      const a = await account(), b = await account(), trip = `trip-cp-${randomBytes(8).toString("hex")}`;
      await trips.createTrip(trip,await issueInternalCapability(secret,trip,{role:"system",id:"cp-test"}));
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3)',[trip,a.user.id,b.user.id]);
      const payload = structuredClone((JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:CheckpointPayload}[]).find((r) => r.schema === "checkpoint-payload")!.value);
      payload.trip_id = trip;
      const aRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:a.session.session.id,userId:a.user.id});
      const bRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:b.session.session.id,userId:b.user.id});
      const aScope = {owner:userActorId(a.user.id),trip,workspace:"host-workspace"}, now = new Date();
      expect((await aRepo.save(aScope,0,"save",payload,now)).checkpoint_revision).toBe(1);
      await expect(bRepo.load({...aScope,owner:userActorId(b.user.id)},now)).rejects.toMatchObject({code:"CHECKPOINT_NOT_FOUND"});
      await expect(aRepo.load({...aScope,workspace:"other-workspace"},now)).rejects.toMatchObject({code:"CHECKPOINT_NOT_FOUND"});
      await expect(pool.query("SELECT * FROM e03_checkpoint.heads")).rejects.toThrow();
      await expect(pool.query("SELECT e03_checkpoint.read_scene($1,$2,$3,$4)",[aScope.owner,trip,aScope.workspace,now.toISOString()])).rejects.toThrow();
      const forged = new PgCheckpointRepository(pool,null,undefined,{sessionId:a.session.session.id,userId:b.user.id});
      await expect(forged.load({...aScope,owner:userActorId(b.user.id)},now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      let enter!: () => void, release!: () => void, revoked = false;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const racing = new PgCheckpointRepository(pool,null,async (point) => { if (point === "before_commit") { enter(); await gate; } },
        {sessionId:a.session.session.id,userId:a.user.id});
      const write = racing.save(aScope,1,"authorized-before-revocation",payload,now);
      await Promise.race([entered,write.then(() => { throw new Error("write completed before test gate"); })]);
      const pid = (await owner.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const revoke = owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,a.user.id]).then(() => { revoked = true; });
      const observer = new Client({connectionString:cfg!.migrationUrl});
      try {
        await observer.connect();
        const deadline = Date.now()+3000; let lockObserved = false;
        while (Date.now() < deadline && !lockObserved) {
          const row = (await observer.query<{wait_event_type:string|null}>("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
          lockObserved = row?.wait_event_type === "Lock";
          if (!lockObserved) await new Promise((resolve) => setTimeout(resolve,20));
        }
        expect(lockObserved).toBe(true); expect(revoked).toBe(false);
      } finally { release(); await observer.end(); }
      expect((await write).checkpoint_revision).toBe(2);
      await revoke;
      await expect(aRepo.load(aScope,now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(aRepo.save(aScope,2,"next",payload,now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    } finally { await Promise.all([identity.close(),trips.close()]); }
  }, 30000);
});
