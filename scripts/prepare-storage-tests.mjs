import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { grantConfirmationRuntime } from "./grant-confirmation-runtime.mjs";

if (process.env.E02_TEST_PROVISION !== "1") throw new Error("Explicit E02_TEST_PROVISION=1 is required for disposable local test provisioning");
const adminUrl = process.env.MIGRATION_DATABASE_URL;
if (!adminUrl) throw new Error("Provide a local test MIGRATION_DATABASE_URL");
const parsed = new URL(adminUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("Only a local disposable PostgreSQL test server is supported");
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw new Error("Provide a new private output file outside version control");
const suffix = crypto.randomBytes(8).toString("hex");
const database = `antu_e02_test_${suffix}`, runtimeRole = `antu_e02_runtime_${suffix}`;
const password = crypto.randomBytes(24).toString("hex");
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
try {
  await admin.query(`CREATE ROLE ${quote(runtimeRole)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${quote(database)}`);
  // Regression coverage: persistence must handle a non-UTC database without shifting deadlines.
  await admin.query(`ALTER DATABASE ${quote(database)} SET timezone TO 'Asia/Shanghai'`);
  await admin.query(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(runtimeRole)}`);
} finally { await admin.end(); }
parsed.pathname = `/${database}`;
const migrationUrl = parsed.toString();
const owner = new Client({ connectionString: migrationUrl });
await owner.connect();
try {
  const { rows } = await owner.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'");
  if (rows[0].count !== 0) throw new Error("Test database must start empty");
  const command = spawnSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl }, encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(`Migration failed: ${(command.stdout + command.stderr).replaceAll(migrationUrl, "[local-test-url]").replaceAll(password, "[test-password]")}`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${quote(runtimeRole)}`);
  await owner.query(`GRANT SELECT, INSERT ON "TripStateDocument" TO ${quote(runtimeRole)}`);
  await owner.query(`GRANT UPDATE ("revision", "snapshot") ON "TripStateDocument" TO ${quote(runtimeRole)}`);
  await owner.query(`GRANT SELECT, INSERT ON "TripStateHistory", "TripStateProposal", "TripStateIdempotency" TO ${quote(runtimeRole)}`);
  await grantConfirmationRuntime(owner, runtimeRole);
  parsed.username = runtimeRole; parsed.password = password;
  const result = { migrationUrl, runtimeUrl: parsed.toString(), database, runtimeRole, emptyTablesBeforeMigration: 0 };
  fs.writeFileSync(output, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ database, runtimeRole, empty_tables_before_migration: 0, migration: "applied", private_connection_file_written: true }));
} finally { await owner.end(); }
