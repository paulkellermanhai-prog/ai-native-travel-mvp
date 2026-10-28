import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { TripStateContracts } from "./contracts.generated";
import { schemaResources } from "./schema-resources.generated";

export type ContractName = keyof TripStateContracts;
export type { TripStateContracts } from "./contracts.generated";

export class TripStateContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TripStateContractError";
    this.code = code;
  }
}

const ajv = new Ajv2020({
  strict: true, allowUnionTypes: true, allErrors: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false,
});
addFormats(ajv);
// Synchronous compilation from registered original $ids: no loadSchema or network fallback.
for (const schema of Object.values(schemaResources)) ajv.addSchema(schema);
const validators = new Map(Object.entries(schemaResources).map(([name, schema]) => {
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`Missing offline contract: ${name}`);
  return [name, validate];
}));

/** Shape/format validation only. It is not authorization, a state transition or a full business guard. */
export function parseContract<N extends ContractName>(name: N, value: unknown): TripStateContracts[N] {
  const validate = validators.get(name);
  if (!validate || !validate(value)) {
    const error = validate?.errors?.[0];
    throw new TripStateContractError("SCHEMA", `${name}:${error?.instancePath ?? ""}: ${error?.message ?? "Unknown contract"}`);
  }
  return value as TripStateContracts[N];
}
