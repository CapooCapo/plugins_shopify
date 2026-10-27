import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSafeDatabaseEnvironment,
  validateDatabaseIdentity,
  validateTestDatabaseUrls,
} from "../scripts/postgres-test-guard.mjs";

const testUrl = "postgresql://stockhub_test:local-only@127.0.0.1:55432/stockhub_regression?schema=public";
const identity = { database: "stockhub_regression", user: "stockhub_test", address: "127.0.0.1", clientAddress: "127.0.0.1", port: 55432 };

test("PostgreSQL guard rejects missing explicit variables before connection", () => {
  assert.throws(() => validateTestDatabaseUrls({ STOCKHUB_TEST_DATABASE_URL: testUrl }), /both .* explicitly set/);
  assert.throws(() => validateTestDatabaseUrls({ DATABASE_URL: testUrl }), /both .* explicitly set/);
});

test("PostgreSQL guard rejects a managed URL fallback even when the test URL is safe", () => {
  assert.throws(() => validateTestDatabaseUrls({
    STOCKHUB_TEST_DATABASE_URL: testUrl,
    DATABASE_URL: "postgresql://managed.example/production",
  }), /must exactly match/);
});

test("PostgreSQL guard rejects non-loopback, unexpected database, and default port URLs", () => {
  for (const url of [
    "postgresql://test:pw@db.example:55432/stockhub_regression",
    "postgresql://test:pw@127.0.0.1:55432/production",
    "postgresql://test:pw@127.0.0.1:5432/stockhub_regression",
  ]) {
    assert.throws(() => validateTestDatabaseUrls({ DATABASE_URL: url, STOCKHUB_TEST_DATABASE_URL: url }));
  }
});

test("PostgreSQL guard accepts the isolated target and checks queried server identity", () => {
  const target = validateTestDatabaseUrls({ DATABASE_URL: testUrl, STOCKHUB_TEST_DATABASE_URL: testUrl });
  assert.equal(target.parsed.hostname, "127.0.0.1");
  assert.deepEqual(validateDatabaseIdentity(identity, target.parsed), identity);
});

test("PostgreSQL guard accepts a private Docker bridge server and the internal PostgreSQL port mapping", () => {
  const { parsed } = validateTestDatabaseUrls({ DATABASE_URL: testUrl, STOCKHUB_TEST_DATABASE_URL: testUrl });
  const dockerIdentity = { ...identity, address: "172.17.0.2/32", clientAddress: "172.17.0.1/32", port: 5432 };
  assert.deepEqual(validateDatabaseIdentity(dockerIdentity, parsed), dockerIdentity);
});

test("PostgreSQL guard refuses public/non-private server addresses", () => {
  const { parsed } = validateTestDatabaseUrls({ DATABASE_URL: testUrl, STOCKHUB_TEST_DATABASE_URL: testUrl });
  for (const address of ["8.8.8.8", "100.64.0.1", "172.32.0.1"]) {
    assert.throws(() => validateDatabaseIdentity({ ...identity, address }, parsed), /RFC1918 private/);
  }
});

test("PostgreSQL guard rejects malformed or out-of-range inet prefixes", () => {
  const { parsed } = validateTestDatabaseUrls({ DATABASE_URL: testUrl, STOCKHUB_TEST_DATABASE_URL: testUrl });
  for (const address of ["172.17.0.2/33", "172.17.0.2/-1", "172.17.0.2/32/1", "172.17.0.2/not-a-prefix"]) {
    assert.throws(() => validateDatabaseIdentity({ ...identity, address }, parsed), /RFC1918 private/);
  }
});

test("PostgreSQL guard refuses database and user mismatches before migration or test execution", () => {
  const { parsed } = validateTestDatabaseUrls({ DATABASE_URL: testUrl, STOCKHUB_TEST_DATABASE_URL: testUrl });
  assert.throws(() => validateDatabaseIdentity({ ...identity, database: "postgres" }, parsed), /database/);
  assert.throws(() => validateDatabaseIdentity({ ...identity, user: "admin" }, parsed), /user/);
});

test("PostgreSQL guard rejects mismatched client address and unexpected server ports", () => {
  const { parsed } = validateTestDatabaseUrls({ DATABASE_URL: testUrl, STOCKHUB_TEST_DATABASE_URL: testUrl });
  for (const unsafe of [
    { ...identity, clientAddress: "203.0.113.20" },
    { ...identity, port: 6432 },
  ]) {
    assert.throws(() => validateDatabaseIdentity(unsafe, parsed));
  }
});

test("PostgreSQL child environment explicitly overrides both database URL variables", () => {
  const env = buildSafeDatabaseEnvironment({ DATABASE_URL: "unsafe", STOCKHUB_TEST_DATABASE_URL: "safe" }, testUrl);
  assert.equal(env.DATABASE_URL, testUrl);
  assert.equal(env.STOCKHUB_TEST_DATABASE_URL, testUrl);
});
