import { decodeDCContract, parseDCContract } from "../contracts";
import type { DecisionContextContracts } from "../contracts.generated";

type OpenTurn = DecisionContextContracts["open-turn"];
type Task = OpenTurn["tasks"][number];
/** Only identity fields are needed from previously registered tasks. */
export type TaskCorePrior = Pick<Task, "task_key" | "kind" | "branch" | "progress">;
type Span = Task["evidence"][number];

// Internal diagnostics only; these are not additions to the DC wire error contract.
export type TaskCoreErrorCode =
  | "CLOCK" | "EVENT_TIME" | "TASK_KEYS" | "TASK_RELATION" | "SOURCE_SPAN"
  | "PROGRESS_EVIDENCE" | "TASK_NOT_RECOVERABLE" | "TASK_IDENTITY"
  | "TASK_CLOSED" | "TASK_PAUSED" | "PRIOR_TASKS_AMBIGUOUS";
export class TaskCoreError extends Error {
  constructor(readonly code: TaskCoreErrorCode) {
    super(`Task core: ${code}`);
    this.name = "TaskCoreError";
  }
}
function requireCondition(condition: boolean, code: TaskCoreErrorCode): void {
  if (!condition) throw new TaskCoreError(code);
}
function checkSpan(span: Span, text: string): void {
  const points = Array.from(text);
  requireCondition(span.start < span.end && span.end <= points.length &&
    points.slice(span.start, span.end).join("") === span.quote, "SOURCE_SPAN");
}

/**
 * Checks only rules independent of Context/Packet and external state. `priorTasks`
 * must be the caller's already verified, complete same-session task snapshot.
 * A successful result is not a validated open-turn, registration or authorization.
 */
function checkTaskCore(body: OpenTurn, priorTasks: readonly TaskCorePrior[], nowMs: number): void {
  requireCondition(Number.isSafeInteger(nowMs), "CLOCK");
  const receivedMs = Date.parse(body.event.received_at);
  const fraction = body.event.received_at.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/i)?.[1] ?? "";
  // R6 uses Python datetime.fromisoformat, which truncates fractional seconds to microseconds.
  const subMillisecond = /[1-9]/.test(fraction.slice(3, 6));
  requireCondition(Number.isFinite(receivedMs) &&
    (receivedMs < nowMs || (receivedMs === nowMs && !subMillisecond)), "EVENT_TIME");
  const keys = body.tasks.map(task => task.task_key);
  const focus = body.focus_keys;
  requireCondition(new Set(keys).size === keys.length && new Set(focus).size === focus.length &&
    focus.every(key => keys.includes(key)), "TASK_KEYS");
  const current = new Map(priorTasks.map(task => [task.task_key, task]));
  requireCondition(current.size === priorTasks.length, "PRIOR_TASKS_AMBIGUOUS");
  for (const task of body.tasks) {
    const key = task.task_key;
    requireCondition(!task.related_task_keys.includes(key) &&
      task.related_task_keys.every(related => current.has(related)), "TASK_RELATION");
    for (const span of task.evidence) checkSpan(span, body.event.text);
    if (task.progress !== "open") {
      requireCondition(task.certainty === "explicit" && task.progress_evidence !== null, "PROGRESS_EVIDENCE");
    }
    if (task.progress_evidence !== null) checkSpan(task.progress_evidence, body.event.text);
    if (["continue", "focus", "resume", "reopen"].includes(task.relation)) {
      const prior = current.get(key);
      if (prior === undefined) throw new TaskCoreError("TASK_NOT_RECOVERABLE");
      requireCondition(prior.kind === task.kind && prior.branch === task.branch, "TASK_IDENTITY");
      requireCondition(prior.progress !== "handled" || task.relation === "reopen", "TASK_CLOSED");
      requireCondition(prior.progress !== "paused" || task.progress !== "open" ||
        task.relation === "resume" || task.relation === "reopen", "TASK_PAUSED");
    } else {
      requireCondition(!current.has(key), "TASK_IDENTITY");
      if (task.relation === "refine") requireCondition(task.related_task_keys.length > 0, "TASK_RELATION");
    }
    current.set(key, task);
  }
}

/** Contract parsing is mandatory before the pure rules; all other prerequisites remain unchecked. */
export function parseAndCheckTaskCore(value: unknown, priorTasks: readonly TaskCorePrior[], nowMs: number): OpenTurn {
  const body = parseDCContract("open-turn", value);
  checkTaskCore(body, priorTasks, nowMs);
  return body;
}
export function decodeAndCheckTaskCore(text: string, priorTasks: readonly TaskCorePrior[], nowMs: number): OpenTurn {
  const body = decodeDCContract("open-turn", text);
  checkTaskCore(body, priorTasks, nowMs);
  return body;
}
