import fs from "node:fs";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";

export const E04_RUNTIME_INSTALL_VERSION=3;
export const E04_RUNTIME_SOURCE="../src/server/next-action-policy/runtime/sql/001-runtime.sql";
export const E04_RUNTIME_SHA256="8e797f2c18dafdc3ea393041f5715c4e6fcf60eaadcd399cecdf0719165d35fc";
export const E04_TOOL_RESULTS_SOURCE="../src/server/next-action-policy/runtime/sql/002-tool-results.sql";
export const E04_TOOL_RESULTS_SHA256="e2d080db8067f8ffa3ab4bc335c54196261b046ac8605bb02a55ab15d3f05d02";
const rolePattern=/^antu_e02_runtime_[0-9a-f]+$/;
const quote=value=>`"${value.replaceAll('"','""')}"`;

export function e04RuntimeSource(){
  const source=fs.readFileSync(fileURLToPath(new URL(E04_RUNTIME_SOURCE,import.meta.url)),"utf8");
  const sha256=crypto.createHash("sha256").update(source).digest("hex");
  if(sha256!==E04_RUNTIME_SHA256)throw new Error("E04 runtime SQL digest differs");
  return {source,sha256};
}
function toolResultsSource(){
  const source=fs.readFileSync(fileURLToPath(new URL(E04_TOOL_RESULTS_SOURCE,import.meta.url)),"utf8");
  const sha256=crypto.createHash("sha256").update(source).digest("hex");
  if(sha256!==E04_TOOL_RESULTS_SHA256)throw new Error("E04 tool results SQL digest differs");
  return {source,sha256};
}

export async function installE04Runtime(client,{runtimeRole}){
  if(!rolePattern.test(runtimeRole))throw new Error("Refusing unrecognized E04 runtime role");
  const roles=await client.query("SELECT rolname FROM pg_roles WHERE rolname=$1",[runtimeRole]);
  if(roles.rowCount!==1)throw new Error("E04 runtime role is missing");
  const runtime=e04RuntimeSource(),tools=toolResultsSource();
  await client.query("SELECT pg_advisory_xact_lock(hashtext('e04-runtime-installer-v3'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS e04_install");
  await client.query("REVOKE ALL ON SCHEMA e04_install FROM PUBLIC");
  await client.query(`CREATE TABLE IF NOT EXISTS e04_install.versions(
    component TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),manifest JSONB NOT NULL,installed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp())`);
  await client.query("REVOKE ALL ON e04_install.versions FROM PUBLIC");
  const installed=await client.query("SELECT version,manifest FROM e04_install.versions WHERE component='e04-runtime' FOR UPDATE");
  const manifest={version:E04_RUNTIME_INSTALL_VERSION,sources:[{path:E04_RUNTIME_SOURCE,sha256:runtime.sha256},{path:E04_TOOL_RESULTS_SOURCE,sha256:tools.sha256}]};let disposition="already_installed";
  if(!installed.rowCount){
    if((await client.query("SELECT to_regnamespace('e04_runtime') IS NOT NULL AS present")).rows[0].present)throw new Error("Unversioned E04 runtime exists");
    await client.query(runtime.source);await client.query(tools.source);
    await client.query("INSERT INTO e04_install.versions(component,version,manifest) VALUES('e04-runtime',$1,$2::jsonb)",
      [E04_RUNTIME_INSTALL_VERSION,JSON.stringify(manifest)]);
    disposition="installed";
  }else if(installed.rows[0].version===2){
    const prior={version:2,sha256:E04_RUNTIME_SHA256};
    if(!(await client.query("SELECT $1::jsonb=$2::jsonb AS same",[JSON.stringify(installed.rows[0].manifest),JSON.stringify(prior)])).rows[0].same)
      throw new Error("Installed E04 runtime version or digest differs");
    await client.query(tools.source);
    await client.query("UPDATE e04_install.versions SET version=$1,manifest=$2::jsonb,installed_at=clock_timestamp() WHERE component='e04-runtime'",
      [E04_RUNTIME_INSTALL_VERSION,JSON.stringify(manifest)]);disposition="upgraded";
  }else if(installed.rows[0].version!==E04_RUNTIME_INSTALL_VERSION||
    !(await client.query("SELECT $1::jsonb=$2::jsonb AS same",[JSON.stringify(installed.rows[0].manifest),JSON.stringify(manifest)])).rows[0].same)
      throw new Error("Installed E04 runtime version or digest differs");
  await client.query(`GRANT USAGE ON SCHEMA e04_runtime TO ${quote(runtimeRole)}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA e04_runtime TO ${quote(runtimeRole)}`);
  const expected=await client.query("SELECT to_regclass('e04_runtime.decisions') IS NOT NULL AS decisions,to_regclass('e04_runtime.actions') IS NOT NULL AS actions,to_regclass('e04_runtime.steps') IS NOT NULL AS steps,to_regclass('e04_runtime.tool_invocations') IS NOT NULL AS tool_invocations,to_regclass('e04_runtime.tool_completions') IS NOT NULL AS tool_completions");
  if(!Object.values(expected.rows[0]).every(Boolean))throw new Error("Installed E04 runtime objects are incomplete");
  return {disposition,version:E04_RUNTIME_INSTALL_VERSION,sha256:crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")};
}
