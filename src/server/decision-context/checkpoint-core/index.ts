import { canonicalJson, digest } from "../../trip-state/command-json";
import { parseDCContract } from "../contracts";
import type { CheckpointPayload } from "../contracts.generated";

/** Internal error codes are the existing R6 vocabulary, not a new wire contract. */
export class CheckpointError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CheckpointError"; }
}
const requireRule = (ok: unknown, code: string): void => { if (!ok) throw new CheckpointError(code); };

/** Shape, references and original Unicode code-point evidence. Does not establish identity. */
export function validateCheckpoint(value: unknown, tripId: string, currentRevision: number): CheckpointPayload {
  let payload: CheckpointPayload;
  try { payload = parseDCContract("checkpoint-payload", value); }
  catch { throw new CheckpointError("CONTRACT_INVALID"); }
  requireRule(Number.isSafeInteger(currentRevision) && currentRevision >= 0, "STATE_BEHIND_CHECKPOINT");
  requireRule(payload.trip_id === tripId, "TRIP_MISMATCH");
  requireRule(payload.captured_state_revision <= currentRevision, "STATE_BEHIND_CHECKPOINT");
  const keys = payload.tasks.map((row) => row.task.task_key), all = new Set(keys);
  requireRule(all.size === keys.length && payload.focus_keys.every((key) => all.has(key)), "CHECKPOINT_CORRUPT");
  for (const row of payload.tasks) {
    const task = row.task;
    requireRule(task.related_task_keys.every((key) => all.has(key) && key !== task.task_key), "CHECKPOINT_CORRUPT");
    requireRule(row.base_revision <= payload.captured_state_revision && row.result_revision <= payload.captured_state_revision, "CHECKPOINT_CORRUPT");
    const chars = Array.from(row.event.text);
    const span = (s: { start: number; end: number; quote: string }) => {
      requireRule(s.start >= 0 && s.start < s.end && s.end <= chars.length && chars.slice(s.start, s.end).join("") === s.quote, "SOURCE_SPAN");
    };
    task.evidence.forEach(span);
    requireRule(task.progress === "open" || (task.certainty === "explicit" && task.progress_evidence !== null), "CHECKPOINT_CORRUPT");
    if (task.progress_evidence) span(task.progress_evidence);
  }
  requireRule(payload.view.expanded_task_keys.every((key) => all.has(key)), "SCENE_REFERENCES");
  requireRule(new Set(payload.drafts.map((d) => d.draft_id)).size === payload.drafts.length, "SCENE_REFERENCES");
  for (const draft of payload.drafts) {
    requireRule(draft.base_revision <= payload.captured_state_revision, "SCENE_REFERENCES");
    if (draft.proposal) requireRule(draft.proposal.expected_revision === draft.base_revision && draft.proposal.input.text === draft.text && draft.proposal.input.reference === draft.source_reference, "INPUT_BINDING");
  }
  requireRule(Buffer.byteLength(canonicalJson(payload), "utf8") <= 2_000_000, "CHECKPOINT_TOO_LARGE");
  return structuredClone(payload);
}

export const checkpointDigest = (payload: CheckpointPayload): string => digest(payload);
