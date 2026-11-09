import { parseDCContract, type DecisionContextContracts } from "../contracts";
import { digest } from "../../trip-state/command-json";
import { instantMicros } from "../../trip-state/semantics";

type Change = DecisionContextContracts["change"];
type Packet = DecisionContextContracts["packet"];
type Confirm = DecisionContextContracts["confirm"];

/** Policy failure only. This module does not create or authenticate a host capability. */
export class BridgeRuleError extends Error {
  constructor(readonly code: string) { super(`Decision Context write rule: ${code}`); this.name = "BridgeRuleError"; }
}
function requireRule(condition: unknown, code: string): asserts condition { if (!condition) throw new BridgeRuleError(code); }

/**
 * Pure R6 rule evaluation, not a trusted packet, delivery or session verifier.
 * The host must independently establish ownership/currentness and perform all
 * necessary rechecks in the TS transaction before this can protect a write.
 */
export function checkChangeRules(raw: unknown, packetRaw: unknown, turn: { turnId: string; event: Packet["pending_input"]["event"]; recovered: boolean }, deliveredIds: readonly string[]): Change {
  const body = structuredClone(parseDCContract("change", raw));
  const packet: Packet = structuredClone(parseDCContract("packet", packetRaw));
  requireRule(!turn.recovered, "RESTORED_INPUT_READ_ONLY");
  requireRule(body.packet_id === packet.packet_id && body.turn_id === packet.turn_id && body.turn_id === turn.turnId, "TURN_MISMATCH");
  requireRule(body.request.expected_revision === packet.context.state_revision, "REVISION_CHANGED");
  const input = packet.pending_input.event;
  requireRule(input.event_id === turn.event.event_id && input.text === turn.event.text && input.reference === turn.event.reference, "INPUT_BINDING");
  requireRule(body.request.input.text === input.text && body.request.input.reference === input.reference, "INPUT_BINDING");
  const commands = body.request.commands;
  requireRule(packet.task.branch === "actual" || commands.every(c => c.op === "create" && c.object_type === "Skeleton" && c.data.purpose === "scenario"), "HYPOTHETICAL_WRITE");
  if (commands.some(c => c.op === "adopt_skeleton" || c.op === "decide_candidate" || c.op === "withdraw_decision")) {
    const selected = new Set(packet.context.selected_object_ids), delivered = new Set(deliveredIds);
    requireRule(selected.size === delivered.size && [...selected].every(id => delivered.has(id)), "INCOMPLETE_DELIVERY");
  }
  return body;
}

/** Shape comparison only. Grant authenticity, session and scope are host responsibilities. */
export function checkGrantFields(grant: { principalId: string; eventId: string; requestDigest: string; revision: number; expiresAt: string; runtimeId?: string },
  input: { principalId: string; eventId: string; request: Change["request"]; now: string; runtimeId?: string }): void {
  let current = false;
  try { current = instantMicros(grant.expiresAt) > instantMicros(input.now); } catch { current = false; }
  requireRule(current && grant.principalId === input.principalId && grant.eventId === input.eventId && grant.requestDigest === digest(input.request)
    && grant.revision === input.request.expected_revision && (input.runtimeId === undefined || grant.runtimeId === input.runtimeId), "WRITE_GRANT");
}

/** Check a known current turn's proposal binding; not user confirmation evidence. */
export function checkConfirmationRules(raw: unknown, current: { turnId: string; proposalId: string | null; recovered: boolean }): Confirm {
  const body = structuredClone(parseDCContract("confirm", raw));
  requireRule(!current.recovered, "RESTORED_INPUT_READ_ONLY");
  requireRule(current.turnId === body.turn_id && current.proposalId !== null && current.proposalId === body.proposal_id, "PROPOSAL_BINDING");
  return body;
}
