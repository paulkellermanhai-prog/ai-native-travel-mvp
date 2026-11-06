import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { schemaResources } from "../trip-state/schema-resources.generated";
import { decodeCommandJson } from "../trip-state/command-json";
import { dcSchemaResources } from "./schema-resources.generated";
import type { DecisionContextContracts } from "./contracts.generated";
export type { DecisionContextContracts } from "./contracts.generated";
export type DCContractName = keyof DecisionContextContracts;
export type FoundationErrorCode = "SCHEMA" | "INVALID_JSON" | "INTEGER_REPRESENTATION" | "PERMISSION";
/** Internal adaptation errors, never new DC wire error enums. No input values in diagnostics. */
export class DecisionContextContractError extends Error {
  constructor(readonly code: FoundationErrorCode) { super(`Decision Context boundary: ${code}`); this.name = "DecisionContextContractError"; }
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats(ajv);
for (const schema of [...Object.values(schemaResources), ...Object.values(dcSchemaResources)]) ajv.addSchema(schema);
const validators = new Map(Object.entries(dcSchemaResources).map(([name,schema]) => {
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`Missing offline DC schema: ${name}`);
  return [name,validate];
}));
// Exact execution representation boundary; the frozen JSON Schema remains unbounded.
const counters = new Set(["expected_revision", "revision", "version", "subject_version", "base_revision", "result_revision"]);
function collect(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key,child] of Object.entries(value)) {
    if (child && typeof child === "object" && "type" in child && child.type === "integer") counters.add(key);
    collect(child);
  }
}
for (const schema of Object.values(dcSchemaResources)) collect(schema);
function checkNumbers(value: unknown, key = ""): void {
  if (typeof value === "number" && counters.has(key) && (!Number.isSafeInteger(value) || value < 0)) throw new DecisionContextContractError("INTEGER_REPRESENTATION");
  if (value && typeof value === "object") for (const [k,v] of Object.entries(value)) checkNumbers(v,k);
}
/** Shape and safe-counter validation only: creates no authorization or runtime state. */
export function parseDCContract<N extends DCContractName>(name: N, value: unknown): DecisionContextContracts[N] {
  if (!validators.get(name)?.(value)) throw new DecisionContextContractError("SCHEMA");
  checkNumbers(value);
  return value as DecisionContextContracts[N];
}
export function decodeDCContract<N extends DCContractName>(name: N, text: string): DecisionContextContracts[N] {
  let value: unknown;
  try { value = decodeCommandJson(text,[...counters]); }
  catch (error) { throw new DecisionContextContractError(error instanceof SyntaxError ? "INVALID_JSON" : "INTEGER_REPRESENTATION"); }
  return parseDCContract(name,value);
}
