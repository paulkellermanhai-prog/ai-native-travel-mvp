import { openTripCommandService } from "../../trip-state/internal/persistence";
import { openIdentity } from "../../auth/config";
import { sessionHost } from "../../auth/authorization";
import { openModelHttpService } from "../../auth/internal-service";
import { databaseEnvSchema } from "../../../lib/env";

/**
 * Lower-level TS/PG channels only, NOT the DC write bridge. The caller must not
 * expose these as a trusted runtime endpoint: turn, delivery and exact grant
 * checks have not been connected. Actual Session auth and its transactional
 * guard remain in the existing service; Model never becomes User.
 */
export async function openTSChannels(env: Partial<NodeJS.ProcessEnv>, modelSecret: string) {
  const connection = databaseEnvSchema.parse(env).DATABASE_URL;
  const identity = await openIdentity(env);
  let users: Awaited<ReturnType<typeof openTripCommandService>> | undefined;
  try {
    users = await openTripCommandService(connection, sessionHost(identity));
    const models = await openModelHttpService(connection, modelSecret);
    return { users, models, async close() { await Promise.all([users!.close(), models.close(), identity.close()]); } };
  } catch (error) { await Promise.all([identity.close(), ...(users ? [users.close()] : [])]); throw error; }
}
