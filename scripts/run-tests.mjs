import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSchemaPath = resolve(root, "prisma/schema.prisma");
const testSchemaPath = resolve(root, "prisma/.schema.test.prisma");
const prismaCli = resolve(root, "node_modules/.bin/prisma");

// If PostgreSQL-gated specs are enabled, prove that both URL variables point
// to the isolated local test database before any test process can connect.
if (process.env.STOCKHUB_TEST_DATABASE_URL) {
  const guard = spawnSync(process.execPath, [resolve(root, "scripts/postgres-test-guard.mjs"), "verify"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (guard.error) throw guard.error;
  if (guard.status !== 0) process.exit(guard.status ?? 1);
}

function rewriteModelNativeTypes(schema, modelName, replacements) {
  const modelPattern = new RegExp(`(model ${modelName} \\{[\\s\\S]*?\\n\\})`);
  const match = schema.match(modelPattern);
  if (!match) throw new Error(`Could not find ${modelName} in the test schema source`);
  let model = match[1];
  for (const [from, to, expected] of replacements) {
    const count = model.split(from).length - 1;
    if (count !== expected) throw new Error(`Expected ${expected} ${from} annotation(s) in ${modelName}, found ${count}`);
    model = model.replaceAll(from, to);
  }
  return schema.replace(match[1], model);
}

const sourceSchema = await readFile(sourceSchemaPath, "utf8");
let testSchema = sourceSchema
  .replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output   = "../node_modules/.prisma/stockhub-test-client"')
  .replace('provider = "postgresql"', 'provider = "sqlite"')
  .replace('url      = env("DATABASE_URL")', 'url      = "file:dev.sqlite"');

// SQLite does not support the catalog models' PostgreSQL native annotations.
// Remove them only from the derived test schema; keep prisma/schema.prisma intact.
testSchema = rewriteModelNativeTypes(testSchema, "CatalogImportBatch", [["@db.Text", "", 1]]);
testSchema = rewriteModelNativeTypes(testSchema, "CatalogImportLine", [["@db.Decimal(20, 6)", "", 1], ["@db.Text", "", 1]]);
testSchema = rewriteModelNativeTypes(testSchema, "CatalogImportGroup", [["@db.Text", "", 1]]);

for (const modelName of ["CatalogImportBatch", "CatalogImportLine", "CatalogImportGroup"]) {
  const modelPattern = new RegExp(`(model ${modelName} \\{[\\s\\S]*?\\n\\})`);
  const model = testSchema.match(modelPattern)?.[1];
  if (!model) throw new Error(`Could not find ${modelName} in the derived SQLite test schema`);
  if (/@db\./.test(model)) throw new Error(`Native Prisma annotations remain in derived SQLite model ${modelName}`);
}

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
