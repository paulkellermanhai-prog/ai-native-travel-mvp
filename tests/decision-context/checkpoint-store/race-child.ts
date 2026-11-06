import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { PgCheckpointRepository, type StorageScope } from "../../../src/server/decision-context/checkpoint-store/repository";

const url = process.env.E03_CHILD_DATABASE_URL;
const scope = JSON.parse(process.env.E03_CHILD_SCOPE ?? "null") as StorageScope | null;
if (!url || !scope) throw new Error("Missing isolated test child environment");
const payload = (JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:unknown}[]).find((r) => r.schema === "checkpoint-payload")!.value;
const pool = new Pool({ connectionString: url });
await pool.query("SELECT 1");
process.stdout.write("ready\n");
await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
try {
  const ack = await new PgCheckpointRepository(pool, null).save(scope, 0, process.env.E03_CHILD_KEY!, payload, new Date("2030-01-01T00:00:00Z"));
  process.stdout.write(`${JSON.stringify({ revision: ack.checkpoint_revision })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ code: (error as {code?:string}).code })}\n`);
} finally { await pool.end(); }
