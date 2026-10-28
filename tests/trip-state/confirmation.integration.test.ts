import fs from "node:fs";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openTripCommandService, type CommandHost } from "../../src/server/trip-state/internal/persistence";
import type { Actor, ConfirmRequest } from "../../src/server/trip-state/commands";
import { scenario, clock, uuids, oracle, requestAt, type Audit } from "../support/command-fixtures";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("Confirmation CI requires real PostgreSQL");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { migrationUrl: string; runtimeUrl: string; runtimeRole: string } : null;
const actors: Record<string, Actor> = { user: { role: "user", id: "scenario-user" }, model: { role: "model", id: "scenario-ai" }, system: { role: "system", id: "scenario-system" }, tool: { role: "tool", id: "scenario-tool" } };
const resources: Array<{ close: () => Promise<void> }> = [];
let owner: Client, runtime: Client;
type Response = TripStateContracts["response"];
type Result = { response: Response; state_after: State; audit: Audit };

async function setup(hostClock = clock, uuid = uuids()) {
  const tripId = `trip-confirm-${crypto.randomBytes(8).toString("hex")}`;
  const credentials = Object.fromEntries(Object.keys(actors).map((role) => [role, Object.freeze({})]));
  const host: CommandHost = { clock: hostClock, uuid, authorize: (trip, credential) => {
    const role = Object.keys(credentials).find((key) => credentials[key] === credential);
    if (trip !== tripId || !role) throw new Error("Host denied trip access");
    return { tripId, actor: actors[role] };
  } };
  const open = async (overrides: Partial<CommandHost> = {}) => { const s = await openTripCommandService(config!.runtimeUrl, { ...host, ...overrides }); resources.push(s); return s; };
  const s = await open(); await s.createTrip(tripId, credentials.system);
  for (const step of scenario.steps.slice(0, 6)) expect(await s.submit(tripId, step.request, credentials[step.actor.role])).toMatchObject({ outcome: "applied" });
  const request = requestAt(6, 6, "model-choice"), before = (await s.state(tripId, credentials.user))!;
  const send = () => s.submit(tripId, request, credentials.model);
  const body = (pending: Response, overrides: Partial<ConfirmRequest> = {}): ConfirmRequest => ({ expected_revision: 6, idempotency_key: "confirm-key", proposal_digest: pending.proposal_digest!, accept: true, ...overrides });
  return { tripId, s, open, credentials, host, request, before, send, body };
}
async function counts(tripId: string) {
  return (await runtime.query('SELECT (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS requests, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals', [tripId])).rows[0];
}
async function persisted(tripId: string) {
  const tables = ["TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency"];
  const rows = [];
  for (const table of tables) rows.push((await runtime.query(`SELECT row_to_json(t) AS value FROM "${table}" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text`, [tripId])).rows);
  return rows;
}
async function child(message: object) {
  const worker = fork("tests/support/confirmation-process.mjs", [], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; worker.stderr?.on("data", (chunk) => { errors += String(chunk); });
  const exit = once(worker, "exit");
  try {
    const ready = await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]);
    expect(ready[0]).toEqual({ ready: true }); worker.send(message);
    const result = await Promise.race([once(worker, "message"), exit.then(() => { throw new Error(errors); })]);
    await exit; return result[0] as { response: Response; processId: number };
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
}

describe.skipIf(!config)("E02-04A real PostgreSQL proposal lifecycle", () => {
  beforeAll(async () => { owner = new Client({ connectionString: config!.migrationUrl }); runtime = new Client({ connectionString: config!.runtimeUrl }); await owner.connect(); await runtime.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((s) => s.close())); });
  afterAll(async () => { await owner?.end(); await runtime?.end(); });

  it.each([true, false])("matches Python for preview → pending → confirm(%s) → submit/confirm replay", async (accept) => {
    const f = await setup(), { s, tripId, credentials } = f;
    const stored = await persisted(tripId), preview = await s.preview(tripId, f.request, credentials.model);
    expect(await persisted(tripId)).toEqual(stored);
    const pending = await f.send(); expect(await s.state(tripId, credentials.user)).toEqual(f.before);
    expect(await counts(tripId)).toEqual({ history: 7, requests: 7, proposals: 1 });
    const confirm = f.body(pending, { accept }), result = await s.confirm(tripId, pending.proposal_id!, confirm, credentials.user);
    const submitReplay = await s.submit(tripId, f.request, credentials.model);
    const reopened = await f.open(), confirmReplay = await reopened.confirm(tripId, pending.proposal_id!, confirm, credentials.user);
    const operations = [...scenario.steps.slice(0, 6), { method: "preview", actor: actors.model, request: f.request }, { actor: actors.model, request: f.request },
      { method: "confirm", proposalIndex: 7, actor: actors.user, request: confirm }, { actor: actors.model, request: f.request }, { method: "confirm", proposalIndex: 7, actor: actors.user, request: confirm }];
    const python = oracle<Result[]>({ mode: "lifecycle", initial: { ...scenario.initial_state, trip_id: tripId }, operations });
    expect(preview).toEqual(python[6].response); expect(pending).toEqual(python[7].response); expect(result).toEqual(python[8].response);
    expect(submitReplay).toEqual(python[9].response); expect(confirmReplay).toEqual(python[10].response);
    expect(await s.state(tripId, credentials.user)).toEqual(python[10].state_after); expect(await s.history(tripId, credentials.user)).toEqual(python[10].audit);
    expect(await counts(tripId)).toEqual({ history: 8, requests: 8, proposals: 0 });
    if (!accept) { expect(result).toMatchObject({ outcome: "rejected", revision: 6, diff: [], errors: [] }); expect(await s.state(tripId, credentials.user)).toEqual(f.before); }
    if (process.env.E02_CONFIRMATION_EVIDENCE_PATH) fs.appendFileSync(process.env.E02_CONFIRMATION_EVIDENCE_PATH, JSON.stringify({ accept, preview, pending, confirmed: result, submit_replay: submitReplay, confirm_replay: confirmReplay, state: await s.state(tripId, credentials.user), history: await s.history(tripId, credentials.user), python_exact_match: true }) + "\n");
  });
  it("binds persisted request/Actor/diff/digest/revision/deadline; pending authority stays unchanged", async () => {
    const f = await setup(), pending = await f.send();
    const row = (await runtime.query('SELECT * FROM "TripStateProposal" WHERE "tripId"=$1', [f.tripId])).rows[0];
    expect(row.payload).toMatchObject({ request: f.request, actor: actors.model, digest: pending.proposal_digest, cache_key: [actors.model.id, "model", f.request.idempotency_key],
      details: { diff: pending.diff, effective: null, created_at: "2030-01-01T00:00:00Z", expires_at: "2030-01-01T00:05:00Z" }, expires: "2030-01-01T00:05:00Z" });
    expect(row.basisRevision).toBe("6"); expect(await f.s.state(f.tripId, f.credentials.user)).toEqual(f.before);
    expect(await f.s.submit(f.tripId, f.request, f.credentials.model)).toEqual(pending);
    expect(await counts(f.tripId)).toEqual({ history: 7, requests: 7, proposals: 1 });
  });
  it.each(["digest", "revision", "expiry", "model", "tool", "unknown-proposal"])("rejects %s without changing any table", async (kind) => {
    let now = clock(); const f = await setup(() => now), pending = await f.send(), body = f.body(pending);
    let credential = f.credentials.user, proposal = pending.proposal_id!;
    const expected: Record<string, string> = { digest: "CONFIRMATION_SCOPE", revision: "VERSION_CONFLICT", expiry: "CONFIRMATION_EXPIRED", model: "PERMISSION", tool: "PERMISSION", "unknown-proposal": "PROPOSAL_NOT_FOUND" };
    if (kind === "digest") body.proposal_digest = "different";
    if (kind === "revision") body.expected_revision = 5;
    if (kind === "expiry") now = new Date("2030-01-01T00:05:00Z");
    if (kind === "model" || kind === "tool") credential = f.credentials[kind];
    if (kind === "unknown-proposal") proposal = "proposal-missing";
    const before = await persisted(f.tripId), result = await f.s.confirm(f.tripId, proposal, body, credential);
    expect(result).toMatchObject({ outcome: kind === "revision" ? "conflict" : "rejected", diff: [], errors: [{ code: expected[kind] }] });
    expect(await persisted(f.tripId)).toEqual(before);
  });
  it("requires fresh revision after intervening user change and retains the unusable proposal", async () => {
    const f = await setup(), pending = await f.send(), change = requestAt(4, 6, "intervening-edit");
    change.commands = [{ op: "revise", object_type: "Preference", id: "pref-new", changes: { expression: "新的用户明确表达" } }];
    expect(await f.s.submit(f.tripId, change, f.credentials.user)).toMatchObject({ outcome: "applied", revision: 7 });
    const stored = await persisted(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending, { expected_revision: 7 }), f.credentials.user)).toMatchObject({ outcome: "conflict", errors: [{ code: "VERSION_CONFLICT" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("prevents cross-trip access and does not disclose or consume another trip's proposal", async () => {
    const a = await setup(), b = await setup(), pending = await a.send(), stored = await persisted(a.tripId);
    await expect(a.s.confirm(b.tripId, pending.proposal_id!, a.body(pending), a.credentials.user)).rejects.toThrow("Host denied");
    expect(await b.s.confirm(b.tripId, pending.proposal_id!, a.body(pending), b.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "PROPOSAL_NOT_FOUND" }] });
    await expect(a.s.preview(a.tripId, a.request, { role: "user", id: "forged" })).rejects.toThrow("Host denied");
    expect(await persisted(a.tripId)).toEqual(stored);
  });
  it("binds confirmation key to proposal and content; a new key cannot confirm a consumed proposal", async () => {
    const f = await setup(), pending = await f.send(), body = f.body(pending);
    const result = await f.s.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user);
    expect(result.outcome).toBe("applied"); const stored = await persisted(f.tripId);
    for (const [proposal, request] of [[pending.proposal_id!, { ...body, accept: false }], ["different-proposal", body]] as const) {
      expect(await f.s.confirm(f.tripId, proposal, request, f.credentials.user)).toMatchObject({ outcome: "conflict", errors: [{ code: "IDEMPOTENCY_CONFLICT" }] });
    }
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, { ...body, idempotency_key: "another-key" }, f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "PROPOSAL_NOT_FOUND" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("serializes competing confirmations on independent connections", async () => {
    const f = await setup(), pending = await f.send(), other = await f.open(), body = f.body(pending);
    const results = await Promise.all([f.s.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user), other.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user)]);
    expect(results[0]).toEqual(results[1]); expect(results[0].outcome).toBe("applied");
    expect(await counts(f.tripId)).toEqual({ history: 8, requests: 8, proposals: 0 });
  });
  it("permits only one winner when two different confirmation keys race", async () => {
    const f = await setup(), pending = await f.send(), other = await f.open();
    const results = await Promise.all([f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user), other.confirm(f.tripId, pending.proposal_id!, f.body(pending, { idempotency_key: "other" }), f.credentials.user)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "rejected"]); expect(results.find((r) => r.outcome === "rejected")!.errors[0].code).toBe("PROPOSAL_NOT_FOUND");
    expect(await counts(f.tripId)).toEqual({ history: 8, requests: 8, proposals: 0 });
  });
  it("races an ordinary revision write against confirmation without last-writer overwrite", async () => {
    const f = await setup(), pending = await f.send(), other = await f.open();
    const edit = requestAt(4, 6, "competing-user-edit"); edit.commands = [{ op: "revise", object_type: "Preference", id: "pref-new", changes: { expression: "竞争中的用户新表达" } }];
    const results = await Promise.all([f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user), other.submit(f.tripId, edit, f.credentials.user)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]); expect(results.find((r) => r.outcome === "conflict")!.errors[0].code).toBe("VERSION_CONFLICT");
    expect((await f.s.state(f.tripId, f.credentials.user))!.revision).toBe(7);
  });
  it("does not let preview reserve a key or bypass current revision through cached submit results", async () => {
    const f = await setup(), stored = await persisted(f.tripId);
    const preview = await f.s.preview(f.tripId, f.request, f.credentials.model);
    expect(preview.outcome).toBe("preview"); expect(await persisted(f.tripId)).toEqual(stored);
    expect(await f.s.confirm(f.tripId, preview.proposal_id!, f.body(preview), f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "PROPOSAL_NOT_FOUND" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
    const changed = { ...f.request, reason: "preview did not cache this key" };
    const pending = await f.s.submit(f.tripId, changed, f.credentials.model);
    await f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user);
    expect(await f.s.preview(f.tripId, changed, f.credentials.model)).toMatchObject({ outcome: "conflict", errors: [{ code: "VERSION_CONFLICT" }] });
    expect((await f.s.submit(f.tripId, changed, f.credentials.model)).outcome).toBe("applied");
  });
  it("grants only the bounded capability; direct cache/proposal mutation and premature finalization fail", async () => {
    const f = await setup(), pending = await f.send(), stored = await persisted(f.tripId);
    for (const sql of ['UPDATE "TripStateIdempotency" SET "response"=\'{}\'::jsonb', 'DELETE FROM "TripStateIdempotency"', 'UPDATE "TripStateProposal" SET "payload"=\'{}\'::jsonb', 'DELETE FROM "TripStateProposal"', 'TRUNCATE "TripStateProposal"']) {
      await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
    const row = (await runtime.query("SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege(current_user,p.oid,'EXECUTE') AS executable, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p WHERE p.oid='public.finalize_trip_confirmation(text,text,jsonb)'::regprocedure")).rows[0];
    expect(row).toMatchObject({ prosecdef: true, executable: true, public_execute: false, proconfig: ["search_path=pg_catalog, public"] }); expect(row.owner).not.toBe(config!.runtimeRole);
    await expect(runtime.query('SELECT public.finalize_trip_confirmation($1,$2,$3::jsonb)', [f.tripId, pending.proposal_id, JSON.stringify({ ...pending, outcome: "applied" })])).rejects.toBeTruthy();
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("recovers pending proposals after disconnect and replays final submit/confirm responses in independent OS processes", async () => {
    const f = await setup(), pending = await f.send(), body = f.body(pending);
    await f.s.close();
    const confirmed = (await child({ method: "confirm", tripId: f.tripId, proposalId: pending.proposal_id, request: body, clock: clock().toISOString() })).response;
    expect(confirmed.outcome).toBe("applied");
    const submit = await child({ method: "submit", tripId: f.tripId, request: f.request });
    const confirm = await child({ method: "confirm", tripId: f.tripId, proposalId: pending.proposal_id, request: body });
    expect(submit.processId).not.toBe(process.pid); expect(confirm.processId).not.toBe(submit.processId);
    expect(submit.response).toEqual(confirmed); expect(confirm.response).toEqual(confirmed);
    expect(await counts(f.tripId)).toEqual({ history: 8, requests: 8, proposals: 0 });
  }, 15000);
  it("leaves an actually expired persisted proposal, authority, history and both cache namespaces unchanged", async () => {
    const f = await setup(() => new Date()), pending = await f.send();
    // Owner-only fixture shortens the persisted deadline so this tests real elapsed time without waiting five minutes.
    await owner.query(`WITH expiry AS (SELECT clock_timestamp()+interval '150 milliseconds' AS at)
      UPDATE "TripStateProposal" SET "expiresAt"=expiry.at,
      "payload"=jsonb_set(jsonb_set("payload",'{expires}',to_jsonb(to_char(expiry.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
        '{details,expires_at}',to_jsonb(to_char(expiry.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
      FROM expiry WHERE "tripId"=$1`, [f.tripId]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stored = await persisted(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "CONFIRMATION_EXPIRED" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
    expect(await f.s.submit(f.tripId, f.request, f.credentials.model)).toEqual(pending); // Original Python replays the original key before version/expiry checks.
  });
  it("uses the original Store's captured confirmation time when actual SQL work finishes after expiry", async () => {
    const proposalTime = new Date(Date.now() - 300000 + 2500); let captured = proposalTime;
    const f = await setup(() => captured), pending = await f.send(), body = f.body(pending);
    const deadline = new Date(proposalTime.getTime() + 300000).toISOString(); captured = new Date();
    expect(captured.getTime()).toBeLessThan(Date.parse(deadline));
    const name = `delay_${crypto.randomBytes(8).toString("hex")}`;
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tripId"='${f.tripId}' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "TripStateHistory" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    let result: Response;
    try { result = await f.s.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user); }
    finally { await owner.query(`DROP TRIGGER ${name} ON "TripStateHistory"`); await owner.query(`DROP FUNCTION public.${name}()`); }
    expect((await owner.query('SELECT clock_timestamp()>$1::timestamptz AS expired', [deadline])).rows[0].expired).toBe(true);
    const python = oracle<Result[]>({ mode: "lifecycle", initial: f.before, uuidStart: 1018, clock: proposalTime.toISOString(), operations: [
      { request: f.request, actor: actors.model }, { method: "confirm", proposalIndex: 0, request: body, actor: actors.user, clock: captured.toISOString() },
    ] });
    expect(result!).toEqual(python[1].response); expect(result!.outcome).toBe("applied");
    expect(await f.s.state(f.tripId, f.credentials.user)).toEqual(python[1].state_after);
  }, 15000);
  it("rolls back proposal consumption and original-cache finalization if the confirming OS process dies before COMMIT", async () => {
    const f = await setup(), pending = await f.send(), body = f.body(pending), stored = await persisted(f.tripId);
    const name = `crash_${crypto.randomBytes(8).toString("hex")}`, lock = crypto.randomInt(1, 2000000000);
    await owner.query('SELECT pg_advisory_lock($1)', [lock]);
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."tripId"='${f.tripId}' THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN OLD; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE DELETE ON "TripStateProposal" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    const worker = fork("tests/support/confirmation-process.mjs", [], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exit = once(worker, "exit");
    try {
      expect((await once(worker, "message"))[0]).toEqual({ ready: true });
      worker.send({ method: "confirm", tripId: f.tripId, proposalId: pending.proposal_id, request: body, clock: clock().toISOString(), applicationName: name });
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        blocked = (await owner.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory') AS blocked", [name])).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true); worker.kill("SIGKILL"); await exit;
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      await owner.query('SELECT pg_advisory_unlock($1)', [lock]);
      await owner.query(`DROP TRIGGER ${name} ON "TripStateProposal"`); await owner.query(`DROP FUNCTION public.${name}()`);
    }
    expect(await persisted(f.tripId)).toEqual(stored);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user)).toMatchObject({ outcome: "applied", revision: 7 });
    expect(await counts(f.tripId)).toEqual({ history: 8, requests: 8, proposals: 0 });
  }, 15000);
  it.each(["history", "confirmation-cache", "original-cache", "proposal-delete"])("rolls back a real SQL fault at %s, retains pending, then succeeds on retry", async (point) => {
    const f = await setup(), pending = await f.send(), body = f.body(pending), stored = await persisted(f.tripId);
    const name = `fail_${crypto.randomBytes(8).toString("hex")}`;
    const table = point === "history" ? "TripStateHistory" : point === "proposal-delete" ? "TripStateProposal" : "TripStateIdempotency";
    const event = point === "original-cache" ? "UPDATE" : point === "proposal-delete" ? "DELETE" : "INSERT";
    const condition = event === "DELETE" ? `OLD."tripId"='${f.tripId}'` : `NEW."tripId"='${f.tripId}'`;
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN ${event === "DELETE" ? "OLD" : "NEW"}; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try {
      expect(await f.s.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "INTERNAL_FAILURE" }] });
      expect(await persisted(f.tripId)).toEqual(stored);
    } finally { await owner.query(`DROP TRIGGER ${name} ON "${table}"`); await owner.query(`DROP FUNCTION public.${name}()`); }
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, body, f.credentials.user)).toMatchObject({ outcome: "applied", revision: 7 });
    expect(await counts(f.tripId)).toEqual({ history: 8, requests: 8, proposals: 0 });
  });
  it.each(["request", "diff", "actor", "effective", "deadline"])("detects persisted %s tampering before consumption", async (kind) => {
    const f = await setup(), pending = await f.send();
    const paths = { request: ["request", "reason"], diff: ["details", "diff"], actor: ["actor", "id"], effective: ["details", "effective"], deadline: ["details", "expires_at"] };
    const replacement = kind === "diff" ? [] : "tampered";
    await owner.query('UPDATE "TripStateProposal" SET "payload"=jsonb_set("payload",$1::text[],$2::jsonb) WHERE "tripId"=$3', [paths[kind as keyof typeof paths], JSON.stringify(replacement), f.tripId]);
    const stored = await persisted(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "STORAGE_INTEGRITY" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("detects a changed stored digest even when the proposal's column and payload agree", async () => {
    const f = await setup(), pending = await f.send();
    await owner.query('UPDATE "TripStateProposal" SET "digest"=\'tampered\', "payload"=jsonb_set("payload",\'{digest}\',\'"tampered"\'::jsonb) WHERE "tripId"=$1', [f.tripId]);
    const stored = await persisted(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "STORAGE_INTEGRITY" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("revalidates business conditions instead of relying on only a matching revision and digest", async () => {
    const f = await setup(), pending = await f.send();
    const state = structuredClone(f.before), candidate = state.objects.find((o) => o.type === "Candidate")!;
    if (candidate.type === "Candidate") { candidate.status = "excluded"; candidate.exclusion_reason = "合成损坏注入：原业务前提不再成立"; }
    await owner.query('UPDATE "TripStateDocument" SET "snapshot"=$1::jsonb WHERE "tripId"=$2', [JSON.stringify(state), f.tripId]);
    const stored = await persisted(f.tripId);
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, f.body(pending), f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "CANDIDATE_EXCLUDED" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("rejects request-supplied Actor data in preview and confirmation", async () => {
    const f = await setup(), pending = await f.send(), stored = await persisted(f.tripId);
    expect(await f.s.preview(f.tripId, { ...f.request, actor: actors.user }, f.credentials.model)).toMatchObject({ outcome: "rejected", errors: [{ code: "SCHEMA" }] });
    expect(await f.s.confirm(f.tripId, pending.proposal_id!, { ...f.body(pending), actor: actors.user }, f.credentials.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "SCHEMA" }] });
    expect(await persisted(f.tripId)).toEqual(stored);
  });
  it("records the actual distinct host-authorized User, without substituting pending-user", async () => {
    const f = await setup(), pending = await f.send(), body = f.body(pending), actor: Actor = { role: "user", id: "another-authorized-user" };
    const service = await f.open({ authorize: (trip, token) => { if (trip !== f.tripId || token !== "synthetic-authorized-session") throw new Error("Denied"); return { tripId: trip, actor }; } });
    const response = await service.confirm(f.tripId, pending.proposal_id!, body, "synthetic-authorized-session");
    const python = oracle<Result[]>({ mode: "lifecycle", initial: f.before, uuidStart: 1018, operations: [{ request: f.request, actor: actors.model }, { method: "confirm", proposalIndex: 0, request: body, actor }] });
    expect(response).toEqual(python[1].response); expect(await f.s.state(f.tripId, f.credentials.user)).toEqual(python[1].state_after);
    const audit = await f.s.history(f.tripId, f.credentials.user);
    expect({ intents: audit.intents.slice(-2), changes: audit.changes.slice(-2) }).toEqual(python[1].audit);
  });
});
