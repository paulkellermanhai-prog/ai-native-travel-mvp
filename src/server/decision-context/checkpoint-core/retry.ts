import { CheckpointError, validateCheckpoint } from "./index";
import type { Ack, CheckpointPayload } from "../contracts.generated";
import type { StorageScope } from "../checkpoint-store/repository";

type Save = (scope: StorageScope, expected: number, key: string, payload: CheckpointPayload, now: Date) => Promise<Ack>;
type Pending = { scope: StorageScope; expected: number; key: string; payload: CheckpointPayload };

/** Per-host-instance pending save. No business command or old authority is captured/replayed. */
export class PendingCheckpointSave {
  private pending: Pending | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly saveOnly: Save) {}

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(action);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async save(scope: StorageScope, expected: number, key: string, input: unknown, now: Date): Promise<Ack> {
    const draft = input as Partial<CheckpointPayload>;
    const payload = validateCheckpoint(input, scope.trip, draft?.captured_state_revision ?? -1);
    const record = { scope: { ...scope }, expected, key, payload };
    const timestamp = new Date(now);
    return this.exclusive(() => this.perform(record, timestamp));
  }

  private async perform(record: Pending, now: Date): Promise<Ack> {
    try {
      const ack = await this.saveOnly({ ...record.scope }, record.expected, record.key, structuredClone(record.payload), now);
      this.pending = null;
      return ack;
    } catch (error) {
      this.pending = structuredClone(record);
      throw error;
    }
  }

  async retry(now: Date): Promise<Ack> {
    const timestamp = new Date(now);
    return this.exclusive(() => {
      if (!this.pending) throw new CheckpointError("CHECKPOINT_RETRY_EMPTY");
      return this.perform(structuredClone(this.pending), timestamp);
    });
  }
}
