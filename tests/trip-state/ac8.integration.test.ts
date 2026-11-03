import fs from "node:fs";
import crypto from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { openSyntheticStorageHarness, openTripCommandService, type CommandHost } from "../../src/server/trip-state/internal/persistence";
import type { Actor } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, uuids } from "../support/command-fixtures";
import { ingest } from "../support/fact-fixtures";

const envFile = process.env.E02_STORAGE_ENV_FILE;
if (process.env.CI && !envFile) throw new Error("AC8 CI requires real PostgreSQL");
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
  const tripId = `trip-ac8-${crypto.randomBytes(8).toString("hex")}`, state = structuredClone(initial);
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

describe.skipIf(!config)("stage B actual PostgreSQL AC8 boundaries", () => {
  beforeAll(async () => { runtime = new Client({ connectionString: config!.runtimeUrl }); await runtime.connect(); });
  afterEach(async () => { await Promise.all(resources.splice(0).map((service) => service.close())); });
  afterAll(async () => { await runtime?.end(); });

  it("X01 rejects other member directly and on Model acceptance; original member may revoke after reconnect", async () => {
    const f = await setup(), first = await f.service.submit(f.tripId, change(f.state, [adopt()]), f.tokens.user);
    expect(first.outcome).toBe("applied");
    const state = (await f.service.state(f.tripId, f.tokens.user))!, decision = state.objects.find((o) => o.type === "Decision" && o.status === "confirmed")!;
    const request = change(state, [{ op: "withdraw_decision", id: decision.id }], "ac8-direct");
    const before = await fingerprint(f.tripId);
    expect(await f.service.preview(f.tripId, request, f.tokens.other)).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
    expect(await f.service.submit(f.tripId, request, f.tokens.other)).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
    expect(await fingerprint(f.tripId)).toBe(before);
    const pending = await f.service.submit(f.tripId, { ...request, idempotency_key: "ac8-model" }, f.tokens.model);
    expect(pending.outcome).toBe("pending_confirmation");
    const body = { expected_revision: state.revision, idempotency_key: "ac8-confirm", proposal_digest: pending.proposal_digest!, accept: true };
    const proposed = await fingerprint(f.tripId);
    expect(await f.service.confirm(f.tripId, pending.proposal_id!, body, f.tokens.other)).toMatchObject({ outcome: "rejected", errors: [{ code: "PERMISSION" }] });
    expect(await fingerprint(f.tripId)).toBe(proposed);
    expect(await f.service.confirm(f.tripId, pending.proposal_id!, { ...body, accept: false }, f.tokens.other)).toMatchObject({ outcome: "rejected", errors: [] });
    const fresh = await f.service.submit(f.tripId, { ...request, idempotency_key: "ac8-model-again" }, f.tokens.model);
    await f.service.close();
    const recovered = await f.open();
    expect(await recovered.confirm(f.tripId, fresh.proposal_id!, { ...body, idempotency_key: "ac8-confirm-original", proposal_digest: fresh.proposal_digest! }, f.tokens.user)).toMatchObject({ outcome: "applied" });
    const after = (await recovered.state(f.tripId, f.tokens.user))!;
    expect(after.objects.find((o) => o.id === decision.id)?.status).toBe("revoked");
    expect(after.effective_skeleton_id).toBeNull();
  });

  it("C12 conflicting service observation stales the adopted plan and rejects a new adoption atomically", async () => {
    const f = await setup(); await f.service.submit(f.tripId, change(f.state, [adopt()]), f.tokens.user);
    const adopted = (await f.service.state(f.tripId, f.tokens.user))!;
    const opposite = ingest("opposite-service"); opposite.data.query_status = "no_service";
    if (opposite.data.value?.kind !== "transport") throw new Error("Fixture");
    Object.assign(opposite.data.value, { service_exists: false, departure: null, arrival: null, duration_minutes: null });
    expect(await f.service.submit(f.tripId, change(adopted, [opposite]), f.tokens.tool)).toMatchObject({ outcome: "applied" });
    const current = (await f.service.state(f.tripId, f.tokens.user))!;
    expect(object(current, "skeleton-a", "Skeleton").assessment.status).toBe("stale");
    expect(current.objects.find((o) => o.type === "Decision" && o.status === "confirmed")).toBeTruthy();
    const replacement = createFrom(object(current, "skeleton-a", "Skeleton"), "contested-replacement");
    const before = await fingerprint(f.tripId);
    expect(await f.service.submit(f.tripId, change(current, [replacement, adopt("contested-replacement")]), f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "HARD_CONFLICT" }] });
    expect(await fingerprint(f.tripId)).toBe(before);
    expect(await f.service.submit(f.tripId, change(current, [{ op: "transition", id: opposite.id, event: "contradict" }]), f.tokens.tool)).toMatchObject({ outcome: "applied" });
  });

  it("P03 two-object correction commits one history entry; P05 incomplete budget fails without a write", async () => {
    const f = await setup(), second = createFrom(object(f.state, "pref-culture", "Preference"), "pref-transfer");
    if (second.op !== "create" || second.object_type !== "Preference") throw new Error("Fixture");
    second.scope = { kind: "entity", ids: ["aswan"] }; Object.assign(second.data, { subject_ids: ["aswan"], certainty: "inferred", support: "weak" });
    await f.service.submit(f.tripId, change(f.state, [second]), f.tokens.user);
    const before = (await f.service.state(f.tripId, f.tokens.user))!;
    const correction = change(before, [
      { op: "revise", object_type: "Preference", id: "pref-culture", changes: { expression: "文化仍喜欢，但本轮不优先" } },
      { op: "revise", object_type: "Preference", id: "pref-transfer", changes: { expression: "阿斯旺仍想去", evidence_refs: ["synthetic-old", "synthetic-correction"] } },
    ]);
    expect(await f.service.submit(f.tripId, correction, f.tokens.user)).toMatchObject({ outcome: "applied" });
    const after = (await f.service.state(f.tripId, f.tokens.user))!, history = await f.service.history(f.tripId, f.tokens.user);
    expect(history.changes.at(-1)!.diff.map((d) => d.id)).toEqual(expect.arrayContaining(["pref-culture", "pref-transfer"]));
    expect(after.objects.find((o) => o.id === "constraint-budget")).toEqual(before.objects.find((o) => o.id === "constraint-budget"));
    const budget = createFrom(object(after, "constraint-budget", "Constraint"), "rough-budget");
    if (budget.op !== "create" || budget.object_type !== "Constraint") throw new Error("Fixture");
    budget.data.value = { kind: "budget", mode: "intent", minimum_minor: null, maximum_minor: 2000000, currency: null as never,
      people: null as never, categories: [] };
    const stored = await fingerprint(f.tripId);
    expect(await f.service.submit(f.tripId, change(after, [budget]), f.tokens.user)).toMatchObject({ outcome: "rejected", errors: [{ code: "SCHEMA" }] });
    expect(await fingerprint(f.tripId)).toBe(stored);
  });
});
