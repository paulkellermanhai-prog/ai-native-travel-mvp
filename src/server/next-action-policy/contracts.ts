import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import napSchema from "../../../specs/nap-r3-2026-11-06/sources/engineering/contracts.schema.json";
import { schemaResources } from "../trip-state/schema-resources.generated";
import { dcSchemaResources } from "../decision-context/schema-resources.generated";

// Contract structure only: this is not an authorization, freshness or policy check.
export const napMessageNames = ["DecisionRequest", "DecisionPlan", "ToolCompletion", "UIFeedback", "RequestObservation", "ActionRecord", "Error"] as const;
export type NapMessageName = typeof napMessageNames[number];
export class NapContractError extends Error {
  constructor() { super("NAP 0.1.0 message: SCHEMA"); this.name = "NapContractError"; }
}

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats(ajv);
for (const schema of [...Object.values(schemaResources), ...Object.values(dcSchemaResources)]) ajv.addSchema(schema);
ajv.addSchema(napSchema);
const validators = new Map(napMessageNames.map(name => {
  const validate = ajv.getSchema(`${napSchema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Missing NAP 0.1.0 schema: ${name}`);
  return [name, validate];
}));

/** In-memory shape/format validation; no JSON decoder, side effects or trusted provenance. */
export function validateNapMessage(name: NapMessageName, value: unknown): void {
  if (!validators.get(name)?.(value)) throw new NapContractError();
}
