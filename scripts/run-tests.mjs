import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSchemaPath = resolve(root, "prisma/schema.prisma");
const testSchemaPath = resolve(root, "prisma/.schema.test.prisma");
const prismaCli = resolve(root, "node_modules/.bin/prisma");

const sourceSchema = await readFile(sourceSchemaPath, "utf8");
const testSchema = sourceSchema
  .replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output   = "../node_modules/.prisma/stockhub-test-client"')
  .replace('provider = "postgresql"', 'provider = "sqlite"')
  .replace('url      = env("DATABASE_URL")', 'url      = "file:dev.sqlite"');

if (testSchema === sourceSchema || !testSchema.includes('provider = "sqlite"')) {
  throw new Error("Could not derive the isolated SQLite test schema from prisma/schema.prisma");
}

await writeFile(testSchemaPath, testSchema, { flag: "wx" });
try {
  const generate = spawnSync(prismaCli, ["generate", "--schema", testSchemaPath], { cwd: root, stdio: "inherit" });
  if (generate.error) throw generate.error;
  if (generate.status !== 0) process.exitCode = generate.status ?? 1;

  if (!process.exitCode) {
    const tests = spawnSync(process.execPath, ["--test"], { cwd: root, stdio: "inherit" });
    if (tests.error) throw tests.error;
    process.exitCode = tests.status ?? 1;
  }
} finally {
  await rm(testSchemaPath, { force: true });
}
