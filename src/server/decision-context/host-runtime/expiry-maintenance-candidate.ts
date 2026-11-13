import type { Client } from "pg";

/**
 * One bounded E11 maintenance pass on an autocommit, maintenance-only PG
 * connection. Expiry markers commit before a separate physical cleanup query;
 * a failed cleanup leaves its marker and job for the next pass. The caller
 * must start a fresh sequence scan after reaching the end on each schedule.
 * This is not a production scheduler or a grant to the application role.
 */
export async function runEvidenceMaintenanceCandidate(client:Client,afterSequence=0,limit=64) {
  if(!Number.isSafeInteger(afterSequence)||afterSequence<0||!Number.isInteger(limit)||limit<1||limit>256)
    throw new Error("INVALID_MAINTENANCE_BATCH");
  const scanned=await client.query<{out_sequence:string;out_event_id:string;disposition:string}>(
    'SELECT * FROM public.host_checkpoint_expire_batch_candidate($1,$2)',[afterSequence,limit]);
  let nextSequence=afterSequence,expired=0;const justExpired:string[]=[];
  for(const row of scanned.rows){nextSequence=Number(row.out_sequence);if(row.disposition==="expired"){expired++;justExpired.push(row.out_event_id);}}
  const pending=await client.query<{event_id:string}>(
    'SELECT event_id FROM public."HostEvidenceCleanup" WHERE completed_at IS NULL ORDER BY (event_id=ANY($2::text[])) DESC,requested_at,event_id LIMIT $1',[limit,justExpired]);
  let cleaned=0,cleanupFailed=0;
  for(const row of pending.rows) {
    try {
      const result=await client.query<{ok:boolean}>('SELECT public.host_evidence_cleanup_candidate($1) AS ok',[row.event_id]);
      if(result.rows[0]?.ok)cleaned++;else cleanupFailed++;
    } catch { cleanupFailed++; }
  }
  const runtime=await client.query<{installed:boolean}>("SELECT to_regclass('e04_runtime.decisions') IS NOT NULL AS installed");
  let redacted=0;
  if(runtime.rows[0]?.installed){
    const result=await client.query(`WITH expired AS (
      SELECT ctid FROM e04_runtime.decisions WHERE expires_at<=clock_timestamp() AND content_available=TRUE
      ORDER BY expires_at,owner_id,trip_id,workspace_key,decision_id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE e04_runtime.decisions AS decision
      SET request_json='{"redacted":true}'::jsonb,plan_json='{"redacted":true}'::jsonb,content_available=FALSE
      FROM expired WHERE decision.ctid=expired.ctid`,[limit]);
    redacted=result.rowCount??0;
  }
  return {scanned:scanned.rows.length,expired,cleaned,cleanupFailed,redacted,nextSequence,scanComplete:scanned.rows.length<limit};
}
