import { request as nodeHttpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { SignJWT } from "jose";
import { issueInternalCapability, openInternalTripService } from "../../src/server/auth/internal-service";
import { parseContract } from "../../src/server/trip-state/contracts";
import { requestAt, scenario } from "../support/command-fixtures";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";

type Body = TripStateContracts["response"];
type User = { id: string; email: string; password: string; cookie: string };
const pause = (n: number) => new Promise((r) => setTimeout(r, n));
const file = process.env.E02_STORAGE_ENV_FILE;
if (!file) throw new Error("HTTP acceptance requires a real provisioned PostgreSQL test database");
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
if (!/^antu_e02_test_[a-z0-9_]+$/.test(cfg.database) || !cfg.authUrl) throw new Error("Isolated identity and PostgreSQL infrastructure required");

test("E02-05C actual production Next.js, real HTTP credentials and PostgreSQL", { timeout: 240000 }, async (t) => {
  const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Port allocation failed");
  const port = address.port; await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, secret = crypto.randomBytes(32).toString("hex"), authSecret = crypto.randomBytes(32).toString("hex");
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "antu-http-")); fs.chmodSync(privateDir, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: cfg.runtimeUrl, AUTH_DATABASE_URL: cfg.authUrl, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret,
    INTERNAL_SERVICE_SECRET: secret, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" };
  const webEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: cfg.runtimeUrl, AUTH_DATABASE_URL: cfg.authUrl, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret,
    INTERNAL_SERVICE_SECRET: secret, NEXT_TELEMETRY_DISABLED: "1" }; // Never pass migration credentials, admin flags or test-config paths to Next.
  const owner = new Client({ connectionString: cfg.migrationUrl }); await owner.connect();
  const internal = await openInternalTripService(cfg.runtimeUrl, secret), evidence: unknown[] = [];
  let server: ChildProcess | undefined, generation = 0;
  async function stop() { if (server && server.exitCode === null && server.signalCode === null) { const ended = once(server, "exit"); server.kill("SIGTERM"); await ended; } }
  async function start() {
    const log = fs.openSync(path.join(privateDir, `next-${generation++}.log`), "a", 0o600);
    const current = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env: webEnv, stdio: ["ignore", log, log] }); server = current; fs.closeSync(log);
    for (let i = 0; i < 150; i++) {
      if (current.exitCode !== null) throw new Error("Actual Next server exited; private log retained");
      try { const r = await fetch(origin + "/api/health"); if (r.ok) return; } catch { /* Server may not be listening yet. */ }
      await pause(100);
    }
    throw new Error("Actual Next readiness timeout");
  }
  function admin(operation: string, input: object) {
    try { return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/auth-admin.ts", operation], {
      input: JSON.stringify(input), env: { ...env, MIGRATION_DATABASE_URL: cfg.migrationUrl, ANTU_AUTH_ADMIN: "1" }, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    })); } catch { throw new Error("Operator bootstrap failed (credentials not logged)"); }
  }
  function createUser(): User {
    const email = `${crypto.randomUUID()}@example.invalid`, password = crypto.randomBytes(24).toString("base64url");
    return { id: admin("create-user", { name: "HTTP credential acceptance", email, password }).userId, email, password, cookie: "" };
  }
  async function http(method: string, route: string, body?: object | string, user?: User, headers: Record<string, string | undefined> = {}) {
    const h = new Headers(method === "POST" ? { "content-type": "application/json", origin } : {}); for (const [key, value] of Object.entries(headers)) if (value !== undefined) h.set(key, value); if (user?.cookie) h.set("cookie", user.cookie);
    const response = await fetch(origin + route, { method, headers: h, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), redirect: "manual" });
    const text = await response.text(), value = text ? JSON.parse(text) : null;
    if (route.startsWith("/trips/") && method !== "HEAD") parseContract(response.status === 200 && method === "GET" ? route.endsWith("/state") ? "state" : "history" : "response", value);
    evidence.push({ method, route, status: response.status, body: value }); // Deliberately excludes credentials, cookies and request passwords.
    return { status: response.status, body: value, headers: response.headers };
  }
  async function login(user: User) {
    const r = await http("POST", "/api/auth/sign-in/email", { email: user.email, password: user.password }); assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
    const cookies = r.headers.getSetCookie(); assert(cookies.some((s) => /httponly/i.test(s) && /samesite=lax/i.test(s)));
    user.cookie = cookies.map((c) => c.split(";")[0]).join("; "); assert(user.cookie);
  }
  const trip = `trip-http-${crypto.randomBytes(8).toString("hex")}`, otherTrip = `trip-http-${crypto.randomBytes(8).toString("hex")}`;
  const statePath = `/trips/${trip}/state`, changes = `/trips/${trip}/changes`;
  const state = async () => (await http("GET", statePath, undefined, a)).body as State;
  async function fingerprint(includeAuth = false) {
    const tables = ["TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency", ...(includeAuth ? ["AuthUser", "AuthSession", "AuthAccount", "AuthRateLimit", "AuthVerification", "TripMembership"] : [])];
    const all = [];
    for (const table of tables) all.push((await owner.query(`SELECT row_to_json(t) AS row FROM "${table}" t ${table.startsWith("TripState") ? 'WHERE "tripId"=$1' : ""} ORDER BY row_to_json(t)::text`, table.startsWith("TripState") ? [trip] : [])).rows);
    return crypto.createHash("sha256").update(JSON.stringify(all)).digest("hex");
  }
  async function bearer(role: "model" | "system" | "tool" = "model", bound = trip) { return { authorization: "Bearer " + await issueInternalCapability(secret, bound, { role, id: `${role}-http-acceptance` }) }; }
  function edit(revision: number, label: string) {
    const r = requestAt(4, revision, `http-${label}-${crypto.randomBytes(4).toString("hex")}`); const c = r.commands[0];
    if (c.op !== "revise" || c.object_type !== "Preference") throw new Error("Source command fixture"); c.changes.expression = label; return r;
  }
  async function pending(label: string) { const s = await state(), request = edit(s.revision, label), r = await http("POST", changes, request, undefined, await bearer()); assert.equal(r.status, 202); assert.equal(r.body.outcome, "pending_confirmation"); return { request, response: r.body as Body, revision: s.revision }; }
  function confirmation(p: Awaited<ReturnType<typeof pending>>, accept = true, key = crypto.randomUUID()) { return { expected_revision: p.revision, idempotency_key: key, proposal_digest: p.response.proposal_digest!, accept }; }
  let a: User, b: User, durableRequest: TripStateContracts["change-request"], durableResponse: Body;
  try {
    a = createUser(); b = createUser(); admin("create-trip", { tripId: trip, userId: a.id }); admin("create-trip", { tripId: otherTrip, userId: b.id }); await start();
    await t.test("real password login, HttpOnly cookie, wrong credentials, anonymous and invalid sessions", async () => {
      await login(a); await login(b);
      assert.equal((await http("POST", "/api/auth/sign-in/email", { email: a.email, password: crypto.randomBytes(24).toString("hex") })).status, 401);
      for (const headers of [{}, { cookie: "better-auth.session_token=invalid" }, { "x-user-id": a.id, "x-actor-role": "user" }]) assert.equal((await http("GET", statePath, undefined, undefined, headers)).status, 403);
    });
    await t.test("own state/history and cross-user/cross-trip denial, without account or revision leakage", async () => {
      const r = await http("GET", statePath, undefined, a); assert.equal(r.status, 200); assert.equal(r.body.revision, 0); assert.equal(r.body.trip_id, trip);
      assert.deepEqual((await http("GET", changes, undefined, a)).body, { intents: [], changes: [] });
      for (const route of [statePath, changes]) { const denied = await http("GET", route, undefined, b); assert.equal(denied.status, 403); assert.equal(denied.body.revision, 0); }
      assert.equal((await http("GET", `/trips/${otherTrip}/state`, undefined, a)).status, 403);
      assert.equal((await http("GET", "/trips/trip-unknown/state", undefined, a)).status, 403);
    });
    await t.test("registration, anonymous creation/import, raw Actor headers and System/Tool network credentials cannot grant authority", async () => {
      assert.equal((await http("POST", "/api/auth/sign-up/email", { name: "forged", email: "forged@example.invalid", password: crypto.randomBytes(20).toString("hex") })).status, 404);
      const before = await fingerprint();
      assert.equal((await http("POST", statePath, { snapshot: {} }, a)).status, 405);
      assert.equal((await http("POST", changes, scenario.steps[0].request, a, { "x-actor-role": "system" })).status, 403);
      for (const role of ["system", "tool"] as const) assert.equal((await http("POST", changes, scenario.steps[0].request, undefined, await bearer(role))).status, 403);
      assert.equal((await http("GET", statePath, undefined, a, await bearer())).status, 403);
      assert.equal(await fingerprint(), before);
    });
    await t.test("actual Scenario A seven-command path through trusted internal/HTTP actors, with persistent GET state/history", async () => {
      const sys = await issueInternalCapability(secret, trip, { role: "system", id: "system-http-acceptance" });
      assert.equal((await internal.submit(trip, scenario.steps[0].request, sys)).outcome, "applied");
      for (let i = 1; i < 7; i++) {
        const r = requestAt(i, (await state()).revision, `http-a-${i}`), role = scenario.steps[i].actor.role;
        const result = await http("POST", changes, r, role === "user" ? a : undefined, role === "model" ? await bearer() : {});
        assert.equal(result.status, 200); assert.equal(result.body.revision, i + 1);
      }
      const s = await state(); assert.equal(s.revision, 7); assert.equal(s.effective_skeleton_id, null);
      assert.equal(s.objects.find((o) => o.type === "Candidate")?.status, "retained");
      const decision = s.objects.find((o) => o.type === "Decision"); assert.equal(decision?.type === "Decision" && decision.confirmed_by, `user-${a.id}`);
      assert.equal((await http("GET", changes, undefined, a)).body.changes.length, 7);
    });
    await t.test("preview does not write any business/authentication table and responses are private/no-store", async () => {
      const s = await state(), before = await fingerprint(true), r = await http("POST", changes + "/preview", edit(s.revision, "preview-only"), a);
      assert.equal(r.status, 200); assert.equal(r.body.outcome, "preview"); assert.equal(await fingerprint(true), before);
      assert.match(r.headers.get("cache-control")!, /no-store/); assert(r.headers.get("vary")!.split(",").some((v) => v.trim().toLowerCase() === "cookie")); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    });
    await t.test("Model HTTP 202 pending keeps authority unchanged; User confirmation finalizes original and confirmation idempotency keys", async () => {
      const before = await state(), p = await pending("accepted-proposal"); assert.deepEqual(await state(), before);
      const body = confirmation(p), route = changes + `/${p.response.proposal_id}/confirm`;
      const confirmed = await http("POST", route, body, a); assert.equal(confirmed.status, 200); assert.equal(confirmed.body.revision, before.revision + 1);
      assert.deepEqual((await http("POST", changes, p.request, undefined, await bearer())).body, confirmed.body);
      assert.deepEqual((await http("POST", route, body, a)).body, confirmed.body);
      assert.equal((await http("POST", route, { ...body, accept: false }, a)).status, 409);
    });
    await t.test("User rejection records history and preserves current authority; original request replays the final rejection", async () => {
      const before = await state(), p = await pending("rejected-proposal"), body = confirmation(p, false);
      const r = await http("POST", changes + `/${p.response.proposal_id}/confirm`, body, a); assert.equal(r.status, 422); assert.equal(r.body.outcome, "rejected"); assert.deepEqual(r.body.errors, []);
      assert.deepEqual(await state(), before); assert.deepEqual((await http("POST", changes, p.request, undefined, await bearer())).body, r.body);
    });
    await t.test("digest tampering, Model confirmation, ChangeRecord-as-Proposal and cross-trip confirmation are rejected without mutation", async () => {
      const p = await pending("confirmation-negatives"), before = await fingerprint(), route = changes + `/${p.response.proposal_id}/confirm`;
      const tampered = await http("POST", route, { ...confirmation(p), proposal_digest: "tampered-digest" }, a); assert.equal(tampered.status, 422); assert.equal(tampered.body.errors[0].code, "CONFIRMATION_SCOPE");
      assert.equal((await http("POST", route, confirmation(p), undefined, await bearer())).status, 403);
      const history = (await http("GET", changes, undefined, a)).body;
      const wrongId = await http("POST", changes + `/${history.changes.at(-1).id}/confirm`, confirmation(p), a); assert.equal(wrongId.status, 422); assert.equal(wrongId.body.errors[0].code, "PROPOSAL_NOT_FOUND");
      assert.equal((await http("POST", `/trips/${otherTrip}/changes/${p.response.proposal_id}/confirm`, confirmation(p), b)).status, 422);
      assert.equal(await fingerprint(), before);
    });
    await t.test("revoking membership blocks every operation and replay; restoring authorization permits the still-unconsumed Proposal", async () => {
      const p = await pending("permission-change"), before = await fingerprint(); admin("revoke-trip", { tripId: trip, userId: a.id });
      for (const [method, route, body] of [["GET", statePath, undefined], ["GET", changes, undefined], ["POST", changes + "/preview", p.request], ["POST", changes, p.request], ["POST", changes + `/${p.response.proposal_id}/confirm`, confirmation(p)]] as const) assert.equal((await http(method, route, body, a)).status, 403);
      assert.equal(await fingerprint(), before); admin("grant-trip", { tripId: trip, userId: a.id });
      assert.equal((await http("POST", changes + `/${p.response.proposal_id}/confirm`, confirmation(p), a)).status, 200);
    });
    await t.test("Proposal expiry uses elapsed wall time, retains pending evidence and never mutates authority", async () => {
      const p = await pending("expiring-proposal"), future = new Date(Date.now() + 100).toISOString();
      await owner.query(`UPDATE "TripStateProposal" SET "expiresAt"=$1::timestamptz,payload=jsonb_set(jsonb_set(payload,'{expires}',to_jsonb($1::text)),'{details,expires_at}',to_jsonb($1::text)) WHERE "tripId"=$2 AND "proposalId"=$3`, [future, trip, p.response.proposal_id]);
      await pause(180); const before = await fingerprint(), r = await http("POST", changes + `/${p.response.proposal_id}/confirm`, confirmation(p), a);
      assert.equal(r.status, 422); assert.equal(r.body.errors[0].code, "CONFIRMATION_EXPIRED"); assert.equal(await fingerprint(), before);
    });
    await t.test("real concurrent HTTP writes conflict by revision; identical requests replay once and changed content conflicts", async () => {
      let s = await state(); const [x, y] = await Promise.all([http("POST", changes, edit(s.revision, "race-a"), a), http("POST", changes, edit(s.revision, "race-b"), a)]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409]); s = await state();
      durableRequest = edit(s.revision, "durable-idempotency"); const [r1, r2] = await Promise.all([http("POST", changes, durableRequest, a), http("POST", changes, durableRequest, a)]);
      assert.equal(r1.status, 200); assert.deepEqual(r1.body, r2.body); durableResponse = r1.body;
      const before = await fingerprint(); assert.equal((await http("POST", changes, { ...durableRequest, reason: "different content" }, a)).status, 409); assert.equal(await fingerprint(), before);
    });
    await t.test("invalid JSON, huge numeric tokens, unknown fields, unsafe content types and oversized bodies are safe failures", async () => {
      const s = await state(), r = edit(s.revision, "invalid-input"), before = await fingerprint();
      for (const body of ["{", JSON.stringify({ ...r, actor: { role: "system", id: "forged" } }), JSON.stringify(r).replace(/"expected_revision":\d+/, '"expected_revision":9007199254740993'), JSON.stringify(r).replace(/"expected_revision":\d+/, '"expected_revision":9007199254740991.1')]) assert.equal((await http("POST", changes, body, a)).status, 422);
      assert.equal((await http("POST", changes, r, a, { "content-type": "text/plain" })).status, 422);
      assert.equal((await http("POST", changes, '"' + "x".repeat(256 * 1024) + '"', a)).status, 422);
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('"' + "x".repeat(256 * 1024) + '"')); controller.close(); } });
      const chunked = await fetch(origin + changes, { method: "POST", headers: { cookie: a.cookie, origin, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
      assert.equal(chunked.status, 422); const streamedError = parseContract("response", await chunked.json()); assert.equal(streamedError.errors[0].code, "SCHEMA");
      evidence.push({ method: "POST", route: changes, transport: "Chunked bytes without Content-Length", status: chunked.status, body: streamedError });
      assert.equal(await fingerprint(), before);
    });
    await t.test("Cookie CSRF/Origin defenses and wrong methods return formal errors, and E03 is not implemented", async () => {
      const s = await state(), r = edit(s.revision, "csrf"), before = await fingerprint();
      for (const headers of [{ origin: "https://evil.example.invalid" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) assert.equal((await http("POST", changes, r, a, headers)).status, 403);
      const missing = await fetch(origin + changes, { method: "POST", headers: { cookie: a.cookie, "content-type": "application/json" }, body: JSON.stringify(r) }); assert.equal(missing.status, 403); parseContract("response", await missing.json());
      for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) assert.equal((await http(method, changes, undefined, a)).status, 405);
      assert.equal((await http("HEAD", statePath, undefined, a)).status, 405);
      assert.equal((await http("POST", `/trips/${trip}/decision-context`, {}, a)).status, 404); assert.equal(await fingerprint(), before);
    });
    await t.test("signed service credentials are scoped/expiring and cannot be exchanged for User identity", async () => {
      const before = await fingerprint(); assert.equal((await http("GET", statePath, undefined, undefined, await bearer("model", otherTrip))).status, 403);
      const expired = await new SignJWT({ trip, role: "model" }).setProtectedHeader({ alg: "HS256" }).setIssuer("antu-internal").setAudience("antu-trip-service").setSubject("model-expired").setIssuedAt(Math.floor(Date.now()/1000)-120).setExpirationTime(Math.floor(Date.now()/1000)-60).sign(new TextEncoder().encode(secret));
      for (const token of [expired, "static-fake-token"]) assert.equal((await http("GET", statePath, undefined, undefined, { authorization: "Bearer " + token })).status, 403);
      assert.equal(await fingerprint(), before);
    });
    await t.test("internal SQL fault returns sanitized 500, rolls back all business tables and succeeds exactly once on retry", async () => {
      const s = await state(), request = edit(s.revision, "sql-failure"), before = await fingerprint(), name = `http_fail_${crypto.randomBytes(6).toString("hex")}`;
      await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tripId"='${trip}' THEN RAISE EXCEPTION 'E02_INTERNAL_DATABASE_ERROR_MUST_NOT_ESCAPE'; END IF; RETURN NEW; END $$`);
      await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "TripStateHistory" FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
      try { const r = await http("POST", changes, request, a); assert.equal(r.status, 500); assert.equal(r.body.errors[0].code, "INTERNAL_FAILURE"); assert(!JSON.stringify(r.body).includes("E02_INTERNAL")); assert.equal(await fingerprint(), before); }
      finally { await owner.query(`DROP TRIGGER ${name} ON "TripStateHistory"`); await owner.query(`DROP FUNCTION public.${name}()`); }
      assert.equal((await http("POST", changes, request, a)).status, 200);
    });
    await t.test("expired and revoked real sessions fail, and signing in again restores only authorized access", async () => {
      await owner.query('UPDATE "AuthSession" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE "userId"=$1', [a.id]); assert.equal((await http("GET", statePath, undefined, a)).status, 403); await login(a);
      assert.equal((await http("POST", "/api/auth/sign-out", {}, a)).status, 200); assert.equal((await http("GET", statePath, undefined, a)).status, 403); await login(a);
    });
    await t.test("actual Next process restart, reauthentication, state/history and durable idempotency recovery", async () => {
      const before = await state(), history = (await http("GET", changes, undefined, a)).body; await stop(); await start(); await login(a);
      assert.deepEqual(await state(), before); assert.deepEqual((await http("GET", changes, undefined, a)).body, history);
      const replay = await http("POST", changes, durableRequest, a); assert.equal(replay.status, 200); assert.deepEqual(replay.body, durableResponse);
    });
    await t.test("revocation while a malformed HTTP body is streaming cannot reveal another member's new revision", async () => {
      admin("grant-trip", {tripId:trip,userId:b.id});
      const prior=await state();
      let responseResolve!:(value:{status:number;body:Body})=>void,responseReject!:(error:Error)=>void;
      const responsePromise=new Promise<{status:number;body:Body}>((resolve,reject)=>{responseResolve=resolve;responseReject=reject;});
      const slow=nodeHttpRequest(origin+changes,{method:"POST",headers:{cookie:a.cookie,origin,"content-type":"application/json"}},response=>{
        let raw="";response.setEncoding("utf8");response.on("data",chunk=>{raw+=chunk;});response.on("end",()=>{
          try{responseResolve({status:response.statusCode!,body:parseContract("response",JSON.parse(raw))});}catch(error){responseReject(error as Error);}
        });
      });
      void responsePromise.catch(()=>{}); // The test may abort before awaiting the HTTP response.
      slow.on("error",responseReject);slow.write("{");
      try {
        // Hold the chunked body open so the request overlaps the member change.
        await pause(750);
        const advanced=await http("POST",changes,edit(prior.revision,"other-member-advances"),b);assert.equal(advanced.status,200);
        assert.equal(advanced.body.revision,prior.revision+1);
        admin("revoke-trip",{tripId:trip,userId:a.id});
        const afterB=await owner.query('SELECT "revision", (SELECT count(*)::int FROM "TripStateHistory" h WHERE h."tripId"=$1) AS n FROM "TripStateDocument" WHERE "tripId"=$1',[trip]);
        slow.end();const denied=await responsePromise;
        assert.equal(denied.status,403);assert.equal(denied.body.revision,0);assert.equal(denied.body.errors[0].code,"PERMISSION");assert.deepEqual(denied.body.diff,[]);assert.deepEqual(denied.body.affected_ids,[]);
        const afterA=await owner.query('SELECT "revision", (SELECT count(*)::int FROM "TripStateHistory" h WHERE h."tripId"=$1) AS n FROM "TripStateDocument" WHERE "tripId"=$1',[trip]);assert.deepEqual(afterA.rows,afterB.rows);
        evidence.push({method:"POST",route:changes,transport:"slow chunked malformed body; membership revoked after another user advanced",status:denied.status,body:denied.body});
      } finally {slow.destroy();admin("grant-trip",{tripId:trip,userId:a.id});admin("revoke-trip",{tripId:trip,userId:b.id});}
    });
    await t.test("durable authentication throttling cannot be bypassed by claiming a different forwarded IP", async () => {
      let limited = false;
      for (let i = 0; i < 22; i++) { const r = await http("POST", "/api/auth/sign-in/email", { email: a.email, password: crypto.randomBytes(20).toString("hex") }, undefined, { "x-forwarded-for": `198.51.100.${i+1}` }); if (r.status === 429) { limited = true; break; } assert.equal(r.status, 401); }
      assert.equal(limited, true);
    });
  } finally {
    await stop(); await internal.close(); await owner.end();
    if (process.env.E02_HTTP_EVIDENCE_PATH) fs.writeFileSync(process.env.E02_HTTP_EVIDENCE_PATH, JSON.stringify({ producer: "Actual Next production process, Node HTTP fetch, Better Auth real credentials and PostgreSQL; no route-function or database mocks", evidence }, null, 2) + "\n");
  }
});
