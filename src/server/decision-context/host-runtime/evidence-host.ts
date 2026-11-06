import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/prisma/client";
import { databaseEnvSchema } from "../../../lib/env";
import { openIdentity } from "../../auth/config";
import { sessionHost, userActorId } from "../../auth/authorization";
import { runtimeRoleSafetySql } from "../../database/runtime-role-safety.mjs";
import { EvidenceBoundaryError, type EventReceipt, type DeleteReceipt } from "../../interaction-evidence/contracts";
import { prepareEvidenceEvent } from "./evidence-event";

type Scope = { ownerId: string; sessionId: string; tripId: string; workspaceKey: string };
type RecordRow = { disposition: string; out_event_id: string | null; out_sequence: bigint | null; out_recorded_at: Date | null };
type DeleteRow = { disposition: string; deletion_revision: bigint | null; accepted_at: Date | null; cleanup_pending: boolean | null };
const deny = (): never => { throw new EvidenceBoundaryError("EVIDENCE_ACCESS_DENIED"); };
const unavailable = (): never => { throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE"); };
const counter = (n: bigint | null): number => {
  if (n === null || n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable();
  return Number(n);
};

/**
 * Internal test/integration service. No HTTP route or production enablement.
 * Workspaces are minted by this host, not supplied by the caller; opaque grants
 * expire with the process and are bound to the exact authenticated Session.
 */
export async function openEvidenceHost(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const connection = databaseEnvSchema.parse(env).DATABASE_URL;
  const url = new URL(connection);
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c timezone=UTC`.trim());
  const identity = await openIdentity(env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const [role] = await db.$queryRawUnsafe<Array<{ denied: boolean }>>(runtimeRoleSafetySql, null, "trip");
    const [evidenceRole] = await db.$queryRaw<Array<{ denied: boolean }>>`
      WITH principals AS (SELECT oid FROM pg_roles WHERE pg_has_role(current_user,oid,'USAGE') OR pg_has_role(current_user,oid,'SET')),
      evidence_tables AS (SELECT c.oid,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('HostEvidenceWorkspace','HostEvidenceEvent','HostEvidenceCleanup') AND c.relkind='r')
      SELECT (SELECT count(*) FROM evidence_tables) <> 3 OR EXISTS (
        SELECT 1 FROM evidence_tables c CROSS JOIN principals p WHERE c.relowner=p.oid
          OR has_table_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) AS denied`;
    if (!role || role.denied || !evidenceRole || evidenceRole.denied) throw new Error("Evidence host requires an isolated non-owner runtime role");
  } catch (error) { await Promise.all([db.$disconnect(), identity.close()]); throw error; }
  const host = sessionHost(identity), workspaces = new WeakMap<object, Scope>();
  let closed = false;
  async function principal(credential: Headers) {
    if (closed || !(credential instanceof Headers)) return deny();
    const headers = new Headers({ cookie: credential.get("cookie") ?? "" });
    const session = await identity.auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session || session.session.expiresAt.getTime() <= Date.now()) return deny();
    return { headers, ownerId: session.user.id, sessionId: session.session.id };
  }
  async function authorized(tripId: string, credential: Headers) {
    const current = await principal(credential);
    try {
      const actor = await host.authorize(tripId, current.headers);
      if (actor.actor.role !== "user" || actor.actor.id !== userActorId(current.ownerId)) return deny();
    } catch { return deny(); }
    return current;
  }
  async function scoped(ticket: object, credential: Headers) {
    const scope = ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
    if (!scope) return deny();
    const current = await authorized(scope.tripId, credential);
    if (current.ownerId !== scope.ownerId || current.sessionId !== scope.sessionId) return deny();
    return { scope, headers: current.headers };
  }
  return {
    async createWorkspace(tripId: string, credential: Headers): Promise<object> {
      const p = await authorized(tripId, credential);
      const scope: Scope = { ownerId: p.ownerId, sessionId: p.sessionId, tripId, workspaceKey: `work_${randomUUID()}` };
      try {
        await db.$transaction(async tx => {
          try { await host.guard!(tripId, p.headers, tx); } catch { return deny(); }
          const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT public.host_evidence_workspace_candidate(${p.sessionId},${p.ownerId},${tripId},${scope.workspaceKey}) AS ok`;
          if (!row?.ok) return deny();
        });
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); }
      const ticket = Object.freeze({}); workspaces.set(ticket, scope); return ticket;
    },
    async record(ticket: object, credential: Headers, value: unknown): Promise<EventReceipt> {
      const { scope, headers } = await scoped(ticket, credential);
      const event = prepareEvidenceEvent({ userId: scope.ownerId, sessionId: scope.sessionId }, scope.tripId, scope.workspaceKey, value, new Date());
      try {
        const row = await db.$transaction(async tx => {
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          const [result] = await tx.$queryRaw<RecordRow[]>`SELECT * FROM public.host_evidence_record_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${event.eventId},${event.input.entry},${event.input.text},${event.receivedAt},${event.input.idempotency_key},${event.inputDigest})`;
          if (!result || result.disposition === "denied") return deny();
          if (result.disposition === "deleted") throw new EvidenceBoundaryError("EVIDENCE_DELETED");
          if (result.disposition === "conflict") throw new EvidenceBoundaryError("EVENT_KEY_CONFLICT");
          if (!["inserted", "replayed"].includes(result.disposition) || !result.out_event_id || !result.out_recorded_at) return unavailable();
          counter(result.out_sequence);
          return result;
        });
        return { owner_id: scope.ownerId, trip_id: scope.tripId, workspace_key: scope.workspaceKey, event_id: row.out_event_id!, sequence: counter(row.out_sequence), recorded_at: row.out_recorded_at!.toISOString(), durable: true, replayed: row.disposition === "replayed" };
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; throw new EvidenceBoundaryError("EVENT_ACK_UNKNOWN"); }
    },
    async deleteEvent(ticket: object, credential: Headers, eventId: string): Promise<DeleteReceipt> {
      const { scope, headers } = await scoped(ticket, credential);
      if (typeof eventId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(eventId)) return unavailable();
      try {
        const row = await db.$transaction(async tx => {
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          const [result] = await tx.$queryRaw<DeleteRow[]>`SELECT * FROM public.host_evidence_delete_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${eventId})`;
          if (!result || result.disposition === "denied") return deny();
          if (result.disposition === "missing") throw new EvidenceBoundaryError("EVIDENCE_MISSING");
          if (result.disposition !== "deleted" || !result.accepted_at || result.cleanup_pending === null) return unavailable();
          counter(result.deletion_revision); return result;
        });
        return { owner_id: scope.ownerId, trip_id: scope.tripId, workspace_key: scope.workspaceKey, durable: true, deletion_revision: counter(row.deletion_revision), accepted_at: row.accepted_at!.toISOString(), cleanup_pending: row.cleanup_pending! };
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); }
    },
    async close() { if (closed) return; closed = true; await Promise.all([db.$disconnect(), identity.close()]); },
  };
}
