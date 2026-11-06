import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAndCheckTaskCore } from "../../../src/server/decision-context/task-core/validate";

// Compare the full R6 open_turn, not a hand-written date parser. All inputs are synthetic.
const dc = path.resolve("specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/90_可运行工程包");
const ts = path.resolve("specs/ts-ac8-stage-a-2026-11-03/trip-state-schema-v0.1/90_可运行工程包");
const python = `
import json, sys
from datetime import datetime, timezone
from tripstate.engine import Store
from tripstate.fixtures import initial_state
from context_runtime.runtime import Runtime, RuntimeFault, Principal
clock = datetime(2030, 1, 1, tzinfo=timezone.utc)
out = []
for timestamp in json.load(sys.stdin):
    store = Store(initial_state(), clock=lambda: clock)
    state = store.get_state()
    runtime = Runtime(store)
    principal = Principal("synthetic-user", (state["trip_id"],))
    body = dict(runtime_contract_version="0.1.0", trip_id=state["trip_id"], expected_revision=state["revision"],
        event=dict(event_id="synthetic-event", entry="dialogue", text="看", reference="synthetic", received_at=timestamp),
        tasks=[dict(task_key="E", question="看", kind="explore", target_ids=[], branch="actual", relation="new",
          related_task_keys=[], certainty="explicit", evidence=[dict(start=0, end=1, quote="看")],
          progress="open", progress_evidence=None)], focus_keys=["E"])
    try:
        runtime.open_turn(body, principal)
        out.append("accepted")
    except RuntimeFault as exc:
        out.append(exc.code)
print(json.dumps(out))
`;
const times = [
  "2030-01-01T00:00:00Z", "2030-01-01T00:00:00.0000000Z",
  "2030-01-01T00:00:00.0000001Z", "2030-01-01T00:00:00.0000010Z",
  "2030-01-01T00:00:00.0009999Z", "2030-01-01T00:00:00.0010000Z",
  "2030-01-01T01:00:00.0000001+01:00", "2029-12-31T23:59:59.9999999Z",
];
function candidate(timestamp: string): string {
  const body = { runtime_contract_version: "0.1.0", trip_id: "synthetic-trip", expected_revision: 0,
    event: { event_id: "synthetic-event", entry: "dialogue", text: "看", reference: "synthetic", received_at: timestamp },
    tasks: [{ task_key: "E", question: "看", kind: "explore", target_ids: [], branch: "actual", relation: "new",
      related_task_keys: [], certainty: "explicit", evidence: [{ start: 0, end: 1, quote: "看" }], progress: "open", progress_evidence: null }], focus_keys: ["E"] };
  try { parseAndCheckTaskCore(body, [], Date.parse("2030-01-01T00:00:00Z")); return "accepted"; }
  catch (error) { return (error as { code: string }).code; }
}
describe("R6 timestamp precision evidence", () => {
  it("records the same synthetic inputs through the pinned R6 runtime and task-core", () => {
    const result = execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["-B", "-c", python], {
      input: JSON.stringify(times), encoding: "utf8", timeout: 60000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: [dc, ts].join(path.delimiter) },
    });
    expect(JSON.parse(result)).toEqual(["accepted", "accepted", "accepted", "EVENT_TIME", "EVENT_TIME", "EVENT_TIME", "accepted", "accepted"]);
    expect(times.map(candidate)).toEqual(["accepted", "accepted", "accepted", "EVENT_TIME", "EVENT_TIME", "EVENT_TIME", "accepted", "accepted"]);
  });
});
