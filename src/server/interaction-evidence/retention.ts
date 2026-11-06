import { EvidenceBoundaryError } from "./contracts";
const DAY=86400000;
function time(d:Date):number { const n=d.getTime(); if(!Number.isFinite(n)) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE"); return n; }
/** UTC calendar months, clamped at month end (Feb 29 -> Feb 28); never a 365-day substitute. */
function twelveMonths(recorded:Date):number {
  const d=new Date(time(recorded)); const day=d.getUTCDate(); d.setUTCDate(1); d.setUTCFullYear(d.getUTCFullYear()+1);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate(); d.setUTCDate(Math.min(day,last)); return time(d);
}
export type RetentionInput={recordedAt:Date;tripEndedAt:Date|null;lastVerifiedRelatedAt:Date|null;deletedAt:Date|null};
/** Extension beyond 12 months intentionally disabled until explicit finite policy approval. */
export function evidenceDeadline(input:RetentionInput):Date {
  const recorded=time(input.recordedAt), related=input.lastVerifiedRelatedAt ? time(input.lastVerifiedRelatedAt) : recorded;
  if(related<recorded) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
  const deadlines=[related+180*DAY,twelveMonths(input.recordedAt)];
  if(input.tripEndedAt) deadlines.push(time(input.tripEndedAt)+30*DAY);
  return new Date(Math.min(...deadlines));
}
export function requireReadableEvidence(input:RetentionInput,now:Date):void {
  if(input.deletedAt!==null) throw new EvidenceBoundaryError("EVIDENCE_DELETED");
  if(time(now)<time(input.recordedAt) || (input.lastVerifiedRelatedAt && time(input.lastVerifiedRelatedAt)>time(now))) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
  if(time(now)>=time(evidenceDeadline(input))) throw new EvidenceBoundaryError("EVIDENCE_EXPIRED");
}
