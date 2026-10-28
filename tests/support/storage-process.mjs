import fs from "node:fs";
import { Client } from "pg";

if (process.env.NODE_ENV !== "test") throw new Error("Synthetic storage subprocess only");
const config = JSON.parse(fs.readFileSync(process.env.E02_STORAGE_ENV_FILE, "utf8"));
if (!/^antu_e02_test_[a-z0-9_]+$/.test(config.database)) throw new Error("An isolated database is required");
const client = new Client({ connectionString: config.runtimeUrl });
await client.connect();
const identity = (await client.query('SELECT current_database() AS name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
if (identity.name !== config.database || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole) throw new Error("Actual connection must be an isolated unprivileged test identity");
if (process.env.E02_PROCESS_MODE === "crash") {
  process.on("message", async (batch) => {
    await client.query("BEGIN");
    await client.query('UPDATE "TripStateDocument" SET "snapshot"=$1::jsonb, "revision"=$2 WHERE "tripId"=$3', [JSON.stringify(batch.snapshot), batch.snapshot.revision, batch.tripId]);
    await client.query('INSERT INTO "TripStateHistory" ("tripId","sequence","intentId","changeRecordId","intent","change") VALUES ($1,1,$2,$3,$4::jsonb,$5::jsonb)',
      [batch.tripId, batch.intent.id, batch.change.id, JSON.stringify(batch.intent), JSON.stringify(batch.change)]);
    process.send({ staged: true }); // Parent SIGKILLs this process before COMMIT.
  });
  process.send({ ready: true });
} else {
  const trip = process.env.E02_READ_TRIP_ID;
  const state = (await client.query('SELECT "snapshot" FROM "TripStateDocument" WHERE "tripId"=$1', [trip])).rows[0]?.snapshot;
  const history = (await client.query('SELECT "intent","change" FROM "TripStateHistory" WHERE "tripId"=$1 ORDER BY "sequence"', [trip])).rows;
  const proposals = (await client.query('SELECT "proposalId","payload","basisRevision"::text FROM "TripStateProposal" WHERE "tripId"=$1', [trip])).rows;
  const requests = (await client.query('SELECT "requestDigest","request","response" FROM "TripStateIdempotency" WHERE "tripId"=$1', [trip])).rows;
  await client.end();
  console.log(JSON.stringify({ state, history, proposals, requests, processId: process.pid }));
}
