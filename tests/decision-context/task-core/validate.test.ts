import { describe, expect, it } from "vitest";
import { decodeAndCheckTaskCore, parseAndCheckTaskCore } from "../../../src/server/decision-context/task-core/validate";
import type { DecisionContextContracts } from "../../../src/server/decision-context/contracts.generated";

type Turn = DecisionContextContracts["open-turn"];
type Task = Turn["tasks"][number];
const now = Date.parse("2030-01-01T00:00:00Z");
function task(overrides: Partial<Task> = {}): Task {
  return { task_key: "E", question: "探索", kind: "explore", target_ids: [], branch: "actual",
    relation: "new", related_task_keys: [], certainty: "explicit",
    evidence: [{ start: 0, end: 3, quote: "先🧭看" }], progress: "open", progress_evidence: null, ...overrides };
}
function turn(tasks: [Task, ...Task[]] = [task()]): Turn {
  return { runtime_contract_version: "0.1.0", trip_id: "synthetic-trip", expected_revision: 0,
    event: { event_id: "synthetic-event", entry: "dialogue", text: "先🧭看看", reference: "synthetic", received_at: "2030-01-01T00:00:00Z" },
    tasks, focus_keys: [tasks[0].task_key] };
}
function code(body: Turn, prior: Task[], error: string) {
  expect(() => parseAndCheckTaskCore(body, prior, now)).toThrow(expect.objectContaining({ code: error }));
}
describe("limited synthetic task-core checks", () => {
  it("reuses the frozen parser and decoder and leaves both inputs unchanged", () => {
    const body = turn(); const prior = [task({ task_key: "P" })];
    const saved = structuredClone({ body, prior });
    expect(parseAndCheckTaskCore(body, prior, now)).toEqual(body);
    expect(decodeAndCheckTaskCore(JSON.stringify(body), prior, now)).toEqual(body);
    expect({ body, prior }).toEqual(saved);
  });
  it("rejects invalid shape, version, and exact-number boundary at the reused contract boundary", () => {
    for (const value of [{ ...turn(), injected: true }, { ...turn(), runtime_contract_version: "0.2.0" },
      { ...turn(), expected_revision: "0" }, { ...turn(), expected_revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => parseAndCheckTaskCore(value, [], now)).toThrow();
    }
    const json = JSON.stringify(turn()).replace('"expected_revision":0', '"expected_revision":9007199254740993');
    expect(() => decodeAndCheckTaskCore(json, [], now)).toThrow(expect.objectContaining({ code: "INTEGER_REPRESENTATION" }));
    expect(decodeAndCheckTaskCore(JSON.stringify(turn()).replace('"expected_revision":0', '"expected_revision":9007199254740991'), [], now).expected_revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("rejects future events including submillisecond fractions and invalid clock", () => {
    for (const time of ["2030-01-01T00:00:01Z", "2030-01-01T00:00:00.0001Z"]) {
      const body = turn(); body.event.received_at = time; code(body, [], "EVENT_TIME");
    }
    const same = turn(); same.event.received_at = "2030-01-01T01:00:00+01:00";
    expect(() => parseAndCheckTaskCore(same, [], now)).not.toThrow();
    expect(() => parseAndCheckTaskCore(turn(), [], NaN)).toThrow(expect.objectContaining({ code: "CLOCK" }));
  });
  it("compares all input fraction digits against an integer-millisecond clock", () => {
    const equal = turn(); equal.event.received_at = "2030-01-01T00:00:00.000000000Z";
    expect(() => parseAndCheckTaskCore(equal, [], now)).not.toThrow();
    const tiny = turn(); tiny.event.received_at = "2030-01-01T01:00:00.0000000001+01:00";
    code(tiny, [], "EVENT_TIME");
    const before = turn(); before.event.received_at = "2029-12-31T23:59:59.999999999Z";
    expect(() => parseAndCheckTaskCore(before, [], now)).not.toThrow();
    const sameMillisecond = turn(); sameMillisecond.event.received_at = "2030-01-01T00:00:00.0001Z";
    // With only an integer-millisecond trusted clock, reject rather than assume hidden fractions.
    code(sameMillisecond, [], "EVENT_TIME");
  });
  it("validates exact Unicode code point spans and progress evidence against this event", () => {
    expect(() => parseAndCheckTaskCore(turn(), [], now)).not.toThrow();
    code(turn([task({ evidence: [{ start: 0, end: 4, quote: "先🧭看" }] })]), [], "SOURCE_SPAN");
    code(turn([task({ evidence: [{ start: 1, end: 2, quote: "旧" }] })]), [], "SOURCE_SPAN");
    for (const progress of ["paused", "handled"] as const) {
      code(turn([task({ progress, progress_evidence: null })]), [], "PROGRESS_EVIDENCE");
      code(turn([task({ progress, certainty: "inferred", progress_evidence: { start: 0, end: 1, quote: "先" } })]), [], "PROGRESS_EVIDENCE");
      expect(() => parseAndCheckTaskCore(turn([task({ progress, progress_evidence: { start: 0, end: 1, quote: "先" } })]), [], now)).not.toThrow();
    }
    code(turn([task({ progress_evidence: { start: 1, end: 2, quote: "错" } })]), [], "SOURCE_SPAN");
  });
  it("enforces unique task/focus keys and ordered, non-self relations", () => {
    code(turn([task(), task()]), [], "TASK_KEYS");
    const dup = turn(); dup.focus_keys = ["E", "E"]; code(dup, [], "SCHEMA");
    const missing = turn(); missing.focus_keys = ["missing"]; code(missing, [], "TASK_KEYS");
    code(turn([task({ related_task_keys: ["E"] })]), [], "TASK_RELATION");
    code(turn([task({ relation: "refine" })]), [], "TASK_RELATION");
    const refined = task({ task_key: "Q", relation: "refine", related_task_keys: ["E"] });
    expect(() => parseAndCheckTaskCore(turn([task(), refined]), [], now)).not.toThrow();
    code(turn([refined, task()]), [], "TASK_RELATION");
    code(turn(), [task({ task_key: "P" }), task({ task_key: "P" })], "PRIOR_TASKS_AMBIGUOUS");
  });
  it("preserves identity, handled reopening and paused resumption without changing prior tasks", () => {
    const old = task({ progress: "paused" });
    code(turn([task({ relation: "focus" })]), [old], "TASK_PAUSED");
    expect(() => parseAndCheckTaskCore(turn([task({ relation: "resume" })]), [old], now)).not.toThrow();
    code(turn([task({ relation: "continue" })]), [task({ progress: "handled" })], "TASK_CLOSED");
    expect(() => parseAndCheckTaskCore(turn([task({ relation: "reopen" })]), [task({ progress: "handled" })], now)).not.toThrow();
    code(turn([task({ relation: "continue" })]), [], "TASK_NOT_RECOVERABLE");
    code(turn([task({ relation: "continue", branch: "hypothetical" })]), [task()], "TASK_IDENTITY");
    code(turn([task({ relation: "continue", kind: "skeleton_choice" })]), [task()], "TASK_IDENTITY");
    code(turn(), [task()], "TASK_IDENTITY");
    const b = task({ task_key: "B", relation: "new" });
    expect(() => parseAndCheckTaskCore(turn([b]), [old], now)).not.toThrow();
    expect(old.progress).toBe("paused");
  });
});
