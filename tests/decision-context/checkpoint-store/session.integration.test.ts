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
    await owner.query(`GRANT EXECUTE ON FUNCTION e03_checkpoint.session_write_scene(text,text,text,text,bigint,text,text,jsonb,text,text,text,boolean), e03_checkpoint.session_read_scene(text,text,text,text,text), e03_checkpoint.session_list_scenes(text,text,text,text,text) TO "${role}"`);
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
      const a = await account(), b = await account(), c = await account(), d = await account(), e = await account(), f = await account(), g = await account(), trip = `trip-cp-${randomBytes(8).toString("hex")}`;
      await trips.createTrip(trip,await issueInternalCapability(secret,trip,{role:"system",id:"cp-test"}));
      await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2),($1,$3),($1,$4),($1,$5),($1,$6),($1,$7),($1,$8)',[trip,a.user.id,b.user.id,c.user.id,d.user.id,e.user.id,f.user.id,g.user.id]);
      const payload = structuredClone((JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:CheckpointPayload}[]).find((r) => r.schema === "checkpoint-payload")!.value);
      payload.trip_id = trip;
      const aRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:a.session.session.id,userId:a.user.id,trip,workspace:"host-workspace"});
      const bRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:b.session.session.id,userId:b.user.id,trip,workspace:"host-workspace"});
      const aScope = {owner:userActorId(a.user.id),trip,workspace:"host-workspace"}, now = new Date();
      expect((await aRepo.save(aScope,0,"save",payload,now)).checkpoint_revision).toBe(1);
      const otherRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:a.session.session.id,userId:a.user.id,trip,workspace:"other-workspace"});
      expect((await otherRepo.save({...aScope,workspace:"other-workspace"},0,"save-other",payload,now)).checkpoint_revision).toBe(1);
      await expect(bRepo.load({...aScope,owner:userActorId(b.user.id)},now)).rejects.toMatchObject({code:"CHECKPOINT_NOT_FOUND"});
      await expect(aRepo.load({...aScope,workspace:"other-workspace"},now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      expect((await aRepo.list(aScope.owner,trip,now)).map((row) => row.workspace_key)).toEqual(["host-workspace"]);
      expect((await otherRepo.list(aScope.owner,trip,now)).map((row) => row.workspace_key)).toEqual(["other-workspace"]);
      await expect(pool.query("SELECT * FROM e03_checkpoint.heads")).rejects.toThrow();
      await expect(pool.query("SELECT e03_checkpoint.read_scene($1,$2,$3,$4)",[aScope.owner,trip,aScope.workspace,now.toISOString()])).rejects.toThrow();
      await expect(pool.query("SELECT e03_checkpoint.list_scenes($1,$2,$3)",[aScope.owner,trip,now.toISOString()])).rejects.toThrow();
      await expect(pool.query("SELECT e03_checkpoint.write_scene($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)",
        [aScope.owner,trip,aScope.workspace,1,"forged","digest",JSON.stringify(payload),"digest",now.toISOString(),null,false])).rejects.toThrow();
      const rights = (await pool.query<{direct:boolean;create_schema:boolean;raw_execute:boolean;owner:boolean}>(`SELECT
        has_table_privilege(current_user,'e03_checkpoint.heads','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        has_table_privilege(current_user,'e03_checkpoint.receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS direct,
        has_schema_privilege(current_user,'e03_checkpoint','CREATE') AS create_schema,
        has_function_privilege(current_user,'e03_checkpoint.write_scene(text,text,text,bigint,text,text,jsonb,text,text,text,boolean)','EXECUTE') OR
        has_function_privilege(current_user,'e03_checkpoint.read_scene(text,text,text,text)','EXECUTE') OR
        has_function_privilege(current_user,'e03_checkpoint.list_scenes(text,text,text)','EXECUTE') AS raw_execute,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='e03_checkpoint' AND c.relname IN ('heads','receipts') AND pg_has_role(current_user,c.relowner,'USAGE')) AS owner`)).rows[0];
      expect(rights).toEqual({direct:false,create_schema:false,raw_execute:false,owner:false});
      // The SQL wrapper still accepts a server-supplied workspace string. This
      // deliberate counterexample is why a real host ownership proof remains required.
      const rawOther = await pool.query<{value:{payload?:unknown}}>("SELECT e03_checkpoint.session_read_scene($1,$2,$3,$4,$5) AS value",
        [a.session.session.id,a.user.id,trip,"other-workspace",now.toISOString()]);
      expect(rawOther.rows[0].value.payload).toBeTruthy();
      const forged = new PgCheckpointRepository(pool,null,undefined,{sessionId:a.session.session.id,userId:b.user.id,trip,workspace:"host-workspace"});
      await expect(forged.load({...aScope,owner:userActorId(b.user.id)},now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      for (const [who,operation] of [[b,"read"],[c,"write"]] as const) {
        const scoped = {...aScope,owner:userActorId(who.user.id)};
        const repo = new PgCheckpointRepository(pool,null,undefined,{sessionId:who.session.session.id,userId:who.user.id,trip,workspace:"host-workspace"});
        await repo.save(scoped,0,`${operation}-initial`,payload,now);
        const locker = new Client({connectionString:cfg!.migrationUrl}); await locker.connect();
        try {
          await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[who.session.session.id]);
          await locker.query("BEGIN");
          await locker.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))",[scoped.owner,trip,scoped.workspace]);
          const operationPromise = operation === "read" ? repo.load(scoped,now) : repo.save(scoped,1,"after-expiry",payload,now);
          const pending = operationPromise.then((value) => ({value}), (error) => ({error}));
          const deadline = Date.now()+7000; let observedLock = false, expired = false;
          while (Date.now()<deadline && !(observedLock && expired)) {
            const observed = await owner.query<{waiting:boolean;expired:boolean}>(
              'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type=\'Lock\' AND query LIKE $3) AS waiting, (SELECT "expiresAt" <= clock_timestamp() FROM "AuthSession" WHERE id=$2) AS expired',
              [role,who.session.session.id,`%session_${operation}_scene%`]);
            observedLock ||= observed.rows[0].waiting; expired ||= observed.rows[0].expired;
            if (!(observedLock && expired)) await new Promise((resolve) => setTimeout(resolve,20));
          }
          expect(observedLock).toBe(true); expect(expired).toBe(true);
          await locker.query("COMMIT");
          expect(await pending).toMatchObject({error:{code:"ACCESS_DENIED"}});
        } finally { await locker.query("ROLLBACK").catch(() => undefined); await locker.end(); }
      }
      // A membership revocation that has the row lock first must win over a
      // later read which is waiting to acquire the shared authorization lock.
      const dScope = {...aScope,owner:userActorId(d.user.id)};
      const dRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:d.session.session.id,userId:d.user.id,trip,workspace:"host-workspace"});
      await dRepo.save(dScope,0,"before-revoke",payload,now);
      const revoker = new Client({connectionString:cfg!.migrationUrl}); await revoker.connect();
      try {
        await revoker.query("BEGIN");
        await revoker.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,d.user.id]);
        const pending = dRepo.load(dScope,now).then((value) => ({value}), (error) => ({error}));
        const deadline = Date.now()+5000; let observedLock = false;
        while (Date.now()<deadline && !observedLock) {
          observedLock = (await owner.query<{waiting:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE '%session_read_scene%') AS waiting",[role])).rows[0].waiting;
          if (!observedLock) await new Promise((resolve) => setTimeout(resolve,20));
        }
        expect(observedLock).toBe(true);
        await revoker.query("COMMIT");
        expect(await pending).toMatchObject({error:{code:"ACCESS_DENIED"}});
      } finally { await revoker.query("ROLLBACK").catch(() => undefined); await revoker.end(); }
      // Opposite order: authorization owns the membership lock before an
      // unrelated checkpoint lock clears; revocation must wait for the write.
      const eScope = {...aScope,owner:userActorId(e.user.id)};
      const eRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:e.session.session.id,userId:e.user.id,trip,workspace:"host-workspace"});
      await eRepo.save(eScope,0,"e-initial",payload,now);
      const checkpointLock = new Client({connectionString:cfg!.migrationUrl}), laterRevoker = new Client({connectionString:cfg!.migrationUrl});
      await checkpointLock.connect(); await laterRevoker.connect();
      try {
        await checkpointLock.query("BEGIN");
        await checkpointLock.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))",[eScope.owner,trip,eScope.workspace]);
        const pending = eRepo.save(eScope,1,"e-before-revoke",payload,now);
        let waiting = false, deadline = Date.now()+5000;
        while (Date.now()<deadline && !waiting) {
          waiting = (await owner.query<{waiting:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE '%session_write_scene%') AS waiting",[role])).rows[0].waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve,20));
        }
        expect(waiting).toBe(true);
        const pid = (await laterRevoker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const revokeAfter = laterRevoker.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2',[trip,e.user.id]);
        waiting = false; deadline = Date.now()+5000;
        while (Date.now()<deadline && !waiting) {
          waiting = (await owner.query<{waiting:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS waiting",[pid])).rows[0].waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve,20));
        }
        expect(waiting).toBe(true);
        await checkpointLock.query("COMMIT");
        expect((await pending).checkpoint_revision).toBe(2);
        await revokeAfter;
        await expect(eRepo.load(eScope,now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      } finally { await checkpointLock.query("ROLLBACK").catch(() => undefined); await checkpointLock.end(); await laterRevoker.end(); }
      // Once post-lock authorization has succeeded, it is the linearization
      // point. A later natural expiry does not retroactively cancel that write;
      // the next operation must reauthorize and fail.
      const fScope = {...aScope,owner:userActorId(f.user.id)};
      let fEntered!: () => void, fRelease!: () => void;
      const fAtCommit = new Promise<void>((resolve) => { fEntered = resolve; });
      const fGate = new Promise<void>((resolve) => { fRelease = resolve; });
      await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[f.session.session.id]);
      const fRepo = new PgCheckpointRepository(pool,null,async (point) => { if (point === "before_commit") { fEntered(); await fGate; } },
        {sessionId:f.session.session.id,userId:f.user.id,trip,workspace:"host-workspace"});
      const fWrite = fRepo.save(fScope,0,"linearized-before-expiry",payload,now);
      await Promise.race([fAtCommit,fWrite.then(() => { throw new Error("write completed before test gate"); })]);
      try {
        const deadline = Date.now()+7000; let expired = false;
        while (Date.now()<deadline && !expired) {
          expired = (await owner.query<{expired:boolean}>('SELECT "expiresAt" <= clock_timestamp() AS expired FROM "AuthSession" WHERE id=$1',[f.session.session.id])).rows[0].expired;
          if (!expired) await new Promise((resolve) => setTimeout(resolve,20));
        }
        expect(expired).toBe(true);
      } finally { fRelease(); }
      expect((await fWrite).checkpoint_revision).toBe(1);
      await expect(fRepo.load(fScope,now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      // A privileged maintenance session deliberately violates the advisory-lock
      // discipline and holds only the row lock. The final authorization already
      // passed, so expiry while waiting for the row does not revoke this write.
      const gScope = {...aScope,owner:userActorId(g.user.id)};
      const gRepo = new PgCheckpointRepository(pool,null,undefined,{sessionId:g.session.session.id,userId:g.user.id,trip,workspace:"host-workspace"});
      await gRepo.save(gScope,0,"g-initial",payload,now);
      const rowLocker = new Client({connectionString:cfg!.migrationUrl}); await rowLocker.connect();
      try {
        await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()+interval \'3 seconds\' WHERE id=$1',[g.session.session.id]);
        await rowLocker.query("BEGIN");
        const blockerPid = (await rowLocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await rowLocker.query("SELECT revision FROM e03_checkpoint.heads WHERE owner_id=$1 AND trip_id=$2 AND workspace=$3 FOR UPDATE",[gScope.owner,trip,gScope.workspace]);
        const pending = gRepo.save(gScope,1,"after-final-auth-row-wait",payload,now).then((value) => ({value}), (error) => ({error}));
        const deadline = Date.now()+7000; let blocked = false, expired = false;
        while (Date.now()<deadline && !(blocked && expired)) {
          const row = (await owner.query<{waiting:boolean;expired:boolean}>(`SELECT
            EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'
              AND $3=ANY(pg_blocking_pids(pid)) AND query LIKE '%session_write_scene%') AS waiting,
            (SELECT "expiresAt" <= clock_timestamp() FROM "AuthSession" WHERE id=$2) AS expired`,
            [role,g.session.session.id,blockerPid])).rows[0];
          blocked ||= row.waiting; expired ||= row.expired;
          if (!(blocked && expired)) await new Promise((resolve) => setTimeout(resolve,20));
        }
        expect(blocked).toBe(true); expect(expired).toBe(true);
        await rowLocker.query("COMMIT");
        expect(await pending).toMatchObject({value:{checkpoint_revision:2}});
        await expect(gRepo.load(gScope,now)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      } finally { await rowLocker.query("ROLLBACK").catch(() => undefined); await rowLocker.end(); }
      let enter!: () => void, release!: () => void, revoked = false;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const racing = new PgCheckpointRepository(pool,null,async (point) => { if (point === "before_commit") { enter(); await gate; } },
        {sessionId:a.session.session.id,userId:a.user.id,trip,workspace:"host-workspace"});
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
