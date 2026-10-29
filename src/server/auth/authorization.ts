import type { Identity } from "./config";
import type { CommandHost } from "../trip-state/internal/persistence";
import { TripStateContractError } from "../trip-state/contracts";

const denied = (): never => { throw new TripStateContractError("PERMISSION", "Access denied"); };
export function userActorId(id: string) { return `user-${id}`; }

/** Only a library-verified Cookie session can create a grant; neither body nor identity headers participate. */
export function sessionHost(identity: Identity): CommandHost {
  const proofs = new WeakMap<object, { sessionId: string; userId: string }>();
  return {
    async authorize(tripId, credential) {
      if (!(credential instanceof Headers)) return denied();
      const headers = new Headers({ cookie: credential.get("cookie") ?? "" });
      const session = await identity.auth.api.getSession({ headers, query: { disableCookieCache: true } });
      if (!session || session.session.expiresAt.getTime() <= Date.now()) return denied();
      const membership = await identity.db.tripMembership.findUnique({ where: { tripId_userId: { tripId, userId: session.user.id } } });
      if (!membership) return denied();
      proofs.set(credential, { sessionId: session.session.id, userId: session.user.id });
      return { tripId, actor: { role: "user", id: userActorId(session.user.id) } };
    },
    async guard(tripId, credential, tx) {
      const proof = credential && typeof credential === "object" ? proofs.get(credential) : undefined;
      if (!proof) return denied();
      const [result] = await tx.$queryRaw<Array<{ allowed: boolean }>>`SELECT public.authorize_trip_session(${proof.sessionId},${proof.userId},${tripId}) AS allowed`;
      if (!result?.allowed) return denied();
    },
  };
}
