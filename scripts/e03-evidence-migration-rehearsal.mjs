import fs from "node:fs";
import { Client } from "pg";
import {
  E03_CANDIDATE_SHA256,
  E03_CANDIDATE_SOURCES,
  e03CandidateSources,
  installE03Candidate,
  verifyE03CandidateSources,
} from "./e03-candidate-installer.mjs";

// Local rehearsal only. Never accept an arbitrary or production database URL.
const configFile = process.env.E02_STORAGE_ENV_FILE;
if (!configFile) throw new Error("E02_STORAGE_ENV_FILE must identify a disposable local test database");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (!/^antu_e02_test_[0-9a-f]+$/.test(config.database ?? "") ||
    !/^antu_e02_runtime_[0-9a-f]+$/.test(config.runtimeRole ?? "") ||
    !/^antu_e03_lifecycle_[0-9a-f]+$/.test(config.lifecycleRole ?? ""))
  throw new Error("Only a provisioned disposable E02 test database is supported");
const url = new URL(config.migrationUrl);
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("PostgreSQL required");
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== config.database) throw new Error("Local disposable database URL required");

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
  const { sources } = e03CandidateSources();
  let digestMismatchRejected = false;
  try {
    verifyE03CandidateSources(sources.map((source, index) => index === 0 ? `${source}\n-- rehearsal digest mismatch` : source));
  } catch (error) {
    digestMismatchRejected = (error instanceof Error && error.message.includes("digest differs"));
  }
  if (!digestMismatchRejected) throw new Error("Candidate SQL digest mismatch was not rejected");
  await client.query("BEGIN"); began = true;
  const first=await installE03Candidate(client,{runtimeRole:config.runtimeRole,lifecycleRole:config.lifecycleRole});
  const repeated=await installE03Candidate(client,{runtimeRole:config.runtimeRole,lifecycleRole:config.lifecycleRole});
  const { rows } = await client.query(`SELECT
    to_regclass('public."HostEvidenceEvent"') IS NOT NULL AS event_table,
    to_regclass('public."HostEvidenceAssociationLog"') IS NOT NULL AS association_table,
    to_regclass('public."HostEvidenceSceneEventWitness"') IS NOT NULL AS witness_table,
    to_regclass('e03_checkpoint.heads') IS NOT NULL AS checkpoint_table,
    to_regprocedure('public.host_evidence_unlink_task_source_candidate(text,text,text,text,text,text,text,text,text,text,bigint,text)') IS NOT NULL AS correction,
    to_regprocedure('public.host_evidence_sync_trip_lifecycle_candidate(text,bigint,timestamp with time zone)') IS NOT NULL AS lifecycle,
    to_regprocedure('public.host_checkpoint_reopen_workspace_candidate(text,text,text,text,text)') IS NOT NULL AS reopen,
    (SELECT version FROM e03_install.versions WHERE component='e03-host-candidate')::int AS install_version,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%' AND c.relkind='r')::int AS evidence_table_count,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%' AND c.relkind='r' AND
        (has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT') OR
         has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE'))) AS runtime_direct_table_access,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%' AND c.relkind='r' AND
        (has_table_privilege($2,c.oid,'SELECT') OR has_table_privilege($2,c.oid,'INSERT') OR
         has_table_privilege($2,c.oid,'UPDATE') OR has_table_privilege($2,c.oid,'DELETE'))) AS lifecycle_direct_table_access,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE FALSE END) AS runtime_sequence_access,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($2,c.oid,'USAGE,SELECT,UPDATE') ELSE FALSE END) AS lifecycle_sequence_access,
    has_function_privilege($1,'public.host_evidence_record_candidate(text,text,text,text,text,bigint,text,text,text,timestamp with time zone,text,text)','EXECUTE') AS runtime_record_execute,
    has_function_privilege($1,'public.host_checkpoint_reopen_workspace_candidate(text,text,text,text,text)','EXECUTE') AS runtime_reopen_execute,
    has_function_privilege($1,'public.host_evidence_sync_trip_lifecycle_candidate(text,bigint,timestamp with time zone)','EXECUTE') AS runtime_lifecycle_execute,
    has_function_privilege($2,'public.host_evidence_sync_trip_lifecycle_candidate(text,bigint,timestamp with time zone)','EXECUTE') AS lifecycle_execute,
    has_function_privilege($2,'public.host_evidence_record_candidate(text,text,text,text,text,bigint,text,text,text,timestamp with time zone,text,text)','EXECUTE') AS lifecycle_record_execute,
    has_function_privilege($2,'public.host_checkpoint_reopen_workspace_candidate(text,text,text,text,text)','EXECUTE') AS lifecycle_reopen_execute,
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname='public' AND (p.proname LIKE 'host_evidence_%_candidate' OR p.proname LIKE 'host_checkpoint_%_candidate')
        AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_candidate_execute`,
    [config.runtimeRole,config.lifecycleRole]);
  const check = rows[0];
  if (!check?.event_table || !check.association_table || !check.witness_table || !check.checkpoint_table || !check.correction || !check.lifecycle || !check.reopen ||
      check.install_version !== 3 || check.evidence_table_count !== 10 || check.runtime_direct_table_access || check.lifecycle_direct_table_access ||
      check.runtime_sequence_access || check.lifecycle_sequence_access || !check.runtime_record_execute || !check.runtime_reopen_execute || check.runtime_lifecycle_execute ||
      !check.lifecycle_execute || check.lifecycle_record_execute || check.lifecycle_reopen_execute || check.public_candidate_execute ||
      first.disposition!=="installed" || repeated.disposition!=="already_installed")
    throw new Error("Candidate dependency or least-privilege rehearsal failed");
  await client.query("ROLLBACK"); began = false;
  const { rows: after } = await client.query(`SELECT to_regclass('public."HostEvidenceEvent"') IS NOT NULL AS evidence,
    to_regnamespace('e03_checkpoint') IS NOT NULL AS checkpoint,to_regnamespace('e03_install') IS NOT NULL AS installer`);
  if (after[0]?.evidence || after[0]?.checkpoint !== baseline[0].existing_checkpoint || after[0]?.installer)
    throw new Error("Rehearsal changed the baseline database");
  let installedManifestMismatchRejected = false;
  await client.query("BEGIN"); began = true;
  try {
    await installE03Candidate(client,{runtimeRole:config.runtimeRole,lifecycleRole:config.lifecycleRole});
    await client.query("UPDATE e03_install.versions SET manifest='{}'::jsonb WHERE component='e03-host-candidate'");
    await installE03Candidate(client,{runtimeRole:config.runtimeRole,lifecycleRole:config.lifecycleRole});
  } catch (error) {
    installedManifestMismatchRejected = (error instanceof Error && error.message.includes("version or digest differs"));
  }
  await client.query("ROLLBACK"); began = false;
  if (!installedManifestMismatchRejected) throw new Error("Installed candidate manifest mismatch was not rejected");
  const { rows: afterFailure } = await client.query(`SELECT to_regclass('public."HostEvidenceEvent"') IS NOT NULL AS evidence,
    to_regnamespace('e03_checkpoint') IS NOT NULL AS checkpoint,to_regnamespace('e03_install') IS NOT NULL AS installer`);
  if (afterFailure[0]?.evidence || afterFailure[0]?.checkpoint !== baseline[0].existing_checkpoint || afterFailure[0]?.installer)
    throw new Error("Failed installation rehearsal changed the baseline database");
  console.log(JSON.stringify({ status: "candidate_rehearsal_passed", database_kind: "disposable_local_postgresql_17",
    install_version:first.version,first_install:first.disposition,repeated_install:repeated.disposition,
    scripts: E03_CANDIDATE_SOURCES.map((name, index) => ({ file: name.slice(3), sha256: first.sha256[index],
      applied_in_transaction: index !== 1 || !baseline[0].existing_checkpoint })),
    expected_sha256: E03_CANDIDATE_SHA256, checkpoint_schema_preexisting: baseline[0].existing_checkpoint,
    digest_mismatch_rejected: true, installed_manifest_mismatch_rejected: true,
    installed_then_rolled_back: true, failed_install_rolled_back: true,
    runtime_direct_access: false,lifecycle_role_isolated:true }));
} finally {
  if (began) await client.query("ROLLBACK");
  await client.end();
}
