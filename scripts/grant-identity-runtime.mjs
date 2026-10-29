import { runtimeRoleSafetySql } from "../src/server/database/runtime-role-safety.mjs";

// Deployment helper: roles must already exist and be non-owner/non-admin. No role is created here.
export async function grantIdentityRuntime(client, tripRole, authRole) {
  if (tripRole === authRole) throw new Error("Trip and authentication runtime roles must be distinct");
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  for (const [role, family] of [[tripRole, "trip"], [authRole, "auth"]]) {
    const { rows } = await client.query(runtimeRoleSafetySql, [role, family]);
    if (rows.length !== 1 || rows[0].denied) throw new Error("Identity grants require existing unprivileged non-owner roles with isolated table and column permissions");
  }
  await client.query(`GRANT EXECUTE ON FUNCTION public.authorize_trip_session(TEXT,TEXT,TEXT) TO ${quote(tripRole)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(authRole)}`);
  await client.query(`GRANT SELECT,INSERT ON "AuthUser","AuthAccount" TO ${quote(authRole)}`);
  await client.query(`GRANT UPDATE ("name","email","emailVerified","image","updatedAt") ON "AuthUser" TO ${quote(authRole)}`);
  await client.query(`GRANT UPDATE ("password","accessToken","refreshToken","idToken","accessTokenExpiresAt","refreshTokenExpiresAt","scope","updatedAt") ON "AuthAccount" TO ${quote(authRole)}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "AuthSession","AuthRateLimit" TO ${quote(authRole)}`);
  await client.query(`GRANT SELECT ON "TripMembership" TO ${quote(authRole)}`);
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  const { Client } = await import("pg");
  const tripRole = process.env.TRIP_STATE_RUNTIME_ROLE, authRole = process.env.AUTH_RUNTIME_ROLE;
  if (!tripRole || !authRole || !process.env.MIGRATION_DATABASE_URL) throw new Error("Configure explicit existing roles and migration connection");
  const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL }); await owner.connect();
  try { await grantIdentityRuntime(owner, tripRole, authRole); console.log("Identity grants applied to existing non-owner runtime identities"); }
  finally { await owner.end(); }
}
