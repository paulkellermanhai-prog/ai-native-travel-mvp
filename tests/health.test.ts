import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/health/route";

describe("health endpoint", () => {
  it("reports application liveness without requiring a database", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "antu-mvp" });
  });
});
