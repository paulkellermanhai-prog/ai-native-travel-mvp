import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { napMessageNames, validateNapMessage, type NapMessageName } from "../../src/server/next-action-policy/contracts";

const dc = JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as Array<{schema: string; value: Record<string, unknown>}>;
const packet = dc.find(v => v.schema === "packet")!.value;
const event = dc.find(v => v.schema === "open-turn")!.value.event;
const date = "2030-01-01T00:00:00Z", hash = "a".repeat(64), version = "0.1.0";
const fixtures: Record<NapMessageName, Record<string, unknown>> = {
  DecisionRequest: {nap_contract_version: version, decision_id: "decision", runtime_id: "runtime", trigger: {kind: "user_event", reference: "event"}, packets: [packet]},
  DecisionPlan: {nap_contract_version: version, decision_id: "decision", runtime_id: "runtime", basis: [{packet_id: "packet", turn_id: "turn", task_key: "task", state_revision: 0, snapshot_digest: hash, expires_at: date}], response: {request_ids: [], disposition: "answered", text: "Answer", evidence_refs: []}, actions: []},
  ToolCompletion: {nap_contract_version: version, completion_id: "completion", decision_id: "decision", action_id: "action", step_id: "step", query_digest: hash, basis_state_revision: 0, result_status: "timeout", provider_ref: "provider", observed_at: date, expires_at: null, raw_result_ref: "result", validated_fact_ids: [], error: null},
  UIFeedback: {nap_contract_version: version, feedback_id: "feedback", decision_id: "decision", action_id: null, type: "clicked", event},
  RequestObservation: {nap_contract_version: version, observation_id: "observation", task_key: "task", event_id: "event", action_id: null, kind: "withdrawal", scope: "request", basis_revision: 0, source_ref: "source", content_digest: null, coverage: "none", assessment: "semantic_review_required", related_observation_ids: [], created_at: date},
  ActionRecord: {nap_contract_version: version, decision_id: "decision", action_id: "action", phase: "proposed", plan_digest: hash, completed_step_ids: [], result_refs: [], error_ref: null, related_action_ids: [], updated_at: date},
  Error: {nap_contract_version: version, code: "NAP_CONTRACT_INVALID", message: "Invalid", retryable: false, source_code: null, decision_id: null, action_id: null},
};

describe("E04 NAP candidate message structures", () => {
  it("keeps the selected candidate schema byte-for-byte", () => {
    const bytes = fs.readFileSync("specs/nap-candidate-2026-11-06/contracts.schema.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("61dd550805f163eb5f5e9f0e82fa2ca3c3592fe64a49a117b608b1fc55fcfbbc");
  });
  it.each(napMessageNames)("validates %s without modifying it", name => {
    const value = structuredClone(fixtures[name]);
    validateNapMessage(name, value);
    expect(value).toEqual(fixtures[name]);
    expect(() => validateNapMessage(name, {...value, forged_authority: true})).toThrow();
    expect(() => validateNapMessage(name, {...value, nap_contract_version: "0.2.0"})).toThrow();
  });
  it("checks the actual pinned DC packet and event references", () => {
    const badPacket = {...packet, runtime_contract_version: "0.2.0"};
    expect(() => validateNapMessage("DecisionRequest", {...fixtures.DecisionRequest, packets: [badPacket]})).toThrow();
    expect(() => validateNapMessage("UIFeedback", {...fixtures.UIFeedback, event: {...event as object, forged: true}})).toThrow();
  });
  it("rejects invalid formats, enums and missing fields", () => {
    expect(() => validateNapMessage("RequestObservation", {...fixtures.RequestObservation, created_at: "2030-02-31T00:00:00Z"})).toThrow();
    expect(() => validateNapMessage("ToolCompletion", {...fixtures.ToolCompletion, result_status: "success"})).toThrow();
    const {trigger: _trigger, ...missing} = fixtures.DecisionRequest; void _trigger;
    expect(() => validateNapMessage("DecisionRequest", missing)).toThrow();
  });
  it("never fetches external schemas", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected network access"); });
    try { vi.resetModules(); const nap = await import("../../src/server/next-action-policy/contracts"); for (const name of napMessageNames) nap.validateNapMessage(name, fixtures[name]); expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); }
  });
});
