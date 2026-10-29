import { openModelHttpService } from "../auth/internal-service";
import { openIdentity } from "../auth/config";
import { sessionHost } from "../auth/authorization";
import { openTripCommandService } from "../trip-state/internal/persistence";
import { databaseEnvSchema } from "../../lib/env";

async function open() {
  const connection = databaseEnvSchema.parse(process.env).DATABASE_URL;
  const identity = await openIdentity();
  try { return { identity, trips: await openTripCommandService(connection, sessionHost(identity)), models: process.env.INTERNAL_SERVICE_SECRET ? await openModelHttpService(connection, process.env.INTERNAL_SERVICE_SECRET) : null }; }
  catch (error) { await identity.close(); throw error; }
}
// Initialized only by server requests: a build needs no secrets and receives no permissive fallback.
let pending: ReturnType<typeof open> | undefined;
export function webRuntime() {
  if (!pending) pending = open().catch((error) => { pending = undefined; throw error; });
  return pending;
}
