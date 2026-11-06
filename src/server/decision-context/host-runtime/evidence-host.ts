import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
import { canonicalJson, decodeCommandJson, digest } from "../../trip-state/command-json";
import { CheckpointError, checkpointDigest, validateCheckpoint } from "../checkpoint-core";
import type { CheckpointPayload } from "../contracts.generated";
import { classifyRecovery } from "../recovery-core";
import { buildRestoredSceneCandidate } from "../integration/restored-scene-candidate";
import { parseStateReferences } from "../../trip-state/references";
import { checkStateCounters } from "../../trip-state/numbers";

type Registration = { turn_id: string; revision: number; task_keys: string[]; focus_keys: string[] };
type TaskMemory = Omit<TaskCorePrior,"task_key"> & { sources: Map<string,string>; incomplete: boolean; fingerprint: string; eventSequence: number; retentionRevision: number };
type Scope = { ownerId: string; sessionId: string; tripId: string; workspaceKey: string; capability: string; runtimeId: string;
  recoveredEvents: Set<string>; recoveryWatermark: number | null; deletionRevision: number; pendingSaves: Set<string>; pendingSaveSticky: boolean; inflightSaves: number; keyEpochs: Map<string,number>; tasks: Map<string, TaskMemory>;
  turns: Map<string, { digest: string; result: Pick<Registration,"turn_id"|"revision">; sources: Map<string,string>; sequence: number }>;
  invalidTurns: Set<string>; receipts: Map<string,Set<object>>; replayReceipts: Map<string,EventReceipt>; disposed: boolean; tail: Promise<void> };
type RecordRow = { disposition: string; out_event_id: string | null; out_sequence: bigint | null; out_recorded_at: Date | null };
type DeleteRow = { disposition: string; deletion_revision: bigint | null; accepted_at: Date | null; cleanup_pending: boolean | null; event_highwater: bigint | null };
type EventRow = { allowed: boolean; out_entry: "dialogue" | "map" | "timeline" | "comparison" | null; out_body: string | null; out_received_at: Date | null; out_retention_revision: bigint | null };
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
export async function openEvidenceHost(env: Partial<NodeJS.ProcessEnv> = process.env, testHooks?: { beforeRestoreRecheck?: () => Promise<void>; afterRestoreCommit?: () => Promise<void>; afterMintCommit?: () => Promise<void>; afterCandidateBeforeRecheck?: () => Promise<void>; onCandidatePacketWarnings?: (warnings: readonly string[]) => void; onSaveQueued?: () => void }) {
  if (testHooks && process.env.NODE_ENV !== "test") return unavailable();
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
        WHERE n.nspname='public' AND c.relname IN ('HostEvidenceWorkspace','HostEvidenceEvent','HostEvidenceCleanup','HostEvidenceTripLifecycle','HostEvidenceTaskSource','HostEvidenceScene','HostEvidenceTaskKey') AND c.relkind='r')
      SELECT (SELECT count(*) FROM evidence_tables) <> 7 OR EXISTS (
        SELECT 1 FROM evidence_tables c CROSS JOIN principals p WHERE c.relowner=p.oid
          OR has_table_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) OR EXISTS (
        SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace CROSS JOIN principals p
        WHERE n.nspname='public' AND f.proname IN ('host_evidence_delete_candidate','host_evidence_cleanup_candidate')
          AND (f.proowner=p.oid OR has_function_privilege(p.oid,f.oid,'EXECUTE'))) AS denied`;
    // Checkpoint primitives are not E11-safe yet, including their Session
    // wrappers. Do not start this host under a role that can bypass the E11
    // boundary through a direct grant, ownership or an inherited/SET role.
    const [checkpointRole] = await db.$queryRaw<Array<{ denied: boolean }>>`
      WITH principals AS (SELECT oid FROM pg_roles WHERE pg_has_role(current_user,oid,'USAGE') OR pg_has_role(current_user,oid,'SET')),
      ns AS (SELECT oid,nspowner FROM pg_namespace WHERE nspname='e03_checkpoint')
      SELECT EXISTS (SELECT 1 FROM ns CROSS JOIN principals p WHERE ns.nspowner=p.oid OR has_schema_privilege(p.oid,ns.oid,'CREATE'))
        OR EXISTS (SELECT 1 FROM pg_class c JOIN ns ON c.relnamespace=ns.oid CROSS JOIN principals p
          WHERE c.relkind IN ('r','p') AND (c.relowner=p.oid OR has_table_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        OR EXISTS (SELECT 1 FROM pg_proc f JOIN ns ON f.pronamespace=ns.oid CROSS JOIN principals p
          WHERE f.proowner=p.oid OR has_function_privilege(p.oid,f.oid,'EXECUTE')) AS denied`;
    if (!role || role.denied || !evidenceRole || evidenceRole.denied || !checkpointRole || checkpointRole.denied)
      throw new Error("Evidence host requires an isolated non-owner runtime role without checkpoint access");
  } catch (error) { await Promise.all([db.$disconnect(), identity.close()]); throw error; }
  const host = sessionHost(identity), workspaces = new WeakMap<object, Scope>(), eventProofs = new WeakMap<object, { scope: Scope; eventId: string; token: string }>();
  const activeScopes = new Set<Scope>();
  let closed = false;
  // Task keys may contain user text; retain only a keyed, scope-bound index.
  const taskIndex = (scope: Scope, key: string) => createHmac("sha256",keySecret).update("task-identity\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,key]),"utf8").digest("hex");
  const taskFingerprint = (scope: Scope, task: unknown) => createHmac("sha256",keySecret).update("task-value\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,task]),"utf8").digest("hex");
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
      const scope: Scope = { ownerId: p.ownerId, sessionId: p.sessionId, tripId, workspaceKey: `work_${randomUUID()}`, capability: randomBytes(32).toString("hex"), runtimeId: `runtime-${randomUUID().replaceAll("-","")}`, recoveredEvents:new Set(), recoveryWatermark:null, deletionRevision:0, pendingSaves:new Set(), pendingSaveSticky:false, inflightSaves:0, keyEpochs:new Map(), tasks: new Map(), turns: new Map(), invalidTurns: new Set(), receipts: new Map(), replayReceipts: new Map(), disposed:false, tail: Promise.resolve() };
      try {
        await db.$transaction(async tx => {
          try { await host.guard!(tripId, p.headers, tx); } catch { return deny(); }
          const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT public.host_evidence_workspace_candidate(${p.sessionId},${p.ownerId},${tripId},${scope.workspaceKey},${scope.capability}) AS ok`;
          if (!row?.ok) return deny();
        });
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); }
      if (closed) return deny();
      const ticket = Object.freeze({}); workspaces.set(ticket, scope); activeScopes.add(scope); return ticket;
    },
    /** Internal opaque Task identifier; caller-supplied labels are not proof. */
    async mintTaskKey(ticket: object, credential: Headers, operationKey: string): Promise<string> {
      if (typeof operationKey!=="string" || !operationKey || operationKey.length>256) return unavailable();
      const start=ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
      const runtime=start?.runtimeId, retention=start?.deletionRevision;
      const {scope,headers}=await scoped(ticket,credential);
      if (scope!==start) return deny();
      return exclusive(scope,async()=> {
        if (scope.runtimeId!==runtime || scope.deletionRevision!==retention) return unavailable();
        const logicalKey=createHmac("sha256",keySecret).update("task-key-logical\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,operationKey]),"utf8").digest("hex");
        const previousEpoch=scope.keyEpochs.get(logicalKey);
        if (previousEpoch!==undefined && previousEpoch!==scope.deletionRevision) return unavailable();
        if (previousEpoch===undefined && scope.keyEpochs.size>=256) return unavailable();
        scope.keyEpochs.set(logicalKey,scope.deletionRevision);
        const token=createHmac("sha256",keySecret).update("task-key-request\0").update(canonicalJson([logicalKey,scope.deletionRevision]),"utf8").digest("hex");
        try {
          const key=await db.$transaction(async tx=> {
            try { await host.guard!(scope.tripId,headers,tx); } catch { return deny(); }
            const [row]=await tx.$queryRaw<Array<{key:string|null}>>`SELECT public.host_evidence_mint_task_key_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${BigInt(scope.deletionRevision)},${token}) AS key`;
            if (!row?.key || !/^task-[0-9a-f]{32}$/.test(row.key)) return unavailable();
            return row.key;
          });
          await testHooks?.afterMintCommit?.();
          if (closed || scope.disposed) return deny();
          return key;
        } catch(error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); }
      });
    },
    async record(ticket: object, credential: Headers, value: unknown): Promise<EventReceipt> {
      const startingScope = ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
      const startingRuntime = startingScope?.runtimeId, startingRetention=startingScope?.deletionRevision, receivedAt=new Date();
      let snapshot: unknown; try { snapshot=structuredClone(value); } catch { return unavailable(); }
      const { scope, headers } = await scoped(ticket, credential);
      if (scope!==startingScope) return deny();
      const event = prepareEvidenceEvent({ userId: scope.ownerId, sessionId: scope.sessionId }, scope.tripId, scope.workspaceKey, snapshot, receivedAt);
      const keyToken = evidenceKeyToken(keySecret, scope, event.input.idempotency_key);
      return exclusive(scope, async () => { if (scope.runtimeId!==startingRuntime || scope.deletionRevision!==startingRetention) return unavailable(); try {
        const row = await db.$transaction(async tx => {
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          const [result] = await tx.$queryRaw<RecordRow[]>`SELECT * FROM public.host_evidence_record_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${BigInt(scope.deletionRevision)},${event.eventId},${event.input.entry},${event.input.text},${event.receivedAt},${keyToken},${event.inputDigest})`;
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
          await tx.$queryRaw`SELECT 1 FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          const [result] = await tx.$queryRaw<DeleteRow[]>`SELECT * FROM public.host_checkpoint_delete_event_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${eventId})`;
          if (!result || result.disposition === "denied") return deny();
          if (result.disposition === "missing") throw new EvidenceBoundaryError("EVIDENCE_MISSING");
          if (result.disposition !== "deleted" || !result.accepted_at || result.cleanup_pending === null) return unavailable();
          counter(result.deletion_revision); counter(result.event_highwater); return result;
        });
        // The first deletion's persisted cutoff is replayed unchanged. It
        // invalidates pre-cutoff state, never later independent work.
        const cutoff=counter(row.event_highwater), revision=counter(row.deletion_revision);
        if (revision>scope.deletionRevision) {
          scope.runtimeId=`runtime-${randomUUID().replaceAll("-","")}`;
          scope.pendingSaves.clear(); scope.pendingSaveSticky=false;
        }
        for (const [id,receipts] of scope.receipts) {
          for (const receipt of receipts) {
            const proof=eventProofs.get(receipt);
            if (proof && (receipt as EventReceipt).sequence<=cutoff) { eventProofs.delete(receipt); receipts.delete(receipt); }
          }
          if (!receipts.size) scope.receipts.delete(id);
        }
        for (const [id,receipt] of scope.replayReceipts) if (receipt.sequence<=cutoff) scope.replayReceipts.delete(id);
        for (const task of scope.tasks.values()) if (task.eventSequence<=cutoff) { task.sources.clear(); task.incomplete=true; }
        for (const [id,turn] of scope.turns) if (turn.sequence<=cutoff) { scope.turns.delete(id); scope.invalidTurns.add(id); }
        scope.recoveryWatermark=Math.max(scope.recoveryWatermark ?? 0,cutoff);
        scope.deletionRevision=Math.max(scope.deletionRevision,revision);
        return { owner_id: scope.ownerId, trip_id: scope.tripId, workspace_key: scope.workspaceKey, durable: true, deletion_revision: counter(row.deletion_revision), accepted_at: row.accepted_at!.toISOString(), cleanup_pending: row.cleanup_pending! };
      } catch (error) { if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); } });
    },
    /** Internal, process-local identity registration only; no Packet, association or checkpoint is created. */
    async registerTaskIdentity(ticket: object, credential: Headers, receipt: EventReceipt, raw: unknown): Promise<Registration & { runtime_id: string }> {
      let snapshot: unknown; try { snapshot=structuredClone(raw); } catch { return unavailable(); }
      const { scope, headers } = await scoped(ticket, credential);
      const proof = receipt && typeof receipt === "object" ? eventProofs.get(receipt) : undefined;
      if (!proof || proof.scope !== scope) return deny();
      const parsed = identityInput.safeParse(snapshot); if (!parsed.success) return unavailable();
      return exclusive(scope, async () => {
        if (eventProofs.get(receipt) !== proof) return deny();
        if (scope.recoveredEvents.has(proof.eventId) || (scope.recoveryWatermark!==null && receipt.sequence<=scope.recoveryWatermark))
          throw new CheckpointError("RECOVERED_EVENT_REPLAY");
        if (closed || scope.invalidTurns.has(proof.eventId)) return unavailable();
        const result = await db.$transaction(async tx => {
          const [document] = await tx.$queryRaw<Array<{ revision: bigint; snapshot: string }>>`SELECT "revision", "snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
          try { await host.guard!(scope.tripId, headers, tx); } catch { return deny(); }
          if (!document) return deny();
          const event = async (id: string, token: string, metadata: boolean) => {
            const [row] = await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${id},${token},${metadata})`;
            if (!row?.allowed) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE"); return row;
          };
          const source = await event(proof.eventId, proof.token, false);
          if (!source.out_entry || !source.out_body || !source.out_received_at) return unavailable();
          const retentionRevision=counter(source.out_retention_revision);
          if (retentionRevision!==scope.deletionRevision) return unavailable();
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
            return { replay: {...priorResult.result, task_keys:shaped.tasks.map(task=>task.task_key), focus_keys:[...shaped.focus_keys]}, body: null, fingerprint, retentionRevision };
          }
          const dependencies = new Set<string>();
          for (const task of shaped.tasks) {
            if (scope.tasks.has(taskIndex(scope,task.task_key))) dependencies.add(task.task_key);
            for (const key of task.related_task_keys) if (scope.tasks.has(taskIndex(scope,key))) dependencies.add(key);
          }
          const priorSources = new Map<string,string>();
          const priorTasks: TaskCorePrior[] = [];
          for (const key of dependencies) {
            const prior=scope.tasks.get(taskIndex(scope,key))!; if (prior.incomplete || prior.retentionRevision!==retentionRevision) return unavailable();
            for (const [id,token] of prior.sources) priorSources.set(id,token);
            priorTasks.push({task_key:key,kind:prior.kind,branch:prior.branch,progress:prior.progress});
          }
          for (const [id,token] of priorSources) await event(id,token,true);
          if (state.revision !== parsed.data.expected_revision) throw new TurnIdentityError("REVISION_CHANGED");
          const checked = parseAndCheckTaskCore(shaped,priorTasks,Date.now());
          const ids = new Set(state.objects.map(item => item.id));
          if (checked.tasks.some(task => task.target_ids.some(id => !ids.has(id)))) throw new TurnIdentityError("TARGET_NOT_FOUND");
          // Register the verified Task/source dependencies before this same
          // transaction commits. No source text is stored in the binding table.
          for (const task of checked.tasks) {
            const sources = new Map<string,string>([[proof.eventId,proof.token]]);
            const dependencies = [scope.tasks.get(taskIndex(scope,task.task_key)),...task.related_task_keys.map(key=>scope.tasks.get(taskIndex(scope,key)))];
            for (const prior of dependencies) if (prior) for (const [id,token] of prior.sources) sources.set(id,token);
            for (const [id,token] of [...sources].sort(([a],[b])=>a.localeCompare(b))) {
              const [linked] = await tx.$queryRaw<Array<{ok:boolean}>>`SELECT public.host_evidence_bind_task_source_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${taskIndex(scope,task.task_key)},${JSON.stringify(task)}::jsonb,${id},${token}) AS ok`;
              if (!linked?.ok) return unavailable();
            }
          }
          return { replay: null, body: checked, fingerprint, retentionRevision };
        });
        if (closed) return unavailable();
        if (result.replay) return { ...structuredClone(result.replay), runtime_id: scope.runtimeId };
        const checked = result.body!;
        const registration: Registration = { turn_id:`turn_${randomUUID()}`, revision:checked.expected_revision, task_keys:checked.tasks.map(task => task.task_key), focus_keys:[...checked.focus_keys] };
        const sources = new Map<string,string>([[proof.eventId,proof.token]]);
        for (const task of checked.tasks) {
          const taskSources = new Map<string,string>([[proof.eventId,proof.token]]);
          const dependencies = [scope.tasks.get(taskIndex(scope,task.task_key)),...task.related_task_keys.map(key=>scope.tasks.get(taskIndex(scope,key)))];
          for (const prior of dependencies) if (prior) for (const [id,token] of prior.sources) taskSources.set(id,token);
          for (const [id,token] of taskSources) sources.set(id,token);
          scope.tasks.set(taskIndex(scope,task.task_key),{ kind:task.kind, branch:task.branch, progress:task.progress, sources:taskSources, incomplete:false, fingerprint:taskFingerprint(scope,task), eventSequence:receipt.sequence, retentionRevision:result.retentionRevision });
        }
        scope.turns.set(proof.eventId,{ digest:result.fingerprint, result:{turn_id:registration.turn_id,revision:registration.revision}, sources, sequence:receipt.sequence });
        return { ...registration, runtime_id: scope.runtimeId };
      });
    },
    /**
     * Internal bounded save only. Drafts, errors and non-unprocessed states
     * require sources/host state not yet available and are rejected, not trimmed.
     * This does not install a recovered scene or expose checkpoint payloads.
     */
    async saveCheckpoint(ticket: object, credential: Headers, input: unknown, expectedRevision: number, operationKey: string) {
      const startingScope=ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
      const startingRuntime=startingScope?.runtimeId, startingRetention=startingScope?.deletionRevision;
      let snapshot: unknown, cloneFailed=false; try { snapshot=structuredClone(input); } catch { cloneFailed=true; }
      const { scope, headers } = await scoped(ticket, credential);
      if (scope!==startingScope) return deny();
      if (scope.inflightSaves>=256) { scope.pendingSaveSticky=true; throw new CheckpointError("RECOVERY_UNAVAILABLE"); }
      scope.inflightSaves++; let entered=false;
      try {
        testHooks?.onSaveQueued?.();
        return await exclusive(scope, async () => {
          entered=true;
          try {
        if (scope.runtimeId!==startingRuntime) {
          if (scope.deletionRevision===startingRetention) scope.pendingSaveSticky=true;
          throw new CheckpointError("RECOVERY_UNAVAILABLE");
        }
        let payload:CheckpointPayload;
        try {
          if (cloneFailed) throw new CheckpointError("CONTRACT_INVALID");
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof operationKey !== "string" || !operationKey || operationKey.length > 256)
            throw new CheckpointError("CHECKPOINT_POLICY");
          const captured = snapshot as Partial<CheckpointPayload>;
          payload = validateCheckpoint(snapshot,scope.tripId,captured?.captured_state_revision ?? -1);
          if (!payload.tasks.length || payload.drafts.length || payload.tasks.some(row => row.errors.length || row.processing_status !== "unprocessed" ||
            row.base_revision !== payload.captured_state_revision || row.result_revision !== payload.captured_state_revision))
            throw new CheckpointError("RECOVERY_UNAVAILABLE");
          for (const row of payload.tasks) {
            const registered=scope.tasks.get(taskIndex(scope,row.task.task_key));
            if (!registered || registered.incomplete || registered.fingerprint !== taskFingerprint(scope,row.task)) throw new CheckpointError("RECOVERY_UNAVAILABLE");
          }
        } catch(error) { scope.pendingSaveSticky=true; throw error; }
        const requestDigest=digest({expected_revision:expectedRevision,payload,deleted:false});
        const keyToken=createHmac("sha256",keySecret).update("checkpoint-key\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,operationKey]),"utf8").digest("hex");
        const payloadDigest=checkpointDigest(payload), now=new Date().toISOString();
        const pendingToken=createHmac("sha256",keySecret).update("pending-save\0").update(canonicalJson([keyToken,requestDigest]),"utf8").digest("hex");
        let commitSent=false;
        try {
          const value=await db.$transaction(async tx => {
            await tx.$queryRaw`SELECT 1 FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
            try { await host.guard!(scope.tripId,headers,tx); } catch { return deny(); }
            const [row]=await tx.$queryRaw<Array<{value:{fault?:string;ack?:unknown}}>>`SELECT public.host_checkpoint_save_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${BigInt(expectedRevision)},${keyToken},${requestDigest},${JSON.stringify(payload)}::jsonb,${payloadDigest},${now},${null}) AS value`;
            if (!row?.value) throw new CheckpointError("CHECKPOINT_STORAGE");
            if (row.value.fault) throw new CheckpointError(row.value.fault);
            const parsed=parseDCContract("scene-ack",{runtime_contract_version:"0.1.0",ack:row.value.ack});
            if (parsed.ack.workspace_key!==scope.workspaceKey || parsed.ack.checkpoint_revision!==expectedRevision+1 || parsed.ack.payload_digest!==payloadDigest || parsed.ack.deleted)
              throw new CheckpointError("CHECKPOINT_STORAGE");
            commitSent=true; return parsed.ack;
          });
          scope.pendingSaves.delete(pendingToken); return value;
        } catch(error) {
          if (scope.pendingSaves.size>=256 && !scope.pendingSaves.has(pendingToken)) scope.pendingSaveSticky=true;
          else scope.pendingSaves.add(pendingToken);
          if (error instanceof CheckpointError || error instanceof EvidenceBoundaryError) throw error;
          throw new CheckpointError(commitSent ? "CHECKPOINT_ACK_UNKNOWN" : "CHECKPOINT_STORAGE");
        }
          } finally { scope.inflightSaves--; }
        });
      } finally { if (!entered) scope.inflightSaves--; }
    },
    /**
     * Internal same-process installation candidate. No original text, Packet,
     * Grant or scene-restored response crosses this method. A new authenticated
     * event is required before an installed task can be used for a new turn.
     */
    async restoreCheckpoint(ticket: object, credential: Headers, bodyBudgetBytes?: number) {
      const { scope, headers }=await scoped(ticket,credential);
      return exclusive(scope,async()=> {
        const runtimeId=`runtime-${randomUUID().replaceAll("-","")}`;
        try {
          const restored=await db.$transaction(async tx=> {
            const [document]=await tx.$queryRaw<Array<{revision:bigint;snapshot:string}>>`SELECT "revision", "snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
            try { await host.guard!(scope.tripId,headers,tx); } catch { return deny(); }
            if (!document) return deny();
            const [row]=await tx.$queryRaw<Array<{value:{fault?:string;revision?:number;payload_digest?:string;payload?:unknown;sources?:unknown;event_highwater?:number;saved_at?:string}}>>`SELECT public.host_checkpoint_read_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability}) AS value`;
            if (!row?.value) throw new CheckpointError("CHECKPOINT_STORAGE");
            if (row.value.fault) throw new CheckpointError(row.value.fault);
            const state=parseStateReferences(decodeCommandJson(document.snapshot)); checkStateCounters(state);
            if (state.trip_id!==scope.tripId || BigInt(state.revision)!==document.revision) throw new CheckpointError("REVISION_CHANGED");
            const payload=validateCheckpoint(row.value.payload,scope.tripId,state.revision);
            if (typeof row.value.payload_digest!=="string" || checkpointDigest(payload)!==row.value.payload_digest ||
                !Number.isSafeInteger(row.value.revision) || !Number.isSafeInteger(row.value.event_highwater) || row.value.event_highwater!<0 || !Array.isArray(row.value.sources)) throw new CheckpointError("CHECKPOINT_CORRUPT");
            const sourceShape=z.strictObject({task_token:z.string().regex(/^[0-9a-f]{64}$/),event_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),event_token:z.string().regex(/^[0-9a-f]{64}$/)});
            const sourceRows=z.array(sourceShape).safeParse(row.value.sources);
            if (!sourceRows.success) throw new CheckpointError("CHECKPOINT_CORRUPT");
            const installed=new Map<string,TaskMemory>();
            for (const item of payload.tasks) {
              const token=taskIndex(scope,item.task.task_key), sources=new Map<string,string>();
              for (const source of sourceRows.data) if (source.task_token===token) sources.set(source.event_id,source.event_token);
              if (!sources.has(item.event.event_id)) throw new CheckpointError("RECOVERY_UNAVAILABLE");
              installed.set(token,{kind:item.task.kind,branch:item.task.branch,progress:item.task.progress,sources,incomplete:false,fingerprint:taskFingerprint(scope,item.task),eventSequence:row.value.event_highwater!,retentionRevision:0});
            }
            const classified=classifyRecovery(payload,state);
            await testHooks?.beforeRestoreRecheck?.();
            let candidate:ReturnType<typeof buildRestoredSceneCandidate> | undefined;
            if (bodyBudgetBytes!==undefined) {
              if (typeof row.value.saved_at!=="string") throw new CheckpointError("CHECKPOINT_CORRUPT");
              const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
              if (!clock?.now) throw new CheckpointError("RECOVERY_UNAVAILABLE");
              // Bodies remain inside this transaction; no delivery or ledger is
              // asserted by constructing them. Drafts are currently rejected.
              candidate=buildRestoredSceneCandidate({checkpoint:payload,currentState:state,workspaceKey:scope.workspaceKey,
                checkpointRevision:row.value.revision!,savedAt:row.value.saved_at,runtimeId,bodyBudgetBytes,now:clock.now,saveUnacknowledged:scope.pendingSaveSticky || scope.pendingSaves.size>0 || scope.inflightSaves>0});
            }
            await testHooks?.afterCandidateBeforeRecheck?.();
            const [recheck]=await tx.$queryRaw<Array<{value:{fault?:string;revision?:number}}>>`SELECT public.host_checkpoint_inspect_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability}) AS value`;
            if (!recheck?.value) throw new CheckpointError("CHECKPOINT_STORAGE");
            if (recheck.value.fault) throw new CheckpointError(recheck.value.fault);
            if (recheck.value.revision!==row.value.revision) throw new CheckpointError("CHECKPOINT_CONFLICT");
            // A save can queue while the final database check is awaited. It
            // cannot clear until this exclusive action releases, so only add
            // the warning; these candidates are not delivered or persisted.
            const unacknowledged=scope.pendingSaveSticky || scope.pendingSaves.size>0 || scope.inflightSaves>0;
            if (candidate && unacknowledged) {
              let patched=false;
              for (const packet of candidate.packets) {
                if (!packet.packet.warnings.includes("scene_save_unacknowledged_business_state_is_separate")) {
                  packet.packet.warnings.push("scene_save_unacknowledged_business_state_is_separate");
                  packet.fingerprint=digest({packet:packet.packet,assembly:packet.assembly}); patched=true;
                }
              }
              if (patched) {
                candidate.scene.packets=candidate.packets.map(packet=>structuredClone(packet.packet));
                parseDCContract("scene-restored",candidate.scene);
                const [last]=await tx.$queryRaw<Array<{value:{fault?:string;revision?:number}}>>`SELECT public.host_checkpoint_inspect_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability}) AS value`;
                if (!last?.value) throw new CheckpointError("CHECKPOINT_STORAGE");
                if (last.value.fault) throw new CheckpointError(last.value.fault);
                if (last.value.revision!==row.value.revision) throw new CheckpointError("CHECKPOINT_CONFLICT");
              }
            }
            if (candidate) testHooks?.onCandidatePacketWarnings?.(candidate.packets.flatMap(packet=>packet.packet.warnings));
            const candidateCounts=candidate ? {turns:candidate.turns.length,packets:candidate.packets.length} : undefined;
            return { installed,eventIds:payload.tasks.map(item=>item.event.event_id),checkpointRevision:row.value.revision!,
              savedRevision:classified.saved_state_revision,currentRevision:classified.current_state_revision,taskCount:payload.tasks.length,watermark:row.value.event_highwater!,candidateCounts,candidateUnacknowledged:unacknowledged };
          });
          await testHooks?.afterRestoreCommit?.();
          if (closed || scope.disposed) return deny();
          // A save may queue while COMMIT is awaited. Since no Packet has been
          // delivered, refuse this stale candidate and let the caller retry.
          if (restored.candidateCounts && !restored.candidateUnacknowledged &&
              (scope.pendingSaveSticky || scope.pendingSaves.size>0 || scope.inflightSaves>0))
            throw new CheckpointError("RECOVERY_UNAVAILABLE");
          // Atomic within this host's per-workspace executor. Cross-process
          // delivery and the real Packet/Grant host remain separately gated.
          for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
          scope.receipts.clear(); scope.replayReceipts.clear(); scope.turns.clear(); scope.invalidTurns.clear();
          scope.recoveredEvents=new Set(restored.eventIds); scope.recoveryWatermark=restored.watermark; scope.tasks=restored.installed; scope.runtimeId=runtimeId;
          return {runtime_id:runtimeId,checkpoint_revision:restored.checkpointRevision,saved_state_revision:restored.savedRevision,
            current_state_revision:restored.currentRevision,restored_task_count:restored.taskCount,
            ...(restored.candidateCounts ? {candidate_turn_count:restored.candidateCounts.turns,candidate_packet_count:restored.candidateCounts.packets,candidate_save_unacknowledged:scope.pendingSaveSticky || scope.pendingSaves.size>0 || scope.inflightSaves>0} : {})};
        } catch(error) {
          if (error instanceof CheckpointError || error instanceof EvidenceBoundaryError) throw error;
          throw new CheckpointError("CHECKPOINT_STORAGE");
        }
      });
    },
    /** Metadata-only checkpoint inspection; it does not return or install a scene. */
    async inspectCheckpoint(ticket: object, credential: Headers) {
      const { scope, headers }=await scoped(ticket,credential);
      return exclusive(scope,async()=> {
        try {
          return await db.$transaction(async tx=> {
            await tx.$queryRaw`SELECT 1 FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
            try { await host.guard!(scope.tripId,headers,tx); } catch { return deny(); }
            const [row]=await tx.$queryRaw<Array<{value:{fault?:string;revision?:number;saved_at?:string;expires_at?:string|null}}>>`SELECT public.host_checkpoint_inspect_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability}) AS value`;
            if (!row?.value) throw new CheckpointError("CHECKPOINT_STORAGE");
            if (row.value.fault) throw new CheckpointError(row.value.fault);
            return row.value;
          });
        } catch(error) {
          if (error instanceof CheckpointError || error instanceof EvidenceBoundaryError) throw error;
          throw new CheckpointError("CHECKPOINT_STORAGE");
        }
      });
    },
    /** Releases only process-local capabilities; it does not delete persisted evidence. */
    async disposeWorkspace(ticket: object) {
      const scope = ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
      if (!scope) return;
      await exclusive(scope,async()=> {
        scope.disposed=true; scope.capability="";
        for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
        scope.receipts.clear(); scope.replayReceipts.clear(); scope.tasks.clear(); scope.turns.clear(); scope.invalidTurns.clear(); scope.recoveredEvents.clear(); scope.recoveryWatermark=null; scope.pendingSaves.clear(); scope.pendingSaveSticky=false; scope.keyEpochs.clear();
        workspaces.delete(ticket); activeScopes.delete(scope);
      });
    },
    async close() {
      if (closed) return; closed = true;
      for (const scope of activeScopes) {
        scope.disposed=true; scope.capability="";
        for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
        scope.receipts.clear(); scope.replayReceipts.clear(); scope.tasks.clear(); scope.turns.clear(); scope.invalidTurns.clear(); scope.recoveredEvents.clear(); scope.recoveryWatermark=null; scope.pendingSaves.clear(); scope.pendingSaveSticky=false; scope.keyEpochs.clear();
      }
      activeScopes.clear(); await Promise.all([db.$disconnect(), identity.close()]);
    },
  };
}
