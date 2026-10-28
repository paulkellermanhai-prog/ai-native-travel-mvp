import { TripStateContractError } from "./contracts";

/** An execution representation boundary, not a change to the original unbounded integer schema. */
export function safeCounter(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TripStateContractError("INTEGER_REPRESENTATION", `${name} cannot be represented exactly by this JavaScript runtime`);
  return value;
}
export function incrementCounter(value: number, name: string): number {
  safeCounter(value, name);
  return safeCounter(value + 1, name);
}
export function checkStateCounters(state: { revision: number; objects: Array<{ version: number; subject_version?: number; dependencies?: Array<{ version: number }> }> }): void {
  safeCounter(state.revision, "revision");
  for (const object of state.objects) {
    safeCounter(object.version, "object version");
    if (object.subject_version !== undefined) safeCounter(object.subject_version, "subject version");
    for (const dependency of object.dependencies ?? []) safeCounter(dependency.version, "dependency version");
  }
}
