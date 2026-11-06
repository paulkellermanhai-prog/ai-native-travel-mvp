import { openIdentity } from "../auth/config";
import { sessionHost } from "../auth/authorization";
import { databaseEnvSchema } from "../../lib/env";
import { TripStateContractError } from "../trip-state/contracts";
import { openTripCommandService } from "../trip-state/internal/persistence";
import { assembleContextSnapshot, validateContextSnapshot, type ContextAssembly } from "./context-assembly";

const deny = (): never => { throw new TripStateContractError("PERMISSION", "Access denied"); };

/**
 * Server-installed Session boundary. This service never accepts a caller-provided
 * reader, actor, clock, snapshot or authorization callback. Tickets are private,
 * process-local capabilities bound to the same live Session, user and trip.
 */
export async function openSessionContextService(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const connection = databaseEnvSchema.parse(env).DATABASE_URL;
  const identity = await openIdentity(env);
  let trips: Awaited<ReturnType<typeof openTripCommandService>>;
  try { trips = await openTripCommandService(connection, sessionHost(identity)); }
  catch (error) { await identity.close(); throw error; }
  const grants = new WeakMap<object, { tripId: string; sessionId: string; userId: string; context: ContextAssembly }>();
  let closed = false;
  async function session(headers: Headers) {
    const value = await identity.auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!value || value.session.expiresAt.getTime() <= Date.now()) return deny();
    return { sessionId: value.session.id, userId: value.user.id };
  }
  function copyCookie(credential: unknown) {
    if (!(credential instanceof Headers)) return deny();
    return new Headers({ cookie: credential.get("cookie") ?? "" });
  }
  return {
    async assemble(tripId: string, credential: Headers, taskId: string, targetIds: readonly string[]) {
      if (closed) return deny();
      const headers = copyCookie(credential), targets = [...targetIds];
      const principal = await session(headers);
      const state = await trips.state(tripId, headers);
      if (!state || state.trip_id !== tripId) return deny();
      const context = assembleContextSnapshot(state, taskId, targets, new Date());
      const ticket = Object.freeze({});
      grants.set(ticket, { tripId, ...principal, context: structuredClone(context) });
      return ticket;
    },
    async consume(tripId: string, credential: Headers, ticket: object) {
      if (closed) return deny();
      const headers = copyCookie(credential), principal = await session(headers);
      const grant = ticket && typeof ticket === "object" ? grants.get(ticket) : undefined;
      if (!grant || grant.tripId !== tripId || grant.sessionId !== principal.sessionId || grant.userId !== principal.userId) return deny();
      const state = await trips.state(tripId, headers);
      if (!state || state.trip_id !== tripId) return deny();
      validateContextSnapshot(grant.context, state, new Date());
      // Delivery rechecks live Session, membership, snapshot and expiry after validation.
      const current = await trips.state(tripId, headers);
      if (!current || current.trip_id !== tripId) return deny();
      validateContextSnapshot(grant.context, current, new Date());
      return structuredClone(grant.context);
    },
    async close() { if (closed) return; closed = true; await Promise.all([trips.close(), identity.close()]); },
  };
}
