// One parameterized PostgreSQL 17 policy for deployment and both runtime identities.
// $1: explicit role, or NULL for current_user; $2: auth or trip. No grants are changed here.
// Inspect effective column/table ACLs, including PUBLIC, inherited roles and SET ROLE paths.
export const runtimeRoleSafetySql = `
WITH subject AS (
  SELECT oid FROM pg_roles WHERE rolname=COALESCE($1::text,current_user)
), principals AS (
  SELECT r.* FROM pg_roles r, subject s
  WHERE pg_has_role(s.oid,r.oid,'USAGE') OR pg_has_role(s.oid,r.oid,'SET')
), protected_tables(family,table_id) AS (VALUES
  ('trip','public."TripStateDocument"'::regclass),
  ('trip','public."TripStateHistory"'::regclass),
  ('trip','public."TripStateProposal"'::regclass),
  ('trip','public."TripStateIdempotency"'::regclass),
  ('auth','public."AuthUser"'::regclass),
  ('auth','public."AuthSession"'::regclass),
  ('auth','public."AuthAccount"'::regclass),
  ('auth','public."AuthVerification"'::regclass),
  ('auth','public."AuthRateLimit"'::regclass),
  ('auth','public."TripMembership"'::regclass)
)
SELECT ($2::text NOT IN ('auth','trip')
  OR EXISTS (SELECT 1 FROM principals WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  OR EXISTS (SELECT 1 FROM protected_tables t JOIN pg_class c ON c.oid=t.table_id, principals p WHERE c.relowner=p.oid)
  OR EXISTS (SELECT 1 FROM protected_tables t, principals p WHERE t.family<>$2::text AND (
    has_table_privilege(p.oid,t.table_id,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR has_any_column_privilege(p.oid,t.table_id,'SELECT,INSERT,UPDATE,REFERENCES')
  ))) AS denied FROM subject`;
