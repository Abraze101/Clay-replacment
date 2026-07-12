import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEnv } from "../src/config/env.js";

test("env: defaults apply with an empty environment", () => {
  const env = parseEnv({});
  assert.equal(env.DATABASE_URL, "pglite://./.data/lead-engine");
  assert.equal(env.LOG_LEVEL, "info");
  assert.equal(env.EXPORT_DIR, "./exports");
  assert.equal(env.LEASE_TTL_SECONDS, 60);
  assert.equal(env.MAX_STEP_ATTEMPTS, 3);
});

test("env: rejects an unsupported DATABASE_URL scheme", () => {
  assert.throws(() => parseEnv({ DATABASE_URL: "mysql://nope" }), /DATABASE_URL/);
});

test("env: rejects invalid numeric bounds", () => {
  assert.throws(() => parseEnv({ LEASE_TTL_SECONDS: "1" }), /LEASE_TTL_SECONDS/);
  assert.throws(() => parseEnv({ MAX_STEP_ATTEMPTS: "99" }), /MAX_STEP_ATTEMPTS/);
});

test("env: provider keys are optional in M0", () => {
  const env = parseEnv({});
  assert.equal(env.APOLLO_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});
