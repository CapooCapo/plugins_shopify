import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

test("generated Prisma client exposes the ActivityLog delegate", async () => {
  const prisma = new PrismaClient();
  try {
    assert.equal(typeof prisma.activityLog?.findFirst, "function");
    assert.equal(typeof prisma.activityLog?.findMany, "function");
  } finally {
    await prisma.$disconnect();
  }
});
