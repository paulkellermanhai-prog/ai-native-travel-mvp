import { TripStateContractError } from "../trip-state/contracts";

export const COMMAND_BODY_LIMIT = 256 * 1024;
export function requireOrigin(request: Request, origin: string) {
  if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") throw new TripStateContractError("PERMISSION", "Access denied");
}
export async function readJsonText(request: Request, limit = COMMAND_BODY_LIMIT): Promise<string> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) throw new TripStateContractError("SCHEMA", "Content-Type must be application/json");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) throw new TripStateContractError("SCHEMA", "Request body exceeds the limit");
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  if (!reader) return "";
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new TripStateContractError("SCHEMA", "Request body exceeds the limit"); }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks); return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (error instanceof TripStateContractError) throw error;
    throw new TripStateContractError("SCHEMA", "Invalid request body");
  } finally { reader.releaseLock(); }
}
export function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff", ...extra } });
}
