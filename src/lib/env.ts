import { z } from "zod";

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url().refine(
    (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
    "DATABASE_URL must use PostgreSQL",
  ),
});
