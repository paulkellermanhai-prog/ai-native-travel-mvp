import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openSyntheticStorageHarness, openTripCommandService, type CommandHost } from "../../src/server/trip-state/internal/persistence";
import type { Actor } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, uuids } from "../support/command-fixtures";
import { restorationRequest } from "../../src/server/trip-state/restoration";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("UX02 CI requires real PostgreSQL");
const config = envFile ? JSON.parse(fs.readFileSync(envFile, "utf8")) as { runtimeUrl: string } : null;
const actors: Record<string, Actor> = {
  user: { role: "user", id: "scenario-user" }, other: { role: "user", id: "other-member" },
  model: { role: "model", id: "scenario-ai" }, tool: { role: "tool", id: "scenario-provider" }, system: { role: "system", id: "scenario-system" },
};
const adopt = (id = "skeleton-a"): TripStateContracts["command"] => ({ op: "adopt_skeleton", id, acknowledge_unknowns: true,
  confirmation_scope: ["cities", "order", "stays", "connections"] });
const resources: Array<{ close: () => Promise<void> }> = [];
let runtime: Client;

async function setup(initial: State = base) {
  const tripId = `trip-ux02-${crypto.randomBytes(8).toString("hex")}`, state = structuredClone(initial);
  state.trip_id = tripId; for (const o of state.objects) o.trip_id = tripId;
  const seed = await openSyntheticStorageHarness(config!.runtimeUrl); resources.push(seed); await seed.seedSyntheticSnapshot(state);
  const tokens = Object.fromEntries(Object.keys(actors).map((role) => [role, Object.freeze({})]));
  const host: CommandHost = { clock, uuid: uuids(2000), authorize: (trip, credential) => {
    const role = Object.keys(tokens).find((key) => tokens[key] === credential);
    if (trip !== tripId || !role) throw new Error("Host denied trip access");
    return { tripId, actor: actors[role] };
  } };
  const open = async () => { const service = await openTripCommandService(config!.runtimeUrl, host); resources.push(service); return service; };
  return { tripId, state, tokens, open, service: await open() };
}
async function fingerprint(tripId: string) {
  const rows = [];
  for (const table of ["TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency"])
    rows.push((await runtime.query(`SELECT row_to_json(t) AS value FROM "${table}" t WHERE "tripId"=$1 ORDER BY row_to_json(t)::text`, [tripId])).rows);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

describe.skipIf(!config)("UX02 restoration on actual PostgreSQL", () => {
  beforeAll(async () => { runtime = new Client({ connectionString: config!.runtimeUrl }); await runtime.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((service) => service.close())); });
  afterAll(async () => { await runtime?.end(); });
  it.each([undefined, "luxor"])("%s preview and replay after reconnect preserve history exactly once", async (cityId) => {
    const f = await setup();
    await f.service.submit(f.tripId, change(f.state, [adopt()], "adopt-original"), f.tokens.user);
    const adopted = (await f.service.state(f.tripId, f.tokens.user))!, next = createFrom(object(adopted, "skeleton-a", "Skeleton"), "next-plan");
    if (next.op !== "create" || next.object_type !== "Skeleton") throw new Error("Fixture");
    next.data.parent_id = "skeleton-a"; next.data.stops[0].nights = 1;
    await f.service.submit(f.tripId, change(adopted, [next, adopt("next-plan")], "new-plan"), f.tokens.user);
    const current = (await f.service.state(f.tripId, f.tokens.user))!;
    const request = restorationRequest(current, { sourceId: "skeleton-a", newId: "restored-plan", expectedRevision: current.revision,
      idempotencyKey: "restore-pg", reason: "合成当前授权", input: { kind: "dialogue", reference: "new-event", text: "恢复已展示安排", target_ids: [] }, cityId, acknowledgeUnknowns: true });
    const before = await fingerprint(f.tripId), history = await f.service.history(f.tripId, f.tokens.user);
    expect((await f.service.preview(f.tripId, request, f.tokens.user)).outcome).toBe("preview"); expect(await fingerprint(f.tripId)).toBe(before);
    const applied = await f.service.submit(f.tripId, request, f.tokens.user); expect(applied.outcome).toBe("applied");
    const saved = await fingerprint(f.tripId); await f.service.close(); const recovered = await f.open();
    expect(await recovered.submit(f.tripId, request, f.tokens.user)).toEqual(applied); expect(await fingerprint(f.tripId)).toBe(saved);
    expect((await recovered.history(f.tripId, f.tokens.user)).changes).toHaveLength(history.changes.length + 1);
    const state = (await recovered.state(f.tripId, f.tokens.user))!;
    expect(state.effective_skeleton_id).toBe("restored-plan");
    expect(object(state, "restored-plan", "Skeleton").stops[0].nights).toBe(cityId ? 1 : 2);
    expect(object(state, "skeleton-a", "Skeleton")).toEqual(object(current, "skeleton-a", "Skeleton"));
    expect(await recovered.submit(f.tripId, { ...request, idempotency_key: "different-intent" }, f.tokens.user)).toMatchObject({ outcome: "conflict", errors: [{ code: "VERSION_CONFLICT" }] });
    expect(await fingerprint(f.tripId)).toBe(saved);
  });
  it("current hard constraint rejects whole restore without a new row", async () => {
    const f = await setup(); await f.service.submit(f.tripId, change(f.state, [adopt()], "first"), f.tokens.user);
    let state = (await f.service.state(f.tripId, f.tokens.user))!;
    await f.service.submit(f.tripId, change(state, [{ op: "revise", object_type: "Constraint", id: "constraint-nights", changes: { value: { kind: "duration", maximum_nights: 3 } } }], "hard"), f.tokens.user);
    state = (await f.service.state(f.tripId, f.tokens.user))!;
    const body = restorationRequest(state, { sourceId: "skeleton-a", newId: "blocked-restoration", expectedRevision: state.revision, idempotencyKey: "blocked", reason: "合成当前恢复", input: { kind: "dialogue", reference: "new", text: "恢复", target_ids: [] }, acknowledgeUnknowns: true });
    const before = await fingerprint(f.tripId);
    expect(await f.service.preview(f.tripId, body, f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "HARD_CONFLICT" }] });
    expect(await f.service.submit(f.tripId, body, f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "HARD_CONFLICT" }] });
    expect(await fingerprint(f.tripId)).toBe(before);
  });
});
