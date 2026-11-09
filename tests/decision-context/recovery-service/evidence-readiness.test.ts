import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { inspectRecoveryEvidence } from "../../../src/server/decision-context/recovery-service/evidence-readiness";
import type { CheckpointPayload } from "../../../src/server/decision-context/contracts.generated";
import type { HostInteractionEvidenceReader } from "../../../src/server/interaction-evidence/contracts";

it("uses a bounded actual-reader interface and keeps reader failure unavailable", async () => {
  const payload = structuredClone((JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:CheckpointPayload}[]).find((r) => r.schema === "checkpoint-payload")!.value);
  const scope = {owner_id:"user",trip_id:payload.trip_id,workspace_key:"workspace"};
  const read = vi.fn<HostInteractionEvidenceReader["read"]>(async () => { throw new Error("E11 unavailable"); });
  const reader: HostInteractionEvidenceReader = {read};
  const headers = new Headers({cookie:"session=fake-test-cookie", "x-user-id":"ignored"});
  const result = await inspectRecoveryEvidence(reader,scope,payload,headers,{from:new Date("2030-01-01Z"),to:new Date("2030-01-02Z")});
  expect(result.ready).toBe(false);
  expect(result.failures).toEqual([{task_key:payload.tasks[0].task.task_key,reason:"EVIDENCE_UNAVAILABLE"}]);
  const [requestedScope,request,receivedHeaders] = read.mock.calls[0];
  expect(requestedScope).toEqual({...scope,task_key:payload.tasks[0].task.task_key});
  expect(request).toMatchObject({page_size:100,cursor:null});
  expect(receivedHeaders.get("x-user-id")).toBeNull();
  expect(JSON.stringify(result)).not.toContain(payload.tasks[0].event.text);
  payload.tasks = []; payload.focus_keys = []; payload.drafts = [];
  const empty = await inspectRecoveryEvidence(reader,scope,payload,new Headers(),{from:new Date("2030-01-01Z"),to:new Date("2030-01-02Z")});
  expect(empty).toEqual({ready:false,failures:[{task_key:"",reason:"EVIDENCE_UNAVAILABLE"}]});
});
