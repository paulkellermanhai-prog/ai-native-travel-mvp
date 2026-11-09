import { SignJWT, jwtVerify } from "jose";
import { openTripCommandService, type CommandHost } from "../trip-state/internal/persistence";
import { TripStateContractError } from "../trip-state/contracts";
import { validateActor, type Actor } from "../trip-state/commands";

function key(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new Error("Configure a separate INTERNAL_SERVICE_SECRET of at least 32 bytes");
  return new TextEncoder().encode(secret);
}
/** Trusted server/operator issuance only. HTTP accepts verified Model capabilities; System/Tool stay private. */
export async function issueInternalCapability(secret: string, tripId: string, actor: Actor) {
  validateActor(actor);
  if (!["model", "system", "tool"].includes(actor.role)) throw new Error("Internal principals cannot mint User sessions");
  return new SignJWT({ trip: tripId, role: actor.role }).setProtectedHeader({ alg: "HS256" }).setIssuer("antu-internal").setAudience("antu-trip-service")
    .setSubject(actor.id).setIssuedAt().setExpirationTime("60s").sign(key(secret));
}
export function createInternalHost(secret: string): CommandHost {
  const secretKey = key(secret);
  const authorize: CommandHost["authorize"] = async (tripId, credential) => {
    try {
      if (typeof credential !== "string") throw new Error();
      const { payload } = await jwtVerify(credential, secretKey, { algorithms: ["HS256"], issuer: "antu-internal", audience: "antu-trip-service", maxTokenAge: "60s" });
      if (payload.trip !== tripId || !["model", "system", "tool"].includes(String(payload.role)) || !payload.sub || !payload.exp) throw new Error();
      const actor = { role: payload.role, id: payload.sub } as Actor; validateActor(actor); return { tripId, actor };
    } catch { throw new TripStateContractError("PERMISSION", "Internal access denied"); }
  };
  return { authorize, guard: async (tripId, credential) => { await authorize(tripId, credential); } };
}

export async function openInternalTripService(connection: string, secret: string) {
  return openTripCommandService(connection, createInternalHost(secret));
}
/** Network proposal adapter accepts verified Model principals only; System/Tool remain private SDK callers. */
export async function openModelHttpService(connection: string, secret: string) {
  const trusted = createInternalHost(secret);
  const authorize: CommandHost["authorize"] = async (trip, credential) => {
    const grant = await trusted.authorize(trip, credential);
    if (grant.actor.role !== "model") throw new TripStateContractError("PERMISSION", "Model service access required");
    return grant;
  };
  return openTripCommandService(connection, { authorize, guard: async (trip, credential) => { await authorize(trip, credential); } });
}
