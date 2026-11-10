import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ServerResponse } from "node:http";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient, type Prisma } from "../../../generated/prisma/client";
import { databaseEnvSchema } from "../../../lib/env";
import { openIdentity } from "../../auth/config";
import { sessionHost, userActorId } from "../../auth/authorization";
import { runtimeRoleSafetySql } from "../../database/runtime-role-safety.mjs";
import { CURSOR_TTL_MS, MAX_WINDOW_MS, PAGE_LIMIT, cursorSchema, EvidenceBoundaryError, type EventReceipt, type DeleteReceipt, type RecordInput, type EvidencePage } from "../../interaction-evidence/contracts";
import { checkCursor, checkReadWindow } from "../../interaction-evidence/boundaries";
import { evidenceKeyToken, prepareEvidenceEvent } from "./evidence-event";
import { parseAndCheckTaskCore, type TaskCorePrior } from "../task-core/validate";
import { parseDCContract } from "../contracts";
import { canonicalJson, decodeCommandJson, digest } from "../../trip-state/command-json";
import { CheckpointError, checkpointDigest, validateCheckpoint } from "../checkpoint-core";
import type { CheckpointPayload, DecisionContextContracts } from "../contracts.generated";
import { classifyRecovery } from "../recovery-core";
import { buildRestoredSceneCandidate } from "../integration/restored-scene-candidate";
import { assembleContextSnapshot, validateContextSnapshot } from "../context-assembly";
import { buildPacketCandidate, checkPacketTurn, materializeDeliveredPacket, type PacketCandidate } from "../packet-core/packet";
import { createShortPacketHandoffCandidate, type HandoffDeadline } from "./packet-short-handoff-candidate";
import { parseStateReferences } from "../../trip-state/references";
import { checkStateCounters } from "../../trip-state/numbers";
import { instantAttoseconds } from "../../trip-state/conditions";
import { openTripCommandService, type CommandHost } from "../../trip-state/internal/persistence";
import { parseContract, TripStateContractError } from "../../trip-state/contracts";
import { BridgeRuleError, checkChangeRules, checkConfirmationRules, checkGrantFields } from "../write-bridge/rules";
import type { TransactionalBridgeHost } from "../write-bridge/orchestrator";
import type {DecisionPlan} from "../../next-action-policy/decision-engine";
import {claimDecisionStep,markExecutionUnknown,readDecisionRecord,saveDecisionPlan} from "../../next-action-policy/runtime-store";
import type {TrustedDecisionRequest} from "../../next-action-policy/trusted-packet-source";
import {validatePlanRequestConsistency} from "../../next-action-policy/plan-packet-consistency";

type Registration = { turn_id: string; revision: number; task_keys: string[]; focus_keys: string[] };
type TaskMemory = Omit<TaskCorePrior,"task_key"> & { sources: Map<string,string>; incomplete: boolean; fingerprint: string; eventSequence: number; retentionRevision: number };
type Change = DecisionContextContracts["change"];
type Confirm = DecisionContextContracts["confirm"];
type WriteGrant = { principalId:string;eventId:string;requestDigest:string;revision:number;expiresAt:string;runtimeId:string };
type PacketMemory = { packetId:string; turnId:string; taskHash:string; budget:number; at:number; contextId:string; expiresAt:number; warning:boolean;
  runtimeId:string; packet:DecisionContextContracts["packet"]; grants:Map<string,WriteGrant>; proposalId:string|null;
  tracker:ReturnType<typeof createShortPacketHandoffCandidate>; postflight:(()=>Promise<void>)|null; invalidate:()=>void };
type TurnLease = { id:string; cipher:Buffer; iv:Buffer; tag:Buffer; expiresAt:number; timer:NodeJS.Timeout };
type Scope = { ownerId: string; sessionId: string; tripId: string; workspaceKey: string; capability: string; runtimeId: string;
  recoveredEvents: Set<string>; recoveryWatermark: number | null; deletionRevision: number; pendingSaves: Set<string>; pendingSaveSticky: boolean; inflightSaves: number; keyEpochs: Map<string,number>; tasks: Map<string, TaskMemory>;
  recoveredTasks: Map<string,InterpretedTask>; recoveredFocus:string[];
  turns: Map<string, { digest: string; result: Pick<Registration,"turn_id"|"revision">; sources: Map<string,string>; sequence: number }>;
  invalidTurns: Set<string>; receipts: Map<string,Set<object>>; replayReceipts: Map<string,EventReceipt>; packetInvalidators:Set<()=>void>; packets:Map<string,PacketMemory>; leaseKey:Buffer; turnLeases:Map<string,TurnLease>; disposed: boolean; tail: Promise<void> };
type RecordRow = { disposition: string; out_event_id: string | null; out_sequence: bigint | null; out_recorded_at: Date | null };
type DeleteRow = { disposition: string; deletion_revision: bigint | null; accepted_at: Date | null; cleanup_pending: boolean | null; event_highwater: bigint | null };
type EventRow = { allowed: boolean; out_entry: "dialogue" | "map" | "timeline" | "comparison" | null; out_body: string | null; out_received_at: Date | null; out_retention_revision: bigint | null; out_valid_for_ms:bigint|null };
type TaskSnapshotRow = { ok:boolean; out_retention_revision:bigint|null; out_highwater:bigint|null; out_association_revision:bigint|null; out_unlinked_count:bigint|null; out_sources:unknown };
type UnlinkRow = { disposition:"denied"|"conflict"|"replayed"|"unlinked"; out_association_revision:bigint|null; out_retention_revision:bigint|null };
type SupersedeRow = { disposition:"denied"|"conflict"|"replayed"|"superseded"; out_association_revision:bigint|null; out_retention_revision:bigint|null };
type InterpretedTask = DecisionContextContracts["open-turn"]["tasks"][number];
type WriteOperation = {kind:"change";scope:Scope;headers:Headers;body:Change;memory:PacketMemory;role:"user"|"model";grant?:WriteGrant} |
  {kind:"confirm";scope:Scope;headers:Headers;body:Confirm;memory:PacketMemory;role:"user"};
export type ControlledInterpreter = (input:{event:{event_id:string;entry:RecordInput["entry"];text:string;reference:string;received_at:string};state:ReturnType<typeof parseStateReferences>;
  runtime_focus:{tasks:InterpretedTask[];focus_keys:string[];complete:boolean};mint_task_key:(ordinal:number)=>Promise<string>;
  read_task_evidence:(taskKey:string,window:{page_size:number;from:string;to:string;cursor:string|null})=>Promise<EvidencePage>})=>Promise<{tasks:unknown;focus_keys:unknown}>;
const identityInput = z.strictObject({ expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tasks: z.unknown(), focus_keys: z.unknown() });
const workspaceKeyInput = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
const unlinkInput = z.strictObject({action:z.literal("unlink"),task_key:z.string().regex(/^task-[0-9a-f]{32}$/),event_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),
  source_turn_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),expected_association_revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
  idempotency_key:z.string().min(1).max(256)});
const unlinkBatchInput=z.array(unlinkInput).min(1).max(32);
const supersedeInput=z.strictObject({action:z.literal("supersede"),task_key:z.string().regex(/^task-[0-9a-f]{32}$/),
  old_event_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),old_source_turn_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),
  replacement_event_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),replacement_source_turn_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),
  expected_association_revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),idempotency_key:z.string().min(1).max(256)});
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
export async function openEvidenceHost(env: Partial<NodeJS.ProcessEnv> = process.env, testHooks?: { beforeRestoreRecheck?: () => Promise<void>; afterRestoreCommit?: () => Promise<void>; afterMintCommit?: () => Promise<void>; afterCandidateBeforeRecheck?: () => Promise<void>; onCandidatePacketWarnings?: (warnings: readonly string[]) => void; onSaveQueued?: () => void; onLivePacketCandidate?: (candidate:PacketCandidate,recheck:()=>Promise<void>,bind:(invalidate:()=>void)=>()=>void)=>Promise<void>; beforePacketHandoff?:()=>Promise<void>; afterFinalPacketCheck?:()=>Promise<void>; afterPacketHandoffCommit?:()=>Promise<void>; beforeTrustedPacketBatchFinalCheck?:()=>Promise<void>; trustedPacketBatchLockTimeoutMs?:number; beforeWriteGuard?:()=>Promise<void> }) {
  if (testHooks && process.env.NODE_ENV !== "test") return unavailable();
  if(testHooks?.trustedPacketBatchLockTimeoutMs!==undefined&&(!Number.isInteger(testHooks.trustedPacketBatchLockTimeoutMs)||testHooks.trustedPacketBatchLockTimeoutMs<1))return unavailable();
  const connection = databaseEnvSchema.parse(env).DATABASE_URL;
  const keySecret = env.E11_IDEMPOTENCY_SECRET;
  if (typeof keySecret !== "string" || Buffer.byteLength(keySecret, "utf8") < 32) return unavailable();
  const cursorSecret=keySecret;
  const url = new URL(connection);
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c timezone=UTC`.trim());
  const identity = await openIdentity(env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const [role] = await db.$queryRawUnsafe<Array<{ denied: boolean }>>(runtimeRoleSafetySql, null, "trip");
    const [evidenceRole] = await db.$queryRaw<Array<{ denied: boolean }>>`
      WITH principals AS (SELECT oid FROM pg_roles WHERE pg_has_role(current_user,oid,'USAGE') OR pg_has_role(current_user,oid,'SET')),
      evidence_tables AS (SELECT c.oid,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('HostEvidenceWorkspace','HostEvidenceEvent','HostEvidenceCleanup','HostEvidenceTripLifecycle','HostEvidenceTaskSource','HostEvidenceAssociationHead','HostEvidenceAssociationLog','HostEvidenceScene','HostEvidenceTaskKey','HostEvidenceSceneEventWitness') AND c.relkind='r')
      SELECT (SELECT count(*) FROM evidence_tables) <> 10 OR EXISTS (
        SELECT 1 FROM evidence_tables c CROSS JOIN principals p WHERE c.relowner=p.oid
          OR has_table_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(p.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) OR EXISTS (
        SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace CROSS JOIN principals p
        WHERE n.nspname='public' AND f.proname IN ('host_evidence_delete_candidate','host_evidence_cleanup_candidate',
          'host_checkpoint_expire_event_candidate','host_checkpoint_expire_batch_candidate')
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
  const interpreterReads=new WeakMap<object,{scope:Scope;eventId:string;token:string}>();
  const routingSecret=randomBytes(32);
  const activeScopes = new Set<Scope>();
  const writeCredentials=new WeakMap<object,WriteOperation>();
  const modelActorId="model-e03-runtime";
  let writeServicePromise:ReturnType<typeof openTripCommandService>|undefined;
  let closed = false;
  const writeCommandHost:CommandHost={
    async authorize(tripId,credential){
      const operation=credential&&typeof credential==="object"?writeCredentials.get(credential):undefined;
      if(!operation||operation.scope.tripId!==tripId||closed||operation.scope.disposed)throw new TripStateContractError("PERMISSION","Access denied");
      return {tripId,actor:{role:operation.role,id:operation.role==="user"?userActorId(operation.scope.ownerId):modelActorId}};
    },
    async guard(tripId,credential,tx){
      const operation=credential&&typeof credential==="object"?writeCredentials.get(credential):undefined;
      if(!operation||operation.scope.tripId!==tripId)throw new TripStateContractError("PERMISSION","Access denied");
      await guardWriteOperation(tx,operation);
    },
  };
  function writeService(){return writeServicePromise??=openTripCommandService(connection,writeCommandHost);}
  const pageCursorShape=z.strictObject({cursor:cursorSchema,from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true})});
  const cursorStale=():never=>{throw new EvidenceBoundaryError("EVIDENCE_CURSOR_STALE");};
  function sealPageCursor(value:z.infer<typeof pageCursorShape>) {
    const body=Buffer.from(canonicalJson(value),"utf8"),signature=createHmac("sha256",cursorSecret).update("e11-page-cursor\0").update(body).digest();
    return `${body.toString("base64url")}.${signature.toString("base64url")}`;
  }
  function openPageCursor(value:string) {
    if(typeof value!=="string"||value.length>4096)return cursorStale();
    const parts=value.split(".");if(parts.length!==2)return cursorStale();
    const body=Buffer.from(parts[0],"base64url"),signature=Buffer.from(parts[1],"base64url");
    if(body.toString("base64url")!==parts[0]||signature.toString("base64url")!==parts[1]||signature.length!==32||
      !timingSafeEqual(signature,createHmac("sha256",cursorSecret).update("e11-page-cursor\0").update(body).digest()))
      return cursorStale();
    try{return pageCursorShape.parse(JSON.parse(body.toString("utf8")));}catch{return cursorStale();}
  }
  // Task keys may contain user text; retain only a keyed, scope-bound index.
  const taskIndex = (scope: Scope, key: string) => createHmac("sha256",keySecret).update("task-identity\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,key]),"utf8").digest("hex");
  const taskFingerprint = (scope: Scope, task: unknown) => createHmac("sha256",keySecret).update("task-value\0").update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,task]),"utf8").digest("hex");
  function clearTurnLeases(scope:Scope) {
    for(const lease of scope.turnLeases.values()){clearTimeout(lease.timer);lease.cipher.fill(0);lease.iv.fill(0);lease.tag.fill(0);}
    scope.turnLeases.clear();scope.leaseKey.fill(0);
  }
  function rememberTurn(scope:Scope,turnId:string,input:unknown) {
    const bytes=Buffer.from(JSON.stringify(input),"utf8");
    try {
      if(bytes.length>1_048_576)return unavailable();
      const old=scope.turnLeases.get(turnId);if(old){for(const packet of scope.packets.values())if(packet.turnId===turnId)packet.invalidate();clearTimeout(old.timer);old.cipher.fill(0);old.iv.fill(0);old.tag.fill(0);}
      const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",scope.leaseKey,iv),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
      const expiresAt=Date.now()+300_000,id=randomUUID();
      const timer=setTimeout(()=>{const current=scope.turnLeases.get(turnId);if(current?.id===id){for(const packet of scope.packets.values())if(packet.turnId===turnId)packet.invalidate();current.cipher.fill(0);current.iv.fill(0);current.tag.fill(0);scope.turnLeases.delete(turnId);}},300_000);timer.unref();
      scope.turnLeases.set(turnId,{id,cipher:encrypted,iv,tag:cipher.getAuthTag(),expiresAt,timer});
    } finally {bytes.fill(0);}
  }
  function turnInput(scope:Scope,turnId:string) {
    const lease=scope.turnLeases.get(turnId);if(!lease||lease.expiresAt<=Date.now())return unavailable();
    const decipher=createDecipheriv("aes-256-gcm",scope.leaseKey,lease.iv);decipher.setAuthTag(lease.tag);
    const plaintext=Buffer.concat([decipher.update(lease.cipher),decipher.final()]);
    try {return {value:JSON.parse(plaintext.toString("utf8")) as unknown,id:lease.id};} finally {plaintext.fill(0);}
  }
  function checkTurnLease(scope:Scope,turnId:string,id:string) {const current=scope.turnLeases.get(turnId);if(!current||current.id!==id||current.expiresAt<=Date.now())return unavailable();}
  function invalidatePackets(scope:Scope) { for(const invalidate of scope.packetInvalidators) { try { invalidate(); } catch { /* durable deletion must not be undone by local cleanup */ } } scope.packetInvalidators.clear(); scope.packets.clear(); }
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
  function freshScope(p:{ownerId:string;sessionId:string},tripId:string,workspaceKey=`work_${randomUUID()}`):Scope {
    return { ownerId:p.ownerId,sessionId:p.sessionId,tripId,workspaceKey,capability:randomBytes(32).toString("hex"),runtimeId:`runtime-${randomUUID().replaceAll("-","")}`,
      recoveredEvents:new Set(),recoveryWatermark:null,deletionRevision:0,pendingSaves:new Set(),pendingSaveSticky:false,inflightSaves:0,keyEpochs:new Map(),tasks:new Map(),recoveredTasks:new Map(),recoveredFocus:[],turns:new Map(),invalidTurns:new Set(),receipts:new Map(),replayReceipts:new Map(),packetInvalidators:new Set(),packets:new Map(),leaseKey:randomBytes(32),turnLeases:new Map(),disposed:false,tail:Promise.resolve() };
  }
  async function scoped(ticket: object, credential: Headers) {
    const scope = ticket && typeof ticket === "object" ? workspaces.get(ticket) : undefined;
    if (!scope) return deny();
    const current = await authorized(scope.tripId, credential);
    if (current.ownerId !== scope.ownerId || current.sessionId !== scope.sessionId) return deny();
    return { scope, headers: current.headers };
  }
  async function taskSourcesCurrent(tx:Prisma.TransactionClient,scope:Scope,taskToken:string,sources:Map<string,string>) {
    if(sources.size<1||sources.size>256)return unavailable();
    for(const [eventId,eventToken] of sources){
      const [row]=await tx.$queryRaw<Array<{ok:boolean}>>`SELECT public.host_evidence_task_source_current_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${taskToken},${eventId},${eventToken}) AS ok`;
      if(!row?.ok)return unavailable();
    }
  }
  /** Rebuild from the authorized event and caller-supplied task; no Task text is cached. */
  async function packetFromCurrent(tx:Prisma.TransactionClient,scope:Scope,headers:Headers,raw:unknown,turnId:string,taskHash:string,budget:number,seed?:PacketMemory) {
    const input=identityInput.safeParse(raw); if(!input.success)return unavailable();
    const found=[...scope.turns.entries()].find(([,entry])=>entry.result.turn_id===turnId);
    if(!found||closed||scope.disposed)return deny();
    const [eventId,registered]=found,token=registered.sources.get(eventId); if(!token)return unavailable();
    const [document]=await tx.$queryRaw<Array<{revision:bigint;snapshot:string}>>`SELECT "revision", "snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
    try {await host.guard!(scope.tripId,headers,tx);} catch {return deny();}
    if(!document)return deny();
    let deadline:HandoffDeadline|undefined;
    const applyBudget=(started:bigint,startedWall:number,remaining:bigint|null)=> {
      if(remaining===null||remaining<=1n)return unavailable();
      const bounded=remaining>300_001n?300_000n:remaining-1n;
      const end=started+bounded*1_000_000n,wall=startedWall+Number(bounded);
      deadline={monotonicNs:deadline===undefined||end<deadline.monotonicNs?end:deadline.monotonicNs,wallMs:deadline===undefined||wall<deadline.wallMs?wall:deadline.wallMs};
    };
    const read=async(id:string,key:string,metadata:boolean)=> {
      const started=process.hrtime.bigint(),startedWall=Date.now();
      const [row]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${id},${key},${metadata})`;
      if(!row?.allowed||counter(row.out_retention_revision)!==scope.deletionRevision)return unavailable();applyBudget(started,startedWall,row.out_valid_for_ms);return row;
    };
    const source=await read(eventId,token,false);
    if(!source.out_entry||!source.out_body||!source.out_received_at)return unavailable();
    for(const [id,key] of registered.sources)await read(id,key,true);
    const state=parseStateReferences(decodeCommandJson(document.snapshot));checkStateCounters(state);
    if(state.trip_id!==scope.tripId||BigInt(state.revision)!==document.revision||state.revision!==registered.result.revision)return unavailable();
    const event={event_id:eventId,entry:source.out_entry,text:source.out_body,reference:`host-interaction:${eventId}`,received_at:source.out_received_at.toISOString()};
    const body=parseDCContract("open-turn",{runtime_contract_version:"0.1.0",trip_id:scope.tripId,expected_revision:input.data.expected_revision,event,tasks:input.data.tasks,focus_keys:input.data.focus_keys});
    if(body.expected_revision!==registered.result.revision||createHmac("sha256",keySecret!).update(canonicalJson(body),"utf8").digest("hex")!==registered.digest)return unavailable();
    const task=body.tasks.find(item=>taskIndex(scope,item.task_key)===taskHash),current=scope.tasks.get(taskHash);
    if(!task||!current||current.incomplete||current.retentionRevision!==scope.deletionRevision||current.fingerprint!==taskFingerprint(scope,task))return unavailable();
    await taskSourcesCurrent(tx,scope,taskHash,current.sources);
    if(seed&&(seed.runtimeId!==scope.runtimeId||(!seed.warning&&(scope.pendingSaveSticky||scope.pendingSaves.size>0||scope.inflightSaves>0))))return unavailable();
    const at=seed?new Date(seed.at):new Date(),assembly=assembleContextSnapshot(state,task.task_key,task.target_ids,at);
    if(seed)assembly.context.id=seed.contextId;
    const turn=parseDCContract("turn",{runtime_contract_version:"0.1.0",runtime_id:scope.runtimeId,turn_id:turnId,revision:registered.result.revision,tasks:body.tasks,focus_keys:body.focus_keys,checkpoint_ack:null});
    const pending={event,base_revision:registered.result.revision,processing_status:"unprocessed" as const,proposal_id:null,result_revision:registered.result.revision,errors:[]};
    const request=parseDCContract("assemble",{runtime_contract_version:"0.1.0",turn_id:turnId,task_key:task.task_key,body_budget_bytes:budget});
    const warning=seed?.warning??(scope.pendingSaveSticky||scope.pendingSaves.size>0||scope.inflightSaves>0);
    const candidate=buildPacketCandidate({request,packetId:seed?.packetId??`packet-${randomUUID().replaceAll("-","")}`,task,pending,assembly,state,now:at,recoveredInput:false,saveUnacknowledged:warning});
    checkPacketTurn(candidate,turn,pending);if(seed)seed.tracker.revalidate(candidate);
    const recheck=async()=>{
      for(const [id,key] of registered.sources)await read(id,key,true);
      await taskSourcesCurrent(tx,scope,taskHash,current.sources);
      try {await host.guard!(scope.tripId,headers,tx);} catch{return deny();}
      validateContextSnapshot(assembly,state,new Date());
      const started=process.hrtime.bigint(),startedWall=Date.now();
      const [clock]=await tx.$queryRaw<Array<{remaining:bigint|null}>>`SELECT FLOOR(EXTRACT(EPOCH FROM (${assembly.context.expires_at}::timestamptz-clock_timestamp()))*1000)::BIGINT AS remaining`;
      applyBudget(started,startedWall,clock?.remaining??null);
      // Unselected facts can begin or stop affecting C12/conditions without a
      // revision change. Bound the handoff by *all* fact transitions, not
      // just the selected facts used to compute Context.expires_at.
      const facts=state.objects.filter(item=>item.type==="ExternalFact");
      if(facts.length) {
        const tickStart=process.hrtime.bigint(),tickWall=Date.now();
        const [dbClock]=await tx.$queryRaw<Array<{millis:bigint}>>`SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT AS millis`;
        if(!dbClock)return unavailable();
        const unit=1_000_000_000_000_000n;
        for(const fact of facts)for(const value of [fact.observed_at,fact.expires_at]) {
          const instant=instantAttoseconds(value),millis=instant>=0n?instant/unit:(instant-(unit-1n))/unit;
          if(millis>=dbClock.millis)applyBudget(tickStart,tickWall,millis-dbClock.millis-1n);
        }
      }
    };
    await recheck();
    return {candidate,state,recheck,deadline:()=>deadline??unavailable(),at:at.getTime(),warning};
  }
  function writeActorId(operation:WriteOperation) {
    return operation.role==="user"?userActorId(operation.scope.ownerId):modelActorId;
  }
  async function writeReplay(tx:Prisma.TransactionClient,operation:WriteOperation) {
    const domain=operation.kind==="confirm"?"confirmation":operation.role;
    const key=operation.body.request.idempotency_key,actorId=writeActorId(operation);
    const [row]=await tx.$queryRaw<Array<{request:string;response:string}>>`SELECT "request"::text AS request,"response"::text AS response
      FROM "TripStateIdempotency" WHERE "tripId"=${operation.scope.tripId} AND "actorId"=${actorId}
      AND "operationDomain"=${domain} AND "key"=${key}`;
    return row?{request:decodeCommandJson(row.request),response:parseContract("response",decodeCommandJson(row.response))}:null;
  }
  function writePacket(scope:Scope,packetId:string) {
    const memory=scope.packets.get(packetId);
    if(!memory||memory.runtimeId!==scope.runtimeId||memory.expiresAt<=Date.now())throw new BridgeRuleError("PACKET_STALE");
    return memory;
  }
  async function currentWritePacket(tx:Prisma.TransactionClient,operation:WriteOperation) {
    try {
      const memory=operation.memory;
      if(operation.scope.packets.get(memory.packetId)!==memory||memory.runtimeId!==operation.scope.runtimeId)return unavailable();
      const lease=turnInput(operation.scope,memory.turnId);
      const built=await packetFromCurrent(tx,operation.scope,operation.headers,lease.value,memory.turnId,memory.taskHash,memory.budget,memory);
      checkTurnLease(operation.scope,memory.turnId,lease.id);
      return {built,deliveredIds:memory.tracker.delivery(built.candidate).deliveredIds};
    } catch(error) {
      if(error instanceof EvidenceBoundaryError&&error.code==="EVIDENCE_ACCESS_DENIED")throw new TripStateContractError("PERMISSION","Access denied");
      if(error instanceof EvidenceBoundaryError)throw new BridgeRuleError("PACKET_STALE");
      throw error;
    }
  }
  async function guardWriteOperation(tx:Prisma.TransactionClient,operation:WriteOperation) {
    try {
      await testHooks?.beforeWriteGuard?.();
      await host.guard!(operation.scope.tripId,operation.headers,tx);
      if(await writeReplay(tx,operation))return;
      const {built,deliveredIds}=await currentWritePacket(tx,operation);
      if(operation.kind==="change") {
        checkChangeRules(operation.body,built.candidate.packet,{turnId:operation.memory.turnId,event:built.candidate.packet.pending_input.event,recovered:false},deliveredIds);
        if(operation.grant) {
          const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
          if(!clock)return unavailable();
          checkGrantFields(operation.grant,{principalId:userActorId(operation.scope.ownerId),eventId:built.candidate.packet.pending_input.event.event_id,
            request:operation.body.request,now:clock.now.toISOString(),runtimeId:operation.scope.runtimeId});
        }
      } else checkConfirmationRules(operation.body,{turnId:operation.memory.turnId,proposalId:operation.memory.proposalId,recovered:false});
    } catch(error) {
      if(error instanceof EvidenceBoundaryError) {
        if(error.code==="EVIDENCE_ACCESS_DENIED")throw new TripStateContractError("PERMISSION","Access denied");
        throw new BridgeRuleError("PACKET_STALE");
      }
      throw error;
    }
  }
  async function executeWrite(operation:WriteOperation,request:Change["request"]|Confirm["request"],proposalId?:string) {
    const credential=Object.freeze({});writeCredentials.set(credential,operation);
    try {
      const service=await writeService();
      return await (operation.kind==="change"?service.submit(operation.scope.tripId,request,credential):service.confirm(operation.scope.tripId,proposalId!,request,credential));
    } finally {writeCredentials.delete(credential);}
  }
  async function changeScope(scope:Scope,headers:Headers,body:Change) {
    const memory=writePacket(scope,body.packet_id),grant=memory.grants.get(body.request.idempotency_key),role=grant?"user" as const:"model" as const;
    const operation:WriteOperation={kind:"change",scope,headers,body,memory,role,...(grant?{grant}:{})};
    return db.$transaction(async tx=> {
      try {await host.guard!(scope.tripId,headers,tx);} catch {return deny();}
      const replay=await writeReplay(tx,operation);
      if(replay)return {operation,bridge:{packet:memory.packet,turn:{turnId:memory.turnId,event:memory.packet.pending_input.event,recovered:false},deliveredIds:[],
        principalId:userActorId(scope.ownerId),now:new Date().toISOString(),runtimeId:scope.runtimeId,...(grant?{grant}:{}),
        replay:{bodyDigest:canonicalJson(replay.request)===canonicalJson(body.request)?digest(body):"idempotency-conflict",response:replay.response}}};
      const {built,deliveredIds}=await currentWritePacket(tx,operation);
      const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
      if(!clock)return unavailable();
      return {operation,bridge:{packet:built.candidate.packet,turn:{turnId:memory.turnId,event:built.candidate.packet.pending_input.event,recovered:false},deliveredIds,
        principalId:userActorId(scope.ownerId),now:clock.now.toISOString(),runtimeId:scope.runtimeId,...(grant?{grant}:{})}};
    });
  }
  async function readTrustedPacketBatch(ticket:object,credential:Headers,packetIds:readonly string[]) {
    const ids=[...packetIds];
    if(ids.length<1||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(id)))return unavailable();
    const start=await scoped(ticket,credential),startingRuntime=start.scope.runtimeId;
    try {
      return await exclusive(start.scope,async()=>db.$transaction(async tx=>{
        if(testHooks?.trustedPacketBatchLockTimeoutMs!==undefined)
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${testHooks.trustedPacketBatchLockTimeoutMs}ms`}, true)`;
        const packets:DecisionContextContracts["packet"][]=[],memories:PacketMemory[]=[],leaseIds:string[]=[];
        for(const packetId of ids) {
          const memory=start.scope.packets.get(packetId);
          if(!memory||memory.runtimeId!==startingRuntime||memory.expiresAt<=Date.now()||memory.postflight)return unavailable();
          const progress=memory.tracker.progress();
          if(!progress.initial_sent||progress.pending||progress.remaining_count!==0)return unavailable();
          const lease=turnInput(start.scope,memory.turnId);
          const built=await packetFromCurrent(tx,start.scope,start.headers,lease.value,memory.turnId,memory.taskHash,memory.budget,memory);
          checkTurnLease(start.scope,memory.turnId,lease.id);await built.recheck();
          const delivery=memory.tracker.delivery(built.candidate);
          memories.push(memory);leaseIds.push(lease.id);packets.push(materializeDeliveredPacket(built.candidate,delivery));
        }
        const first=packets[0];
        if(!first||packets.some(packet=>packet.context.state_revision!==first.context.state_revision))return unavailable();
        await testHooks?.beforeTrustedPacketBatchFinalCheck?.();
        const final=await scoped(ticket,credential);
        if(final.scope!==start.scope||final.scope.runtimeId!==startingRuntime)return deny();
        try {await host.guard!(final.scope.tripId,final.headers,tx);} catch {return deny();}
        const [document]=await tx.$queryRaw<Array<{revision:bigint;now:Date}>>`SELECT "revision",clock_timestamp() AS now FROM "TripStateDocument" WHERE "tripId"=${final.scope.tripId} FOR SHARE`;
        if(!document||document.revision!==BigInt(first.context.state_revision))return unavailable();
        const now=document.now.getTime();
        for(let index=0;index<memories.length;index++) {
          const memory=memories[index],progress=memory.tracker.progress();
          if(final.scope.packets.get(memory.packetId)!==memory||memory.runtimeId!==startingRuntime||memory.expiresAt<=now||memory.postflight||
            !progress.initial_sent||progress.pending||progress.remaining_count!==0)return unavailable();
          checkTurnLease(final.scope,memory.turnId,leaseIds[index]);
        }
        return {runtime_id:startingRuntime,packets};
      }));
    } catch(error) {
      if(error instanceof EvidenceBoundaryError)throw error;
      return unavailable();
    }
  }
  return {
    async createWorkspace(tripId: string, credential: Headers): Promise<object> {
      const p = await authorized(tripId, credential);
      const scope=freshScope(p,tripId);
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
    /**
     * Rebinds an existing persisted workspace to the current authenticated
     * Session. The caller-supplied key is only a locator: PostgreSQL proves the
     * owner/trip relation, rotates the capability and rechecks the Checkpoint,
     * Task sources and E11 barriers before this host mints a new opaque ticket.
     */
    async reopenWorkspace(tripId:string,credential:Headers,workspaceKey:string):Promise<object> {
      const key=workspaceKeyInput.safeParse(workspaceKey);if(!key.success)return deny();
      const p=await authorized(tripId,credential),scope=freshScope(p,tripId,key.data);
      try {
        await db.$transaction(async tx=>{
          try{await host.guard!(tripId,p.headers,tx);}catch{return deny();}
          const [row]=await tx.$queryRaw<Array<{ok:boolean}>>`SELECT public.host_checkpoint_reopen_workspace_candidate(${p.sessionId},${p.ownerId},${tripId},${scope.workspaceKey},${scope.capability}) AS ok`;
          if(!row?.ok)return unavailable();
          try{await host.guard!(tripId,p.headers,tx);}catch{return deny();}
        });
      } catch(error) {if(error instanceof EvidenceBoundaryError)throw error;return unavailable();}
      if(closed)return deny();
      const ticket=Object.freeze({});workspaces.set(ticket,scope);activeScopes.add(scope);return ticket;
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
          invalidatePackets(scope);
          clearTurnLeases(scope);scope.leaseKey=randomBytes(32);
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
      if(Buffer.byteLength(JSON.stringify(parsed.data),"utf8")>1_048_576)return unavailable();
      return exclusive(scope, async () => {
        if (eventProofs.get(receipt) !== proof) return deny();
        if (scope.recoveredEvents.has(proof.eventId) || (scope.recoveryWatermark!==null && receipt.sequence<=scope.recoveryWatermark))
          throw new CheckpointError("RECOVERED_EVENT_REPLAY");
        if (closed || scope.invalidTurns.has(proof.eventId)) return unavailable();
        const proposedTurnId=`turn_${randomUUID()}`;
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
              const [linked] = await tx.$queryRaw<Array<{ok:boolean}>>`SELECT public.host_evidence_bind_task_source_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${taskIndex(scope,task.task_key)},${JSON.stringify(task)}::jsonb,${id},${token},${proposedTurnId}) AS ok`;
              if (!linked?.ok) return unavailable();
            }
          }
          return { replay: null, body: checked, fingerprint, retentionRevision };
        });
        if (closed) return unavailable();
        if (result.replay) {
          if(result.replay.task_keys.some(key=>scope.tasks.get(taskIndex(scope,key))?.incomplete!==false))return unavailable();
          rememberTurn(scope,result.replay.turn_id,parsed.data);return { ...structuredClone(result.replay), runtime_id: scope.runtimeId };
        }
        const checked = result.body!;
        const registration: Registration = { turn_id:proposedTurnId, revision:checked.expected_revision, task_keys:checked.tasks.map(task => task.task_key), focus_keys:[...checked.focus_keys] };
        const sources = new Map<string,string>([[proof.eventId,proof.token]]);
        for (const task of checked.tasks) {
          const taskSources = new Map<string,string>([[proof.eventId,proof.token]]);
          const dependencies = [scope.tasks.get(taskIndex(scope,task.task_key)),...task.related_task_keys.map(key=>scope.tasks.get(taskIndex(scope,key)))];
          for (const prior of dependencies) if (prior) for (const [id,token] of prior.sources) taskSources.set(id,token);
          for (const [id,token] of taskSources) sources.set(id,token);
          scope.tasks.set(taskIndex(scope,task.task_key),{ kind:task.kind, branch:task.branch, progress:task.progress, sources:taskSources, incomplete:false, fingerprint:taskFingerprint(scope,task), eventSequence:receipt.sequence, retentionRevision:result.retentionRevision });
          scope.recoveredTasks.delete(taskIndex(scope,task.task_key));scope.recoveredFocus=scope.recoveredFocus.filter(key=>key!==task.task_key);
        }
        scope.turns.set(proof.eventId,{ digest:result.fingerprint, result:{turn_id:registration.turn_id,revision:registration.revision}, sources,sequence:receipt.sequence });
        rememberTurn(scope,registration.turn_id,parsed.data);
        return { ...registration, runtime_id: scope.runtimeId };
      });
    },
    /** Server-installed interpretation after durable recording; no model service is installed here. */
    async openInterpretedTurnCandidate(ticket:object,credential:Headers,value:RecordInput,interpret:ControlledInterpreter) {
      if(typeof interpret!=="function")return unavailable();
      const receipt=await this.record(ticket,credential,value);
      const {scope,headers}=await scoped(ticket,credential);
      const context=await exclusive(scope,async()=>db.$transaction(async tx=>{
        const [document]=await tx.$queryRaw<Array<{revision:bigint;snapshot:string}>>`SELECT "revision","snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        if(!document)return deny();
        const parsed=parseStateReferences(decodeCommandJson(document.snapshot));checkStateCounters(parsed);
        if(parsed.trip_id!==scope.tripId||BigInt(parsed.revision)!==document.revision)return unavailable();
        const prior=new Map<string,InterpretedTask>();let focus:string[]=[],complete=true;
        for(const [token,task] of scope.recoveredTasks){
          const current=scope.tasks.get(token);
          if(!current||current.incomplete||current.fingerprint!==taskFingerprint(scope,task)){complete=false;continue;}
          try{await taskSourcesCurrent(tx,scope,token,current.sources);prior.set(task.task_key,structuredClone(task));}
          catch{complete=false;}
        }
        focus=scope.recoveredFocus.filter(key=>prior.has(key));
        for(const turn of scope.turns.values()){
          let candidate:DecisionContextContracts["turn"];
          try {
            const lease=turnInput(scope,turn.result.turn_id);
            const input=identityInput.parse(lease.value);
            candidate=parseDCContract("turn",{runtime_contract_version:"0.1.0",runtime_id:scope.runtimeId,turn_id:turn.result.turn_id,
              revision:turn.result.revision,tasks:input.tasks,focus_keys:input.focus_keys,checkpoint_ack:null});
          } catch {complete=false;continue;}
          let sourcesValid=true;
          for(const [id,token] of turn.sources){
            const [row]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${id},${token},${true})`;
            if(!row?.allowed||counter(row.out_retention_revision)!==scope.deletionRevision){sourcesValid=false;break;}
          }
          if(!sourcesValid){complete=false;continue;}
          for(const task of candidate.tasks){
            const current=scope.tasks.get(taskIndex(scope,task.task_key));
            if(current&&!current.incomplete&&current.fingerprint===taskFingerprint(scope,task))prior.set(task.task_key,task);
            else if(!current||current.incomplete)complete=false;
          }
          focus=candidate.focus_keys.filter(key=>prior.has(key));
        }
        if(prior.size!==scope.tasks.size)complete=false;
        return {state:parsed,runtime_focus:{tasks:[...prior.values()],focus_keys:focus,complete}};
      }));
      const event={event_id:receipt.event_id,entry:value.entry,text:value.text,reference:`host-interaction:${receipt.event_id}`,received_at:receipt.recorded_at};
      const minted=new Map<number,string>();
      const mint=async(ordinal:number)=>{
        if(!Number.isInteger(ordinal)||ordinal<0||ordinal>=256)return unavailable();
        const existing=minted.get(ordinal);if(existing)return existing;
        const key=await this.mintTaskKey(ticket,credential,`${receipt.event_id}:${ordinal}`);minted.set(ordinal,key);return key;
      };
      let interpreting=true;
      const readTaskEvidence=async(taskKey:string,window:{page_size:number;from:string;to:string;cursor:string|null})=>{
        if(!interpreting)return unavailable();
        const proof=eventProofs.get(receipt);if(!proof||proof.scope!==scope)return unavailable();
        const request=structuredClone(window);interpreterReads.set(request,{scope,eventId:proof.eventId,token:proof.token});
        return this.readTaskEvidenceCandidate(ticket,credential,taskKey,request);
      };
      let interpreted:{tasks:unknown;focus_keys:unknown};
      try {
        interpreted=await interpret({event:structuredClone(event),state:structuredClone(context.state),runtime_focus:structuredClone(context.runtime_focus),
          mint_task_key:mint,read_task_evidence:readTaskEvidence});
      } finally {interpreting=false;}
      const proposed=parseDCContract("open-turn",{runtime_contract_version:"0.1.0",trip_id:scope.tripId,expected_revision:context.state.revision,event,tasks:interpreted.tasks,focus_keys:interpreted.focus_keys});
      const priorKeys=new Set(context.runtime_focus.tasks.map(task=>task.task_key)),newKeys=new Set(minted.values());
      for(const task of proposed.tasks){
        const continuing=["continue","focus","resume","reopen"].includes(task.relation);
        if(continuing?!priorKeys.has(task.task_key):!newKeys.has(task.task_key))return unavailable();
      }
      const registration=await this.registerTaskIdentity(ticket,credential,receipt,{expected_revision:context.state.revision,tasks:proposed.tasks,focus_keys:proposed.focus_keys});
      return parseDCContract("turn",{runtime_contract_version:"0.1.0",runtime_id:registration.runtime_id,turn_id:registration.turn_id,revision:registration.revision,
        tasks:proposed.tasks,focus_keys:proposed.focus_keys,checkpoint_ack:null});
    },
    /** Explicit trusted-host correction batch. One failed member rolls back all. */
    async unlinkTaskSourcesBatchCandidate(ticket:object,credential:Headers,raw:unknown) {
      let copy:unknown;try{copy=structuredClone(raw);}catch{return unavailable();}
      const parsed=unlinkBatchInput.safeParse(copy);if(!parsed.success)return unavailable();
      const commands=parsed.data,{scope,headers}=await scoped(ticket,credential);
      return exclusive(scope,async()=>{
        const seen=new Set<string>(),seenOperations=new Set<string>(),batchEvent=commands[0].event_id;
        const checked=commands.map(command=>{
          const taskToken=taskIndex(scope,command.task_key),task=scope.tasks.get(taskToken);
          const turn=[...scope.turns.values()].find(item=>item.result.turn_id===command.source_turn_id);
          const eventToken=task?.sources.get(command.event_id);
          if(command.event_id!==batchEvent||!task||!turn?.sources.has(command.event_id)||!eventToken||
            seen.has(taskToken)||seenOperations.has(command.idempotency_key))return deny();
          seen.add(taskToken);seenOperations.add(command.idempotency_key);
          const operation=createHmac("sha256",keySecret).update("association-correction\0")
            .update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,command.idempotency_key])).digest("hex");
          return {command,taskToken,eventToken,operation};
        });
        const results=await db.$transaction(async tx=>{
          await tx.$queryRaw`SELECT 1 FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
          try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
          const rows:UnlinkRow[]=[];
          for(const {command,taskToken,eventToken,operation} of checked){
            const [row]=await tx.$queryRaw<UnlinkRow[]>`SELECT * FROM public.host_evidence_unlink_task_source_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},
              ${scope.workspaceKey},${scope.capability},${command.task_key},${taskToken},${command.event_id},${eventToken},
              ${command.source_turn_id},${BigInt(command.expected_association_revision)},${operation})`;
            if(!row||row.disposition==="denied")return deny();
            if(row.disposition==="conflict")throw new EvidenceBoundaryError("ASSOCIATION_CONFLICT");
            rows.push(row);
          }
          if(rows.some(row=>row.disposition!==rows[0].disposition))throw new EvidenceBoundaryError("ASSOCIATION_CONFLICT");
          try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
          return rows;
        });
        const revision=counter(results.at(-1)!.out_retention_revision),affected=new Set(checked.map(item=>item.taskToken));
        for(const token of affected){const memory=scope.tasks.get(token);if(memory)memory.incomplete=true;}
        for(const packet of [...scope.packets.values()])if(affected.has(packet.taskHash))packet.invalidate();
        return results.map((row,index)=>({action:"unlink" as const,task_key:commands[index].task_key,event_id:commands[index].event_id,
          association_revision:counter(row.out_association_revision),retention_revision:revision,
          replayed:row.disposition==="replayed"}));
      });
    },
    /** Single-source convenience wrapper; model text cannot call this path. */
    async unlinkTaskSourceCandidate(ticket:object,credential:Headers,raw:unknown) {
      return (await this.unlinkTaskSourcesBatchCandidate(ticket,credential,[raw]))[0];
    },
    /** Same-Task, older-event to newer-event correction; no semantic inference. */
    async supersedeTaskSourceCandidate(ticket:object,credential:Headers,raw:unknown) {
      let copy:unknown;try{copy=structuredClone(raw);}catch{return unavailable();}
      const parsed=supersedeInput.safeParse(copy);if(!parsed.success||parsed.data.old_event_id===parsed.data.replacement_event_id)return unavailable();
      const command=parsed.data,{scope,headers}=await scoped(ticket,credential);
      return exclusive(scope,async()=>{
        const taskToken=taskIndex(scope,command.task_key),task=scope.tasks.get(taskToken);
        const oldTurn=scope.turns.get(command.old_event_id),newTurn=scope.turns.get(command.replacement_event_id);
        const proofToken=(eventId:string)=>{
          const direct=task?.sources.get(eventId);if(direct)return direct;
          for(const receipt of scope.receipts.get(eventId)??[]){const proof=eventProofs.get(receipt);if(proof?.scope===scope)return proof.token;}
          return undefined;
        };
        const oldToken=proofToken(command.old_event_id),newToken=task?.sources.get(command.replacement_event_id);
        if(!task||task.incomplete||!oldToken||!newToken||oldTurn?.result.turn_id!==command.old_source_turn_id||
          newTurn?.result.turn_id!==command.replacement_source_turn_id||!oldTurn.sources.has(command.old_event_id)||
          !newTurn.sources.has(command.replacement_event_id))return deny();
        const operation=createHmac("sha256",keySecret).update("association-supersede\0")
          .update(canonicalJson([scope.ownerId,scope.tripId,scope.workspaceKey,command.idempotency_key])).digest("hex");
        const [result]=await db.$transaction(async tx=>{
          await tx.$queryRaw`SELECT 1 FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
          try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
          const rows=await tx.$queryRaw<SupersedeRow[]>`SELECT * FROM public.host_evidence_supersede_task_source_candidate(
            ${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${command.task_key},${taskToken},
            ${command.old_event_id},${oldToken},${command.old_source_turn_id},${command.replacement_event_id},${newToken},
            ${command.replacement_source_turn_id},${BigInt(command.expected_association_revision)},${operation})`;
          try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
          return rows;
        });
        if(!result||result.disposition==="denied")return deny();
        if(result.disposition==="conflict")throw new EvidenceBoundaryError("ASSOCIATION_CONFLICT");
        task.sources.delete(command.old_event_id);
        for(const packet of [...scope.packets.values()])if(packet.taskHash===taskToken)packet.invalidate();
        return {action:"supersede" as const,task_key:command.task_key,old_event_id:command.old_event_id,
          replacement_event_id:command.replacement_event_id,association_revision:counter(result.out_association_revision),
          retention_revision:counter(result.out_retention_revision),replayed:result.disposition==="replayed"};
      });
    },
    /** Internal bounded historical source page; never a new instruction or write grant. */
    async readTaskEvidenceCandidate(ticket:object,credential:Headers,taskKey:string,raw:unknown):Promise<EvidencePage> {
      const pending=raw&&typeof raw==="object"?interpreterReads.get(raw):undefined;
      let input:unknown;try{input=structuredClone(raw);}catch{return unavailable();}
      const request=z.strictObject({page_size:z.number().int().min(1).max(PAGE_LIMIT),from:z.iso.datetime({offset:true}),
        to:z.iso.datetime({offset:true}),cursor:z.string().nullable()}).safeParse(input);
      if(!request.success||typeof taskKey!=="string"||!/^task-[0-9a-f]{32}$/.test(taskKey))return unavailable();
      const from=new Date(request.data.from),to=new Date(request.data.to);
      checkReadWindow(request.data.page_size,from,to);
      const fromTick=instantAttoseconds(request.data.from),toTick=instantAttoseconds(request.data.to);
      if(toTick<fromTick||toTick-fromTick>BigInt(MAX_WINDOW_MS)*1_000_000_000_000n)return unavailable();
      const {scope,headers}=await scoped(ticket,credential),taskToken=taskIndex(scope,taskKey);
      return exclusive(scope,async()=>{
        let committedDeadline=process.hrtime.bigint()+BigInt(CURSOR_TTL_MS)*1_000_000n;
        const page:EvidencePage=await db.$transaction(async tx=>{
        const [document]=await tx.$queryRaw<Array<{revision:bigint}>>`SELECT "revision" FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        if(!document)return deny();
        const task=scope.tasks.get(taskToken);
        if(!task||task.incomplete||task.sources.size<1||task.sources.size>256)
          throw new EvidenceBoundaryError(request.data.cursor===null?"EVIDENCE_UNAVAILABLE":"EVIDENCE_CURSOR_STALE");
        if(pending&&pending.scope!==scope)return unavailable();
        const [snapshot]=await tx.$queryRaw<TaskSnapshotRow[]>`SELECT * FROM public.host_evidence_task_snapshot_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${taskKey},${taskToken},${pending?.eventId??null},${pending?.token??null})`;
        const stale=()=>{throw new EvidenceBoundaryError(request.data.cursor===null?"EVIDENCE_UNAVAILABLE":"EVIDENCE_CURSOR_STALE");};
        if(!snapshot?.ok||counter(snapshot.out_retention_revision)!==scope.deletionRevision||task.retentionRevision!==scope.deletionRevision)return stale();
        const sourceShape=z.array(z.strictObject({event_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),
          event_token:z.string().regex(/^[0-9a-f]{64}$/),sequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          recorded_at:z.iso.datetime({offset:true})})).max(256);
        const sources=sourceShape.safeParse(snapshot.out_sources);
        if(!sources.success||sources.data.length!==task.sources.size||sources.data.some(row=>task.sources.get(row.event_id)!==row.event_token))return stale();
        const highwater=counter(snapshot.out_highwater),association=counter(snapshot.out_association_revision);
        const cursorScope={owner_id:scope.ownerId,trip_id:scope.tripId,workspace_key:scope.workspaceKey,task_key:taskKey};
        let after=0;
        if(request.data.cursor!==null){
          const opened=openPageCursor(request.data.cursor);
          if(opened.from!==request.data.from||opened.to!==request.data.to||opened.cursor.high_watermark!==highwater)throw new EvidenceBoundaryError("EVIDENCE_CURSOR_STALE");
          after=checkCursor(opened.cursor,cursorScope,new Date(),{association,retention:scope.deletionRevision}).after_sequence;
        }
        const partial=():EvidencePage=>({events:[],cursor:null,complete:false,status:"partial",authority:"historical_evidence_only"});
        const incomplete=():EvidencePage=>request.data.cursor===null?partial():cursorStale();
        if(counter(snapshot.out_unlinked_count)>0)return incomplete();
        let deadline=process.hrtime.bigint()+BigInt(CURSOR_TTL_MS)*1_000_000n;
        for(const source of sources.data){
          const started=process.hrtime.bigint();
          const [row]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${source.event_id},${source.event_token},${true})`;
          if(!row?.allowed||counter(row.out_retention_revision)!==scope.deletionRevision||row.out_valid_for_ms===null||row.out_valid_for_ms<=1n)return incomplete();
          const until=started+(row.out_valid_for_ms-1n)*1_000_000n;if(until<deadline)deadline=until;
        }
        const matching=sources.data.filter(source=>source.sequence>after&&source.sequence<=highwater&&
          instantAttoseconds(source.recorded_at)>=fromTick&&instantAttoseconds(source.recorded_at)<=toTick);
        const chosen=matching.slice(0,request.data.page_size),events:EvidencePage["events"]=[];
        for(const source of chosen){
          const started=process.hrtime.bigint();
          const [row]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${source.event_id},${source.event_token},${false})`;
          if(!row?.allowed||!row.out_entry||!row.out_body||!row.out_received_at||row.out_valid_for_ms===null||row.out_valid_for_ms<=1n)return incomplete();
          const until=started+(row.out_valid_for_ms-1n)*1_000_000n;if(until<deadline)deadline=until;
          events.push({owner_id:scope.ownerId,trip_id:scope.tripId,workspace_key:scope.workspaceKey,task_key:taskKey,
            event_id:source.event_id,text:row.out_body,entry:row.out_entry,received_at:row.out_received_at.toISOString(),
            recorded_at:source.recorded_at,sequence:source.sequence,source_reference:`host-interaction:${source.event_id}`,association_revision:association});
        }
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        if(process.hrtime.bigint()>=deadline)return incomplete();
        committedDeadline=deadline;
        const more=matching.length>chosen.length,cursor=more&&chosen.length?sealPageCursor({cursor:{...cursorScope,high_watermark:highwater,
          after_sequence:chosen.at(-1)!.sequence,association_revision:association,retention_revision:scope.deletionRevision,
          expires_at:new Date(Date.now()+CURSOR_TTL_MS).toISOString()},from:request.data.from,to:request.data.to}):null;
        return {events,cursor,complete:!more,status:"complete" as const,authority:"historical_evidence_only" as const};
        });
        if(process.hrtime.bigint()>=committedDeadline)return request.data.cursor===null?
          {events:[],cursor:null,complete:false,status:"partial",authority:"historical_evidence_only"}:cursorStale();
        return page;
      });
    },
    /**
     * Assemble a registered live Turn against the authorized current TS
     * snapshot, returning metadata only. No Packet, text, delivery proof,
     * grant or authorization to write leaves this internal candidate.
     */
    async inspectLivePacketCandidate(ticket: object, credential: Headers, turnId: string, taskKey: string, bodyBudgetBytes: number, raw: unknown) {
      let snapshot:unknown; try { snapshot=structuredClone(raw); } catch { return unavailable(); }
      const {scope,headers}=await scoped(ticket,credential);
      const request=parseDCContract("assemble",{runtime_contract_version:"0.1.0",turn_id:turnId,task_key:taskKey,body_budget_bytes:bodyBudgetBytes});
      const input=identityInput.safeParse(snapshot); if (!input.success) return unavailable();
      return exclusive(scope,async()=> {
        const found=[...scope.turns.entries()].find(([,entry])=>entry.result.turn_id===request.turn_id);
        if (!found || closed || scope.disposed) return deny();
        const [eventId,registered]=found;
        const eventToken=registered.sources.get(eventId); if (!eventToken) return unavailable();
        try {
          const result=await db.$transaction(async tx=> {
            const [document]=await tx.$queryRaw<Array<{revision:bigint;snapshot:string}>>`SELECT "revision", "snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
            try { await host.guard!(scope.tripId,headers,tx); } catch { return deny(); }
            if (!document) return deny();
            const read=async(id:string,token:string,metadata:boolean)=> {
              const [row]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${id},${token},${metadata})`;
              if (!row?.allowed || counter(row.out_retention_revision)!==scope.deletionRevision) return unavailable();
              return row;
            };
            const source=await read(eventId,eventToken,false);
            if (!source.out_entry || !source.out_body || !source.out_received_at) return unavailable();
            for (const [id,token] of registered.sources) await read(id,token,true);
            const state=parseStateReferences(decodeCommandJson(document.snapshot)); checkStateCounters(state);
            // Until the real write bridge tracks this input's processing, do
            // not label it unprocessed against a newer business revision.
            if (state.trip_id!==scope.tripId || BigInt(state.revision)!==document.revision || state.revision!==registered.result.revision) return unavailable();
            // Reconstruct the original registration from the stored event and
            // caller's candidate, then authenticate its full content against
            // the host-held keyed digest. No raw Task snapshot is retained.
            const body=parseDCContract("open-turn",{runtime_contract_version:"0.1.0",trip_id:scope.tripId,expected_revision:input.data.expected_revision,
              event:{event_id:eventId,entry:source.out_entry,text:source.out_body,reference:`host-interaction:${eventId}`,received_at:source.out_received_at.toISOString()},
              tasks:input.data.tasks,focus_keys:input.data.focus_keys});
            if (body.expected_revision!==registered.result.revision ||
                createHmac("sha256",keySecret).update(canonicalJson(body),"utf8").digest("hex")!==registered.digest) return unavailable();
            const task=body.tasks.find(item=>item.task_key===request.task_key),current=scope.tasks.get(taskIndex(scope,request.task_key));
            if (!task || !current || current.incomplete || current.retentionRevision!==scope.deletionRevision ||
                current.fingerprint!==taskFingerprint(scope,task)) return unavailable();
            const taskToken=taskIndex(scope,request.task_key);await taskSourcesCurrent(tx,scope,taskToken,current.sources);
            const turn=parseDCContract("turn",{runtime_contract_version:"0.1.0",runtime_id:scope.runtimeId,turn_id:registered.result.turn_id,
              revision:registered.result.revision,tasks:body.tasks,focus_keys:body.focus_keys,checkpoint_ack:null});
            const pending={event:{event_id:eventId,entry:source.out_entry,text:source.out_body,reference:`host-interaction:${eventId}`,received_at:source.out_received_at.toISOString()},
              base_revision:registered.result.revision,processing_status:"unprocessed" as const,proposal_id:null,result_revision:registered.result.revision,errors:[]};
            const now=new Date(),assembly=assembleContextSnapshot(state,task.task_key,task.target_ids,now);
            const candidate=buildPacketCandidate({request,packetId:`packet-${randomUUID().replaceAll("-","")}`,task,pending,assembly,state,now,
              recoveredInput:false,saveUnacknowledged:scope.pendingSaveSticky || scope.pendingSaves.size>0 || scope.inflightSaves>0});
            checkPacketTurn(candidate,turn,pending);
            const recheck=async()=> {
              for (const [id,token] of registered.sources) await read(id,token,true);
              await taskSourcesCurrent(tx,scope,taskToken,current.sources);
              try { await host.guard!(scope.tripId,headers,tx); } catch { return deny(); }
              validateContextSnapshot(assembly,state,new Date());
            };
            await recheck();
            // Test hook only: openEvidenceHost rejects all hooks outside the
            // test environment. It is not a production delivery barrier.
            if(testHooks?.onLivePacketCandidate) await testHooks.onLivePacketCandidate(structuredClone(candidate),recheck,invalidate=> {
              if(typeof invalidate!=="function"||scope.packetInvalidators.size>=256)return unavailable();
              scope.packetInvalidators.add(invalidate); return ()=>scope.packetInvalidators.delete(invalidate);
            });
            await recheck();
            return {state_revision:state.revision,selected_count:assembly.objects.length,body_count:candidate.packet.objects.length,
              deferred_count:candidate.packet.deferred_ids.length,coverage:candidate.packet.coverage};
          });
          if (closed || scope.disposed) return deny();
          return result;
        } catch(error) { invalidatePackets(scope); if (error instanceof EvidenceBoundaryError) throw error; return unavailable(); }
      });
    },
    /** Internal socket integration candidate; not mounted on a public route. */
    async sendLivePacketCandidate(ticket:object,credential:Headers,turnId:string,taskKey:string,bodyBudgetBytes:number,raw:unknown,response:ServerResponse) {
      let input:unknown;try {input=structuredClone(raw);} catch {return unavailable();}
      const {scope,headers}=await scoped(ticket,credential),credentialCopy=new Headers({cookie:headers.get("cookie")??""});
      const lease=raw===undefined?turnInput(scope,turnId):undefined;if(lease)input=lease.value;
      if(!(response instanceof ServerResponse))return unavailable();
      const taskHash=taskIndex(scope,taskKey);let record:PacketMemory|undefined;
      try {
        const handoff=await exclusive(scope,async()=>db.$transaction(async tx=> {
          for(const item of scope.packets.values())if(item.expiresAt<=Date.now())item.invalidate();
          if(scope.packets.size>=256)return unavailable();
          if(lease)checkTurnLease(scope,turnId,lease.id);
          const built=await packetFromCurrent(tx,scope,headers,input,turnId,taskHash,bodyBudgetBytes);
          const holder:{value?:PacketMemory}={};
          const tracker=createShortPacketHandoffCandidate(built.candidate,async()=>{if(!holder.value?.postflight)return unavailable();await holder.value.postflight();});
          const invalidate=()=>{memory.postflight=null;tracker.invalidate();scope.packets.delete(memory.packetId);scope.packetInvalidators.delete(invalidate);};
          const memory:PacketMemory={packetId:built.candidate.packet.packet_id,turnId,taskHash,budget:bodyBudgetBytes,at:built.at,contextId:built.candidate.assembly.context.id,
            expiresAt:Math.min(built.at+300_000,Date.parse(built.candidate.assembly.context.expires_at)),warning:built.warning,runtimeId:scope.runtimeId,
            packet:structuredClone(built.candidate.packet),grants:new Map(),proposalId:null,tracker,postflight:null,invalidate};
          holder.value=memory;
          record=memory;scope.packets.set(memory.packetId,memory);scope.packetInvalidators.add(invalidate);
          memory.postflight=async()=> {
            const next=await scoped(ticket,credentialCopy);if(next.scope!==scope||scope.packets.get(memory.packetId)!==memory)return deny();
            if(lease)checkTurnLease(scope,turnId,lease.id);
            await exclusive(scope,async()=>db.$transaction(async postTx=>{const current=await packetFromCurrent(postTx,scope,next.headers,input,turnId,taskHash,bodyBudgetBytes,memory);await current.recheck();}));
          };
          await testHooks?.beforePacketHandoff?.(); await built.recheck();
          if(testHooks?.afterFinalPacketCheck)await testHooks.afterFinalPacketCheck();
          if(lease)checkTurnLease(scope,turnId,lease.id);
          return tracker.beginPacket(response,built.candidate,built.deadline());
        }));
        try {await testHooks?.afterPacketHandoffCommit?.();await handoff.afterCommit();return {packet_id:record!.packetId};} finally {if(record)record.postflight=null;}
      } catch(error) {record?.invalidate();if(error instanceof EvidenceBoundaryError)throw error;return unavailable();}
    },
    /** Independent internal page candidate; task material is revalidated, never cached in the ledger. */
    async sendLivePacketPageCandidate(ticket:object,credential:Headers,pageValue:unknown,raw:unknown,response:ServerResponse) {
      let input:unknown,pageInput:unknown;try {input=structuredClone(raw);pageInput=structuredClone(pageValue);} catch{return unavailable();}
      const {scope,headers}=await scoped(ticket,credential),credentialCopy=new Headers({cookie:headers.get("cookie")??""});
      const page=parseDCContract("page-request",pageInput);if(!(response instanceof ServerResponse))return unavailable();
      let record:PacketMemory|undefined,ownsPostflight=false;
      try {
        const handoff=await exclusive(scope,async()=>db.$transaction(async tx=> {
          record=scope.packets.get(page.packet_id);
          const memory=record;if(!memory||memory.runtimeId!==scope.runtimeId||memory.expiresAt<=Date.now()||memory.postflight)return unavailable();
          ownsPostflight=true;
          const lease=raw===undefined?turnInput(scope,memory.turnId):undefined;if(lease)input=lease.value;
          const built=await packetFromCurrent(tx,scope,headers,input,memory.turnId,memory.taskHash,memory.budget,memory);
          memory.postflight=async()=> {
            const next=await scoped(ticket,credentialCopy);if(next.scope!==scope||scope.packets.get(memory.packetId)!==memory)return deny();
            if(lease)checkTurnLease(scope,memory.turnId,lease.id);
            await exclusive(scope,async()=>db.$transaction(async postTx=>{const current=await packetFromCurrent(postTx,scope,next.headers,input,memory.turnId,memory.taskHash,memory.budget,memory);await current.recheck();}));
          };
          await testHooks?.beforePacketHandoff?.();await built.recheck();const now=new Date();
          if(testHooks?.afterFinalPacketCheck)await testHooks.afterFinalPacketCheck();
          if(lease)checkTurnLease(scope,memory.turnId,lease.id);
          return memory.tracker.beginPage(response,built.candidate,page,{state:built.state,now},{state:built.state,now},built.deadline());
        }));
        try {await testHooks?.afterPacketHandoffCommit?.();await handoff.afterCommit();return {packet_id:record!.packetId};} finally {if(record)record.postflight=null;}
      } catch(error) {if(ownsPostflight)record?.invalidate();if(error instanceof EvidenceBoundaryError)throw error;return unavailable();}
    },
    /** Routing hint only. It grants no read and is checked again by sendLivePacketPageCandidate. */
    hasLocalPacketCandidate(ticket:object,packetId:string) {
      const scope=ticket&&typeof ticket==="object"?workspaces.get(ticket):undefined;
      return !!scope&&!scope.disposed&&!closed&&scope.packets.has(packetId);
    },
    /**
     * Server-only read for NAP. The caller supplies only an opaque host ticket
     * and Packet ID; the Packet body always comes from this host's private
     * registry and is rebuilt against the current Session, Trip State, task
     * evidence, runtime generation and expiry before it is returned.
     */
    async readTrustedPacketBatchCandidate(ticket:object,credential:Headers,packetIds:readonly string[]) {
      return readTrustedPacketBatch(ticket,credential,packetIds);
    },
    async readTrustedPacketCandidate(ticket:object,credential:Headers,packetId:string) {
      const batch=await readTrustedPacketBatch(ticket,credential,[packetId]);
      return {runtime_id:batch.runtime_id,packet:batch.packets[0]};
    },
    async saveDecisionPlanCandidate(ticket:object,credential:Headers,requestValue:TrustedDecisionRequest,planValue:DecisionPlan){
      let request:TrustedDecisionRequest,plan:DecisionPlan;
      try{request=structuredClone(requestValue);plan=structuredClone(planValue);validatePlanRequestConsistency(request,plan);}catch{return unavailable();}
      const batch=await readTrustedPacketBatch(ticket,credential,request.packets.map(packet=>packet.packet_id));
      const trusted={...request,runtime_id:batch.runtime_id,packets:batch.packets};
      if(canonicalJson(trusted)!==canonicalJson(request))return unavailable();
      const {scope,headers}=await scoped(ticket,credential);
      return exclusive(scope,async()=>db.$transaction(async tx=>{
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        const [document]=await tx.$queryRaw<Array<{revision:bigint;now:Date}>>`SELECT "revision",clock_timestamp() AS now FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
        if(!document||scope.runtimeId!==request.runtime_id||document.revision!==BigInt(plan.basis[0].state_revision)||
          plan.basis.some(basis=>new Date(basis.expires_at).getTime()<=document.now.getTime()))return unavailable();
        return saveDecisionPlan(tx,{ownerId:scope.ownerId,tripId:scope.tripId,workspaceKey:scope.workspaceKey,runtimeId:scope.runtimeId},request,plan);
      }));
    },
    async claimDecisionStepCandidate(ticket:object,credential:Headers,decisionId:string,actionId:string,stepId:string){
      const {scope,headers}=await scoped(ticket,credential);
      return exclusive(scope,async()=>db.$transaction(async tx=>{
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        const [document]=await tx.$queryRaw<Array<{revision:bigint;now:Date}>>`SELECT "revision",clock_timestamp() AS now FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
        if(!document)return unavailable();
        return claimDecisionStep(tx,{ownerId:scope.ownerId,tripId:scope.tripId,workspaceKey:scope.workspaceKey,runtimeId:scope.runtimeId},
          Number(document.revision),document.now,decisionId,actionId,stepId,randomUUID());
      }));
    },
    async readDecisionRecordCandidate(ticket:object,credential:Headers,decisionId:string){
      const {scope,headers}=await scoped(ticket,credential);
      return db.$transaction(async tx=>{
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        return readDecisionRecord(tx,{ownerId:scope.ownerId,tripId:scope.tripId,workspaceKey:scope.workspaceKey,runtimeId:scope.runtimeId},decisionId);
      });
    },
    async markDecisionExecutionUnknownCandidate(ticket:object,credential:Headers,decisionId:string,actionId:string,stepId:string,claimToken:string){
      const {scope,headers}=await scoped(ticket,credential);
      return exclusive(scope,async()=>db.$transaction(async tx=>{
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        return markExecutionUnknown(tx,{ownerId:scope.ownerId,tripId:scope.tripId,workspaceKey:scope.workspaceKey,runtimeId:scope.runtimeId},
          decisionId,actionId,stepId,claimToken);
      }));
    },
    async authorizeTicketCandidate(ticket:object,credential:Headers) {await scoped(ticket,credential);},
    async authorizeTripCandidate(tripId:string,credential:Headers) {
      const current=await authorized(tripId,credential);
      return createHmac("sha256",routingSecret).update(canonicalJson([current.ownerId,current.sessionId,tripId]),"utf8").digest("hex");
    },
    /** The actual User grant remains private to this host and is rechecked in the Trip State transaction. */
    async authorizeUserChangeCandidate(ticket:object,credential:Headers,value:unknown) {
      const body=structuredClone(parseDCContract("change",value)),{scope,headers}=await scoped(ticket,credential);
      return exclusive(scope,async()=> {
        const memory=writePacket(scope,body.packet_id);
        const operation:WriteOperation={kind:"change",scope,headers,body,memory,role:"user"};
        try {
          return await db.$transaction(async tx=> {
            const {built,deliveredIds}=await currentWritePacket(tx,operation);
            checkChangeRules(body,built.candidate.packet,{turnId:memory.turnId,event:built.candidate.packet.pending_input.event,recovered:false},deliveredIds);
            const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
            if(!clock)return unavailable();
            const expiresAt=new Date(Math.min(memory.expiresAt,built.deadline().wallMs,clock.now.getTime()+300_000)).toISOString();
            const grant:WriteGrant={principalId:userActorId(scope.ownerId),eventId:built.candidate.packet.pending_input.event.event_id,
              requestDigest:digest(body.request),revision:body.request.expected_revision,expiresAt,runtimeId:scope.runtimeId};
            checkGrantFields(grant,{principalId:grant.principalId,eventId:grant.eventId,request:body.request,now:clock.now.toISOString(),runtimeId:scope.runtimeId});
            if(!memory.grants.has(body.request.idempotency_key)&&memory.grants.size>=64)return unavailable();
            memory.grants.set(body.request.idempotency_key,grant);
            return {packet_id:memory.packetId,turn_id:memory.turnId,expires_at:expiresAt};
          });
        } catch(error) {
          if(error instanceof EvidenceBoundaryError&&error.code==="EVIDENCE_ACCESS_DENIED")throw new TripStateContractError("PERMISSION","Access denied");
          if(error instanceof EvidenceBoundaryError)throw new BridgeRuleError("PACKET_STALE");
          throw error;
        }
      });
    },
    /** Internal bridge. The opaque workspace ticket and Cookie Session never come from request JSON. */
    createTransactionalBridgeCandidate(ticket:object,credential:Headers):TransactionalBridgeHost {
      const credentialCopy=new Headers({cookie:credential.get("cookie")??""});
      return {
        async change(body,action) {
          const {scope,headers}=await scoped(ticket,credentialCopy);
          return exclusive(scope,async()=> {
            const current=await changeScope(scope,headers,body);
            let used=false;
            return action(current.bridge,async(role,request)=> {
              if(used||role!==current.operation.role||canonicalJson(request)!==canonicalJson(body.request))throw new BridgeRuleError("WRITE_GRANT");
              used=true;
              const result=await executeWrite(current.operation,request);
              if(result.outcome==="pending_confirmation"&&result.proposal_id)current.operation.memory.proposalId=result.proposal_id;
              return result;
            });
          });
        },
        async confirm(body,action) {
          const {scope,headers}=await scoped(ticket,credentialCopy);
          return exclusive(scope,async()=> {
            const memory=[...scope.packets.values()].find(item=>item.turnId===body.turn_id&&item.proposalId===body.proposal_id);
            if(!memory)throw new BridgeRuleError("PROPOSAL_BINDING");
            const operation:WriteOperation={kind:"confirm",scope,headers,body,memory,role:"user"};
            await db.$transaction(async tx=> {
              try {await host.guard!(scope.tripId,headers,tx);} catch {return deny();}
              if(!await writeReplay(tx,operation)) {
                await currentWritePacket(tx,operation);
                checkConfirmationRules(body,{turnId:memory.turnId,proposalId:memory.proposalId,recovered:false});
              }
            });
            let used=false;
            return action({turnId:memory.turnId,proposalId:memory.proposalId,recovered:false},async(proposalId,request)=> {
              if(used||proposalId!==body.proposal_id||canonicalJson(request)!==canonicalJson(body.request))throw new BridgeRuleError("PROPOSAL_BINDING");
              used=true;return executeWrite(operation,request,proposalId);
            });
          });
        },
      };
    },
    /** Send a registered Turn while its Session, source and state locks are held. */
    async sendTurnCandidate(ticket:object,credential:Headers,value:unknown,response:ServerResponse) {
      const turn=parseDCContract("turn",value),{scope,headers}=await scoped(ticket,credential);
      if(!(response instanceof ServerResponse)||response.headersSent||response.destroyed)return unavailable();
      try {await exclusive(scope,async()=>db.$transaction(async tx=>{
        const found=[...scope.turns.entries()].find(([,entry])=>entry.result.turn_id===turn.turn_id);
        if(!found||turn.runtime_id!==scope.runtimeId)return deny();
        const [eventId,registered]=found,lease=turnInput(scope,turn.turn_id),parsed=identityInput.safeParse(lease.value);
        if(!parsed.success)return unavailable();
        const [document]=await tx.$queryRaw<Array<{revision:bigint;snapshot:string}>>`SELECT "revision","snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        if(!document||document.revision!==BigInt(registered.result.revision)||turn.revision!==registered.result.revision)return unavailable();
        const state=parseStateReferences(decodeCommandJson(document.snapshot));checkStateCounters(state);
        if(state.trip_id!==scope.tripId||BigInt(state.revision)!==document.revision)return unavailable();
        let deadline=process.hrtime.bigint()+300_000_000_000n,wall=Date.now()+300_000;
        const read=async(id:string,token:string,metadata:boolean)=>{
          const started=process.hrtime.bigint(),startedWall=Date.now();
          const [row]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${id},${token},${metadata})`;
          if(!row?.allowed||counter(row.out_retention_revision)!==scope.deletionRevision||row.out_valid_for_ms===null||row.out_valid_for_ms<=1n)return unavailable();
          const bounded=row.out_valid_for_ms>300_001n?300_000n:row.out_valid_for_ms-1n;
          const end=started+bounded*1_000_000n;if(end<deadline)deadline=end;
          const wallEnd=startedWall+Number(bounded);if(wallEnd<wall)wall=wallEnd;
          return row;
        };
        const token=registered.sources.get(eventId);if(!token)return unavailable();
        const source=await read(eventId,token,false);
        if(!source.out_entry||!source.out_body||!source.out_received_at)return unavailable();
        for(const [id,key] of registered.sources)await read(id,key,true);
        const body=parseDCContract("open-turn",{runtime_contract_version:"0.1.0",trip_id:scope.tripId,expected_revision:parsed.data.expected_revision,
          event:{event_id:eventId,entry:source.out_entry,text:source.out_body,reference:`host-interaction:${eventId}`,received_at:source.out_received_at.toISOString()},
          tasks:parsed.data.tasks,focus_keys:parsed.data.focus_keys});
        if(createHmac("sha256",keySecret!).update(canonicalJson(body),"utf8").digest("hex")!==registered.digest||
          canonicalJson([turn.tasks,turn.focus_keys])!==canonicalJson([body.tasks,body.focus_keys]))return unavailable();
        for(const task of body.tasks){
          const token=taskIndex(scope,task.task_key),current=scope.tasks.get(token);
          if(!current||current.incomplete||current.retentionRevision!==scope.deletionRevision||current.fingerprint!==taskFingerprint(scope,task))return unavailable();
          await taskSourcesCurrent(tx,scope,token,current.sources);
        }
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        checkTurnLease(scope,turn.turn_id,lease.id);
        const bytes=Buffer.from(JSON.stringify(turn),"utf8");
        if(process.hrtime.bigint()>=deadline||Date.now()>=wall)return unavailable();
        response.writeHead(200,{"content-type":"application/json; charset=utf-8","content-length":bytes.length,"cache-control":"private, no-store, max-age=0","x-content-type-options":"nosniff","vary":"Cookie"});
        if(process.hrtime.bigint()>=deadline||Date.now()>=wall){response.destroy();return unavailable();}
        response.end(bytes);
      }));} catch(error){if(response.headersSent)response.destroy();if(error instanceof EvidenceBoundaryError)throw error;return unavailable();}
    },
    /** Builds the formal scene payload from host-held Task/Event state; HTTP never supplies it. */
    async saveSceneCandidate(ticket:object,credential:Headers,value:unknown) {
      const body=parseDCContract("scene-save",value),{scope,headers}=await scoped(ticket,credential);
      if(body.workspace_key!==scope.workspaceKey)return deny();
      const payload=await exclusive(scope,async()=>db.$transaction(async tx=>{
        const [document]=await tx.$queryRaw<Array<{revision:bigint;snapshot:string}>>`SELECT "revision","snapshot"::text AS snapshot FROM "TripStateDocument" WHERE "tripId"=${scope.tripId} FOR SHARE`;
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        if(!document)return deny();
        const state=parseStateReferences(decodeCommandJson(document.snapshot));checkStateCounters(state);
        if(state.trip_id!==scope.tripId||BigInt(state.revision)!==document.revision||!body.focus_keys.length)return unavailable();
        const tasks:CheckpointPayload["tasks"]=[];
        for(const taskKey of body.focus_keys){
          const token=taskIndex(scope,taskKey),memory=scope.tasks.get(token);if(!memory||memory.incomplete)return unavailable();
          let selected:DecisionContextContracts["open-turn"]|undefined;
          const candidates=[...scope.turns.entries()].filter(([,row])=>row.result.revision===state.revision).sort(([,a],[,b])=>b.sequence-a.sequence);
          for(const [eventId,row] of candidates){
            try{
              const opened=identityInput.safeParse(turnInput(scope,row.result.turn_id).value),eventToken=row.sources.get(eventId);
              if(!opened.success||!eventToken)continue;
              const [source]=await tx.$queryRaw<EventRow[]>`SELECT * FROM public.host_evidence_for_turn_candidate(${scope.sessionId},${scope.ownerId},${scope.tripId},${scope.workspaceKey},${scope.capability},${eventId},${eventToken},${false})`;
              if(!source?.allowed||counter(source.out_retention_revision)!==scope.deletionRevision||!source.out_entry||!source.out_body||!source.out_received_at)continue;
              const candidate=parseDCContract("open-turn",{runtime_contract_version:"0.1.0",trip_id:scope.tripId,expected_revision:opened.data.expected_revision,
                event:{event_id:eventId,entry:source.out_entry,text:source.out_body,reference:`host-interaction:${eventId}`,received_at:source.out_received_at.toISOString()},
                tasks:opened.data.tasks,focus_keys:opened.data.focus_keys});
              const task=candidate.tasks.find(item=>item.task_key===taskKey);
              if(task&&memory.fingerprint===taskFingerprint(scope,task)){selected=candidate;break;}
            }catch{/* an expired lease is not recoverable save authority */}
          }
          const task=selected?.tasks.find(item=>item.task_key===taskKey);if(!selected||!task)return unavailable();
          await taskSourcesCurrent(tx,scope,token,memory.sources);
          tasks.push({task:structuredClone(task),event:structuredClone(selected.event),base_revision:state.revision,
            processing_status:"unprocessed",result_revision:state.revision,errors:[]});
        }
        const candidate={checkpoint_format_version:1 as const,trip_id:scope.tripId,captured_state_revision:state.revision,
          captured_object_versions:state.objects.map(object=>({id:object.id,version:object.version})).sort((a,b)=>a.id.localeCompare(b.id)),
          tasks,focus_keys:structuredClone(body.focus_keys),view:structuredClone(body.view),drafts:structuredClone(body.drafts),
          deferred_issue_ids:state.objects.filter(object=>object.type==="OpenIssue"&&object.status==="dismissed").map(object=>object.id).sort()};
        try{await host.guard!(scope.tripId,headers,tx);}catch{return deny();}
        return validateCheckpoint(candidate,scope.tripId,state.revision);
      }));
      const ack=await this.saveCheckpoint(ticket,credential,payload,body.expected_checkpoint_revision,body.idempotency_key);
      return parseDCContract("scene-ack",{runtime_contract_version:"0.1.0",ack});
    },
    /** Formal open-turn autosave; failure never pretends that a Checkpoint was acknowledged. */
    async autosaveTurnCandidate(ticket:object,credential:Headers,value:unknown,entry:RecordInput["entry"]) {
      const turn=parseDCContract("turn",value),{scope}=await scoped(ticket,credential);
      const status=await this.checkpointStatusCandidate(ticket,credential);
      return this.saveSceneCandidate(ticket,credential,{runtime_contract_version:"0.1.0",workspace_key:scope.workspaceKey,
        expected_checkpoint_revision:status.current_checkpoint_revision,idempotency_key:`auto-${turn.turn_id}`,
        focus_keys:turn.focus_keys,view:{entry,comparison_refs:[],selected_id:null,expanded_task_keys:turn.focus_keys},drafts:[]});
    },
    /** Metadata-only wire status; payload and original text never cross this boundary. */
    async checkpointStatusCandidate(ticket:object,credential:Headers) {
      const {scope}=await scoped(ticket,credential);let revision=0;
      try{const current=await this.inspectCheckpoint(ticket,credential);revision=Number.isSafeInteger(current.revision)?current.revision!:unavailable();}
      catch(error){if(!(error instanceof CheckpointError)||error.code!=="CHECKPOINT_NOT_FOUND")throw error;}
      const pending=scope.pendingSaveSticky||scope.pendingSaves.size>0||scope.inflightSaves>0;
      return parseDCContract("scene-status-result",{runtime_contract_version:"0.1.0",recovery_available:true,
        last_acknowledged_revision:revision,current_checkpoint_revision:revision,save_pending:pending,last_error:pending?"CHECKPOINT_STORAGE":null});
    },
    /** Internal bounded save only. Non-unprocessed task state remains rejected. */
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
          if (!payload.tasks.length || payload.tasks.some(row => row.errors.length || row.processing_status !== "unprocessed" ||
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
            return { installed,recoveredTasks:payload.tasks.map(item=>structuredClone(item.task)),recoveredFocus:structuredClone(payload.focus_keys),eventIds:payload.tasks.map(item=>item.event.event_id),checkpointRevision:row.value.revision!,
              savedRevision:classified.saved_state_revision,currentRevision:classified.current_state_revision,taskCount:payload.tasks.length,watermark:row.value.event_highwater!,
              candidateCounts,candidateScene:candidate?.scene,candidateUnacknowledged:unacknowledged };
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
          invalidatePackets(scope);clearTurnLeases(scope);scope.leaseKey=randomBytes(32); scope.receipts.clear(); scope.replayReceipts.clear(); scope.turns.clear(); scope.invalidTurns.clear();
          scope.recoveredEvents=new Set(restored.eventIds); scope.recoveryWatermark=restored.watermark; scope.tasks=restored.installed;
          scope.recoveredTasks=new Map(restored.recoveredTasks.map(task=>[taskIndex(scope,task.task_key),task]));scope.recoveredFocus=restored.recoveredFocus;scope.runtimeId=runtimeId;
          return {runtime_id:runtimeId,checkpoint_revision:restored.checkpointRevision,saved_state_revision:restored.savedRevision,
            current_state_revision:restored.currentRevision,restored_task_count:restored.taskCount,
            ...(restored.candidateCounts ? {candidate_turn_count:restored.candidateCounts.turns,candidate_packet_count:restored.candidateCounts.packets,
              candidate_save_unacknowledged:scope.pendingSaveSticky || scope.pendingSaves.size>0 || scope.inflightSaves>0,scene:structuredClone(restored.candidateScene)} : {})};
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
        scope.disposed=true; scope.capability=""; invalidatePackets(scope);clearTurnLeases(scope);
        for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
        scope.receipts.clear(); scope.replayReceipts.clear(); scope.tasks.clear();scope.recoveredTasks.clear();scope.recoveredFocus=[]; scope.turns.clear(); scope.invalidTurns.clear(); scope.recoveredEvents.clear(); scope.recoveryWatermark=null; scope.pendingSaves.clear(); scope.pendingSaveSticky=false; scope.keyEpochs.clear();
        workspaces.delete(ticket); activeScopes.delete(scope);
      });
    },
    async close() {
      if (closed) return; closed = true;
      for (const scope of activeScopes) {
        scope.disposed=true; scope.capability=""; invalidatePackets(scope);clearTurnLeases(scope);
        for (const receipts of scope.receipts.values()) for (const receipt of receipts) eventProofs.delete(receipt);
        scope.receipts.clear(); scope.replayReceipts.clear(); scope.tasks.clear();scope.recoveredTasks.clear();scope.recoveredFocus=[]; scope.turns.clear(); scope.invalidTurns.clear(); scope.recoveredEvents.clear(); scope.recoveryWatermark=null; scope.pendingSaves.clear(); scope.pendingSaveSticky=false; scope.keyEpochs.clear();
      }
      activeScopes.clear();routingSecret.fill(0);
      await Promise.all([db.$disconnect(),identity.close(),...(writeServicePromise?[writeServicePromise.then(service=>service.close())]:[])]);
    },
  };
}
