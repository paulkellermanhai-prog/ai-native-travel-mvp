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
    const connection = connectTrustedCheckpointHost({ saveCheckpoint, inspectCheckpoint } as unknown as TrustedCheckpointHost);

    await expect(connection.save(ticket, credential, payload, 3, "retry-safe-operation")).resolves.toBe(ack);
    await expect(connection.inspect(ticket, credential)).resolves.toBe(metadata);
    expect(saveCheckpoint).toHaveBeenCalledWith(ticket, credential, payload, 3, "retry-safe-operation");
    expect(inspectCheckpoint).toHaveBeenCalledWith(ticket, credential);
  });

  it("fails closed after the connection is closed", async () => {
    const host = {
      saveCheckpoint: vi.fn(),
      inspectCheckpoint: vi.fn(),
    } as unknown as TrustedCheckpointHost;
    const connection = connectTrustedCheckpointHost(host);
    connection.close();

    await expect(connection.inspect({}, new Headers())).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    await expect(connection.save({}, new Headers(), {}, 0, "operation")).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    expect(host.inspectCheckpoint).not.toHaveBeenCalled();
    expect(host.saveCheckpoint).not.toHaveBeenCalled();
  });
});
