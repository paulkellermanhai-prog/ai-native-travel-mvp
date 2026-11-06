import { Pool } from "pg";
import { databaseEnvSchema } from "../../../lib/env";
import { openIdentity } from "../../auth/config";
import { sessionHost, userActorId } from "../../auth/authorization";
import { openTripCommandService } from "../../trip-state/internal/persistence";
import { digest } from "../../trip-state/command-json";
import { CheckpointError } from "../checkpoint-core";
import { PgCheckpointRepository } from "../checkpoint-store/repository";
import { classifyRecovery } from "../recovery-core";

/**
 * Internal inspection only: no restored turns, old text, drafts, packets, grants or
 * writes are returned. Full restore remains closed pending trusted task installation,
 * authorization-generation rotation and the E11 deletion/expiry barrier.
 */
export async function openRecoveryInspection(workspace: string, env: Partial<NodeJS.ProcessEnv> = process.env) {
  if (!workspace || workspace.length > 512) throw new CheckpointError("WORKSPACE_MISMATCH");
  const connection = databaseEnvSchema.parse(env).DATABASE_URL;
  const identity = await openIdentity(env);
  let trips: Awaited<ReturnType<typeof openTripCommandService>>;
  try { trips = await openTripCommandService(connection, sessionHost(identity)); }
  catch (error) { await identity.close(); throw error; }
  const pool = new Pool({ connectionString: connection });
  const repo = new PgCheckpointRepository(pool, null); // inspection never writes or sets a retention policy
  let closed = false;
  async function principal(headers: Headers) {
    const session = await identity.auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session || session.session.expiresAt.getTime() <= Date.now()) throw new CheckpointError("ACCESS_DENIED");
    return { sessionId: session.session.id, userId: session.user.id };
  }
  return {
    async inspect(tripId: string, credential: Headers) {
      if (closed || !(credential instanceof Headers)) throw new CheckpointError("ACCESS_DENIED");
      const headers = new Headers({ cookie: credential.get("cookie") ?? "" });
      const initialPrincipal = await principal(headers);
      const state = await trips.state(tripId, headers); // actual session + trip membership
      if (!state || state.trip_id !== tripId) throw new CheckpointError("ACCESS_DENIED");
      const scope = { owner: userActorId(initialPrincipal.userId), trip: tripId, workspace };
      const saved = await repo.load(scope, new Date());
      const result = classifyRecovery(saved.payload, state);
      const freshPrincipal = await principal(headers);
      if (freshPrincipal.sessionId !== initialPrincipal.sessionId || freshPrincipal.userId !== initialPrincipal.userId) throw new CheckpointError("ACCESS_DENIED");
      const freshState = await trips.state(tripId, headers);
      if (!freshState || freshState.revision !== state.revision || digest(freshState) !== digest(state)) throw new CheckpointError("REVISION_CHANGED");
      const freshSaved = await repo.load(scope, new Date());
      if (freshSaved.revision !== saved.revision || freshSaved.payload_digest !== saved.payload_digest) throw new CheckpointError("CHECKPOINT_CONFLICT");
      // This is internal diagnostic classification, not a scene-restored response.
      return { checkpoint_revision: saved.revision, saved_state_revision: result.saved_state_revision,
        current_state_revision: result.current_state_revision, missing_target_ids: result.missing_target_ids,
        stale_comparison_ids: result.stale_comparison_ids, stale_draft_ids: result.stale_draft_ids,
        deferred_issue_ids: result.deferred_issue_ids, reopened_issue_ids: result.reopened_issue_ids };
    },
    async close() { if (closed) return; closed = true; await Promise.all([pool.end(), trips.close(), identity.close()]); },
  };
}
