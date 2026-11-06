import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const E03_CANDIDATE_INSTALL_VERSION=1;
export const E03_CANDIDATE_SOURCES=[
  "../src/server/decision-context/host-runtime/sql/001-evidence-record-candidate.sql",
  "../src/server/decision-context/checkpoint-store/migration.sql",
  "../src/server/decision-context/integration/checkpoint-evidence-candidate.sql",
];
const runtimeFunctions=[
  "public.host_evidence_workspace_candidate(TEXT,TEXT,TEXT,TEXT,TEXT)",
  "public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT)",
  "public.host_evidence_for_turn_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN)",
  "public.host_evidence_task_snapshot_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)",
  "public.host_evidence_unlink_task_source_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT)",
  "public.host_evidence_supersede_task_source_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT)",
  "public.host_evidence_task_source_current_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)",
  "public.host_evidence_checkpoint_probe_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT)",
  "public.host_evidence_bind_task_source_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT)",
  "public.host_evidence_mint_task_key_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT)",
  "public.host_checkpoint_save_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT)",
  "public.host_checkpoint_inspect_candidate(TEXT,TEXT,TEXT,TEXT,TEXT)",
  "public.host_checkpoint_read_candidate(TEXT,TEXT,TEXT,TEXT,TEXT)",
  "public.host_checkpoint_delete_event_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)",
];
const lifecycleFunction="public.host_evidence_sync_trip_lifecycle_candidate(TEXT,BIGINT,TIMESTAMPTZ)";
const rolePattern=/^antu_e0[23]_(?:runtime|lifecycle)_[0-9a-f]+$/;
const quote=value=>`"${value.replaceAll('"','""')}"`;

export function e03CandidateSources() {
  const sources=E03_CANDIDATE_SOURCES.map(name=>fs.readFileSync(fileURLToPath(new URL(name,import.meta.url)),"utf8"));
  return {sources,sha256:sources.map(source=>crypto.createHash("sha256").update(source).digest("hex"))};
}

export async function installE03Candidate(client,{runtimeRole,lifecycleRole}) {
  if(!rolePattern.test(runtimeRole)||!rolePattern.test(lifecycleRole))throw new Error("Refusing unrecognized candidate roles");
  const roles=await client.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",[[runtimeRole,lifecycleRole]]);
  if(new Set(roles.rows.map(row=>row.rolname)).size!==2)throw new Error("Candidate roles are missing");
  const {sources,sha256}=e03CandidateSources(),manifest={version:E03_CANDIDATE_INSTALL_VERSION,sha256};
  await client.query("SELECT pg_advisory_xact_lock(hashtext('e03-candidate-installer-v1'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS e03_install");
  await client.query("REVOKE ALL ON SCHEMA e03_install FROM PUBLIC");
  await client.query(`CREATE TABLE IF NOT EXISTS e03_install.versions(
    component TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),manifest JSONB NOT NULL,installed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp())`);
  await client.query("REVOKE ALL ON e03_install.versions FROM PUBLIC");
  const installed=await client.query("SELECT version,manifest FROM e03_install.versions WHERE component='e03-host-candidate' FOR UPDATE");
  let disposition="already_installed";
  if(!installed.rowCount) {
    const existing=await client.query(`SELECT to_regclass('public."HostEvidenceWorkspace"') IS NOT NULL AS evidence,
      to_regnamespace('e03_checkpoint') IS NOT NULL AS checkpoint,to_regclass('e03_checkpoint.heads') IS NOT NULL AS heads`);
    if(existing.rows[0].evidence||(existing.rows[0].checkpoint&&!existing.rows[0].heads))throw new Error("Unversioned or incomplete candidate installation exists");
    await client.query(sources[0]);
    if(!existing.rows[0].checkpoint)await client.query(sources[1]);
    await client.query(sources[2]);
    await client.query("INSERT INTO e03_install.versions(component,version,manifest) VALUES('e03-host-candidate',$1,$2::jsonb)",
      [E03_CANDIDATE_INSTALL_VERSION,JSON.stringify(manifest)]);
    disposition="installed";
  } else {
    const same=await client.query("SELECT $1::jsonb=$2::jsonb AS same",[JSON.stringify(installed.rows[0].manifest),JSON.stringify(manifest)]);
    if(installed.rows[0].version!==E03_CANDIDATE_INSTALL_VERSION||!same.rows[0].same)
      throw new Error("Installed E03 candidate version or digest differs");
  }
  const tables=await client.query(`SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname LIKE 'HostEvidence%' AND c.relkind IN ('r','S')`);
  for(const table of tables.rows)await client.query(`REVOKE ALL ON ${table.relkind==='S'?'SEQUENCE':'TABLE'} ${quote(table.nspname)}.${quote(table.relname)} FROM ${quote(runtimeRole)},${quote(lifecycleRole)}`);
  for(const fn of [...runtimeFunctions,lifecycleFunction])await client.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC,${quote(runtimeRole)},${quote(lifecycleRole)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(runtimeRole)},${quote(lifecycleRole)}`);
  await client.query(`GRANT EXECUTE ON FUNCTION ${runtimeFunctions.join(",")} TO ${quote(runtimeRole)}`);
  await client.query(`GRANT EXECUTE ON FUNCTION ${lifecycleFunction} TO ${quote(lifecycleRole)}`);
  const expected=await client.query(`SELECT to_regclass('public."HostEvidenceEvent"') IS NOT NULL AS event,
    to_regclass('public."HostEvidenceAssociationLog"') IS NOT NULL AS association,
    to_regclass('public."HostEvidenceSceneEventWitness"') IS NOT NULL AS witness,
    to_regclass('e03_checkpoint.heads') IS NOT NULL AS checkpoint,
    to_regprocedure('public.host_evidence_sync_trip_lifecycle_candidate(text,bigint,timestamp with time zone)') IS NOT NULL AS lifecycle`);
  if(!Object.values(expected.rows[0]).every(Boolean))throw new Error("Installed candidate objects are incomplete");
  return {disposition,version:E03_CANDIDATE_INSTALL_VERSION,sha256};
}
