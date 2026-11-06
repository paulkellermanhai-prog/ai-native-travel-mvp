import { z } from "zod";
export const HOST_EVIDENCE_CONTRACT = "host-interaction-evidence/v1" as const;
export const EVIDENCE_POLICY = "DC-AC8-PRIVACY-01" as const;
export const PAGE_LIMIT = 100;
export const CURSOR_TTL_MS = 15 * 60 * 1000;
export const MAX_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
const instant = z.iso.datetime({ offset: true });
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const scopeSchema = z.strictObject({ owner_id: z.string().min(1).max(256), trip_id: id, workspace_key: id });
export const taskScopeSchema = scopeSchema.extend({ task_key: id });
export type EvidenceScope = z.infer<typeof scopeSchema>;
export type TaskScope = z.infer<typeof taskScopeSchema>;
export const recordInputSchema = z.strictObject({
  entry:z.enum(["dialogue","map","timeline","comparison"]),
  text:z.string().refine(v => [...v].length >= 1 && [...v].length <= 16000),
  idempotency_key:z.string().min(1).max(256),
});
export type RecordInput = z.infer<typeof recordInputSchema>;
export const eventSchema = z.strictObject({
  contract: z.literal(HOST_EVIDENCE_CONTRACT), ...scopeSchema.shape,
  event_id: id, entry: z.enum(["dialogue","map","timeline","comparison"]),
  text: z.string().refine(v => [...v].length >= 1 && [...v].length <= 16000),
  received_at: instant, recorded_at: instant, sequence: counter,
  source: z.literal("authenticated_user"), session_ref: z.string().min(1).max(256),
  source_reference: z.string().regex(/^host-interaction:[A-Za-z][A-Za-z0-9_-]{0,95}$/),
  idempotency_key: z.string().min(1).max(256), input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  policy: z.literal(EVIDENCE_POLICY), deleted_at: instant.nullable(),
}).refine(e => e.source_reference === `host-interaction:${e.event_id}`);
export type EvidenceEvent = z.infer<typeof eventSchema>;
export const associationSchema = z.strictObject({
  ...taskScopeSchema.shape, link_id:id, event_id:id, action:z.enum(["link","unlink","supersede"]),
  association_revision:counter, expected_association_revision:counter, source_turn_id:id, linked_at:instant,
  idempotency_key:z.string().min(1).max(256),
}).refine(a => a.expected_association_revision < Number.MAX_SAFE_INTEGER && a.association_revision === a.expected_association_revision + 1);
export type EvidenceAssociation = z.infer<typeof associationSchema>;
export const cursorSchema = z.strictObject({
  ...taskScopeSchema.shape, high_watermark:counter, after_sequence:counter,
  association_revision:counter, retention_revision:counter, expires_at:instant,
}).refine(c => c.after_sequence <= c.high_watermark);
/** Cursor payload is internal and must be authenticated by the E03-03 storage adapter. */
export type EvidenceCursor = z.infer<typeof cursorSchema>;
export const evidenceErrors = ["EVENT_KEY_CONFLICT","EVENT_ACK_UNKNOWN","ASSOCIATION_CONFLICT","ASSOCIATION_PENDING","EVIDENCE_CURSOR_STALE","EVIDENCE_ACCESS_DENIED","EVIDENCE_MISSING","EVIDENCE_EXPIRED","EVIDENCE_DELETED","EVIDENCE_UNAVAILABLE"] as const;
export class EvidenceBoundaryError extends Error {
  constructor(readonly code: typeof evidenceErrors[number]) { super(`Host evidence boundary: ${code}`); this.name="EvidenceBoundaryError"; }
}
// Recording success is not a Task interpretation or a current write grant.
export type EventReceipt = EvidenceScope & { event_id:string; sequence:number; durable:true; recorded_at:string; replayed:boolean };
export type EvidencePage = { events:Array<EvidenceEvent & {task_key:string;association_revision:number}>; cursor:string|null; complete:boolean; status:"complete"|"missing"|"deleted"|"expired"|"unlinked"|"pending"|"partial"; authority:"historical_evidence_only" };
export const productionConfigSchema = z.strictObject({
  enabled:z.boolean(), backup_cleanup_days:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  audit_retention_days:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  notice_approved:z.boolean(), deletion_verified:z.boolean(), engineering_gate_passed:z.boolean(),
});
export type ProductionEvidenceConfig = z.infer<typeof productionConfigSchema>;
export const disabledProductionConfig: ProductionEvidenceConfig = Object.freeze({ enabled:false, backup_cleanup_days:null, audit_retention_days:null, notice_approved:false, deletion_verified:false, engineering_gate_passed:false });
export function requireProductionEvidence(config: unknown): ProductionEvidenceConfig {
  const c=productionConfigSchema.safeParse(config);
  if (!c.success || !c.data.enabled || c.data.backup_cleanup_days === null || c.data.audit_retention_days === null || !c.data.notice_approved || !c.data.deletion_verified || !c.data.engineering_gate_passed) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
  return c.data;
}

/** Internal adapter contracts only; no collection, association or reader service is enabled in E03-01. */
export type AssociationCommand = EvidenceScope & { event_id:string; task_keys:readonly string[]; source_turn_id:string; expected_association_revision:number; idempotency_key:string; action:"link"|"unlink"|"supersede" };
export type DeleteReceipt = EvidenceScope & { durable:true; deletion_revision:number; accepted_at:string; cleanup_pending:boolean };
export interface HostInteractionEvidenceReader {
  read(scope:TaskScope, request:{page_size:number;from:string;to:string;cursor:string|null}, credential:Headers):Promise<EvidencePage>;
}
