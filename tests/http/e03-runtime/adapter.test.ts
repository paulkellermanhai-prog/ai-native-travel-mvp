import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHandler } from "../../../src/server/decision-context/http-adapter/handler";
import { RuntimeHttpFault } from "../../../src/server/decision-context/http-core/response";
import { submitChange, confirmChange, type TransactionalBridgeHost } from "../../../src/server/decision-context/write-bridge/orchestrator";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts";
import { digest } from "../../../src/server/trip-state/command-json";
import { scenario } from "../../support/command-fixtures";

// Real local socket and contract adapter only. The host is synthetic, not Session/PG.
const fixtures = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: unknown}>;
const fixture = (name: string) => structuredClone(fixtures.find(row => row.schema === name)!.value);
let origin = "", calls = 0, bridgeEntries = 0, server: http.Server;
describe("E03-07 socket adapter with synthetic host", () => {
  beforeAll(async () => {
    const handler = createRuntimeHandler({ get origin() { return origin; }, async authorize(trip, headers) {
      const cookie = headers.get("cookie");
      if (trip !== "trip-egypt-test" || !["test-session=ok", "test-session=bridge"].includes(cookie ?? "")) throw new RuntimeHttpFault("ACCESS_DENIED");
      if (cookie === "test-session=bridge") {
        const packet = fixture("packet") as DecisionContextContracts["packet"], body = fixture("change") as DecisionContextContracts["change"];
        const confirmation = fixture("confirm") as DecisionContextContracts["confirm"];
        const host: TransactionalBridgeHost = {
          change: async (_body, action) => action({ packet, turn: { turnId: packet.turn_id, event: packet.pending_input.event, recovered: false }, deliveredIds: [], principalId: "synthetic", now: "2030-01-01T00:00:00Z", replay: { bodyDigest: digest(body), response: scenario.steps[0].response } }, async () => { throw new Error("must not submit"); }),
          confirm: async (_body, action) => action({ turnId: confirmation.turn_id, proposalId: "proposal-other", recovered: false }, async () => { throw new Error("must not confirm"); }),
        };
        return { changes: async (value: unknown) => { bridgeEntries++; return submitChange(host, value); }, confirm: async (value: unknown) => { bridgeEntries++; return confirmChange(host, value); } };
      }
      return { turns: async () => { calls++; return fixture("turn"); } };
    } });
    server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const method = req.method ?? "GET", body = Buffer.concat(chunks);
        const request = new Request(origin + req.url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) });
        const response = await handler(request); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { if (server?.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  async function call(path: string, body: string, extra: Record<string, string> = {}, method = "POST") {
    return fetch(origin + path, { method, headers: { origin, cookie: "test-session=ok", "content-type": "application/json", ...extra }, ...(method === "GET" ? {} : { body }) });
  }
  const route = "/runtime/trips/trip-egypt-test/turns";
  it("validates and dispatches a real socket request, returns private response", async () => {
    const response = await call(route, JSON.stringify(fixture("open-turn")));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(fixture("turn"));
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("vary")).toContain("Cookie");
  });
  it("rejects anonymous requests, cross-origin, malformed or inexact JSON before calling handler", async () => {
    const before = calls, valid = JSON.stringify(fixture("open-turn"));
    expect((await call(route, valid, { cookie: "" })).status).toBe(403);
    expect((await call(route, valid, { origin: "https://evil.invalid" })).status).toBe(403);
    expect((await call(route, '{"secret":')).status).toBe(422);
    expect((await call(route, valid.replace('"expected_revision":0', '"expected_revision":0.00000000000000001'))).status).toBe(422);
    expect(calls).toBe(before);
  });
  it("unimplemented endpoints fail closed; unknown paths and methods map correctly", async () => {
    const before = calls;
    expect((await call("/runtime/trips/trip-egypt-test/checkpoints/save", "{}", {})).status).toBe(503);
    expect((await call("/runtime/trips/trip-egypt-test/changes", "{}", {})).status).toBe(500);
    expect((await call("/runtime/trips/trip-egypt-test/unknown", "{}", {})).status).toBe(404);
    expect((await call(route, "", {}, "GET")).status).toBe(405);
    expect(calls).toBe(before);
  });
  it("preserves actual bridge error and raw numeric rejection across a real socket", async () => {
    const body = fixture("change") as DecisionContextContracts["change"], start = bridgeEntries;
    const changed = { ...body, request: { ...body.request, reason: "changed" } }, cookie = { cookie: "test-session=bridge" };
    const response = await call("/runtime/trips/trip-egypt-test/changes", JSON.stringify(changed), cookie);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
    const confirm = await call("/runtime/trips/trip-egypt-test/confirm", JSON.stringify(fixture("confirm")), cookie);
    expect(confirm.status).toBe(422); expect(await confirm.json()).toMatchObject({ code: "PROPOSAL_BINDING", retryable: false });
    const raw = JSON.stringify(body).replace('"expected_revision":0', '"expected_revision":0.00000000000000001');
    const invalid = await call("/runtime/trips/trip-egypt-test/changes", raw, cookie);
    expect(invalid.status).toBe(422); expect(await invalid.json()).toMatchObject({ code: "CONTRACT_INVALID", retryable: false });
    expect(bridgeEntries - start).toBe(2);
  });
});
