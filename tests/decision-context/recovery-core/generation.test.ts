import { expect, it } from "vitest";
import { RecoveryGeneration } from "../../../src/server/decision-context/recovery-core/generation";

it("rotates the local authorization generation even in the same process", () => {
  const g = new RecoveryGeneration(), old = g.id, current = g.rotate();
  expect(current).not.toBe(old);
  expect(() => g.requireCurrent(old)).toThrowError(expect.objectContaining({ code:"WRITE_GRANT" }));
  expect(() => g.requireCurrent(current)).not.toThrow();
});
