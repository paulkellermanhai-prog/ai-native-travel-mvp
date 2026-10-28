import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Deployment-specific role names are not hard-coded into a Prisma migration.
export async function grantConfirmationRuntime(owner, role) {
  if (!role) throw new Error("An explicit existing runtime role is required");
  const { rows } = await owner.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS privileged,
    EXISTS(SELECT 1 FROM pg_class c WHERE c.relname IN ('TripStateDocument','TripStateHistory','TripStateProposal','TripStateIdempotency') AND pg_has_role(r.oid,c.relowner,'USAGE')) AS owns,
    has_table_privilege(r.oid,'public."TripStateHistory"','UPDATE,DELETE,TRUNCATE') OR
    has_table_privilege(r.oid,'public."TripStateProposal"','DELETE,TRUNCATE') OR has_any_column_privilege(r.oid,'public."TripStateProposal"','UPDATE') OR
    has_table_privilege(r.oid,'public."TripStateIdempotency"','DELETE,TRUNCATE') OR has_any_column_privilege(r.oid,'public."TripStateIdempotency"','UPDATE') AS broad
    FROM pg_roles r WHERE r.rolname=$1`, [role]);
  if (rows.length !== 1 || rows[0].privileged || rows[0].owns || rows[0].broad) throw new Error("Existing runtime identity must be non-owner and retain restricted table privileges");
  await owner.query(`GRANT EXECUTE ON FUNCTION public.finalize_trip_confirmation(TEXT, TEXT, JSONB) TO "${role.replaceAll('"', '""')}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.MIGRATION_DATABASE_URL || !process.env.TRIP_STATE_RUNTIME_ROLE) throw new Error("MIGRATION_DATABASE_URL and TRIP_STATE_RUNTIME_ROLE are required; no credentials may be passed as CLI arguments");
  const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  try { await grantConfirmationRuntime(owner, process.env.TRIP_STATE_RUNTIME_ROLE); console.log(JSON.stringify({ bounded_confirmation_execute_granted: true, broad_DML_granted: false })); }
  finally { await owner.end(); }
}
