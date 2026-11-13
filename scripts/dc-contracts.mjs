import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compile } from "json-schema-to-typescript";
const dc = "specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/90_可运行工程包/schemas";
const ts = "specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/schemas";
const selection = "specs/dc-ac8-r6-calibration-2026-11-05/selection.json";
if (crypto.createHash("sha256").update(fs.readFileSync(selection)).digest("hex") !== "eaff06a085946c3a55ddd395169a534b12d8b896e7c4f5dd2b4bde08a46bca77") throw new Error("Accepted R6 source lock changed");
const read = (dir, prefix) => fs.readdirSync(dir).filter(n => n.endsWith(".schema.json")).sort().map(file => ({ name: file.replace(".schema.json", ""), key: prefix + file.replace(".schema.json", ""), file: `${dir}/${file}`, schema: JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8")) }));
const entries = [...read(dc, "dc_"), ...read(ts, "ts_")];
const byId = new Map(entries.map(e => [e.schema.$id, e]));
function localize(value, entry) {
  if (Array.isArray(value)) return value.map(v => localize(v, entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !["$id", "$schema"].includes(k)).map(([k,v]) => {
    if (k !== "$ref") return [k, localize(v, entry)];
    const [id, fragment] = v.split("#"), target = id ? byId.get(id) : entry;
    if (!target) throw new Error(`Unregistered offline type reference: ${v}`);
    return [k, `#/definitions/${target.key}${fragment ?? ""}`];
  }));
  return value;
}
const dcs = entries.filter(e => e.key.startsWith("dc_"));
if (dcs.length !== 20 || entries.length !== 40) throw new Error("Contract inventory changed");
const envelope = { title:"DecisionContextContracts", type:"object", additionalProperties:false,
  properties: Object.fromEntries(dcs.map(e=>[e.name,{$ref:`#/definitions/${e.key}`}])), required:dcs.map(e=>e.name), definitions:Object.fromEntries(entries.map(e=>{ const schema=localize(e.schema,e); if (schema.$ref?.startsWith(`#/definitions/${e.key}/$defs/`)) { const name=schema.$ref.split("/").at(-1); const { $ref: ignored, ...rest }=schema; void ignored; return [e.key,{...rest,...schema.$defs[name]}]; } return [e.key,schema]; })) };
const banner = "/* Generated from Gate A accepted R6. Run npm run dc:generate. Do not edit. */";
const types = await compile(envelope,"DecisionContextContracts",{bannerComment:banner,unknownAny:true,maxItems:-1,$refOptions:{resolve:{http:false,file:false}}});
const registry = banner+"\n"+dcs.map((e,i)=>`import s${i} from "../../../${e.file}";`).join("\n")+"\nexport const dcSchemaResources = {\n"+dcs.map((e,i)=>`  "${e.name}": s${i},`).join("\n")+"\n} as const;\n";
for (const [file,content] of [["contracts.generated.ts",types],["schema-resources.generated.ts",registry]]) {
 const out=path.join("src/server/decision-context",file);
 if(process.argv.includes("--check")) { if(fs.readFileSync(out,"utf8")!==content) throw new Error(`Stale DC contract: ${file}`); }
 else {fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,content);}
}
console.log("DC: 20 original schemas, 20 TS dependencies; offline types verified/generated");
