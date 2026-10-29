import { runtimeRoleSafetySql } from "../../database/runtime-role-safety.mjs";
import { isDeepStrictEqual } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../../../generated/prisma/client";
import { parseContract } from "../contracts";
import { parseStateReferences } from "../references";
import { checkStateCounters, safeCounter } from "../numbers";
import { planCommand, previewCommand, planConfirmation, validateActor, failureResponse, stampTime, type Actor, type CommandRequest, type PendingDetails, type PendingProposal } from "../commands";
import { validateStateSemantics, rule, instantMicros } from "../semantics";
import { decodeCommandJson, digest } from "../command-json";
import { TripStateContractError } from "../contracts";
import type { TripStateContracts, State } from "../contracts.generated";

type Request = TripStateContracts["change-request"] | TripStateContracts["confirm-request"];
type Domain = "user" | "model" | "tool" | "system" | "confirmation";
type RequestKey = { actorId: string; operationDomain: Domain; key: string; requestDigest: string };
export type SyntheticStorageBatch = {
  tripId: string;
  request: Request;
  key: RequestKey;
  snapshot: State;
  intent: TripStateContracts["OperationIntent"];
  change: TripStateContracts["ChangeRecord"];
  response: TripStateContracts["response"];
  proposalExpiresAt?: Date;
  proposalCreatedAt?: Date;
  proposalDetails?: PendingDetails;
};
export type StorageCheckpoint = "snapshot" | "history" | "proposal" | "idempotency" | "before-commit";

export class StorageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "StorageError"; this.code = code; }
}
function requireStorage(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new StorageError(code, message);
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
function storageState(value: unknown) { const state = parseContract("state", typeof value === "string" ? decodeCommandJson(value) : value); checkStateCounters(state); return state; }
function storageResponse(value: unknown) { const response = parseContract("response", typeof value === "string" ? decodeCommandJson(value) : value); safeCounter(response.revision, "response revision"); return response; }

function storageHistory(rows: Array<{ intent: string; change: string }>) {
  const history = parseContract("history", { intents: rows.map((r) => decodeCommandJson(r.intent)), changes: rows.map((r) => decodeCommandJson(r.change)) });
  for (const intent of history.intents) safeCounter(intent.base_revision, "history base revision");
  for (const change of history.changes) { safeCounter(change.base_revision, "history base revision"); safeCounter(change.result_revision, "history result revision"); }
  return history;
}

function createClient(connectionString: string) {
  // Prisma 7's timestamp adapter requires a UTC session to preserve instants from non-UTC servers.
  const url = new URL(connectionString);
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c timezone=UTC`.trim());
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
}

function requireSyntheticEnvironment() {
  requireStorage(process.env.NODE_ENV === "test", "STORAGE_WRITE_DISABLED", "Generic snapshot/batch writes are restricted to isolated synthetic tests");
}

async function checkTripRuntime(client: PrismaClient) {
  const [identity] = await client.$queryRawUnsafe<Array<{ denied: boolean }>>(runtimeRoleSafetySql, null, "trip");
  requireStorage(!!identity && !identity.denied, "STORAGE_IDENTITY", "Trip runtime must be unprivileged, non-owner and isolated from identity table and column permissions");
}

// Read-only storage API. The host must authorize trip access before calling it.
export function openTripStateReader(connectionString: string) {
  const client = createClient(connectionString);
  return {
    async state(tripId: string) {
      await checkTripRuntime(client);
      const [row] = await client.$queryRaw<Array<{ snapshot: string }>>`SELECT "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId" = ${tripId}`;
      return row ? storageState(row.snapshot) : null;
    },
    async history(tripId: string) {
      await checkTripRuntime(client);
      const rows = await client.$queryRaw<Array<{ intent: string; change: string }>>`SELECT "intent"::text AS "intent", "change"::text AS "change" FROM "TripStateHistory" WHERE "tripId" = ${tripId} ORDER BY "sequence"`;
      return storageHistory(rows);
    },
    async idempotency(tripId: string, key: Omit<RequestKey, "requestDigest">) {
      await checkTripRuntime(client);
      const [row] = await client.$queryRaw<Array<{ requestDigest: string; request: string; response: string }>>`SELECT "requestDigest", "request"::text AS "request", "response"::text AS "response" FROM "TripStateIdempotency" WHERE "tripId" = ${tripId} AND "actorId" = ${key.actorId} AND "operationDomain" = ${key.operationDomain} AND "key" = ${key.key}`;
      return row ? { requestDigest: row.requestDigest, request: decodeCommandJson(row.request), response: storageResponse(row.response) } : null;
    },
    async pending(tripId: string, proposalId: string) {
      await checkTripRuntime(client);
      // Consistent snapshot: the proposal basis and aggregate revision are read in one statement.
      const rows = await client.$queryRaw<Array<{ payload: Prisma.JsonValue; basisRevision: bigint; revision: bigint; expiresAt: Date; now: Date }>>`
        SELECT p."payload", p."basisRevision", d."revision", p."expiresAt", clock_timestamp() AS "now"
        FROM "TripStateProposal" p JOIN "TripStateDocument" d ON d."tripId" = p."tripId"
        WHERE p."tripId" = ${tripId} AND p."proposalId" = ${proposalId}`;
      const row = rows[0];
      requireStorage(!!row, "PROPOSAL_NOT_FOUND", "No persisted proposal");
      requireStorage(row.basisRevision === row.revision, "VERSION_CONFLICT", "Proposal basis is stale");
      requireStorage(row.now < row.expiresAt, "CONFIRMATION_EXPIRED", "Proposal has expired");
      return { payload: row.payload, basisRevision: row.basisRevision, expiresAt: row.expiresAt };
    },
    close: () => client.$disconnect(),
  };
}

async function appendHistory(tx: Prisma.TransactionClient, tripId: string, intent: TripStateContracts["OperationIntent"], change: TripStateContracts["ChangeRecord"]) {
  const last = await tx.tripStateHistory.findFirst({ where: { tripId }, orderBy: { sequence: "desc" } });
  await tx.tripStateHistory.create({ data: { tripId, sequence: (last?.sequence ?? 0n) + 1n, intentId: intent.id, changeRecordId: change.id, intent: json(intent), change: json(change) } });
}

async function confirmPrepared(client: PrismaClient, tripId: string, proposalId: string, value: unknown, actor: Actor, host: CommandHost, guard?: (tx: Prisma.TransactionClient) => Promise<void>) {
  rule(actor.role === "user", "PERMISSION", "只有经鉴权用户可确认");
  const request = parseContract("confirm-request", value); safeCounter(request.expected_revision, "expected_revision");
  const requestDigest = digest({ proposal_id: proposalId, request });
  return client.$transaction(async (tx) => {
    const [document] = await tx.$queryRaw<Array<{ revision: bigint; snapshot: string }>>`SELECT "revision", "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId"=${tripId} FOR UPDATE`;
    requireStorage(!!document, "STORAGE_TRIP_NOT_FOUND", "Aggregate does not exist");
    await guard?.(tx);
    const before = storageState(document.snapshot);
    requireStorage(BigInt(before.revision) === document.revision, "STORAGE_INTEGRITY", "Stored revision and JSONB disagree");
    const [cached] = await tx.$queryRaw<Array<{ requestDigest: string; request: string; response: string }>>`SELECT "requestDigest", "request"::text AS "request", "response"::text AS "response" FROM "TripStateIdempotency" WHERE "tripId"=${tripId} AND "actorId"=${actor.id} AND "operationDomain"='confirmation' AND "key"=${request.idempotency_key}`;
    if (cached) {
      rule(cached.requestDigest === requestDigest && same(decodeCommandJson(cached.request), request), "IDEMPOTENCY_CONFLICT", "确认幂等键内容不同");
      return storageResponse(cached.response);
    }
    const [row] = await tx.$queryRaw<Array<{ basisRevision: bigint; digest: string; payload: string }>>`SELECT "basisRevision", "digest", "payload"::text AS "payload" FROM "TripStateProposal" WHERE "tripId"=${tripId} AND "proposalId"=${proposalId}`;
    rule(row, "PROPOSAL_NOT_FOUND", "提案不存在或已经处理");
    const payload = decodeCommandJson(row.payload) as { request: unknown; actor: Actor; digest: string; expires: string; cache_key: string[]; details?: PendingDetails };
    const original = parseContract("change-request", payload.request); validateActor(payload.actor); safeCounter(original.expected_revision, "expected_revision");
    rule(payload.details && row.digest === payload.digest && row.basisRevision === BigInt(original.expected_revision)
      && same(payload.cache_key, [payload.actor.id, payload.actor.role, original.idempotency_key])
      && payload.expires === payload.details.expires_at, "STORAGE_INTEGRITY", "Proposal metadata disagrees");
    const [originalCache] = await tx.$queryRaw<Array<{ requestDigest: string; request: string; response: string }>>`SELECT "requestDigest", "request"::text AS "request", "response"::text AS "response" FROM "TripStateIdempotency" WHERE "tripId"=${tripId} AND "actorId"=${payload.actor.id} AND "operationDomain"=${payload.actor.role} AND "key"=${original.idempotency_key}`;
    rule(originalCache && originalCache.requestDigest === digest(original) && same(decodeCommandJson(originalCache.request), original), "STORAGE_INTEGRITY", "Original submit cache is missing or changed");
    const shown = storageResponse(originalCache.response);
    rule(shown.outcome === "pending_confirmation" && shown.proposal_id === proposalId && shown.proposal_digest === row.digest
      && same(shown.diff, payload.details.diff), "STORAGE_INTEGRITY", "Displayed proposal cache disagrees");
    const pending: PendingProposal = { proposalId, request: original, actor: payload.actor, digest: row.digest, expires: payload.expires, details: payload.details };
    const plan = planConfirmation(before, pending, request, actor, host.clock, host.uuid);
    const updated = await tx.tripStateDocument.updateMany({ where: { tripId, revision: document.revision }, data: { revision: BigInt(plan.snapshot.revision), snapshot: json(plan.snapshot) } });
    requireStorage(updated.count === 1, "VERSION_CONFLICT", "Conditional update lost its expected revision");
    await appendHistory(tx, tripId, plan.intent, plan.change);
    await tx.tripStateIdempotency.create({ data: { tripId, actorId: actor.id, operationDomain: "confirmation", key: request.idempotency_key, requestDigest, request: json(request), response: json(plan.response) } });
    await tx.$queryRaw`SELECT public.finalize_trip_confirmation(${tripId},${proposalId},${JSON.stringify(plan.response)}::jsonb)`;
    return plan.response;
  }, { timeout: 15000, maxWait: 15000 });
}

async function commitPrepared(client: PrismaClient, envelope: {
  tripId: string; request: Request; key: RequestKey; materialize: (current: State) => SyntheticStorageBatch; guard?: (tx: Prisma.TransactionClient) => Promise<void>;
}, fault?: (point: StorageCheckpoint) => void | Promise<void>) {
    const request = parseContract(envelope.key.operationDomain === "confirmation" ? "confirm-request" : "change-request", envelope.request);
    requireStorage(request.idempotency_key === envelope.key.key && !!envelope.key.requestDigest, "STORAGE_INTEGRITY", "Request identity mismatch");
    safeCounter(request.expected_revision, "expected_revision");
    return client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ revision: bigint; snapshot: Prisma.JsonValue }>>`
        SELECT "revision", "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId" = ${envelope.tripId} FOR UPDATE`;
      const current = rows[0];
      requireStorage(!!current, "STORAGE_TRIP_NOT_FOUND", "Aggregate does not exist");
      await envelope.guard?.(tx);
      const identity = { tripId: envelope.tripId, actorId: envelope.key.actorId, operationDomain: envelope.key.operationDomain, key: envelope.key.key };
      const [previous] = await tx.$queryRaw<Array<{ requestDigest: string; request: string; response: string }>>`SELECT "requestDigest", "request"::text AS "request", "response"::text AS "response" FROM "TripStateIdempotency" WHERE "tripId" = ${identity.tripId} AND "actorId" = ${identity.actorId} AND "operationDomain" = ${identity.operationDomain} AND "key" = ${identity.key}`;
      // Replay precedes the revision check, as in the original Store. Compare body too, even for a claimed digest collision.
      if (previous) {
        requireStorage(previous.requestDigest === envelope.key.requestDigest && same(decodeCommandJson(previous.request), request), "IDEMPOTENCY_CONFLICT", "Same key has a different request");
        return { replayed: true, response: storageResponse(previous.response) };
      }
      requireStorage(current.revision === BigInt(request.expected_revision), "VERSION_CONFLICT", "Aggregate revision changed");
      const before = storageState(current.snapshot);
      requireStorage(BigInt(before.revision) === current.revision, "STORAGE_INTEGRITY", "Stored revision and JSONB disagree");
      const batch = envelope.materialize(structuredClone(before));
      requireStorage(batch.tripId === envelope.tripId && same(batch.request, request) && same(batch.key, envelope.key), "STORAGE_INTEGRITY", "Internal plan changed its transaction envelope");
      const after = parseStateReferences(batch.snapshot); checkStateCounters(after);
      const intent = parseContract("OperationIntent", batch.intent);
      const change = parseContract("ChangeRecord", batch.change);
      const response = storageResponse(batch.response);
      safeCounter(intent.base_revision, "intent base revision"); safeCounter(change.base_revision, "change base revision"); safeCounter(change.result_revision, "change result revision");
      requireStorage(after.trip_id === batch.tripId && intent.trip_id === batch.tripId && change.trip_id === batch.tripId
        && change.intent_id === intent.id && intent.base_revision === request.expected_revision
        && change.base_revision === request.expected_revision && change.result_revision === after.revision
        && response.revision === after.revision && change.outcome === response.outcome
        && change.proposal_id === response.proposal_id && change.request_digest === response.proposal_digest
        && change.effective_before === before.effective_skeleton_id && change.effective_after === after.effective_skeleton_id
        && same(change.diff, response.diff) && same(change.affected_ids, response.affected_ids),
      "STORAGE_INTEGRITY", "Snapshot, journal and response disagree");
      requireStorage(batch.key.operationDomain === "confirmation"
        ? change.confirmation_actor === batch.key.actorId
        : intent.actor_id === batch.key.actorId && intent.actor_role === batch.key.operationDomain,
      "STORAGE_INTEGRITY", "Journal actor and cache namespace disagree");
      if ("commands" in request) requireStorage(same(intent.input, request.input) && change.reason === request.reason
        && same(change.actions, request.commands.map((c) => c.op)), "STORAGE_INTEGRITY", "Journal does not describe its request");
      if (change.outcome !== "applied") {
        requireStorage(same(before, after), "STORAGE_INTEGRITY", "Pending/rejected journal cannot change authoritative state");
      } else {
        const oldObjects = new Map(before.objects.map((o) => [o.id, o]));
        const newObjects = new Map(after.objects.map((o) => [o.id, o]));
        const diff = [...new Set([...oldObjects.keys(), ...newObjects.keys()])].sort()
          .filter((id) => !same(oldObjects.get(id), newObjects.get(id)))
          .map((id) => ({ id, before: oldObjects.get(id) ?? null, after: newObjects.get(id) ?? null }));
        const changed = diff.length > 0 || before.effective_skeleton_id !== after.effective_skeleton_id;
        requireStorage(same(diff, change.diff) && after.revision === before.revision + (changed ? 1 : 0), "STORAGE_INTEGRITY", "Revision/diff is not the actual snapshot change");
      }
      requireStorage((change.outcome === "pending_confirmation") === !!batch.proposalExpiresAt, "STORAGE_INTEGRITY", "Pending journal requires exactly one proposal");
      const updated = await tx.tripStateDocument.updateMany({ where: { tripId: batch.tripId, revision: current.revision }, data: { revision: BigInt(after.revision), snapshot: json(after) } });
      requireStorage(updated.count === 1, "VERSION_CONFLICT", "Conditional update lost its expected revision");
      await fault?.("snapshot");
      await appendHistory(tx, batch.tripId, intent, change);
      await fault?.("history");
      if (batch.proposalExpiresAt) {
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
        const created = batch.proposalCreatedAt ?? clock.now;
        const expiry = batch.proposalDetails?.expires_at ?? stampTime(batch.proposalExpiresAt);
        requireStorage("commands" in request && !!change.proposal_id && !!change.request_digest
          && instantMicros(expiry) > BigInt(created.getTime()) * 1000n && instantMicros(expiry) <= BigInt(created.getTime()) * 1000n + 300000000n,
        "CONFIRMATION_EXPIRED", "Proposal must expire within five minutes of its trusted creation time");
        for (const object of before.objects) if (object.type === "ExternalFact") {
          const next = instantMicros(object.expires_at);
          requireStorage(next <= BigInt(created.getTime()) * 1000n || instantMicros(expiry) <= next, "CONFIRMATION_EXPIRED", "Proposal cannot outlive the next known fact expiry");
        }
        const payload = { request, actor: { role: intent.actor_role, id: intent.actor_id }, digest: change.request_digest,
          expires: expiry, cache_key: [batch.key.actorId, batch.key.operationDomain, batch.key.key],
          ...(batch.proposalDetails ? { details: batch.proposalDetails } : {}) };
        if (batch.proposalDetails) {
          // Preserve a dependency deadline's microseconds; JavaScript Date and Prisma timestamps retain only milliseconds.
          await tx.$executeRaw`INSERT INTO "TripStateProposal" ("tripId","proposalId","basisRevision","digest","payload","createdAt","expiresAt")
            VALUES (${batch.tripId},${change.proposal_id},${current.revision},${change.request_digest},${JSON.stringify(payload)}::jsonb,${created},${expiry}::timestamptz)`;
        } else {
          // Preserve the existing isolated synthetic harness and its Prisma error mapping.
          await tx.tripStateProposal.create({ data: { tripId: batch.tripId, proposalId: change.proposal_id, basisRevision: current.revision,
            digest: change.request_digest, payload: json(payload), createdAt: created, expiresAt: batch.proposalExpiresAt } });
        }
      }
      await fault?.("proposal");
      await tx.tripStateIdempotency.create({ data: { ...identity, requestDigest: batch.key.requestDigest, request: json(request), response: json(response) } });
      await fault?.("idempotency");
      await fault?.("before-commit");
      return { replayed: false, response };
    }, { timeout: 15000, maxWait: 15000 });
  }

/** This generic synthetic writer remains test-only; command service below has no batch-input API. */
export async function openSyntheticStorageHarness(connectionString: string, fault?: (point: StorageCheckpoint) => void | Promise<void>) {
  requireSyntheticEnvironment();
  const client = createClient(connectionString);
  try {
    await checkTripRuntime(client);
    const [identity] = await client.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    requireStorage(/^antu_e02_test_[a-z0-9_]+$/.test(identity.database),
      "STORAGE_IDENTITY", "Synthetic writes require an isolated test database and a non-owner, unprivileged runtime role");
  } catch (error) { await client.$disconnect(); throw error; }


  return {
    async seedSyntheticSnapshot(snapshot: unknown) {
      requireSyntheticEnvironment();
      const state = parseStateReferences(snapshot); checkStateCounters(state);
      await client.tripStateDocument.create({ data: { tripId: state.trip_id, revision: BigInt(state.revision), snapshot: json(state) } });
    },
    commitSyntheticBatch: async (batch: SyntheticStorageBatch) => {
      requireSyntheticEnvironment();
      return commitPrepared(client, { ...batch, materialize: () => batch }, fault);
    },
    close: () => client.$disconnect(),
  };
}

export type HostGrant = Readonly<{ tripId: string; actor: Actor }>;
export type CommandHost = {
  // A server-installed authentication + trip-authorization integration. Never take this callback from request data.
  authorize: (tripId: string, credential: unknown) => HostGrant | Promise<HostGrant>;
  // Optional for existing trusted internal hosts; installed mandatorily by the real session host.
  guard?: (tripId: string, credential: unknown, tx: Prisma.TransactionClient) => Promise<void>;
  clock?: () => Date;
  uuid?: () => string;
};

/** Internal command-only channel. No arbitrary snapshot, journal, Actor or patch is accepted from a caller. */
export async function openTripCommandService(connectionString: string, host: CommandHost) {
  rule(host && typeof host.authorize === "function", "ACTOR", "A trusted host authorization integration is required");
  const client = createClient(connectionString);
  try {
    await checkTripRuntime(client);
  } catch (error) { await client.$disconnect(); throw error; }
  async function authorize(tripId: string, credential: unknown): Promise<Actor> {
    const grant = await host.authorize(tripId, credential);
    rule(grant && grant.tripId === tripId, "ACTOR", "Host grant does not authorize this trip");
    validateActor(grant.actor);
    return Object.freeze({ ...grant.actor });
  }
  async function read<T>(tripId: string, credential: unknown, query: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!host.guard) return query(client);
    return client.$transaction(async (tx) => { await host.guard!(tripId, credential, tx); return query(tx); });
  }
  return {
    async createTrip(tripId: string, credential: unknown) {
      const actor = await authorize(tripId, credential);
      rule(actor.role === "system", "PERMISSION", "Only the trusted host system may initialize an empty trip");
      const state = validateStateSemantics({ schema_version: "0.1.0", trip_id: tripId, revision: 0, effective_skeleton_id: null, objects: [] });
      await client.tripStateDocument.create({ data: { tripId, revision: 0n, snapshot: json(state) } });
      return state;
    },
    async preview(tripId: string, input: unknown, credential: unknown) {
      const captured = typeof input === "string" ? decodeCommandJson(input) : structuredClone(input);
      const actor = await authorize(tripId, credential);
      return read(tripId, credential, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ snapshot: string }>>`SELECT "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId"=${tripId}`;
      requireStorage(!!row, "STORAGE_TRIP_NOT_FOUND", "Aggregate does not exist");
      const before = storageState(row.snapshot);
      try { return previewCommand(before, captured, actor, host.clock, host.uuid); }
      catch (error) { if (error instanceof TripStateContractError) return failureResponse(before, error); throw error; }
      });
    },
    async confirm(tripId: string, proposalId: string, input: unknown, credential: unknown) {
      const captured = typeof input === "string" ? decodeCommandJson(input) : structuredClone(input);
      const actor = await authorize(tripId, credential);
      try { return await confirmPrepared(client, tripId, proposalId, captured, actor, host, host.guard ? (tx) => host.guard!(tripId, credential, tx) : undefined); }
      catch (error) {
        const [row] = await client.$queryRaw<Array<{ snapshot: string }>>`SELECT "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId"=${tripId}`;
        requireStorage(!!row, "STORAGE_TRIP_NOT_FOUND", "Aggregate does not exist");
        const failure = error instanceof TripStateContractError || error instanceof StorageError
          ? new TripStateContractError(error.code, error.message) : new TripStateContractError("INTERNAL_FAILURE", "Confirmation storage failed; retry with the same idempotency key to recover its durable outcome");
        return failureResponse(storageState(row.snapshot), failure);
      }
    },
    async submit(tripId: string, input: unknown, credential: unknown) {
      const captured = typeof input === "string" ? decodeCommandJson(input) : structuredClone(input);
      const actor = await authorize(tripId, credential);
      const [row] = await client.$queryRaw<Array<{ snapshot: string }>>`SELECT "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId" = ${tripId}`;
      requireStorage(!!row, "STORAGE_TRIP_NOT_FOUND", "Aggregate does not exist");
      const before = storageState(row.snapshot);
      try {
        const request: CommandRequest = parseContract("change-request", captured);
        safeCounter(request.expected_revision, "expected_revision");
        const key = { actorId: actor.id, operationDomain: actor.role, key: request.idempotency_key, requestDigest: digest(request) };
        const result = await commitPrepared(client, { tripId, request, key, materialize: (current) => planCommand(current, request, actor, host.clock, host.uuid), guard: host.guard ? (tx) => host.guard!(tripId, credential, tx) : undefined });
        return result.response;
      } catch (error) {
        if (error instanceof TripStateContractError || error instanceof StorageError) {
          const [current] = await client.$queryRaw<Array<{ snapshot: string }>>`SELECT "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId" = ${tripId}`;
          return failureResponse(storageState(current?.snapshot ?? before), new TripStateContractError(error.code, error.message));
        }
        throw error; // Storage faults must roll back and remain observable; never claim they applied.
      }
    },
    async state(tripId: string, credential: unknown) {
      await authorize(tripId, credential);
      return read(tripId, credential, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ snapshot: string }>>`SELECT "snapshot"::text AS "snapshot" FROM "TripStateDocument" WHERE "tripId" = ${tripId}`;
      return row ? validateStateSemantics(storageState(row.snapshot)) : null;
      });
    },
    async history(tripId: string, credential: unknown) {
      await authorize(tripId, credential);
      return read(tripId, credential, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ intent: string; change: string }>>`SELECT "intent"::text AS "intent", "change"::text AS "change" FROM "TripStateHistory" WHERE "tripId" = ${tripId} ORDER BY "sequence"`;
      return storageHistory(rows);
      });
    },
    close: () => client.$disconnect(),
  };
}
