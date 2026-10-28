import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const EXPECTED_TEST_HOST = "127.0.0.1";
export const EXPECTED_TEST_PORT = 55432;
export const EXPECTED_TEST_DATABASE = "stockhub_regression";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const prismaCli = resolve(root, "node_modules/.bin/prisma");

class GuardError extends Error {}

function refuse(message) {
  throw new GuardError(message);
}

function isExactLoopbackAddress(address) {
  return ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(address);
}

export function validateTestDatabaseUrls(env) {
  const testUrl = env.STOCKHUB_TEST_DATABASE_URL;
  const databaseUrl = env.DATABASE_URL;
  if (!testUrl || !databaseUrl) {
    refuse("PostgreSQL test operations require both STOCKHUB_TEST_DATABASE_URL and DATABASE_URL to be explicitly set.");
  }

  let parsedTest;
  let parsedDatabase;
  try {
    parsedTest = new URL(testUrl);
    parsedDatabase = new URL(databaseUrl);
  } catch {
    refuse("PostgreSQL test operations require valid PostgreSQL URLs in both database variables.");
  }

  if (!["postgresql:", "postgres:"].includes(parsedTest.protocol) || !["postgresql:", "postgres:"].includes(parsedDatabase.protocol)) {
    refuse("PostgreSQL test operations require PostgreSQL URLs.");
  }
  if (databaseUrl !== testUrl) {
    refuse("DATABASE_URL must exactly match STOCKHUB_TEST_DATABASE_URL; refusing implicit .env fallback.");
  }
  if (parsedTest.hostname !== EXPECTED_TEST_HOST
    || Number(parsedTest.port) !== EXPECTED_TEST_PORT
    || parsedTest.pathname !== `/${EXPECTED_TEST_DATABASE}`) {
    refuse(`PostgreSQL test URL must target ${EXPECTED_TEST_HOST}:${EXPECTED_TEST_PORT}/${EXPECTED_TEST_DATABASE}.`);
  }
  if (!parsedTest.username || !parsedTest.password) {
    refuse("The isolated PostgreSQL test URL must include explicit credentials.");
  }

  return { url: testUrl, parsed: parsedTest };
}

export function validateDatabaseIdentity(identity, parsedUrl) {
  if (identity.database !== EXPECTED_TEST_DATABASE) refuse("Connected PostgreSQL database does not match the isolated test database.");
  if (!identity.user || identity.user !== decodeURIComponent(parsedUrl.username)) refuse("Connected PostgreSQL user does not match the explicitly configured test URL.");
  if (!isExactLoopbackAddress(identity.address)) refuse("PostgreSQL server address is not an exact loopback address; refusing test operation.");
  if (!isExactLoopbackAddress(identity.clientAddress)) refuse("PostgreSQL client address is not an exact loopback address; refusing test operation.");
  // A Docker host-port mapping can expose 127.0.0.1:55432 while PostgreSQL
  // reports its in-container listener as 5432. A direct local test server may
  // instead report the mapped test port; no other server ports are accepted.
  if (![5432, EXPECTED_TEST_PORT].includes(Number(identity.port))) refuse("Connected PostgreSQL server port is not the expected local listener port (5432 or 55432).");
  return identity;
}

export function buildSafeDatabaseEnvironment(env, url) {
  return { ...env, DATABASE_URL: url, STOCKHUB_TEST_DATABASE_URL: url };
}

async function verifyConnection(env) {
  const { url, parsed } = validateTestDatabaseUrls(env);
  let client;
  try {
    const { PrismaClient } = await import("@prisma/client");
    client = new PrismaClient({ datasourceUrl: url });
    const rows = await client.$queryRaw`SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS address, inet_client_addr()::text AS "clientAddress", inet_server_port() AS port`;
    const identity = validateDatabaseIdentity(rows[0] ?? {}, parsed);
    process.stdout.write(`Verified isolated PostgreSQL target: database=${identity.database} user=${identity.user} server=${identity.address}:${identity.port} client=${identity.clientAddress}\n`);
    return url;
  } catch (error) {
    if (error instanceof GuardError) throw error;
    throw new Error("Could not verify isolated PostgreSQL identity; no test or migration command was started. Check that the isolated local test database is running.");
  } finally {
    await client?.$disconnect();
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${command} exited before the guarded workflow could continue.`);
  }
}

async function generatePostgresTestClient(env) {
  const schemaSource = await readFile(resolve(root, "prisma/schema.prisma"), "utf8");
  const generator = /generator client\s*\{/;
  if (!generator.test(schemaSource)) throw new Error("The Prisma client generator was not found in prisma/schema.prisma.");

  const cacheDirectory = resolve(root, "node_modules/.cache");
  await mkdir(cacheDirectory, { recursive: true });
  const schemaDirectory = await mkdtemp(join(cacheDirectory, "stockhub-pg-schema-"));
  try {
    const clientOutput = resolve(root, "node_modules/.prisma/stockhub-pg-test-client");
    const schemaPath = join(schemaDirectory, "schema.prisma");
    await writeFile(schemaPath, schemaSource.replace(generator, `generator client {\n  output = ${JSON.stringify(clientOutput)}`));
    run(prismaCli, ["generate", "--schema", schemaPath], env);
  } finally {
    await rm(schemaDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const mode = process.argv[2];
  if (!["verify", "test", "migrate"].includes(mode)) {
    throw new Error("Usage: node scripts/postgres-test-guard.mjs <verify|test|migrate>");
  }

  const url = await verifyConnection(process.env);
  if (mode === "verify") return;

  const safeEnv = buildSafeDatabaseEnvironment(process.env, url);
  if (mode === "migrate") {
    run(prismaCli, ["migrate", "deploy", "--schema", resolve(root, "prisma/schema.prisma")], safeEnv);
    return;
  }

  await generatePostgresTestClient(safeEnv);

  const postgresTests = (await readdir(resolve(root, "tests")))
    .filter((name) => name.endsWith(".test.mjs") && name.includes("postgres"))
    .map((name) => resolve(root, "tests", name));
  if (postgresTests.length === 0) throw new Error("No PostgreSQL integration test files were found.");
  run(process.execPath, ["--test", ...postgresTests], safeEnv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
