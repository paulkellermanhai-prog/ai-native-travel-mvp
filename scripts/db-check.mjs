import pg from "pg";
import { z } from "zod";

const url = z.url().parse(process.env.DATABASE_URL);
if (!["postgresql:", "postgres:"].includes(new URL(url).protocol)) {
  throw new Error("DATABASE_URL must use PostgreSQL");
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query("SELECT 1 AS ok, version() AS version");
  console.log(JSON.stringify(rows[0]));
} finally {
  await client.end();
}
