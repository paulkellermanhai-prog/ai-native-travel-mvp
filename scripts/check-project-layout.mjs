import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = JSON.parse(fs.readFileSync(path.join(root, "docs/project-cleanup.json"), "utf8"));
const failures = [];
const exists = relative => fs.existsSync(path.join(root, relative));
let receipts = 0;
for (const move of migration.moves) {
  if (!exists(move.to)) failures.push(`Missing relocated file: ${move.to}`);
  if (exists(move.from) && move.from !== "src/server/decision-context/host-runtime/README.md") {
    failures.push(`Unexpected duplicate at old location: ${move.from}`);
  }
  if (move.to.endsWith(".json") && exists(move.to)) {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, move.to))).digest("hex");
    if (digest !== move.original_sha256) failures.push(`Historical receipt changed: ${move.to}`);
    receipts++;
  }
}
for (const removed of migration.removed) {
  if (exists(removed.path)) failures.push(`Superseded file restored: ${removed.path}`);
}

const documents = ["README.md", "AGENTS.md", "specs/README.md", "scripts/README.md", "handoff/README.md",
  "src/server/decision-context/host-runtime/README.md"];
for (const folder of ["docs", "docs/development"]) {
  for (const name of fs.readdirSync(path.join(root, folder))) {
    if (name.endsWith(".md")) documents.push(`${folder}/${name}`);
  }
}
let links = 0;
for (const relative of documents) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]*)\)/g)) {
    const url = match[1].replace(/^<|>$/g, "");
    if (!url || url.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(url)) continue;
    const target = path.resolve(root, path.dirname(relative), decodeURIComponent(url.split("#")[0]));
    if (!fs.existsSync(target)) failures.push(`Broken link in ${relative}: ${url}`);
    links++;
  }
}

for (const relative of ["docs/e03-progress.json", "docs/e04-progress.json"]) {
  const progress = fs.readFileSync(path.join(root, relative), "utf8");
  for (const match of progress.matchAll(/"(docs\/[^"\n]+)"/g)) {
    if (!exists(match[1])) failures.push(`Missing progress reference in ${relative}: ${match[1]}`);
  }
}

if (failures.length) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ moved_files: migration.moves.length,
    immutable_json_receipts: receipts, current_documents: documents.length, local_links: links, status: "PASS" }) + "\n");
}
