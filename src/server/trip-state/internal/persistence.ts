import { isDeepStrictEqual } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../../../generated/prisma/client";
import { parseContract } from "../contracts";
import { parseStateReferences } from "../references";
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

function createClient(connectionString: string) {
  // Prisma 7's timestamp adapter requires a UTC session to preserve instants from non-UTC servers.
  const url = new URL(connectionString);
  url.searchParams.set("options", "-c timezone=UTC");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
}

function requireSyntheticEnvironment() {
  requireStorage(process.env.NODE_ENV === "test", "STORAGE_WRITE_DISABLED", "Business writes require a future trusted command/authorization/semantic guard");
}

// Read-only storage API. The host must authorize trip access before calling it.
export function openTripStateReader(connectionString: string) {
  const client = createClient(connectionString);
  return {
    async state(tripId: string) {
      const row = await client.tripStateDocument.findUnique({ where: { tripId } });
      return row ? parseContract("state", row.snapshot) : null;
    },
    async history(tripId: string) {
      const rows = await client.tripStateHistory.findMany({ where: { tripId }, orderBy: { sequence: "asc" } });
      return parseContract("history", { intents: rows.map((r) => r.intent), changes: rows.map((r) => r.change) });
    },
    async idempotency(tripId: string, key: Omit<RequestKey, "requestDigest">) {
      const row = await client.tripStateIdempotency.findUnique({ where: { tripId_actorId_operationDomain_key: { tripId, ...key } } });
      return row ? { requestDigest: row.requestDigest, request: row.request, response: parseContract("response", row.response) } : null;
    },
    async pending(tripId: string, proposalId: string) {
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

/** No production writer is exported. Only an ephemeral, non-owner test identity can enter here. */
export async function openSyntheticStorageHarness(connectionString: string, fault?: (point: StorageCheckpoint) => void | Promise<void>) {
  requireSyntheticEnvironment();
  const client = createClient(connectionString);
  try {
    const [identity] = await client.$queryRaw<Array<{ database: string; privileged: boolean; owns: boolean }>>`
      SELECT current_database() AS "database",
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS "privileged",
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relname IN ('TripStateDocument','TripStateHistory','TripStateProposal','TripStateIdempotency')
          AND pg_has_role(current_user, c.relowner, 'USAGE')) AS "owns"
      FROM pg_roles r WHERE r.rolname = current_user`;
    requireStorage(/^antu_e02_test_[a-z0-9_]+$/.test(identity.database) && !identity.privileged && !identity.owns,
      "STORAGE_IDENTITY", "Synthetic writes require an isolated test database and a non-owner, unprivileged runtime role");
  } catch (error) { await client.$disconnect(); throw error; }

  async function commit(batch: SyntheticStorageBatch) {
    requireSyntheticEnvironment();
    const request = parseContract(batch.key.operationDomain === "confirmation" ? "confirm-request" : "change-request", batch.request);
    requireStorage(request.idempotency_key === batch.key.key && !!batch.key.requestDigest, "STORAGE_INTEGRITY", "Request identity mismatch");
    return client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ revision: bigint; snapshot: Prisma.JsonValue }>>`
        SELECT "revision", "snapshot" FROM "TripStateDocument" WHERE "tripId" = ${batch.tripId} FOR UPDATE`;
      const current = rows[0];
      requireStorage(!!current, "STORAGE_TRIP_NOT_FOUND", "Aggregate does not exist");
      const identity = { tripId: batch.tripId, actorId: batch.key.actorId, operationDomain: batch.key.operationDomain, key: batch.key.key };
      const previous = await tx.tripStateIdempotency.findUnique({ where: { tripId_actorId_operationDomain_key: identity } });
      // Replay precedes the revision check, as in the original Store. Compare body too, even for a claimed digest collision.
      if (previous) {
        requireStorage(previous.requestDigest === batch.key.requestDigest && same(previous.request, request), "IDEMPOTENCY_CONFLICT", "Same key has a different request");
        return { replayed: true, response: parseContract("response", previous.response) };
      }
      requireStorage(current.revision === BigInt(request.expected_revision), "VERSION_CONFLICT", "Aggregate revision changed");
      const before = parseContract("state", current.snapshot);
      const after = parseStateReferences(batch.snapshot);
      const intent = parseContract("OperationIntent", batch.intent);
      const change = parseContract("ChangeRecord", batch.change);
      const response = parseContract("response", batch.response);
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
      const last = await tx.tripStateHistory.findFirst({ where: { tripId: batch.tripId }, orderBy: { sequence: "desc" } });
      await tx.tripStateHistory.create({ data: { tripId: batch.tripId, sequence: (last?.sequence ?? 0n) + 1n, intentId: intent.id, changeRecordId: change.id, intent: json(intent), change: json(change) } });
      await fault?.("history");
      if (batch.proposalExpiresAt) {
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
        const expiry = batch.proposalExpiresAt.getTime();
        requireStorage("commands" in request && !!change.proposal_id && !!change.request_digest
          && expiry > clock.now.getTime() && expiry <= clock.now.getTime() + 300000,
        "CONFIRMATION_EXPIRED", "Proposal must expire within five minutes of database time");
        for (const object of before.objects) if (object.type === "ExternalFact") {
          const nextExpiry = Date.parse(object.expires_at);
          requireStorage(nextExpiry <= clock.now.getTime() || expiry <= nextExpiry, "CONFIRMATION_EXPIRED", "Proposal cannot outlive the next known fact expiry");
        }
        await tx.tripStateProposal.create({ data: {
          tripId: batch.tripId, proposalId: change.proposal_id, basisRevision: current.revision,
          digest: change.request_digest, expiresAt: batch.proposalExpiresAt,
          payload: json({ request, actor: { role: intent.actor_role, id: intent.actor_id }, digest: change.request_digest,
            expires: batch.proposalExpiresAt.toISOString(), cache_key: [batch.key.actorId, batch.key.operationDomain, batch.key.key] }),
        } });
      }
      await fault?.("proposal");
      await tx.tripStateIdempotency.create({ data: { ...identity, requestDigest: batch.key.requestDigest, request: json(request), response: json(response) } });
      await fault?.("idempotency");
      await fault?.("before-commit");
      return { replayed: false, response };
    }, { timeout: 15000, maxWait: 15000 });
  }
  return {
    async seedSyntheticSnapshot(snapshot: unknown) {
      requireSyntheticEnvironment();
      const state = parseStateReferences(snapshot);
      await client.tripStateDocument.create({ data: { tripId: state.trip_id, revision: BigInt(state.revision), snapshot: json(state) } });
    },
    commitSyntheticBatch: commit,
    close: () => client.$disconnect(),
  };
}
