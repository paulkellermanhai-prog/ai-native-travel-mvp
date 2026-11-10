import { describe, expect, it, vi } from "vitest";
import { connectTrustedCheckpointHost, type TrustedCheckpointHost } from "../../../src/server/decision-context/recovery-service/trusted-host";

describe("trusted checkpoint host connection", () => {
  it("forwards only the opaque host ticket and authenticated credential", async () => {
    const ticket = Object.freeze({});
    const credential = new Headers({ cookie: "session=opaque" });
    const payload = Object.freeze({ checkpoint_format_version: 1 });
    const ack = Object.freeze({ checkpoint_revision: 4 });
    const metadata = Object.freeze({ revision: 4, saved_at: "2026-11-09T00:00:00.000Z", expires_at: null });
    const saveCheckpoint = vi.fn(async () => ack);
    const inspectCheckpoint = vi.fn(async () => metadata);
    const reopened = Object.freeze({});
    const restored = Object.freeze({ runtime_id: "runtime-new", checkpoint_revision: 4 });
    const reopenWorkspace = vi.fn(async () => reopened);
    const restoreCheckpoint = vi.fn(async () => restored);
    const connection = connectTrustedCheckpointHost({ saveCheckpoint, inspectCheckpoint, reopenWorkspace, restoreCheckpoint } as unknown as TrustedCheckpointHost);

    await expect(connection.save(ticket, credential, payload, 3, "retry-safe-operation")).resolves.toBe(ack);
    await expect(connection.inspect(ticket, credential)).resolves.toBe(metadata);
    await expect(connection.reopen("trip-egypt", credential, "work_saved")).resolves.toBe(reopened);
    await expect(connection.restore(reopened, credential, 4096)).resolves.toBe(restored);
    expect(saveCheckpoint).toHaveBeenCalledWith(ticket, credential, payload, 3, "retry-safe-operation");
    expect(inspectCheckpoint).toHaveBeenCalledWith(ticket, credential);
    expect(reopenWorkspace).toHaveBeenCalledWith("trip-egypt", credential, "work_saved");
    expect(restoreCheckpoint).toHaveBeenCalledWith(reopened, credential, 4096);
  });

  it("fails closed after the connection is closed", async () => {
    const host = {
      saveCheckpoint: vi.fn(),
      inspectCheckpoint: vi.fn(),
      reopenWorkspace: vi.fn(),
      restoreCheckpoint: vi.fn(),
    } as unknown as TrustedCheckpointHost;
    const connection = connectTrustedCheckpointHost(host);
    connection.close();

    await expect(connection.inspect({}, new Headers())).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    await expect(connection.save({}, new Headers(), {}, 0, "operation")).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    await expect(connection.reopen("trip-egypt", new Headers(), "work_saved")).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    await expect(connection.restore({}, new Headers())).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    expect(host.inspectCheckpoint).not.toHaveBeenCalled();
    expect(host.saveCheckpoint).not.toHaveBeenCalled();
    expect(host.reopenWorkspace).not.toHaveBeenCalled();
    expect(host.restoreCheckpoint).not.toHaveBeenCalled();
  });
});
