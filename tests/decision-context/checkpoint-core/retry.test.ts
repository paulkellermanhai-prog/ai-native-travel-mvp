import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PendingCheckpointSave } from "../../../src/server/decision-context/checkpoint-core/retry";
import type { CheckpointPayload, Ack } from "../../../src/server/decision-context/contracts.generated";

it("retries only the exact saved scene request, unaffected by later caller mutation", async () => {
  const payload = structuredClone((JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:CheckpointPayload}[]).find((r) => r.schema === "checkpoint-payload")!.value);
  const calls: unknown[][] = [];
  const ack: Ack = { workspace_key:"w", checkpoint_revision:1, saved_at:"2030-01-01T00:00:00Z", expires_at:null, payload_digest:"digest", durable:true, deleted:false };
  const retry = new PendingCheckpointSave(async (...args) => { calls.push(args); if (calls.length === 1) throw new Error("uncertain"); return ack; });
  await expect(retry.retry(new Date())).rejects.toMatchObject({ code:"CHECKPOINT_RETRY_EMPTY" });
  const scope = { owner:"u", trip:payload.trip_id, workspace:"w" }, now = new Date("2030-01-01T00:00:00Z");
  await expect(retry.save(scope, 0, "key", payload, now)).rejects.toThrow("uncertain");
  payload.tasks[0].event.text = "changed after failure"; scope.owner = "changed";
  expect(await retry.retry(now)).toEqual(ack);
  expect(calls[1][0]).toEqual({ owner:"u", trip:payload.trip_id, workspace:"w" });
  expect(calls[1][1]).toBe(0); expect(calls[1][2]).toBe("key");
  expect((calls[1][3] as CheckpointPayload).tasks[0].event.text).not.toBe("changed after failure");
  await expect(retry.retry(now)).rejects.toMatchObject({ code:"CHECKPOINT_RETRY_EMPTY" });
});
