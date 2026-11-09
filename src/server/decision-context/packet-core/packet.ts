import { canonicalJson, digest } from "../../trip-state/command-json";
import type { State } from "../../trip-state/contracts.generated";
import { validateContextSnapshot, type ContextAssembly } from "../context-assembly";
import { parseDCContract, type DecisionContextContracts } from "../contracts";

type Packet = DecisionContextContracts["packet"];
type Page = DecisionContextContracts["page"];
type Assemble = DecisionContextContracts["assemble"];
type Task = Packet["task"];
type Pending = Packet["pending_input"];
type Item = Packet["objects"][number];

/** Internal working values, not credentials or proof of ownership/delivery. */
export type PacketCandidate = { packet: Packet; assembly: ContextAssembly; fingerprint: string };
/** A transport value only: host must privately bind the ledger to session, owner, trip and runtime. */
export type DeliveryLedger = { packetId: string; deliveredIds: string[] };
export class PacketCoreError extends Error {
  constructor(readonly code: "TASK_MISMATCH" | "SNAPSHOT_MISMATCH" | "PAGE_SCOPE" | "DELIVERY_SCOPE" | "PACKET_MISMATCH" | "SCENE_STATUS_UNAVAILABLE") {
    super(`Packet core: ${code}`); this.name = "PacketCoreError";
  }
}
const fail = (code: PacketCoreError["code"]): never => { throw new PacketCoreError(code); };
const json = (value: unknown) => canonicalJson(value);
const bytes = (value: unknown) => Buffer.byteLength(json(value), "utf8");
// Python's default Unicode code point order (not locale-dependent).
function compare(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!), right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function sorted(ids: Iterable<string>): string[] { return [...ids].sort(compare); }
function equal(a: unknown, b: unknown): boolean { return json(a) === json(b); }

/**
 * Build a candidate from a single complete ContextAssembly. The caller owns the
 * trusted turn, task, packet identity, authorization and eventual delivery.
 */
export function buildPacketCandidate(input: {
  request: Assemble; packetId: string; task: Task; pending: Pending;
  assembly: ContextAssembly; state: State; now: Date; recoveredInput: boolean; saveUnacknowledged: boolean;
}): PacketCandidate {
  const { packetId, task, pending, assembly, state, now, recoveredInput, saveUnacknowledged } = input;
  if (typeof recoveredInput !== "boolean" || typeof saveUnacknowledged !== "boolean") fail("SCENE_STATUS_UNAVAILABLE");
  const request = parseDCContract("assemble", input.request);
  if (request.task_key !== task.task_key || assembly.context.task_id !== task.task_key ||
      !equal(sorted(task.target_ids), sorted(assembly.target_ids))) fail("TASK_MISMATCH");
  validateContextSnapshot(assembly, state, now);
  const selected = new Map(assembly.objects.map(o => [o.id, o]));
  if (selected.size !== assembly.objects.length || !equal(sorted(selected.keys()), sorted(assembly.context.selected_object_ids))) fail("SNAPSHOT_MISMATCH");
  const ordered = sorted(selected.keys()).map(id => selected.get(id)!);
  const complete = bytes(ordered) <= request.body_budget_bytes;
  const targets = new Set(task.target_ids);
  const priorities = sorted(selected.keys()).sort((a, b) => Number(!targets.has(a)) - Number(!targets.has(b)) || compare(a, b));
  const primary: Item[] = [];
  let used = 2;
  for (const id of priorities) {
    const object = selected.get(id)!;
    const cost = bytes(object) + (primary.length ? 1 : 0);
    if (complete || used + cost <= request.body_budget_bytes) { primary.push(object); used += cost; }
  }
  const primaryIds = new Set(primary.map(o => o.id));
  const deferred = sorted([...selected.keys()].filter(id => !primaryIds.has(id)));
  const coverage = complete ? "complete" : primary.length ? "layered" : "limited";
  const warnings = complete ? [] : ["partial_hydration_no_trip_feasibility_claim", "manifest_not_a_model_prompt"];
  if (recoveredInput) warnings.push("restored_input_read_only_repreview_required");
  if (saveUnacknowledged) warnings.push("scene_save_unacknowledged_business_state_is_separate");
  if (assembly.context.stale_fact_ids.length) warnings.push("unusable_evidence_not_current_fact");
  if (state.revision !== pending.base_revision && pending.processing_status !== "applied") warnings.push("input_based_on_older_revision_revalidate_before_write");
  const packet = parseDCContract("packet", {
    runtime_contract_version: "0.1.0", packet_id: packetId, turn_id: request.turn_id, task,
    context: assembly.context, pending_input: pending, objects: primary, deferred_ids: deferred, coverage,
    evidence_checked_at: now.toISOString(), snapshot_digest: assembly.snapshot_digest, annotations: assembly.annotations,
    support: complete ? "decision_support" : "information_only", warnings,
  });
  const result = { packet: structuredClone(packet), assembly: structuredClone(assembly) };
  return { ...result, fingerprint: digest(result) };
}

/** Detect altered packet bodies/manifest; a valid shape is not an authorization. */
function checkCandidate(candidate: PacketCandidate): void {
  const packet = parseDCContract("packet", candidate.packet), { assembly } = candidate;
  // Integrity check detects accidental mutation; a recomputable hash is not a credential.
  if (typeof candidate.fingerprint !== "string" || candidate.fingerprint !== digest({ packet, assembly })) fail("PACKET_MISMATCH");
  if (!equal(packet.context, assembly.context) || !equal(packet.annotations, assembly.annotations) ||
      packet.snapshot_digest !== assembly.snapshot_digest || packet.task.task_key !== assembly.context.task_id ||
      !equal(sorted(packet.task.target_ids), sorted(assembly.target_ids))) fail("PACKET_MISMATCH");
  const map = new Map(assembly.objects.map(object => [object.id, object]));
  const initial = packet.objects.map(object => object.id), manifest = assembly.context.selected_object_ids;
  if (map.size !== assembly.objects.length || new Set(initial).size !== initial.length ||
      !equal(sorted(map.keys()), sorted(manifest)) || packet.objects.some(object => !map.has(object.id) || !equal(object, map.get(object.id))) ||
      !equal(sorted(packet.deferred_ids), sorted(manifest.filter(id => !initial.includes(id))))) fail("PACKET_MISMATCH");
  const expected = packet.deferred_ids.length === 0 ? "complete" : initial.length ? "layered" : "limited";
  if (packet.coverage !== expected || packet.support !== (expected === "complete" ? "decision_support" : "information_only")) fail("PACKET_MISMATCH");
}
function checkedDelivered(candidate: PacketCandidate, ledger: DeliveryLedger): Set<string> {
  if (!ledger || ledger.packetId !== candidate.packet.packet_id || !Array.isArray(ledger.deliveredIds)) fail("DELIVERY_SCOPE");
  const result = new Set(ledger.deliveredIds), allowed = new Set(candidate.assembly.context.selected_object_ids);
  if (result.size !== ledger.deliveredIds.length || ledger.deliveredIds.some(id => !allowed.has(id))) fail("DELIVERY_SCOPE");
  return result;
}
/** Only a trusted host may create and retain a ledger. It is not evidence of actual delivery. */
export function emptyDeliveryLedger(candidate: PacketCandidate): DeliveryLedger {
  checkCandidate(candidate);
  return { packetId: candidate.packet.packet_id, deliveredIds: [] };
}
/** Call only after successful delivery, with an authorized private ledger and atomic host update. */
export function recordDelivery(candidate: PacketCandidate, delivered: DeliveryLedger, objectIds: readonly string[]): DeliveryLedger {
  checkCandidate(candidate);
  const ledger = checkedDelivered(candidate, delivered), allowed = new Set(candidate.assembly.context.selected_object_ids);
  if (objectIds.some(id => !allowed.has(id))) fail("DELIVERY_SCOPE");
  for (const id of objectIds) ledger.add(id);
  return { packetId: candidate.packet.packet_id, deliveredIds: sorted(ledger) };
}
/** Two independently read snapshots are required; host rechecks real Session and ownership around delivery. */
export function preparePage(candidate: PacketCandidate, requestValue: unknown, delivered: DeliveryLedger,
  before: { state: State; now: Date }, after: { state: State; now: Date }): Page {
  checkCandidate(candidate);
  const request = parseDCContract("page-request", requestValue);
  if (request.packet_id !== candidate.packet.packet_id) fail("PACKET_MISMATCH");
  const ledger = checkedDelivered(candidate, delivered), items = new Map(candidate.assembly.objects.map(o => [o.id, o]));
  if (request.object_ids.some(id => !items.has(id))) fail("PAGE_SCOPE");
  validateContextSnapshot(candidate.assembly, before.state, before.now);
  const objects = request.object_ids.map(id => items.get(id)!);
  validateContextSnapshot(candidate.assembly, after.state, after.now);
  const proposed = new Set([...ledger, ...request.object_ids]);
  return structuredClone(parseDCContract("page", { runtime_contract_version: "0.1.0", packet_id: request.packet_id,
    state_revision: candidate.assembly.context.state_revision, objects,
    remaining_ids: sorted([...items.keys()].filter(id => !proposed.has(id))), delivery_only_not_model_comprehension: true }));
}
/** Revalidates candidate/authority data supplied by the host; this does not authenticate the host or ledger. */
export function checkConsumption(candidate: PacketCandidate, state: State, now: Date, delivered: DeliveryLedger): { remainingIds: string[] } {
  checkCandidate(candidate);
  const ledger = checkedDelivered(candidate, delivered);
  validateContextSnapshot(candidate.assembly, state, now);
  return { remainingIds: sorted(candidate.assembly.context.selected_object_ids.filter(id => !ledger.has(id))) };
}

/**
 * Compare a candidate with its original turn snapshot. The caller must first
 * obtain that turn from the authenticated host; this comparison creates no
 * ownership proof, does not register a task and does not authorize delivery.
 */
export function checkPacketTurn(candidate: PacketCandidate, turnValue: unknown, trustedPendingValue: unknown): void {
  checkCandidate(candidate);
  const turn = parseDCContract("turn", turnValue);
  if (turn.turn_id !== candidate.packet.turn_id || turn.revision !== candidate.packet.pending_input.base_revision) fail("TASK_MISMATCH");
  // Validates the same frozen nested shape; the host must retrieve it from its trusted registry.
  const trustedPending = parseDCContract("packet", { ...candidate.packet, pending_input: trustedPendingValue }).pending_input;
  if (!equal(candidate.packet.pending_input, trustedPending)) fail("TASK_MISMATCH");
  const keys = turn.tasks.map(task => task.task_key);
  if (new Set(keys).size !== keys.length) fail("TASK_MISMATCH");
  const task = turn.tasks.find(item => item.task_key === candidate.packet.task.task_key);
  if (!task || !equal(task, candidate.packet.task)) fail("TASK_MISMATCH");
}
