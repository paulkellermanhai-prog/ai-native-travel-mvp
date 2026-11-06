import type { Pool } from "pg";
import { digest } from "../../trip-state/command-json";
import { CheckpointError, checkpointDigest, validateCheckpoint } from "../checkpoint-core";
import { parseDCContract } from "../contracts";
import type { Ack, CheckpointPayload, SceneListResult } from "../contracts.generated";

/** A storage key, never an authentication proof. Only a future trusted host may bind it. */
export type StorageScope = Readonly<{ owner: string; trip: string; workspace: string }>;
/** Server-derived values from a real, verified Session; not a client JSON contract. */
export type VerifiedSession = Readonly<{ sessionId: string; userId: string }>;
type Fault = "before_commit" | "after_commit";
type Result = { fault?: string; ack?: Ack };
type Saved = { revision: number; saved_at: string; expires_at: string | null; payload_digest: string; payload: CheckpointPayload; fault?: string };
const fail = (code: string): never => { throw new CheckpointError(code); };
const checkScope = (scope: StorageScope) => {
  if (![scope.owner, scope.trip, scope.workspace].every((s) => typeof s === "string" && s.length > 0 && s.length <= 512)) fail("CHECKPOINT_POLICY");
};
const checkRevision = (revision: number) => {
  if (!Number.isSafeInteger(revision) || revision < 0) fail("CHECKPOINT_POLICY");
};
const stamp = (value: Date): string => value.toISOString().replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => milliseconds === "000" ? "Z" : `.${milliseconds}000Z`);

/**
 * Restricted storage-only candidate. Caller must bind actual Session/owner/trip/workspace;
 * never expose this interface to HTTP. Pool must use a role with EXECUTE-only privileges.
 */
export class PgCheckpointRepository {
  constructor(private readonly pool: Pool, private readonly retentionSeconds: number | null,
    private readonly fault?: (point: Fault) => void | Promise<void>, private readonly session?: VerifiedSession) {
    if (retentionSeconds !== null && (!Number.isSafeInteger(retentionSeconds) || retentionSeconds <= 0)) fail("CHECKPOINT_POLICY");
    if (fault && process.env.NODE_ENV !== "test") fail("CHECKPOINT_POLICY");
  }

  private requireOwner(owner: string) {
    if (this.session && (!this.session.sessionId || !this.session.userId || owner !== `user-${this.session.userId}`)) fail("ACCESS_DENIED");
  }

  async save(scope: StorageScope, expected: number, key: string, input: unknown, now: Date): Promise<Ack> {
    const candidate = input as Partial<CheckpointPayload>;
    const payload = validateCheckpoint(input, scope.trip, candidate?.captured_state_revision ?? -1);
    return this.write(scope, expected, key, payload, now, false);
  }

  async delete(scope: StorageScope, expected: number, key: string, now: Date): Promise<Ack> {
    return this.write(scope, expected, key, null, now, true);
  }

  private async write(scope: StorageScope, expected: number, key: string, payload: CheckpointPayload | null, now: Date, deleted: boolean): Promise<Ack> {
    checkScope(scope); this.requireOwner(scope.owner); checkRevision(expected);
    if (!key || key.length > 512 || !Number.isFinite(now.getTime())) fail("CHECKPOINT_POLICY");
    const savedAt = stamp(now);
    let expires: string | null = null;
    if (!deleted && this.retentionSeconds !== null) {
      const expireTime = now.getTime() + this.retentionSeconds * 1000;
      if (!Number.isFinite(expireTime) || Math.abs(expireTime) > 8.64e15) fail("CHECKPOINT_POLICY");
      expires = stamp(new Date(expireTime));
    }
    const requestDigest = digest({ expected_revision: expected, payload, deleted });
    const client = await this.pool.connect().catch(() => fail("CHECKPOINT_STORAGE"));
    let commitSent = false, committed = false;
    try {
      await client.query("BEGIN");
      const params = [scope.trip, scope.workspace, expected, key, requestDigest, payload === null ? null : JSON.stringify(payload),
        payload === null ? null : checkpointDigest(payload), savedAt, expires, deleted];
      const rows = this.session
        ? await client.query<{ value: Result }>("SELECT e03_checkpoint.session_write_scene($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) AS value", [this.session.sessionId, this.session.userId, ...params])
        : await client.query<{ value: Result }>("SELECT e03_checkpoint.write_scene($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) AS value", [scope.owner, ...params]);
      const result = rows.rows[0]?.value;
      if (!result) fail("CHECKPOINT_STORAGE");
      if (result.fault) fail(result.fault);
      const ack = result.ack;
      if (!ack) throw new CheckpointError("CHECKPOINT_STORAGE");
      try { parseDCContract("scene-ack", { runtime_contract_version: "0.1.0", ack }); }
      catch { throw new CheckpointError("CHECKPOINT_STORAGE"); }
      if (ack.workspace_key !== scope.workspace || ack.checkpoint_revision !== expected + 1 || ack.deleted !== deleted ||
          ack.payload_digest !== (payload === null ? null : checkpointDigest(payload))) throw new CheckpointError("CHECKPOINT_STORAGE");
      await this.fault?.("before_commit");
      commitSent = true;
      await client.query("COMMIT");
      committed = true;
      await this.fault?.("after_commit");
      return ack;
    } catch (error) {
      if (!commitSent) await client.query("ROLLBACK").catch(() => undefined);
      if (commitSent || committed) return fail("CHECKPOINT_ACK_UNKNOWN");
      if (error instanceof CheckpointError) throw error;
      return fail("CHECKPOINT_STORAGE");
    } finally { client.release(commitSent && !committed); }
  }

  async load(scope: StorageScope, now: Date): Promise<Saved> {
    checkScope(scope); this.requireOwner(scope.owner);
    if (!Number.isFinite(now.getTime())) fail("CHECKPOINT_POLICY");
    let saved: Saved;
    try { saved = this.session
      ? (await this.pool.query<{ value: Saved }>("SELECT e03_checkpoint.session_read_scene($1,$2,$3,$4,$5) AS value", [this.session.sessionId, this.session.userId, scope.trip, scope.workspace, now.toISOString()])).rows[0].value
      : (await this.pool.query<{ value: Saved }>("SELECT e03_checkpoint.read_scene($1,$2,$3,$4) AS value", [scope.owner, scope.trip, scope.workspace, now.toISOString()])).rows[0].value; }
    catch { return fail("CHECKPOINT_STORAGE"); }
    if (saved.fault) fail(saved.fault);
    try {
      checkRevision(saved.revision);
      saved.payload = validateCheckpoint(saved.payload, scope.trip, saved.payload.captured_state_revision);
      if (checkpointDigest(saved.payload) !== saved.payload_digest) fail("CHECKPOINT_CORRUPT");
    } catch { return fail("CHECKPOINT_CORRUPT"); }
    return saved;
  }

  async list(owner: string, trip: string, now: Date): Promise<SceneListResult["checkpoints"]> {
    checkScope({ owner, trip, workspace: "_" }); this.requireOwner(owner);
    if (!Number.isFinite(now.getTime())) fail("CHECKPOINT_POLICY");
    let value: SceneListResult["checkpoints"] | { fault: string };
    try { value = this.session
      ? (await this.pool.query<{ value: SceneListResult["checkpoints"] | { fault: string } }>("SELECT e03_checkpoint.session_list_scenes($1,$2,$3,$4) AS value", [this.session.sessionId, this.session.userId, trip, now.toISOString()])).rows[0].value
      : (await this.pool.query<{ value: SceneListResult["checkpoints"] }>("SELECT e03_checkpoint.list_scenes($1,$2,$3) AS value", [owner, trip, now.toISOString()])).rows[0].value; }
    catch { return fail("CHECKPOINT_STORAGE"); }
    if (!Array.isArray(value)) return fail(value.fault || "CHECKPOINT_STORAGE");
    return value;
  }

  async revision(scope: StorageScope, now: Date): Promise<number> {
    checkScope(scope);
    const rows = await this.list(scope.owner, scope.trip, now);
    const value = rows.find((row) => row.workspace_key === scope.workspace)?.checkpoint_revision ?? 0;
    checkRevision(value);
    return value;
  }
}
