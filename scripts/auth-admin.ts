import "dotenv/config";
import { Client } from "pg";
import { z } from "zod";
import { openIdentity } from "../src/server/auth/config";
import { issueInternalCapability, openInternalTripService } from "../src/server/auth/internal-service";

// Operator-only CLI. Credentials arrive on stdin, never command arguments or logs. No HTTP equivalent.
async function main() {
  if (process.env.ANTU_AUTH_ADMIN !== "1") throw new Error("Explicit operator context required");
  let text = "";
  for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 16384) throw new Error("Input too large"); }
  const input: unknown = JSON.parse(text), operation = process.argv[2];
  if (operation === "create-user") {
    const body = z.object({ name: z.string().min(1).max(100), email: z.email(), password: z.string().min(12).max(128) }).strict().parse(input);
    const identity = await openIdentity();
    try { const result = await identity.auth.api.signUpEmail({ body }); console.log(JSON.stringify({ userId: result.user.id, emailVerified: false })); }
    finally { await identity.close(); }
    return;
  }
  const value = z.object({ tripId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/), userId: z.uuid() }).strict().parse(input);
  if (!["create-trip", "grant-trip", "revoke-trip"].includes(operation)) throw new Error("Unknown operator action");
  if (operation === "create-trip") {
    const secret = z.string().min(32).parse(process.env.INTERNAL_SERVICE_SECRET), connection = z.string().min(1).parse(process.env.DATABASE_URL);
    const service = await openInternalTripService(connection, secret);
    try { const capability = await issueInternalCapability(secret, value.tripId, { role: "system", id: "system-administration" }); await service.createTrip(value.tripId, capability); }
    finally { await service.close(); }
  }
  const owner = new Client({ connectionString: z.string().min(1).parse(process.env.MIGRATION_DATABASE_URL) }); await owner.connect();
  try {
    if (operation === "revoke-trip") await owner.query('DELETE FROM "TripMembership" WHERE "tripId"=$1 AND "userId"=$2', [value.tripId, value.userId]);
    else await owner.query('INSERT INTO "TripMembership" ("tripId","userId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [value.tripId, value.userId]);
    console.log(JSON.stringify({ operation, tripId: value.tripId, userId: value.userId }));
  } finally { await owner.end(); }
}
main().catch(() => { console.error("Operator action failed; verify private configuration and input. No credentials were logged."); process.exitCode = 1; });
