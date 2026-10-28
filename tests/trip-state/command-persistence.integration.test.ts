import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTripCommandService, openSyntheticStorageHarness, type CommandHost, type HostGrant } from "../../src/server/trip-state/internal/persistence";
import { scenario, clock, uuids, requestAt, oracle, type Audit } from "../support/command-fixtures";
import type { State } from "../../src/server/trip-state/contracts.generated";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("Command persistence CI requires real PostgreSQL");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { migrationUrl: string; runtimeUrl: string } : null;
const resources: Array<{ close: () => Promise<void> }> = [];
let owner: Client;
function hostFor(tripId: string, uuid = uuids()) {
  // Synthetic opaque credentials stand in for a real server-side session integration; no self-asserted role is trusted.
  const tokens = scenario.steps.map(() => Object.freeze({})), grants = new WeakMap<object, HostGrant>();
  for (const [i, token] of tokens.entries()) grants.set(token, { tripId, actor: scenario.steps[i].actor });
  const host: CommandHost = { clock, uuid, authorize: (trip, credential) => {
    const grant = credential && typeof credential === "object" ? grants.get(credential) : undefined;
    if (!grant || grant.tripId !== trip) throw new Error("Host denied access");
    return grant;
  } };
  return { host, tokens };
}
async function service(host: CommandHost) { const s = await openTripCommandService(config!.runtimeUrl, host); resources.push(s); return s; }
async function setup(uuid = uuids()) {
  const tripId = `trip-command-${crypto.randomBytes(8).toString("hex")}`, h = hostFor(tripId, uuid), s = await service(h.host);
  await s.createTrip(tripId, h.tokens[0]); return { ...h, s, tripId };
}
async function counts(tripId: string) {
  const { rows } = await owner.query('SELECT (SELECT count(*)::int FROM "TripStateHistory" WHERE "tripId"=$1) AS history, (SELECT count(*)::int FROM "TripStateIdempotency" WHERE "tripId"=$1) AS requests, (SELECT count(*)::int FROM "TripStateProposal" WHERE "tripId"=$1) AS proposals', [tripId]);
  return rows[0];
}

describe.skipIf(!config)("E02-03 real command-only PostgreSQL channel", () => {
  beforeAll(async () => { owner = new Client({ connectionString: config!.migrationUrl }); await owner.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((r) => r.close())); vi.unstubAllEnvs(); });
  afterAll(async () => { await owner?.end(); });

  it("persists all seven freshly executed TS steps with the unchanged test harness disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(openSyntheticStorageHarness(config!.runtimeUrl)).rejects.toMatchObject({ code: "STORAGE_WRITE_DISABLED" });
    const { s, tokens, tripId } = await setup();
    const initial = { ...scenario.initial_state, trip_id: tripId };
    const python = oracle<Array<{ response: unknown; state_after: State; audit: Audit }>>({ initial, operations: scenario.steps });
    for (const [index, step] of scenario.steps.entries()) {
      expect(await s.submit(tripId, JSON.stringify(step.request), tokens[index])).toEqual(python[index].response);
      expect(await s.state(tripId, tokens[index])).toEqual(python[index].state_after);
      expect(await s.history(tripId, tokens[index])).toEqual(python[index].audit);
    }
    expect(await counts(tripId)).toEqual({ history: 7, requests: 7, proposals: 0 });
    await s.close();
    const restoredHost = hostFor(tripId), restored = await service(restoredHost.host);
    expect(await restored.state(tripId, restoredHost.tokens[1])).toEqual(python[6].state_after);
    // Independent OS process proves durability without a shared Prisma client or JS cache.
    const recovered = JSON.parse(execFileSync(process.execPath, ["tests/support/storage-process.mjs"], {
      encoding: "utf8", env: { ...process.env, NODE_ENV: "test", E02_READ_TRIP_ID: tripId }, timeout: 15000,
    }));
    expect(recovered.processId).not.toBe(process.pid); expect(recovered.state).toEqual(python[6].state_after);
    expect(recovered.history.map((h: { intent: unknown }) => h.intent)).toEqual(python[6].audit.intents);
  });
  it("requires installed host authorization and rejects forged identities and cross-trip access", async () => {
    const { s, tripId, tokens } = await setup();
    await expect(s.submit(tripId, scenario.steps[0].request, { role: "system", id: "scenario-system" })).rejects.toThrow("Host denied");
    await expect(s.state("other-trip", tokens[0])).rejects.toThrow("Host denied");
    await expect(s.history(tripId, null)).rejects.toThrow("Host denied");
    await expect(s.createTrip(tripId, tokens[1])).rejects.toMatchObject({ code: "PERMISSION" });
    const forged = await s.submit(tripId, { ...scenario.steps[0].request, actor: { role: "system" } }, tokens[1]);
    expect(forged).toMatchObject({ outcome: "rejected", errors: [{ code: "SCHEMA" }] });
    expect(await counts(tripId)).toEqual({ history: 0, requests: 0, proposals: 0 });
    await expect(openTripCommandService(config!.runtimeUrl, {} as CommandHost)).rejects.toMatchObject({ code: "ACTOR" });
    await expect(openTripCommandService(config!.migrationUrl, hostFor(tripId).host)).rejects.toMatchObject({ code: "STORAGE_IDENTITY" });
    const wrongGrant = await service({ authorize: () => ({ tripId: "other-trip", actor: scenario.steps[0].actor }) });
    await expect(wrongGrant.state(tripId, {})).rejects.toMatchObject({ code: "ACTOR" });
  });
  it("serializes competing commands and persists replay/conflict protection across new connections", async () => {
    const { s, tripId, tokens, host } = await setup(), other = await service(host);
    const a = requestAt(0, 0, "race-a"), b = requestAt(0, 0, "race-b");
    const results = await Promise.all([s.submit(tripId, a, tokens[0]), other.submit(tripId, b, tokens[0])]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
    const winner = results[0].outcome === "applied" ? 0 : 1, request = winner === 0 ? a : b;
    expect(results[1 - winner].errors[0].code).toBe("VERSION_CONFLICT");
    expect(await other.submit(tripId, request, tokens[0])).toEqual(results[winner]);
    expect(await s.submit(tripId, { ...request, reason: "different body" }, tokens[0])).toMatchObject({ outcome: "conflict", errors: [{ code: "IDEMPOTENCY_CONFLICT" }] });
    expect(await counts(tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("rejects invalid semantics and mixed command failures before any authoritative or journal/cache write", async () => {
    const { s, tripId, tokens } = await setup();
    const bad = requestAt(0, 0); bad.commands.push(structuredClone(bad.commands[0]));
    expect(await s.submit(tripId, bad, tokens[0])).toMatchObject({ outcome: "rejected", errors: [{ code: "DUPLICATE_ID" }] });
    expect(await s.state(tripId, tokens[0])).toEqual({ ...scenario.initial_state, trip_id: tripId });
    expect(await counts(tripId)).toEqual({ history: 0, requests: 0, proposals: 0 });
    await s.submit(tripId, scenario.steps[0].request, tokens[0]);
    expect(await s.submit(tripId, scenario.steps[1].request, tokens[3])).toMatchObject({ outcome: "pending_confirmation", confirmation_required: true });
    expect(await counts(tripId)).toEqual({ history: 2, requests: 2, proposals: 1 });
  });
  it("rolls back a real mid-transaction history uniqueness failure through the command path", async () => {
    const { s, tripId, tokens, host } = await setup();
    await s.submit(tripId, scenario.steps[0].request, tokens[0]);
    const before = await s.state(tripId, tokens[0]), audit = await s.history(tripId, tokens[0]);
    const collision = await service({ ...host, uuid: uuids() }); // Generates an already persisted intent ID, after snapshot UPDATE.
    await expect(collision.submit(tripId, scenario.steps[1].request, tokens[1])).rejects.toMatchObject({ code: "P2002" });
    expect(await s.state(tripId, tokens[0])).toEqual(before); expect(await s.history(tripId, tokens[0])).toEqual(audit);
    expect(await counts(tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
    expect(await s.submit(tripId, scenario.steps[1].request, tokens[1])).toMatchObject({ outcome: "applied", revision: 2 });
  });
  it("refuses unsafe PG BigInt/JSONB counter reads and raw decimal precision loss", async () => {
    const { s, tripId, tokens } = await setup();
    await expect(s.submit(tripId, '{"expected_revision":9007199254740991.1}', tokens[0])).rejects.toMatchObject({ code: "INTEGER_REPRESENTATION" });
    await owner.query('UPDATE "TripStateDocument" SET "revision"=$1::bigint, "snapshot"=jsonb_set("snapshot",\'{revision}\',to_jsonb($1::bigint)) WHERE "tripId"=$2', ["9007199254740993", tripId]);
    await expect(s.state(tripId, tokens[0])).rejects.toMatchObject({ code: "INTEGER_REPRESENTATION" });
    expect(await counts(tripId)).toEqual({ history: 0, requests: 0, proposals: 0 });
  });
  it("commits the final safe revision exactly and refuses its next increment atomically", async () => {
    const { s, tripId, tokens } = await setup(), max = Number.MAX_SAFE_INTEGER;
    await owner.query('UPDATE "TripStateDocument" SET "revision"=$1::bigint, "snapshot"=jsonb_set("snapshot",\'{revision}\',to_jsonb($1::bigint)) WHERE "tripId"=$2', [String(max - 1), tripId]);
    expect(await s.submit(tripId, requestAt(0, max - 1), tokens[0])).toMatchObject({ outcome: "applied", revision: max });
    expect((await s.state(tripId, tokens[0]))!.revision).toBe(max);
    expect(await s.submit(tripId, requestAt(1, max), tokens[1])).toMatchObject({ outcome: "rejected", errors: [{ code: "INTEGER_REPRESENTATION" }] });
    expect(await counts(tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
  it("reads JSONB as text so a fractional object counter cannot hide behind driver rounding", async () => {
    const { s, tripId, tokens } = await setup(); await s.submit(tripId, scenario.steps[0].request, tokens[0]);
    await owner.query('UPDATE "TripStateDocument" SET "snapshot"=jsonb_set("snapshot",\'{objects,0,version}\',\'1.00000000000000001\'::jsonb) WHERE "tripId"=$1', [tripId]);
    await expect(s.state(tripId, tokens[0])).rejects.toMatchObject({ code: "INTEGER_REPRESENTATION" });
    expect(await counts(tripId)).toEqual({ history: 1, requests: 1, proposals: 0 });
  });
});
