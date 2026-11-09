import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateCheckpoint, checkpointDigest } from "../../../src/server/decision-context/checkpoint-core";
import type { CheckpointPayload } from "../../../src/server/decision-context/contracts.generated";
import { classifyRecovery } from "../../../src/server/decision-context/recovery-core";
import { base } from "../../support/bcg-fixtures";

const rows = JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string; value:unknown}[];
const fixture = () => structuredClone(rows.find((r) => r.schema === "checkpoint-payload")!.value) as CheckpointPayload;
const error = (fn: () => unknown, code: string) => expect(fn).toThrowError(expect.objectContaining({ code }));

describe("R6 checkpoint validation and read-only recovery classification", () => {
  it("accepts the frozen example without mutation and detects illegal fields", () => {
    const p = fixture(); const previous = structuredClone(p);
    expect(validateCheckpoint(p, p.trip_id, p.captured_state_revision)).toEqual(p);
    expect(p).toEqual(previous); expect(checkpointDigest(p)).toMatch(/^[a-f0-9]{64}$/);
    error(() => validateCheckpoint({ ...p, grant: "forged" }, p.trip_id, 0), "CONTRACT_INVALID");
  });
  it("rejects authority mismatch, an older TS, missing task references and false evidence", () => {
    const p = fixture();
    error(() => validateCheckpoint(p, "another-trip", 0), "TRIP_MISMATCH");
    p.captured_state_revision = 1;
    error(() => validateCheckpoint(p, p.trip_id, 0), "STATE_BEHIND_CHECKPOINT");
    p.captured_state_revision = 0; p.focus_keys = ["missing"];
    error(() => validateCheckpoint(p, p.trip_id, 0), "CHECKPOINT_CORRUPT");
    p.focus_keys = [p.tasks[0].task.task_key]; p.tasks[0].task.evidence[0].quote = "未说过";
    error(() => validateCheckpoint(p, p.trip_id, 0), "SOURCE_SPAN");
  });
  it("counts Unicode scalar values for evidence rather than UTF-16 code units", () => {
    const p = fixture(), row = p.tasks[0]; row.event.text = "😀好";
    row.task.evidence = [{ start: 1, end: 2, quote: "好" }];
    expect(() => validateCheckpoint(p, p.trip_id, 0)).not.toThrow();
    row.task.evidence[0].start = 2; row.task.evidence[0].end = 3;
    error(() => validateCheckpoint(p, p.trip_id, 0), "SOURCE_SPAN");
  });
  it("reports missing and stale references without changing the authoritative state", () => {
    const p = fixture(); const state = structuredClone(base); const previous = structuredClone(state);
    p.trip_id = state.trip_id; p.view.selected_id = "missing-object";
    p.view.comparison_refs = [{ id: "missing-object", version: 1 }];
    p.tasks[0].task.target_ids = ["missing-object"];
    const result = classifyRecovery(p, state);
    expect(result.missing_target_ids).toEqual(["missing-object"]);
    expect(result.stale_comparison_ids).toEqual(["missing-object"]);
    expect(state).toEqual(previous);
  });
  it("rejects oversized content instead of truncating or acknowledging it", () => {
    const p = fixture(), row = p.tasks[0];
    p.tasks = Array.from({ length: 50 }, (_, n) => {
      const r = structuredClone(row); r.task.task_key = `task-${n}`;
      r.event.text = "长".repeat(16000); r.task.evidence = [{ start: 0, end: 1, quote: "长" }];
      return r;
    });
    p.focus_keys = ["task-0"];
    error(() => validateCheckpoint(p, p.trip_id, 0), "CHECKPOINT_TOO_LARGE");
  });
  it("flags changed revisions and preserves draft text without applying it", () => {
    const p = fixture(), state = structuredClone(base);
    p.trip_id = state.trip_id;
    p.drafts = [{ draft_id: "draft-1", draft_kind: "hypothetical", base_revision: 0,
      target_ids: [], text: "假设少一晚", source_reference: "input-1", proposal: null }];
    state.revision = 1;
    const before = structuredClone(state), result = classifyRecovery(p, state);
    expect(result.stale_draft_ids).toEqual(["draft-1"]);
    expect(result.payload.drafts[0].text).toBe("假设少一晚");
    expect(state).toEqual(before);
  });
});
