import type { State } from "../trip-state/contracts.generated";
import { selectContextObjects } from "./context-selection";

/** Read one authorized Trip State snapshot and select from that exact revision.
 * This is a read-only integration boundary, not a Packet or a write service. */
export async function readContextSelection(
  reader: { state(tripId: string, credential: unknown): Promise<State | null> },
  tripId: string,
  credential: unknown,
  targetIds: readonly string[],
) {
  const targets = [...targetIds];
  const state = await reader.state(tripId, credential);
  if (!state) return null;
  return { trip_id: state.trip_id, revision: state.revision, ...selectContextObjects(state, targets) };
}
