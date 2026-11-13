import { parseDCContract, type DecisionContextContracts } from "../contracts";
import { parseContract, type TripStateContracts } from "../../trip-state/contracts";
import { digest } from "../../trip-state/command-json";
import { BridgeRuleError, checkChangeRules, checkConfirmationRules, checkGrantFields } from "./rules";

type Change = DecisionContextContracts["change"];
type Confirm = DecisionContextContracts["confirm"];
type Packet = DecisionContextContracts["packet"];
type Result = TripStateContracts["response"];
type Grant = Parameters<typeof checkGrantFields>[0];
type ChangeScope = {
  packet: Packet;
  turn: { turnId: string; event: Packet["pending_input"]["event"]; recovered: boolean };
  deliveredIds: readonly string[];
  principalId: string;
  now: string;
  runtimeId?: string;
  /** Host-authenticated capability only, never read from request JSON. */
  grant?: Grant;
  /** Host's durable, scoped cache entry; only valid after current authentication. */
  replay?: { bodyDigest: string; response: Result };
};

/**
 * Interface for a future trusted host, not implemented or wired here. It must
 * authenticate the current Session/trip/turn, prove packet ownership, freshness
 * and complete delivery, verify the grant's provenance, and hold all required
 * checks with the TS transaction. It must atomically persist its runtime cache
 * or return an explicit uncertain outcome; an outer read followed by a blind TS
 * write cannot satisfy this interface. The caller cannot supply scope via JSON.
 */
export interface TransactionalBridgeHost {
  change<T>(body: Change, action: (scope: ChangeScope, submit: (role: "user" | "model", request: Change["request"]) => Promise<Result>) => Promise<T>): Promise<T>;
  confirm<T>(body: Confirm, action: (scope: { turnId: string; proposalId: string | null; recovered: boolean }, confirm: (proposalId: string, request: Confirm["request"]) => Promise<Result>) => Promise<T>): Promise<T>;
}

/** No production host exists yet. The callbacks are server-installed, not client credentials. */
export async function submitChange(host: TransactionalBridgeHost, raw: unknown): Promise<Result> {
  const body = structuredClone(parseDCContract("change", raw));
  return host.change(body, async (scope, submit) => {
    if (scope.replay) {
      if (scope.replay.bodyDigest !== digest(body)) throw new BridgeRuleError("IDEMPOTENCY_CONFLICT");
      return structuredClone(parseContract("response", scope.replay.response));
    }
    checkChangeRules(body, scope.packet, scope.turn, scope.deliveredIds);
    if (scope.grant) checkGrantFields(scope.grant, { principalId: scope.principalId, eventId: scope.turn.event.event_id, request: body.request, now: scope.now, runtimeId: scope.runtimeId });
    return structuredClone(parseContract("response", await submit(scope.grant ? "user" : "model", body.request)));
  });
}

/** The host callback is invoked only for a real confirmed User action. */
export async function confirmChange(host: TransactionalBridgeHost, raw: unknown): Promise<Result> {
  const body = structuredClone(parseDCContract("confirm", raw));
  return host.confirm(body, async (scope, confirm) => {
    checkConfirmationRules(body, scope);
    return structuredClone(parseContract("response", await confirm(body.proposal_id, body.request)));
  });
}
