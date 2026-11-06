import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { PgCheckpointRepository } from "../../../src/server/decision-context/checkpoint-store/repository";

it("routes Session-bound operations to the transactional SQL guard and rejects a mismatched owner", async () => {
  const fixture = (JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:unknown}[]).find((r) => r.schema === "checkpoint-payload")!.value;
  const query = vi.fn(async (sql: string) => sql.startsWith("SELECT e03_checkpoint.session_write")
    ? { rows:[{ value:{ fault:"ACCESS_DENIED" } }] } : { rows:[] });
  const release = vi.fn(), pool = { connect:async () => ({ query, release }) } as unknown as Pool;
  const repo = new PgCheckpointRepository(pool, null, undefined, { sessionId:"real-session-derived-by-host", userId:"owner" });
  const scope = { owner:"user-owner", trip:"trip-egypt-test", workspace:"host-bound" };
  await expect(repo.save({ ...scope, owner:"user-other" },0,"save",fixture,new Date())).rejects.toMatchObject({code:"ACCESS_DENIED"});
  expect(query).not.toHaveBeenCalled();
  await expect(repo.save(scope,0,"save",fixture,new Date())).rejects.toMatchObject({code:"ACCESS_DENIED"});
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN",expect.stringContaining("session_write_scene"),"ROLLBACK"]);
  expect(release).toHaveBeenCalled();
});
