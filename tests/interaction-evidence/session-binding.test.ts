import { describe, expect, it } from "vitest";
import { evidenceAuthorization } from "../../src/server/interaction-evidence/boundaries";
import type { Identity } from "../../src/server/auth/config";
import type { Prisma } from "../../src/generated/prisma/client";

function fixture() {
  const members = new Set(["A", "B"]), live = new Set(["session-A", "session-B"]);
  const scopes = { A: { owner_id:"A",trip_id:"trip-a",workspace_key:"work-a",task_key:"task-a" }, B: { owner_id:"B",trip_id:"trip-a",workspace_key:"work-a",task_key:"task-a" } };
  const identity = { auth: { api: { getSession: async ({headers}: {headers:Headers}) => {
    const userId=headers.get("cookie");
    if (userId !== "A" && userId !== "B") return null;
    return {session:{id:`session-${userId}`,expiresAt:new Date("2100-01-01")},user:{id:userId}};
  } } }, db: { tripMembership: { findUnique: async ({where}: {where:{tripId_userId:{userId:string}}}) => members.has(where.tripId_userId.userId) ? {} : null } } } as unknown as Identity;
  const tx={ $queryRaw: async (_strings:TemplateStringsArray, sessionId:string, userId:string) => [{allowed:live.has(sessionId) && members.has(userId)}] } as unknown as Prisma.TransactionClient;
  return {auth:evidenceAuthorization(identity),scopes,members,live,tx};
}
describe("E11 immutable signing identity",()=>{
  it("does not rebind an existing grant after the same Headers signs in another member",async()=>{
    const f=fixture(), h=new Headers({cookie:"A"}), a=await f.auth.authorize(h,f.scopes.A);
    h.set("cookie","B"); const b=await f.auth.authorize(h,f.scopes.B); f.members.delete("A");
    await expect(f.auth.guard(a,f.scopes.A,f.tx)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(f.auth.guard(b,f.scopes.B,f.tx)).resolves.toBeUndefined();
  });
  it("failed scope and invalid-cookie attempts cannot rebind or invalidate an earlier proof",async()=>{
    const f=fixture(), h=new Headers({cookie:"A"}), a=await f.auth.authorize(h,f.scopes.A);
    h.set("cookie","B"); await expect(f.auth.authorize(h,f.scopes.A)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    h.set("cookie","invalid"); await expect(f.auth.authorize(h,f.scopes.A)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(f.auth.guard(a,f.scopes.A,f.tx)).resolves.toBeUndefined();
    f.live.delete("session-A"); await expect(f.auth.guard(a,f.scopes.A,f.tx)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
  });
  it("interleaved concurrent authentication keeps each grant attached to its own snapshot",async()=>{
    const f=fixture(), h=new Headers({cookie:"A"});
    const aPromise=f.auth.authorize(h,f.scopes.A); h.set("cookie","B"); const bPromise=f.auth.authorize(h,f.scopes.B);
    const [a,b]=await Promise.all([aPromise,bPromise]); f.members.delete("A");
    await expect(f.auth.guard(a,f.scopes.A,f.tx)).rejects.toMatchObject({code:"EVIDENCE_ACCESS_DENIED"});
    await expect(f.auth.guard(b,f.scopes.B,f.tx)).resolves.toBeUndefined();
  });
});
