import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { Actor, CommandRequest } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";

export const source = "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包";
export type Audit = TripStateContracts["history"];
export type Trace = { scenario: string; initial_state: State; final_state: State; audit: Audit; steps: Array<{
  actor: Actor; request: CommandRequest; response: TripStateContracts["response"]; state_after: State;
}> };
export const traces = JSON.parse(fs.readFileSync(`${source}/examples/scenario-traces.json`, "utf8")) as Trace[];
export const scenario = traces[0];
export const clock = () => new Date("2030-01-01T00:00:00Z");
export function uuids(start = 1000) { let counter = start; return () => (counter++).toString(16).padStart(32, "0"); }
export function oracle<T>(payload: unknown): T {
  return JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["tests/support/command-oracle.py"], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })) as T;
}
export function requestAt(step: number, revision: number, key = `extension-${step}`): CommandRequest {
  return { ...structuredClone(scenario.steps[step].request), expected_revision: revision, idempotency_key: key };
}
