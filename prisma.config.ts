import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://antu:antu_local_only@127.0.0.1:5432/antu?schema=public",
  },
});
