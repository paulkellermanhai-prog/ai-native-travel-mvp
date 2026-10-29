import { describe, expect, it } from "vitest";
import { COMMAND_BODY_LIMIT, readJsonText, requireOrigin, json } from "../../src/server/http/security";
import { errorResponse, statusFor } from "../../src/server/http/trips";
import { decodeCommandJson } from "../../src/server/trip-state/command-json";

const origin = "https://antu.example.invalid";
const request = (body: string, headers = {}) => new Request(origin, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
describe("E02-05B HTTP security and formal response mapping", () => {
  it.each(["application/json", "application/json; charset=UTF-8"])("accepts %s without destroying original JSON numeric tokens", async (type) => {
    const text = '{"expected_revision":9007199254740993}'; expect(await readJsonText(request(text, { "content-type": type }))).toBe(text);
    expect(() => decodeCommandJson(text)).toThrowError(expect.objectContaining({ code: "INTEGER_REPRESENTATION" }));
  });
  it.each(["text/plain", "application/json; charset=utf-16", "application/x-www-form-urlencoded"])("rejects %s", async (type) => { await expect(readJsonText(request("{}", { "content-type": type }))).rejects.toMatchObject({ code: "SCHEMA" }); });
  it("bounds both advertised and actually streamed bytes", async () => {
    await expect(readJsonText(request("{}", { "content-length": String(COMMAND_BODY_LIMIT + 1) }))).rejects.toMatchObject({ code: "SCHEMA" });
    await expect(readJsonText(request('"' + "x".repeat(COMMAND_BODY_LIMIT) + '"'))).rejects.toMatchObject({ code: "SCHEMA" });
    await expect(readJsonText(request("{}", { "content-length": "not-a-number" }))).rejects.toMatchObject({ code: "SCHEMA" });
  });
  it.each([null, "null", "https://evil.example.invalid"])("rejects missing/untrusted Origin=%s", (value) => {
    const headers = new Headers(); if (value !== null) headers.set("origin", value);
    expect(() => requireOrigin(new Request(origin, { headers }), origin)).toThrowError(expect.objectContaining({ code: "PERMISSION" }));
  });
  it("rejects cross-site fetch and allows the exact configured origin", () => {
    expect(() => requireOrigin(new Request(origin, { headers: { origin, "sec-fetch-site": "cross-site" } }), origin)).toThrow();
    expect(() => requireOrigin(new Request(origin, { headers: { origin } }), origin)).not.toThrow();
  });
  it("never permits browser caches to share authenticated responses", () => { const r = json({}, 200); expect(r.headers.get("cache-control")).toContain("no-store"); expect(r.headers.get("vary")).toBe("Cookie"); });
  it.each([["PERMISSION", 403], ["NOT_FOUND", 404], ["METHOD_NOT_ALLOWED", 405], ["VERSION_CONFLICT", 409], ["SCHEMA", 422], ["INTERNAL_FAILURE", 500]] as const)("maps %s to %s using the formal response schema", (code, status) => { expect(statusFor(errorResponse(code, "Synthetic diagnostic"))).toBe(status); });
});
