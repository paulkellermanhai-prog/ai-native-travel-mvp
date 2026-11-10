import { parseDCContract, type DecisionContextContracts } from "../decision-context/contracts";
import { validateNapMessage } from "./contracts";
import { validatePlanInternalIntegrity } from "./plan-integrity";

type Packet = DecisionContextContracts["packet"];
type Request = {decision_id: string; runtime_id: string; packets: Packet[]};
type Basis = {packet_id: string; turn_id: string; task_key: string; state_revision: number; snapshot_digest: string; expires_at: string};
type Plan = {decision_id: string; runtime_id: string; basis: Basis[]};

export class NapPacketConsistencyError extends Error {
  constructor() { super("NAP 0.1.0 plan: PACKET_CONSISTENCY"); this.name = "NapPacketConsistencyError"; }
}

/**
 * Pure comparison of supplied objects, not proof of where packets came from.
 * No authentication, freshness, current-state, delivery, capability, or execution check.
 * The caller must independently establish those trusted facts before use.
 */
export function validatePlanRequestConsistency(requestValue: unknown, planValue: unknown): void {
  validateNapMessage("DecisionRequest", requestValue);
  validatePlanInternalIntegrity(planValue);
  const request = requestValue as Request;
  const plan = planValue as Plan;
  if (plan.decision_id !== request.decision_id || plan.runtime_id !== request.runtime_id) throw new NapPacketConsistencyError();

  const packets = new Map<string, Packet>();
  let baseline: {trip: string; revision: number; digest: string} | undefined;
  for (const raw of request.packets) {
    const packet = parseDCContract("packet", raw);
    // A duplicate identity would make the source object ambiguous, even if some fields match.
    if (packets.has(packet.packet_id)) throw new NapPacketConsistencyError();
    if (packet.context.task_id !== packet.task.task_key) throw new NapPacketConsistencyError();
    const current = {trip: packet.context.trip_id, revision: packet.context.state_revision, digest: packet.snapshot_digest};
    if (baseline && (baseline.trip !== current.trip || baseline.revision !== current.revision || baseline.digest !== current.digest)) throw new NapPacketConsistencyError();
    baseline = current;
    packets.set(packet.packet_id, packet);
  }
  for (const basis of plan.basis) {
    const packet = packets.get(basis.packet_id);
    if (!packet || packet.turn_id !== basis.turn_id || packet.task.task_key !== basis.task_key ||
      packet.context.state_revision !== basis.state_revision || packet.snapshot_digest !== basis.snapshot_digest ||
      packet.context.expires_at !== basis.expires_at) throw new NapPacketConsistencyError();
  }
}
