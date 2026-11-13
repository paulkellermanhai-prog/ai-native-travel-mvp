import { randomUUID } from "node:crypto";
import { digest } from "../trip-state/command-json";
import { stampTime } from "../trip-state/commands";
import { conflictingFactIds, factUsable, instantAttoseconds } from "../trip-state/conditions";
import { parseContract, TripStateContractError } from "../trip-state/contracts";
import type { DecisionContext, State } from "../trip-state/contracts.generated";
import { instantMicros, timestampParts } from "../trip-state/semantics";
import type { Annotation } from "./contracts.generated";
import { scopeApplicability, selectContextObjects } from "./context-selection";

type Item = State["objects"][number];
export type ContextAssembly = {
  context: DecisionContext;
  objects: Item[];
  annotations: Annotation[];
  snapshot_digest: string;
  target_ids: string[];
};
const fail = (code: string): never => { throw new TripStateContractError(code, "Decision Context must be rebuilt"); };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);

/** R6 baseline annotations with the accepted E03-02-C12-APPLICABILITY-2026-11-06-01 difference. */
function annotate(selected: Item[], targets: readonly string[], now: Date | bigint, stale: ReadonlySet<string>, contested: ReadonlySet<string>): Annotation[] {
  const objects = new Map(selected.map(o => [o.id, o]));
  const windows = selected.filter((o): o is Extract<Item, {type:"Constraint"}> => o.type === "Constraint" && o.status === "active" && o.scope.kind === "trip" && o.value.kind === "date_window")
    .map(o => o.value).filter((v): v is Extract<typeof v, {kind:"date_window"}> => v.kind === "date_window");
  return selected.map(o => {
    let applicability = scopeApplicability(o, targets, objects, now, contested);
    let restriction: Annotation["restriction"] = "none", reasons: string[] = [];
    if (o.type === "ExternalFact") {
      applicability = o.applicability;
      if (stale.has(o.id)) { restriction = "decision_limit"; reasons = [factUsable(o, now) ? "fact_contested" : "fact_unusable"]; }
      const date = o.query.date;
      if (windows.length && (date === null || windows.some(w => date < w.start || date > w.end))) {
        applicability = date === null ? "unknown" : "not_applicable";
        restriction = "decision_limit"; reasons.push("check_current_dates_not_revision_only");
      }
    }
    if (o.type === "Skeleton") {
      if (o.assessment.status === "blocked") { restriction = "known_conflict"; reasons = ["assessment_blocked"]; }
      else if (o.assessment.status !== "verified" || o.assessment.unknowns.length) { restriction = "decision_limit"; reasons = ["assessment_incomplete"]; }
    }
    if (o.type === "OpenIssue") { restriction = "decision_limit"; reasons.push("issue_unresolved"); }
    if (o.type === "Decision") {
      reasons.push("confirmation_scope_only");
      if (o.status !== "confirmed" || o.review_state !== "current") { restriction = "decision_limit"; reasons.push("not_current_authorization"); }
    }
    let presentation: Annotation["presentation"] = restriction === "none" ? "policy_judgment" : "limitation_if_used";
    if (o.type === "OpenIssue" && o.status === "dismissed") { presentation = "suppressed_unchanged"; reasons.push("disclose_if_conclusion_uses_affected_scope"); }
    return { id: o.id, retained: true, applicability, restriction, presentation, reason_codes: reasons, evidence_ids: o.dependencies.map(d => d.object_id) };
  });
}

/** R6 Context selection and complete body come from exactly the supplied state snapshot.
 * This pure function performs no authorization. The trusted Session adapter owns access. */
export function assembleContextSnapshot(state: State, taskId: string, targetIds: readonly string[], now: Date): ContextAssembly {
  if (!Number.isFinite(now.getTime())) fail("SCHEMA");
  const targets = [...targetIds];
  parseContract("context-request", { task_id: taskId, selected_object_ids: targets });
  const selection = selectContextObjects(state, targets);
  const index = new Map(state.objects.map(o => [o.id, o]));
  const selected = selection.selected_object_ids.map(id => { const item = index.get(id); if (!item) return fail("DANGLING_REF"); return structuredClone(item); });
  const facts = selected.filter((o): o is Extract<Item, {type:"ExternalFact"}> => o.type === "ExternalFact");
  const contested = conflictingFactIds(index, now), stale = facts.filter(o => contested.has(o.id) || !factUsable(o, now)).map(o => o.id);
  const nowMicros = BigInt(now.getTime()) * 1000n;
  let expiresMicros = nowMicros + 300_000_000n;
  for (const fact of facts) {
    const expiry = instantMicros(fact.expires_at);
    if (expiry > nowMicros && expiry < expiresMicros) expiresMicros = expiry;
  }
  const remainder = (expiresMicros % 1_000_000n + 1_000_000n) % 1_000_000n;
  const base = new Date(Number((expiresMicros - remainder) / 1000n)).toISOString().replace(/\.\d{3}Z$/, "");
  const fraction = remainder.toString().padStart(6, "0");
  const expires = base + (fraction === "000000" ? "Z" : `.${fraction}Z`);
  const context: DecisionContext = {
    id: `context-${randomUUID().replaceAll("-", "")}`, type: "DecisionContext", trip_id: state.trip_id,
    task_id: taskId, status: "active", state_revision: state.revision, assembled_at: stampTime(now), expires_at: expires,
    ...selection, relevant_facts: facts.map(o => o.id), stale_fact_ids: stale,
  };
  parseContract("DecisionContext", context);
  return { context, objects: selected, annotations: annotate(selected, targets, now, new Set(stale), contested), snapshot_digest: digest(state), target_ids: targets };
}

/** Revalidate the original manifest, body, protections and evidence at the moment of consumption. */
export function validateContextSnapshot(assembled: ContextAssembly, state: State, now: Date): void {
  const context = parseContract("DecisionContext", assembled.context);
  if (context.trip_id !== state.trip_id || context.status !== "active" || context.state_revision !== state.revision || assembled.snapshot_digest !== digest(state)) fail("PACKET_STALE");
  if (!Number.isFinite(now.getTime())) fail("PACKET_EXPIRED");
  // Date carries only the start of a millisecond; the real observation can be
  // anywhere within that millisecond. Refuse if expiration might already have
  // occurred rather than pretend that Date contains a microsecond clock.
  const earliest = BigInt(now.getTime()) * 1000n, latest = earliest + 999n;
  if (latest >= instantMicros(context.expires_at)) fail("PACKET_EXPIRED");
  const atCreation = new Date(context.assembled_at);
  const original = assembleContextSnapshot(state, context.task_id, assembled.target_ids, atCreation);
  const current = assembleContextSnapshot(state, context.task_id, assembled.target_ids, now);
  for (const key of ["selected_object_ids", "must_include_constraints", "active_decisions", "open_issues", "relevant_facts", "assembled_from_versions", "stale_fact_ids"] as const) {
    if (!equal(context[key], original.context[key])) fail("SNAPSHOT_MISMATCH");
    if (!equal(context[key], current.context[key])) fail("EVIDENCE_CHANGED");
  }
  if (instantMicros(context.expires_at) !== instantMicros(original.context.expires_at) || !equal(assembled.objects, original.objects) || !equal(assembled.annotations, original.annotations)) fail("SNAPSHOT_MISMATCH");
  if (!equal(assembled.annotations, current.annotations)) fail("EVIDENCE_CHANGED");
  // Check every fact transition in the uncertain millisecond, not just its
  // endpoints: a dispute can appear and disappear before the next tick.
  const start = BigInt(now.getTime()) * 1_000_000_000_000_000n;
  const end = start + 999_999_999_999_999n;
  const boundaries = new Set<bigint>([start]);
  let factCount = 0;
  for (const item of state.objects) if (item.type === "ExternalFact") for (const value of [item.observed_at,item.expires_at]) {
    factCount++;
    const tick = instantAttoseconds(value), { fraction } = timestampParts(value);
    if (tick >= start && tick <= end) {
      // Precision beyond 18 decimal places cannot be represented here safely.
      if (/[1-9]/.test(fraction.slice(18))) fail("EVIDENCE_CHANGED");
      boundaries.add(tick);
    }
  }
  // With no transition inside the bucket, the baseline's millisecond
  // observation has the same evidence state throughout the bucket.
  if (boundaries.size === 1) return;
  // Bound work on adversarial inputs; a dense transition bucket fails closed.
  const estimatedObjects = factCount + state.objects.length + assembled.objects.length + assembled.objects.length * assembled.target_ids.length;
  const estimatedBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  if (boundaries.size > 128 || boundaries.size * estimatedObjects > 100_000 || boundaries.size * estimatedBytes > 64 * 1024 * 1024) fail("EVIDENCE_CHANGED");
  const index = new Map(state.objects.map(o => [o.id,o]));
  const facts = assembled.objects.filter((o): o is Extract<Item,{type:"ExternalFact"}> => o.type === "ExternalFact");
  for (const tick of boundaries) {
    const contested = conflictingFactIds(index,tick);
    const stale = facts.filter(o => contested.has(o.id) || !factUsable(o,tick)).map(o => o.id);
    if (!equal(stale,current.context.stale_fact_ids) || !equal(annotate(assembled.objects,assembled.target_ids,tick,new Set(stale),contested),current.annotations)) fail("EVIDENCE_CHANGED");
  }
}
