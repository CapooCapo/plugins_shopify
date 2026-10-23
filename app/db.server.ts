import { PrismaClient } from "@prisma/client";

function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }
  return new PrismaClient();
}

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;
