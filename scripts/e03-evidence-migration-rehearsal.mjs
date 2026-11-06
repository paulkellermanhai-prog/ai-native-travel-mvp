import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Local rehearsal only. Never accept an arbitrary or production database URL.
const configFile = process.env.E02_STORAGE_ENV_FILE;
if (!configFile) throw new Error("E02_STORAGE_ENV_FILE must identify a disposable local test database");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (!/^antu_e02_test_[0-9a-f]+$/.test(config.database ?? "") ||
    !/^antu_e02_runtime_[0-9a-f]+$/.test(config.runtimeRole ?? ""))
  throw new Error("Only a provisioned disposable E02 test database is supported");
const url = new URL(config.migrationUrl);
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("PostgreSQL required");
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== config.database) throw new Error("Local disposable database URL required");

const names = [
  "../src/server/decision-context/host-runtime/sql/001-evidence-record-candidate.sql",
  "../src/server/decision-context/checkpoint-store/migration.sql",
  "../src/server/decision-context/integration/checkpoint-evidence-candidate.sql",
];
const sources = names.map(name => fs.readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"));
const sha256 = sources.map(source => crypto.createHash("sha256").update(source).digest("hex"));
const client = new Client({ connectionString: config.migrationUrl });
await client.connect();
let began = false;
try {
  const [{ rows: database }, { rows: baseline }] = await Promise.all([
    client.query("SELECT current_database() AS name, current_setting('server_version_num')::int AS version"),
    client.query(`SELECT to_regclass('public."TripStateDocument"') IS NOT NULL AS state,
      to_regclass('public."AuthSession"') IS NOT NULL AS session,
      to_regclass('public."TripMembership"') IS NOT NULL AS membership,
      to_regprocedure('public.authorize_trip_session(text,text,text)') IS NOT NULL AS authorization,
      to_regclass('public."HostEvidenceWorkspace"') IS NOT NULL AS existing_evidence,
      to_regnamespace('e03_checkpoint') IS NOT NULL AS existing_checkpoint,
      to_regclass('e03_checkpoint.heads') IS NOT NULL AS existing_checkpoint_heads`),
  ]);
  if (database[0]?.name !== config.database || database[0]?.version < 170000 ||
      !baseline[0]?.state || !baseline[0]?.session || !baseline[0]?.membership || !baseline[0]?.authorization ||
      baseline[0]?.existing_evidence ||
      (baseline[0]?.existing_checkpoint && !baseline[0]?.existing_checkpoint_heads))
    throw new Error("Disposable PostgreSQL 17 baseline or clean candidate namespace is missing");
  await client.query("BEGIN"); began = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('e03-evidence-migration-rehearsal'))");
  await client.query(sources[0]);
  if (!baseline[0].existing_checkpoint) await client.query(sources[1]);
  await client.query(sources[2]);
  const { rows } = await client.query(`SELECT
    to_regclass('public."HostEvidenceEvent"') IS NOT NULL AS event_table,
    to_regclass('public."HostEvidenceAssociationLog"') IS NOT NULL AS association_table,
    to_regclass('public."HostEvidenceSceneEventWitness"') IS NOT NULL AS witness_table,
    to_regclass('e03_checkpoint.heads') IS NOT NULL AS checkpoint_table,
    to_regprocedure('public.host_evidence_unlink_task_source_candidate(text,text,text,text,text,text,text,text,text,text,bigint,text)') IS NOT NULL AS correction,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%' AND c.relkind='r')::int AS evidence_table_count,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%' AND c.relkind='r' AND
        (has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT') OR
         has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE'))) AS runtime_direct_table_access,
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND (p.proname LIKE 'host_evidence_%_candidate' OR p.proname LIKE 'host_checkpoint_%_candidate')
        AND has_function_privilege($1,p.oid,'EXECUTE')) AS runtime_candidate_execute_access`,
    [config.runtimeRole]);
  const check = rows[0];
  if (!check?.event_table || !check.association_table || !check.witness_table || !check.checkpoint_table || !check.correction ||
      check.evidence_table_count !== 10 || check.runtime_direct_table_access || check.runtime_candidate_execute_access)
    throw new Error("Candidate dependency or least-privilege rehearsal failed");
  await client.query("ROLLBACK"); began = false;
  const { rows: after } = await client.query(`SELECT to_regclass('public."HostEvidenceEvent"') IS NOT NULL AS evidence,
    to_regnamespace('e03_checkpoint') IS NOT NULL AS checkpoint`);
  if (after[0]?.evidence || after[0]?.checkpoint !== baseline[0].existing_checkpoint)
    throw new Error("Rehearsal changed the baseline database");
  console.log(JSON.stringify({ status: "candidate_rehearsal_passed", database_kind: "disposable_local_postgresql_17",
    scripts: names.map((name, index) => ({ file: name.slice(3), sha256: sha256[index],
      applied_in_transaction: index !== 1 || !baseline[0].existing_checkpoint })),
    checkpoint_schema_preexisting: baseline[0].existing_checkpoint,
    installed_then_rolled_back: true, runtime_direct_access: false }));
} finally {
  if (began) await client.query("ROLLBACK");
  await client.end();
}
