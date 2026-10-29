import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

export function authConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Configure a private BETTER_AUTH_SECRET of at least 32 bytes");
  const base = new URL(env.BETTER_AUTH_URL ?? "");
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("Authentication requires a fixed HTTPS origin (HTTP only on loopback)");
  const url = new URL(env.AUTH_DATABASE_URL ?? "");
  if (!["postgresql:", "postgres:"].includes(url.protocol)) throw new Error("Configure a separate AUTH_DATABASE_URL");
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c timezone=UTC`.trim());
  return { secret, origin: base.origin, databaseUrl: url.toString(), secureCookies: base.protocol === "https:" };
}

/** Self-hosted real password/session authentication. No test-token or anonymous fallback. */
export async function openIdentity(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const config = authConfiguration(env), db = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  try {
    const [identity] = await db.$queryRaw<Array<{ denied: boolean }>>`SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relname IN ('AuthUser','AuthSession','AuthAccount','AuthRateLimit','TripStateDocument') AND pg_has_role(current_user,c.relowner,'USAGE'))) AS denied
      FROM pg_roles r WHERE r.rolname=current_user`;
    if (!identity || identity.denied) throw new Error("Authentication runtime must be an unprivileged non-owner");
    const auth = betterAuth({
      appName: "ANTU", baseURL: config.origin, secret: config.secret,
      database: prismaAdapter(db, { provider: "postgresql", transaction: true }),
      user: { modelName: "authUser" }, account: { modelName: "authAccount" }, verification: { modelName: "authVerification" },
      // Registration is server-only via the admin command; the HTTP handler exposes only sign-in/out.
      emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128 },
      session: { modelName: "authSession", expiresIn: 60 * 60 * 24 * 7, disableSessionRefresh: true, cookieCache: { enabled: false } },
      trustedOrigins: [config.origin],
      rateLimit: { enabled: true, storage: "database", modelName: "authRateLimit", window: 60, max: 60,
        customRules: { "/sign-in/email": { window: 60, max: 20 } } },
      advanced: { database: { generateId: () => randomUUID() }, useSecureCookies: config.secureCookies,
        defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" }, trustedProxyHeaders: false },
      logger: { disabled: true }, telemetry: { enabled: false },
    });
    return { auth, db, config, close: () => db.$disconnect() };
  } catch (error) { await db.$disconnect(); throw error; }
}
export type Identity = Awaited<ReturnType<typeof openIdentity>>;
