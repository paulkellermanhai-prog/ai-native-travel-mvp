import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = "specs/ts-ac8-stage-a-2026-11-03";
const packageRoot = path.join(root, "trip-state-schema-v0.1");
const oldRoot = "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包";
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const selection = JSON.parse(fs.readFileSync(path.join(root, "selection.json"), "utf8"));
const indexPath = path.join(packageRoot, "package-index.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const sourcePath = path.join(packageRoot, "90_可运行工程包/source-manifest.json");
const manifest = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const check = (condition, message) => { if (!condition) throw new Error(message); };

check(sha(path.join(root, "trip-state-schema-v0.1.zip")) === selection.zip_sha256, "Approved delivery ZIP SHA-256 changed");
check(sha(indexPath) === selection.package_index_sha256, "Approved package index SHA-256 changed");
check(sha(sourcePath) === selection.source_manifest_sha256, "Approved source manifest SHA-256 changed");
check(index.package_revision === selection.package_revision && index.schema_version === selection.schema_version
  && index.approval_status === selection.original_package_index_status, "Original package revision/status changed");
check(manifest.sources.length === selection.source_count && index.files.length === selection.canonical_file_count, "Source inventory changed");
for (const entry of index.files) check(sha(path.join(packageRoot, entry.canonical_path)) === entry.sha256, `Canonical file changed: ${entry.canonical_path}`);
const schemas = fs.readdirSync(path.join(packageRoot, "90_可运行工程包/schemas")).filter((name) => name.endsWith(".json"));
check(schemas.length === selection.machine_schema_count, "Machine Schema count changed");
for (const name of schemas) check(fs.readFileSync(path.join(packageRoot, "90_可运行工程包/schemas", name)).equals(fs.readFileSync(path.join(oldRoot, "schemas", name))), `E02 machine contract changed: ${name}`);
const trace = "examples/scenario-traces.json";
check(fs.readFileSync(path.join(packageRoot, "90_可运行工程包", trace)).equals(fs.readFileSync(path.join(oldRoot, trace))), "E02 A-G trace changed");
const scenarios = JSON.parse(fs.readFileSync(path.join(packageRoot, "90_可运行工程包", trace), "utf8"));
check(scenarios.length === 7 && scenarios.reduce((count, item) => count + item.steps.length, 0) === 31, "A-G scenario count changed");
console.log(`AC8 source: ${manifest.sources.length} source hashes recorded; ${index.files.length} canonical hashes verified; ${schemas.length} unchanged schemas; 7 scenarios/31 unchanged steps; ZIP SHA-256 verified`);
