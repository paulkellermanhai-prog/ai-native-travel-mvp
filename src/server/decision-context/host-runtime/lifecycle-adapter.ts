import { Pool } from "pg";
import { z } from "zod";
import { EvidenceBoundaryError } from "../../interaction-evidence/contracts";

type LifecycleHost = { authorize:(tripId:string,credential:unknown)=>unknown|Promise<unknown> };
const actorIdSchema=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
const lifecycleGrantSchema=z.strictObject({tripId:z.string(),actor:z.strictObject({role:z.literal("system"),id:actorIdSchema})});
const inputSchema=z.strictObject({trip_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/),
  source_revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),ended_at:z.iso.datetime({offset:true}).nullable()});

async function authorizeLifecycle(host:LifecycleHost,tripId:string,credential:unknown) {
  try {
    const grant=lifecycleGrantSchema.safeParse(await host.authorize(tripId,credential));
    if(!grant.success||grant.data.tripId!==tripId)throw new Error();
  } catch {throw new EvidenceBoundaryError("EVIDENCE_ACCESS_DENIED");}
}

/**
 * Private lifecycle input adapter. The connection must use the dedicated
 * lifecycle role, which receives only EXECUTE on the sync function. The host
 * capability is checked before the transaction and again immediately before
 * commit so an expired internal grant cannot survive a lock wait.
 */
export async function openEvidenceLifecycleAdapter(connectionString:string,host:LifecycleHost) {
  const pool=new Pool({connectionString,max:4});
  return {
    async sync(credential:unknown,raw:unknown) {
      let copy:unknown;try{copy=structuredClone(raw);}catch{throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");}
      const parsed=inputSchema.safeParse(copy);if(!parsed.success)throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
      const input=parsed.data;
      await authorizeLifecycle(host,input.trip_id,credential);
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const result=await client.query<{disposition:string}>('SELECT public.host_evidence_sync_trip_lifecycle_candidate($1,$2,$3) AS disposition',
          [input.trip_id,input.source_revision,input.ended_at]);
        await authorizeLifecycle(host,input.trip_id,credential);
        const disposition=result.rows[0]?.disposition;
        if(disposition!=="synced"&&disposition!=="replayed")throw new EvidenceBoundaryError("EVIDENCE_UNAVAILABLE");
        await client.query("COMMIT");
        return {trip_id:input.trip_id,source_revision:input.source_revision,ended_at:input.ended_at,disposition};
      } catch(error) {try{await client.query("ROLLBACK");}catch{/* original failure remains authoritative */}throw error;}
      finally {client.release();}
    },
    close:()=>pool.end(),
  };
}
