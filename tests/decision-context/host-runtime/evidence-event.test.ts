import { describe, expect, it } from "vitest";
import { evidenceKeyToken, prepareEvidenceEvent } from "../../../src/server/decision-context/host-runtime/evidence-event";

describe("host evidence event preparation", () => {
  const principal = { userId: "user-a", sessionId: "session-a" };
  it("creates server-generated distinct IDs and stable content digests without mutating input", () => {
    const input = { entry: "dialogue", text: "你好 🌍", idempotency_key: "key-a" };
    const now = new Date("2030-01-01T00:00:00.123Z");
    const a = prepareEvidenceEvent(principal, "trip-a", "workspace-a", input, now);
    const b = prepareEvidenceEvent(principal, "trip-a", "workspace-a", input, now);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.inputDigest).not.toBe(prepareEvidenceEvent(principal, "trip-a", "workspace-a", { ...input, text: "你好 🌏" }, now).inputDigest);
    input.text = "changed";
    now.setUTCFullYear(2031);
    expect(a.input.text).toBe("你好 🌍");
    expect(a.receivedAt.toISOString()).toBe("2030-01-01T00:00:00.123Z");
  });
  it("rejects extra fields, forged metadata, malformed scope, invalid times and oversize text", () => {
    const data = { entry: "dialogue", text: "hello", idempotency_key: "key-a" };
    for (const bad of [{ ...data, owner_id: "another" }, { ...data, event_id: "client" }, { ...data, text: "😀".repeat(16001) }]) {
      expect(() => prepareEvidenceEvent(principal, "trip-a", "workspace-a", bad, new Date())).toThrowError(expect.objectContaining({ code: "EVIDENCE_UNAVAILABLE" }));
    }
    expect(() => prepareEvidenceEvent(principal, "../trip", "workspace-a", data, new Date())).toThrow();
    expect(() => prepareEvidenceEvent(principal, "trip-a", "workspace-a", data, new Date(NaN))).toThrow();
    expect(() => prepareEvidenceEvent({ ...principal, sessionId: "" }, "trip-a", "workspace-a", data, new Date())).toThrow();
  });
  it("uses a keyed, scope-bound opaque token instead of retaining a sensitive idempotency key", () => {
    const scope = { ownerId: "user-a", tripId: "trip-a", workspaceKey: "workspace-a" };
    const secret = "s".repeat(32), key = "涉及隐私的原话";
    const token = evidenceKeyToken(secret, scope, key);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(key);
    expect(evidenceKeyToken(secret, scope, key)).toBe(token);
    expect(evidenceKeyToken(secret, { ...scope, workspaceKey: "workspace-b" }, key)).not.toBe(token);
    expect(evidenceKeyToken("x".repeat(32), scope, key)).not.toBe(token);
    expect(() => evidenceKeyToken("short", scope, key)).toThrow();
  });
});
