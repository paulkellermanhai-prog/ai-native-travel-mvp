import { createHmac, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "../../../generated/prisma/client";
import { databaseEnvSchema } from "../../../lib/env";
import { openIdentity } from "../../auth/config";
import { sessionHost, userActorId } from "../../auth/authorization";
import { runtimeRoleSafetySql } from "../../database/runtime-role-safety.mjs";
import { EvidenceBoundaryError, type EventReceipt, type DeleteReceipt } from "../../interaction-evidence/contracts";
import { evidenceKeyToken, prepareEvidenceEvent } from "./evidence-event";
import { parseAndCheckTaskCore, type TaskCorePrior } from "../task-core/validate";
import { parseDCContract } from "../contracts";
import { canonicalJson, decodeCommandJson } from "../../trip-state/command-json";
import { parseStateReferences } from "../../trip-state/references";
import { checkStateCounters } from "../../trip-state/numbers";

type Registration = { turn_id: string; revision: number; task_keys: string[]; focus_keys: string[] };
type TaskMemory = Omit<TaskCorePrior,"task_key"> & { sources: Map<string,string>; incomplete: boolean };
type Scope = { ownerId: string; sessionId: string; tripId: string; workspaceKey: string;
  tasks: Map<string, TaskMemory>;
  turns: Map<string, { digest: string; result: Pick<Registration,"turn_id"|"revision">; sources: Map<string,string> }>;
  invalidTurns: Set<string>; receipts: Map<string,Set<object>>; replayReceipts: Map<string,EventReceipt>; disposed: boolean; tail: Promise<void> };
type RecordRow = { disposition: string; out_event_id: string | null; out_sequence: bigint | null; out_recorded_at: Date | null };
type DeleteRow = { disposition: string; deletion_revision: bigint | null; accepted_at: Date | null; cleanup_pending: boolean | null };
type EventRow = { allowed: boolean; out_entry: "dialogue" | "map" | "timeline" | "comparison" | null; out_body: string | null; out_received_at: Date | null };
const identityInput = z.strictObject({ expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tasks: z.unknown(), focus_keys: z.unknown() });
export class TurnIdentityError extends Error {
  constructor(readonly code: "EVENT_REUSE" | "REVISION_CHANGED" | "TARGET_NOT_FOUND") { super(`Turn identity: ${code}`); this.name = "TurnIdentityError"; }
}
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
  const keySecret = env.E11_IDEMPOTENCY_SECRET;
  if (typeof keySecret !== "string" || Buffer.byteLength(keySecret, "utf8") < 32) return unavailable();
  const url = new URL(connection);
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c timezone=UTC`.trim());
  const identity = await openIdentity(env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const [role] = await db.$queryRawUnsafe<Array<{ denied: boolean }>>(runtimeRoleSafetySql, null, "trip");
    const [evidenceRole] = await db.$queryRaw<Array<{ denied: boolean }>>`
      WITH principals AS (SELECT oid FROM pg_roles WHERE pg_has_role(current_user,oid,'USAGE') OR pg_has_role(current_user,oid,'SET')),
      evidence_tables AS (SELECT c.oid,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('HostEvidenceWorkspace','HostEvidenceEvent','HostEvidenceCleanup','HostEvidenceTripLifecycle') AND c.relkind='r')
      SELECT (SELECT count(*) FROM evidence_tables) <> 4 OR EXISTS (
        SELECT 1 FROM evidence_tables c CROSS JOIN principals p WHERE c.relowner=p.oid
          OR has_table_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) AS denied`;
    if (!role || role.denied || !evidenceRole || evidenceRole.denied) throw new Error("Evidence host requires an isolated non-owner runtime role");
  } catch (error) { await Promise.all([db.$disconnect(), identity.close()]); throw error; }
  const host = sessionHost(identity), workspaces = new WeakMap<object, Scope>(), eventProofs = new WeakMap<object, { scope: Scope; eventId: string; token: string }>();
  const activeScopes = new Set<Scope>();
  const runtimeId = `runtime_${randomUUID()}`;
  let closed = false;
  // Task keys may contain user text; retain only a keyed, scope-bound index.
  const taskIndex = (scope: Scope, key: string) => createHmac("sha256",keySecret).update("task-identity\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,key]),"utf8").digest("hex");
  async function exclusive<T>(scope: Scope, action: () => Promise<T>): Promise<T> {
    const previous = scope.tail; let release!: () => void;
    scope.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { if (closed || scope.disposed) return deny(); return await action(); } finally { release(); }
  }
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
      const scope: Scope = { ownerId: p.ownerId, sessionId: p.sessionId, tripId, workspaceKey: `work_${randomUUID()}`, tasks: new Map(), turns: new Map(), invalidTurns: new Set(), receipts: new Map(), replayReceipts: new Map(), disposed:false, tail: Promise.resolve() };
      try {
        await db.$transaction(async tx => {
          try { await host.guard!(tripId, p.headers, tx); } catch { return deny(); }
          const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT public.host_evidence_workspace_candidate(${p.sessionId},${p.ownerId},${tripId},${scope.workspaceKey}) AS ok`;
          if (!row?.ok) return deny();
        });
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); }
      if (closed) return deny();
      const ticket = Object.freeze({}); workspaces.set(ticket, scope); activeScopes.add(scope); return ticket;
    },
    async record(ticket: object, credential: Headers, value: unknown): Promise<EventReceipt> {
      const { scope, headers } = await scoped(ticket, credential);
      const event = prepareEvidenceEvent({ userId: scope.ownerId, sessionId: scope.sessionId }, scope.tripId, scope.workspaceKey, value, new Date());
      const keyToken = evidenceKeyToken(keySecret, scope, event.input.idempotency_key);
      return exclusive(scope, async () => { try {
        const row = await db.$transaction(async tx => {
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          const [result] = await tx.$queryRaw<RecordRow[]>`SELECT * FROM public.host_evidence_record_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${event.eventId},${event.input.entry},${event.input.text},${event.receivedAt},${keyToken},${event.inputDigest})`;
          if (!result || result.disposition === "denied") return deny();
          if (result.disposition === "deleted") throw new EvidenceBoundaryError("EVIDENCE_DELETED");
          if (result.disposition === "conflict") throw new EvidenceBoundaryError("EVENT_KEY_CONFLICT");
          if (!["inserted", "replayed"].includes(result.disposition) || !result.out_event_id || !result.out_recorded_at) return unavailable();
          counter(result.out_sequence);
          return result;
        });
        if (closed) throw new EvidenceBoundaryError("EVENT_ACK_UNKNOWN");
        const cached = row.disposition === "replayed" ? scope.replayReceipts.get(row.out_event_id!) : undefined;
        if (cached) return cached;
        const receipt: EventReceipt = Object.freeze({ owner_id: scope.ownerId, trip_id: scope.tripId, workspace_key: scope.workspaceKey, event_id: row.out_event_id!, sequence: counter(row.out_sequence), recorded_at: row.out_recorded_at!.toISOString(), durable: true, replayed: row.disposition === "replayed" });
        if (receipt.replayed) scope.replayReceipts.set(receipt.event_id,receipt);
        eventProofs.set(receipt,{scope,eventId:receipt.event_id,token:keyToken});
        const receipts=scope.receipts.get(receipt.event_id) ?? new Set<object>(); receipts.add(receipt); scope.receipts.set(receipt.event_id,receipts);
        return receipt;
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; throw new EvidenceBoundaryError("EVENT_ACK_UNKNOWN"); } });
    },
    async deleteEvent(ticket: object, credential: Headers, eventId: string): Promise<DeleteReceipt> {
      const { scope, headers } = await scoped(ticket, credential);
      if (typeof eventId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(eventId)) return unavailable();
      return exclusive(scope, async () => { try {
        const row = await db.$transaction(async tx => {
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          const [result] = await tx.$queryRaw<DeleteRow[]>`SELECT * FROM public.host_evidence_delete_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${eventId})`;
          if (!result || result.disposition === "denied") return deny();
          if (result.disposition === "missing") throw new EvidenceBoundaryError("EVIDENCE_MISSING");
          if (result.disposition !== "deleted" || !result.accepted_at || result.cleanup_pending === null) return unavailable();
          counter(result.deletion_revision); return result;
        });
        for (const receipt of scope.receipts.get(eventId) ?? []) eventProofs.delete(receipt);
        scope.receipts.delete(eventId);
        scope.replayReceipts.delete(eventId);
        for (const task of scope.tasks.values()) if (task.sources.delete(eventId)) task.incomplete=true;
        for (const [id,turn] of scope.turns) if (turn.sources.has(eventId)) { scope.turns.delete(id); scope.invalidTurns.add(id); }
        return { owner_id: scope.ownerId, trip_id: scope.tripId, workspace_key: scope.workspaceKey, durable: true, deletion_revision: counter(row.deletion_revision), accepted_at: row.accepted_at!.toISOString(), cleanup_pending: row.cleanup_pending! };
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); } });
    },
    /** Internal, process-local identity registration only; no Packet, association or checkpoint is created. */
    async registerTaskIdentity(ticket: object, credential: Headers, receipt: EventReceipt, raw: unknown): Promise<Registration & { runtime_id: string }> {
      const { scope, headers } = await scoped(ticket, credential);
      const proof = receipt && typeof receipt === "object" ? eventProofs.get(receipt) : undefined;
      if (!proof || proof.scope !== scope) return deny();
      const parsed = identityInput.safeParse(raw); if (!parsed.success) return unavailable();
      return exclusive(scope, async () => {
        if (closed || scope.invalidTurns.has(proof.eventId)) return unavailable();
        const result = await db.$transaction(async tx => {
          const [document] = await tx.$queryRaw<Array<{ revision: bigint; snapshot: string }>>`SELECT "revision", "snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          if (!document) return deny();
          const event = async (id: string, token: string, metadata: boolean) => {
            const [row] = await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${id},${token},${metadata})`;
            if (!row?.allowed) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE"); return row;
          };
          const source = await event(proof.eventId, proof.token, false);
          if (!source.out_entry || !source.out_body || !source.out_received_at) return unavailable();
          const state = parseStateReferences(decodeCommandJson(document.snapshot)); checkStateCounters(state);
          if (state.trip_id !== scope.tripId || BigInt(state.revision) !== document.revision) throw new TurnIdentityError("REVISION_CHANGED");
          const body = { runtime_contract_version: "0.1.0", trip_id: scope.tripId, expected_revision: parsed.data.expected_revision,
            event: { event_id: proof.eventId, entry: source.out_entry, text: source.out_body, reference: `host-interaction:${proof.eventId}`, received_at: source.out_received_at.toISOString() },
            tasks: parsed.data.tasks, focus_keys: parsed.data.focus_keys };
          const shaped = parseDCContract("open-turn",body);
          const fingerprint = createHmac("sha256",keySecret).update(canonicalJson(body),"utf8").digest("hex");
          const priorResult = scope.turns.get(proof.eventId);
          if (priorResult) {
            for (const [id,token] of priorResult.sources) await event(id,token,true);
            if (priorResult.digest !== fingerprint) throw new TurnIdentityError("EVENT_REUSE");
            return { replay: {...priorResult.result, task_keys:shaped.tasks.map(task=>task.task_key), focus_keys:[...shaped.focus_keys]}, body: null, fingerprint };
          }
          const dependencies = new Set<string>();
          for (const task of shaped.tasks) {
            if (scope.tasks.has(taskIndex(scope,task.task_key))) dependencies.add(task.task_key);
            for (const key of task.related_task_keys) if (scope.tasks.has(taskIndex(scope,key))) dependencies.add(key);
          }
          const priorSources = new Map<string,string>();
          const priorTasks: TaskCorePrior[] = [];
          for (const key of dependencies) {
            const prior=scope.tasks.get(taskIndex(scope,key))!; if (prior.incomplete) return unavailable();
            for (const [id,token] of prior.sources) priorSources.set(id,token);
            priorTasks.push({task_key:key,kind:prior.kind,branch:prior.branch,progress:prior.progress});
          }
          for (const [id,token] of priorSources) await event(id,token,true);
          if (state.revision !== parsed.data.expected_revision) throw new TurnIdentityError("REVISION_CHANGED");
          const checked = parseAndCheckTaskCore(shaped,priorTasks,Date.now());
          const ids = new Set(state.objects.map(item => item.id));
          if (checked.tasks.some(task => task.target_ids.some(id => !ids.has(id)))) throw new TurnIdentityError("TARGET_NOT_FOUND");
          return { replay: null, body: checked, fingerprint };
        });
        if (closed) return unavailable();
        if (result.replay) return { ...structuredClone(result.replay), runtime_id: runtimeId };
        const checked = result.body!;
        const registration: Registration = { turn_id:`turn_${randomUUID()}`, revision:checked.expected_revision, task_keys:checked.tasks.map(task => task.task_key), focus_keys:[...checked.focus_keys] };
        const sources = new Map<string,string>([[proof.eventId,proof.token]]);
        for (const task of checked.tasks) {
          const taskSources = new Map<string,string>([[proof.eventId,proof.token]]);
          const dependencies = [scope.tasks.get(taskIndex(scope,task.task_key)),...task.related_task_keys.map(key=>scope.tasks.get(taskIndex(scope,key)))];
          for (const prior of dependencies) if (prior) for (const [id,token] of prior.sources) taskSources.set(id,token);
          for (const [id,token] of taskSources) sources.set(id,token);
          scope.tasks.set(taskIndex(scope,task.task_key),{ kind:task.kind, branch:task.branch, progress:task.progress, sources:taskSources, incomplete:false });
        }
        scope.turns.set(proof.eventId,{ digest:result.fingerprint, result:{turn_id:registration.turn_id,revision:registration.revision}, sources });
        return { ...registration, runtime_id: runtimeId };
      });
    },
    /** Releases only process-local capabilities; it does not delete persisted evidence. */
    async disposeWorkspace(ticket: object) {
      const scope = ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
      if (!scope) return;
      await exclusive(scope,async()=> {
        scope.disposed=true;
        for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
        scope.receipts.clear(); scope.replayReceipts.clear(); scope.tasks.clear(); scope.turns.clear(); scope.invalidTurns.clear();
        workspaces.delete(ticket); activeScopes.delete(scope);
      });
    },
    async close() {
      if (closed) return; closed = true;
      for (const scope of activeScopes) {
        scope.disposed=true;
        for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
        scope.receipts.clear(); scope.replayReceipts.clear(); scope.tasks.clear(); scope.turns.clear(); scope.invalidTurns.clear();
      }
      activeScopes.clear(); await Promise.all([db.$disconnect(), identity.close()]);
    },
  };
}
