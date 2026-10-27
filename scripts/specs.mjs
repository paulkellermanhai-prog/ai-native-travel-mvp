import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "specs", "baseline-2026-10-27");
const manifestPath = path.join(bundle, "manifest.json");
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mode = process.argv[2];

if (mode === "export") {
  if (!process.argv[3]) throw new Error("Provide the authorized local product directory");
  const source = path.resolve(process.argv[3]);
  if (fs.existsSync(manifestPath)) throw new Error("Baseline already exists; do not overwrite a versioned handoff");
  const selected = new Set();
  const add = (relative) => {
    const stat = fs.lstatSync(path.join(source, relative));
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not exported: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(source, relative)).sort()) {
        if (name.startsWith(".") || name === "__pycache__") continue;
        add(path.join(relative, name));
      }
    } else if (/\.(md|json|jsonl|py|txt)$/.test(relative)) selected.add(relative);
  };
  add("AI Native旅行产品｜PRD V0.1.md");
  const ts = "trip-state-schema-v0.1/90_可运行工程包";
  add("trip-state-schema-v0.1/package-index.json");
  for (const name of fs.readdirSync(path.join(source, ts)).filter((name) => name.endsWith(".md"))) add(`${ts}/${name}`);
  for (const dir of ["schemas", "rules", "examples", "tripstate"]) add(`${ts}/${dir}`);
  for (const name of ["test_tripstate.py", "test_artifacts.py", "test_global_consistency.py", "test_reservation_profile.py"]) add(`${ts}/tests/${name}`);
  for (const name of ["requirements.txt", "scenario_runner.py"]) add(`${ts}/${name}`);
  const dc = "decision-context-v0.1";
  add(`${dc}/package-index.json`);
  add(`${dc}/04_工程规格`);
  for (const name of ["README.md", "FIELD_DICTIONARY.md", "context_runtime/contracts.py", "examples"]) add(`${dc}/90_可运行工程包/${name}`);
  for (const name of fs.readdirSync(path.join(source, dc, "90_可运行工程包/schemas")).filter((name) => name.endsWith(".json"))) add(`${dc}/90_可运行工程包/schemas/${name}`);
  const nap = "Next-Action-Policy-V0.1";
  const napIndex = JSON.parse(fs.readFileSync(path.join(source, nap, "package-index.json"), "utf8"));
  add(`${nap}/package-index.json`);
  for (const item of napIndex.file_inventory) add(`${nap}/${item.path}`);
  add(`${nap}/nap-c3-validation`);
  selected.delete(`${nap}/nap-c3-validation/source-manifest.json`);

  const privatePattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})|\/Users\/[^/\s]+\//;
  const unsafe = [...selected].filter((relative) => privatePattern.test(fs.readFileSync(path.join(source, relative), "utf8")));
  if (unsafe.length) throw new Error(`Review potential sensitive material before export: ${unsafe.join(", ")}`);
  const files = [];
  for (const relative of [...selected].sort()) {
    const original = path.join(source, relative);
    const target = path.join(bundle, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sha256 = digest(original);
    if (!fs.existsSync(target)) fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
    if (digest(target) !== sha256) throw new Error(`Copy mismatch: ${relative}`);
    files.push({ path: relative.replaceAll(path.sep, "/"), source_path: relative.replaceAll(path.sep, "/"), bytes: fs.statSync(original).size, sha256 });
  }
  const manifest = {
    format: "antu-specification-handoff/v1", date: "2026-10-27",
    source: "authorized local product workspace; source_path is relative to that directory",
    approval: { trip_state_0_1_0: "DEVELOPMENT_BASELINE_PENDING_OWNER_CONFIRMATION", decision_context_r4: "CANDIDATE_PENDING_REVIEW", next_action_policy_0_1_0: "OWNER_APPROVAL_NOT_RECORDED" },
    scope: "E02 authoritative contracts and reference fixtures; copied reference code is not application implementation",
    related_sources_not_copied: [
      { path: "AI Native旅行产品｜项目思考总纲 V2.md", sha256: digest(path.join(source, "AI Native旅行产品｜项目思考总纲 V2.md")), reason: "PRD retains this source association; raw V2 contains local personal filesystem paths and is not needed to redefine the PRD for E02" },
      { path: `${nap}/nap-c3-validation/source-manifest.json`, sha256: digest(path.join(source, nap, "nap-c3-validation/source-manifest.json")), reason: "Local export metadata contains personal filesystem paths; original C3 documents and their hashes are retained" },
    ],
    unresolved: ["DC prose table says 0.1.0 while index/code/schema use 0.2.0", "NAP references sibling nap-c3-validation; byte-identical source is nested in the NAP directory"],
    exclusions: ["duplicate reading mirrors", "historical Handoff discussions", "local exports and absolute paths", "distribution builders and packaging-only tests", "DC runtime implementation and legacy contracts", "private environments, credentials, caches and OS metadata"],
    files,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ exported_files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), manifest: path.relative(root, manifestPath) }));
} else if (mode === "verify") {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.approval.trip_state_0_1_0 !== "DEVELOPMENT_BASELINE_PENDING_OWNER_CONFIRMATION") throw new Error("Owner confirmation status changed");
  for (const file of manifest.files) {
    const target = path.resolve(bundle, file.path);
    if (!target.startsWith(`${bundle}${path.sep}`) || fs.lstatSync(target).isSymbolicLink()) throw new Error(`Unsafe manifest path: ${file.path}`);
    if (fs.statSync(target).size !== file.bytes || digest(target) !== file.sha256) throw new Error(`Specification integrity failed: ${file.path}`);
  }
  const approvalPath = path.join(root, "specs", "trip-state-development-baseline.json");
  const approval = fs.existsSync(approvalPath) ? JSON.parse(fs.readFileSync(approvalPath, "utf8")) : null;
  if (approval && (approval.version !== "0.1.0" || approval.status !== "OWNER_CONFIRMED_FOR_E02_DEVELOPMENT" || approval.source_manifest_sha256 !== digest(manifestPath))) throw new Error("Development baseline does not match the Owner-confirmed snapshot");
  console.log(JSON.stringify({ verified_files: manifest.files.length, snapshot_trip_state_status: manifest.approval.trip_state_0_1_0, current_development_baseline: approval?.status ?? "PENDING_OWNER_CONFIRMATION", unresolved: manifest.unresolved }));
} else {
  throw new Error("Use: node scripts/specs.mjs export <local-product-directory> | verify");
}
