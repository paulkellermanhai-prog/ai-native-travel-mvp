import { openSessionContextService } from "../decision-context/session-context";
import { validatePlanInternalIntegrity } from "./plan-integrity";

/** A field mismatch or conservative expiry; never a wire error or execution authorization. */
export class NapContextBasisError extends Error {
  constructor() { super("NAP context basis preflight: STALE_OR_UNSUPPORTED"); this.name = "NapContextBasisError"; }
}

type Basis = {task_key: string; state_revision: number; snapshot_digest: string; expires_at: string};
type Plan = {basis: Basis[]};

/**
 * Read-only bridge to the accepted E03 session-bound Context service. It compares
 * a single-basis plan with a freshly consumed Context. It does NOT verify Packet,
 * turn/task ownership, delivery, runtime, plan provenance, eligibility, grant,
 * external receipts or transaction-time authorization and must not dispatch.
 * A successful comparison is a point-in-time observation, not a reusable permit.
 * Multi-basis plans are intentionally unsupported pending the real Packet host.
 */
export async function openNapContextBasisPreflight(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const dc = await openSessionContextService(env);
  return {
    async assemble(tripId: string, credential: Headers, taskLabel: string, targets: readonly string[]) {
      const ticket = await dc.assemble(tripId, credential, taskLabel, targets);
      const context = await dc.consume(tripId, credential, ticket);
      return {ticket, context};
    },
    async inspect(tripId: string, credential: Headers, ticket: object, planValue: unknown): Promise<void> {
      // Snapshot before awaiting to prevent mutation of caller-supplied plan during I/O.
      const copy: unknown = structuredClone(planValue);
      validatePlanInternalIntegrity(copy);
      const {basis} = copy as Plan;
      if (basis.length !== 1) throw new NapContextBasisError();
      const current = await dc.consume(tripId, credential, ticket);
      const b = basis[0], ctx = current.context;
      // Parsing to whole milliseconds intentionally expires fractional deadlines at
      // the start of their millisecond. It never extends a microsecond deadline.
      const deadline = Date.parse(ctx.expires_at);
      if (!Number.isFinite(deadline) || Date.now() >= deadline || b.task_key !== ctx.task_id ||
          b.state_revision !== ctx.state_revision || b.snapshot_digest !== current.snapshot_digest || b.expires_at !== ctx.expires_at) {
        throw new NapContextBasisError();
      }
    },
    close: () => dc.close(),
  };
}
