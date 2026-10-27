import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(fs.readFileSync(path.join(root, "specs/trip-state-development-baseline.json"), "utf8"));
const manifestHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "specs/baseline-2026-10-27/manifest.json"))).digest("hex");
if (baseline.status !== "OWNER_CONFIRMED_FOR_E02_DEVELOPMENT" || baseline.version !== "0.1.0" || baseline.source_manifest_sha256 !== manifestHash) throw new Error("Owner-confirmed development baseline is required");
const directory = "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/schemas";
const entries = fs.readdirSync(path.join(root, directory)).filter((f) => f.endsWith(".schema.json")).sort()
  .map((file) => [file.replace(".schema.json", ""), JSON.parse(fs.readFileSync(path.join(root, directory, file), "utf8"))]);
const base = "https://trip-state.example/spec/0.1/";
// Type-generation view only: keep every source file and original runtime $id unchanged.
function localize(value) {
  if (Array.isArray(value)) return value.map(localize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "$id" && key !== "$schema")
    .map(([key, child]) => [key, key === "$ref"
      ? child.replace(base, "#/definitions/").replace(".schema.json", "").replace("#/$defs/", "/$defs/")
      : localize(child)]));
  return value;
}
const envelope = {
  title: "TripStateContracts", type: "object", additionalProperties: false,
  properties: Object.fromEntries(entries.map(([name]) => [name, { $ref: `#/definitions/${name}` }])),
  required: entries.map(([name]) => name), definitions: Object.fromEntries(entries.map(([name, schema]) => [name, localize(schema)])),
};
const banner = "/* Generated from immutable Trip State 0.1.0 schemas. Run npm run contracts:generate. Do not edit. */";
const types = await compile(envelope, "TripStateContracts", {
  bannerComment: banner, unknownAny: true, maxItems: -1,
  $refOptions: { resolve: { http: false, file: false } },
});
const imports = entries.map(([name], i) => `import schema${i} from "../../../${directory}/${name}.schema.json";`).join("\n");
const registry = `${banner}\n${imports}\n\nexport const schemaResources = {\n${entries.map(([name], i) => `  "${name}": schema${i},`).join("\n")}\n} as const;\n`;
for (const [name, content] of [["contracts.generated.ts", types], ["schema-resources.generated.ts", registry]]) {
  const output = path.join(root, "src/server/trip-state", name);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== content) throw new Error(`Stale generated contract: ${name}`);
  } else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content);
  }
}
console.log(`Trip State: ${entries.length} offline schemas; generated types ${process.argv.includes("--check") ? "verified" : "written"}`);
