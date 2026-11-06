import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { PgCheckpointRepository } from "../../../src/server/decision-context/checkpoint-store/repository";

it("routes Session-bound operations to the transactional SQL guard and rejects a mismatched owner", async () => {
  const fixture = (JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:unknown}[]).find((r) => r.schema === "checkpoint-payload")!.value;
  const query = vi.fn(async (sql: string) => sql.startsWith("SELECT e03_checkpoint.session_write")
    ? { rows:[{ value:{ fault:"ACCESS_DENIED" } }] } : { rows:[] });
  const release = vi.fn(), pool = { connect:async () => ({ query, release }) } as unknown as Pool;
  const binding = { sessionId:"real-session-derived-by-host", userId:"owner", trip:"trip-egypt-test", workspace:"host-bound" };
  const repo = new PgCheckpointRepository(pool, null, undefined, binding);
  const scope = { owner:"user-owner", trip:"trip-egypt-test", workspace:"host-bound" };
  await expect(repo.save({ ...scope, owner:"user-other" },0,"save",fixture,new Date())).rejects.toMatchObject({code:"ACCESS_DENIED"});
  binding.workspace = "other";
  await expect(repo.load({...scope,workspace:"other"},new Date())).rejects.toMatchObject({code:"ACCESS_DENIED"});
  await expect(repo.list(scope.owner,"other-trip",new Date())).rejects.toMatchObject({code:"ACCESS_DENIED"});
  expect(query).not.toHaveBeenCalled();
  await expect(repo.save(scope,0,"save",fixture,new Date())).rejects.toMatchObject({code:"ACCESS_DENIED"});
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN",expect.stringContaining("session_write_scene"),"ROLLBACK"]);
  expect(release).toHaveBeenCalled();
});

it("copies the bound scope before waiting for a database connection", async () => {
  const fixture = (JSON.parse(readFileSync("tests/decision-context/fixtures/r6-contracts.json", "utf8")) as {schema:string;value:unknown}[]).find((r) => r.schema === "checkpoint-payload")!.value;
  let connect!: (value: unknown) => void;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    return sql.startsWith("SELECT e03_checkpoint.session_write") ? { rows:[{ value:{ fault:"ACCESS_DENIED" } }] } : { rows:[] };
  });
  const pool = { connect:() => new Promise((resolve) => { connect = resolve; }) } as unknown as Pool;
  const repo = new PgCheckpointRepository(pool,null,undefined,{sessionId:"s",userId:"owner",trip:"trip-egypt-test",workspace:"host-bound"});
  const scope = {owner:"user-owner",trip:"trip-egypt-test",workspace:"host-bound"};
  const pending = repo.save(scope,0,"save",fixture,new Date());
  scope.workspace = "other";
  connect({query,release:vi.fn()});
  await expect(pending).rejects.toMatchObject({code:"ACCESS_DENIED"});
  const call = query.mock.calls.find(([sql]) => sql.includes("session_write_scene"));
  expect(call?.[1]?.[3]).toBe("host-bound");
});
