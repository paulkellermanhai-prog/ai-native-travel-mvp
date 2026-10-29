import { z } from "zod";
import { webRuntime } from "./runtime";
import { json, readJsonText, requireOrigin } from "./security";
import { TripStateContractError } from "../trip-state/contracts";

/** Strict public surface: registration, password administration and service credentials are server-only. */
export async function handleAuthentication(request: Request) {
  const path = new URL(request.url).pathname;
  if (!["/api/auth/sign-in/email", "/api/auth/sign-out"].includes(path)) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  try {
    const { identity } = await webRuntime(); requireOrigin(request, identity.config.origin);
    const value: unknown = JSON.parse(await readJsonText(request, 4096));
    const body = path.endsWith("/sign-in/email") ? z.object({ email: z.email(), password: z.string().min(1).max(128) }).strict().parse(value) : z.object({}).strict().parse(value);
    // Until a trusted proxy is configured, use a conservative shared rate bucket, not caller-provided IP/identity headers.
    const headers = new Headers({ origin: identity.config.origin, "content-type": "application/json", "x-forwarded-for": "127.0.0.1", cookie: request.headers.get("cookie") ?? "" });
    const result = await identity.auth.handler(new Request(identity.config.origin + path, { method: "POST", headers, body: JSON.stringify(body) }));
    const response = json(result.ok ? { ok: true } : { error: result.status === 429 ? "Try again later" : "Authentication failed" }, result.status);
    for (const cookie of result.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
    if (result.headers.has("retry-after")) response.headers.set("Retry-After", result.headers.get("retry-after")!);
    return response; // Do not expose the auth library's session token, account fields or detailed errors.
  } catch (error) {
    const status = error instanceof TripStateContractError && error.code === "PERMISSION" ? 403 : error instanceof SyntaxError || error instanceof z.ZodError || error instanceof TripStateContractError ? 422 : 500;
    return json({ error: status === 403 ? "Access denied" : status === 422 ? "Invalid request" : "Authentication failed" }, status);
  }
}
