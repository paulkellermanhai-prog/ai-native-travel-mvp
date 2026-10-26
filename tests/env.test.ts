import { describe, expect, it } from "vitest";
import { databaseEnvSchema } from "../src/lib/env";

describe("database configuration", () => {
  it("accepts a PostgreSQL URL", () => {
    expect(databaseEnvSchema.safeParse({ DATABASE_URL: "postgresql://localhost/antu" }).success).toBe(true);
  });
  it.each([undefined, "invalid", "https://example.com", "file:./local.db"])("rejects an unsupported URL: %s", (DATABASE_URL) => {
    expect(databaseEnvSchema.safeParse({ DATABASE_URL }).success).toBe(false);
  });
});
