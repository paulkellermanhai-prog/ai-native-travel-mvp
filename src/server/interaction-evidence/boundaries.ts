import { sessionHost, userActorId } from "../auth/authorization";
import type { Identity } from "../auth/config";
import type { Prisma } from "../../generated/prisma/client";
import { cursorSchema, taskScopeSchema, EvidenceBoundaryError, CURSOR_TTL_MS, PAGE_LIMIT, MAX_WINDOW_MS, type TaskScope } from "./contracts";
const denied=(): never => { throw new EvidenceBoundaryError("EVIDENCE_ACCESS_DENIED"); };
/** Called only with host-selected scope from server state, never body/model scope. Rechecks live Session/membership. */
export function evidenceAuthorization(identity: Identity) {
  const host=sessionHost(identity);
  const grants=new WeakMap<object,{scope:TaskScope;credential:Headers}>();
  return {
    async authorize(credential:Headers, trustedScope:TaskScope) {
      const result=taskScopeSchema.safeParse(trustedScope);
      if(!result.success) return denied();
      try {
        if (!(credential instanceof Headers)) return denied();
        // Each grant owns a private credential identity; callers cannot reuse or mutate
        // the WeakMap key used by sessionHost for transaction-time revalidation.
        const privateCredential = new Headers({ cookie: credential.get("cookie") ?? "" });
        const actor=await host.authorize(result.data.trip_id,privateCredential);
        if(actor.actor.role!=="user" || actor.actor.id!==userActorId(result.data.owner_id)) return denied();
        const grant=Object.freeze({ ...result.data });
        grants.set(grant,{scope:{...result.data},credential:privateCredential});
        return grant;
      } catch { return denied(); }
    },
    async guard(grant:object, scope:TaskScope, tx:Prisma.TransactionClient) {
      const proof=grants.get(grant);
      if(!proof || !sameScope(proof.scope,scope)) return denied();
      try { if (!host.guard) return denied(); await host.guard(scope.trip_id,proof.credential,tx); } catch { return denied(); }
    },
  };
}
export function sameScope(a:TaskScope,b:TaskScope):boolean {
  return a.owner_id===b.owner_id && a.trip_id===b.trip_id && a.workspace_key===b.workspace_key && a.task_key===b.task_key;
}
/** For already authenticated cursor payloads only. No decoding a client JSON token into authority. */
export function checkCursor(value:unknown, scope:TaskScope, now:Date, revisions:{association:number;retention:number}) {
  const c=cursorSchema.safeParse(value);
  if(!c.success || !sameScope(c.data,scope) || !Number.isFinite(now.getTime()) || Date.parse(c.data.expires_at)<=now.getTime() || Date.parse(c.data.expires_at)>now.getTime()+CURSOR_TTL_MS || c.data.association_revision!==revisions.association || c.data.retention_revision!==revisions.retention) throw new EvidenceBoundaryError("EVIDENCE_CURSOR_STALE");
  return c.data;
}
export function checkReadWindow(pageSize:number,from:Date,to:Date) {
  const ms=to.getTime()-from.getTime();
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>PAGE_LIMIT||!Number.isFinite(ms)||ms<0||ms>MAX_WINDOW_MS) throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
}
