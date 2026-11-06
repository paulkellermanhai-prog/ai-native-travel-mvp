import { randomUUID } from "node:crypto";
import { CheckpointError } from "../checkpoint-core";

/** Local generation primitive only; the real Turn/Grant host must adopt it atomically. */
export class RecoveryGeneration {
  private current = `runtime-${randomUUID().replaceAll("-", "")}`;
  get id(): string { return this.current; }
  rotate(): string { this.current = `runtime-${randomUUID().replaceAll("-", "")}`; return this.current; }
  requireCurrent(id: string): void { if (id !== this.current) throw new CheckpointError("WRITE_GRANT"); }
}
