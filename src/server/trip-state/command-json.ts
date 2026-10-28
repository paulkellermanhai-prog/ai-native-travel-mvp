import { createHash } from "node:crypto";
import { TripStateContractError } from "./contracts";
import { safeCounter } from "./numbers";

// Node 24 provides the original token to the JSON reviver. Check before precision can be hidden.
export function decodeCommandJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (["expected_revision", "revision", "version", "subject_version", "base_revision", "result_revision"].includes(key) && typeof value === "number") {
      safeCounter(value, key);
      const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(context?.source ?? "");
      if (!match) throw new TripStateContractError("INTEGER_REPRESENTATION", "Lossless counter token is required");
      const coefficient = BigInt(match[2] + (match[3] ?? ""));
      const shift = BigInt(match[4] ?? "0") - BigInt(match[3]?.length ?? 0);
      let exact = 0n;
      if (coefficient) {
        if (shift > 16n || -shift > BigInt((match[2] + (match[3] ?? "")).length)) throw new TripStateContractError("INTEGER_REPRESENTATION", "Counter token is outside the exact integer representation");
        if (shift >= 0n) exact = coefficient * 10n ** shift;
        else {
          const divisor = 10n ** -shift;
          if (coefficient % divisor) throw new TripStateContractError("INTEGER_REPRESENTATION", "Counter token is not an exact integer");
          exact = coefficient / divisor;
        }
      }
      if (match[1]) exact = -exact;
      if (BigInt(value) !== exact) throw new TripStateContractError("INTEGER_REPRESENTATION", "Counter token lost precision");
    }
    return value;
  });
}

// Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')) for JSON wire values.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TripStateContractError("INTEGER_REPRESENTATION", "Non-finite JSON number");
    const wire = JSON.stringify(value);
    if (!wire.includes(".") && !wire.includes("e")) return wire;
    const [coefficient, power] = value.toExponential().split("e");
    const exponent = Number(power);
    if (exponent < -4 || exponent >= 16) return `${coefficient}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
    return wire;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const compare = (a: string, b: string) => {
      const x = Array.from(a, (c) => c.codePointAt(0)!), y = Array.from(b, (c) => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    };
    return `{${Object.keys(object).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TripStateContractError("SCHEMA", "Only JSON values can be hashed");
}
export const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
