import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { expect, it } from "vitest";

it.skipIf(!process.env.DATABASE_URL)("connects Prisma to PostgreSQL without business models", async () => {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const rows = await client.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows).toEqual([{ ok: 1 }]);
  } finally {
    await client.$disconnect();
  }
});
