import { CheckpointError, validateCheckpoint } from "../checkpoint-core";
import type { CheckpointPayload } from "../contracts.generated";
import type { State } from "../../trip-state/contracts.generated";

/** Pure R6 comparison only: does not load evidence, install tasks, authorize or write TS. */
export function classifyRecovery(value: unknown, state: State) {
  const payload: CheckpointPayload = validateCheckpoint(value, state.trip_id, state.revision);
  const objects = new Map(state.objects.map((object) => [object.id, object]));
  const missing = new Set<string>();
  for (const row of payload.tasks) for (const id of row.task.target_ids) if (!objects.has(id)) missing.add(id);
  for (const draft of payload.drafts) for (const id of draft.target_ids) if (!objects.has(id)) missing.add(id);
  for (const ref of payload.view.comparison_refs) if (!objects.has(ref.id)) missing.add(ref.id);
  if (payload.view.selected_id && !objects.has(payload.view.selected_id)) missing.add(payload.view.selected_id);
  const staleComparisonIds = [...new Set(payload.view.comparison_refs.filter((ref) => objects.get(ref.id)?.version !== ref.version).map((ref) => ref.id))].sort();
  const deferred = state.objects.filter((o) => o.type === "OpenIssue" && o.status === "dismissed").map((o) => o.id).sort();
  const reopened = payload.deferred_issue_ids.filter((id) => {
    const object = objects.get(id);
    return object && object.status !== "dismissed" && object.status !== "resolved";
  }).sort();
  if (!Number.isSafeInteger(state.revision)) throw new CheckpointError("STATE_BEHIND_CHECKPOINT");
  return { payload, saved_state_revision: payload.captured_state_revision, current_state_revision: state.revision,
    missing_target_ids: [...missing].sort(), stale_comparison_ids: staleComparisonIds,
    stale_draft_ids: payload.drafts.filter((d) => d.base_revision !== state.revision).map((d) => d.draft_id).sort(),
    deferred_issue_ids: deferred, reopened_issue_ids: reopened };
}
