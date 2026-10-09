import { test } from "node:test";
import assert from "node:assert/strict";
import { env, t } from "../src/index.ts";

const Config = t.object({
  PORT: t.int().default(3000),
  DATABASE_URL: t.string(),
  DEBUG: t.boolean().default(false),
  LOG: t.enum(["pretty", "json"]).optional(),
  RATIO: t.number().optional(),
});

test("env: coerces like a query string, applies defaults, and hands back a frozen, typed value", () => {
  const config = env(Config, { PORT: "8080", DATABASE_URL: "postgres://x", DEBUG: "true", LOG: "json", RATIO: "0.5", OTHER: "ignored" });
  assert.deepEqual(config, { PORT: 8080, DATABASE_URL: "postgres://x", DEBUG: true, LOG: "json", RATIO: 0.5 });
  assert.ok(Object.isFrozen(config));
  const port: number = config.PORT; // typed
  assert.equal(port, 8080);

  const defaults = env(Config, { DATABASE_URL: "x", PORT: "" });
  assert.equal(defaults.PORT, 3000, "an empty variable counts as unset");
  assert.equal(defaults.DEBUG, false);
  assert.equal("LOG" in defaults, false);
});

test("env: one error lists every problem", () => {
  assert.throws(
    () => env(Config, { PORT: "abc", DEBUG: "maybe", LOG: "xml" }),
    (err: Error) => {
      assert.match(err.message, /4 environment variables are not as expected/);
      assert.match(err.message, /PORT must be an integer, got "abc"/);
      assert.match(err.message, /DATABASE_URL is required/);
      assert.match(err.message, /DEBUG must be a boolean/);
      assert.match(err.message, /LOG must be one of "pretty", "json"/);
      return true;
    },
  );
});

test("env: values of secret-looking names never appear in the error", () => {
  const S = t.object({ API_TOKEN: t.int(), DB_PASSWORD: t.string().min(40), JWT_SECRET: t.number(), STRIPE_KEY: t.int(), NAME: t.int() });
  assert.throws(
    () => env(S, { API_TOKEN: "tok-123456", DB_PASSWORD: "hunter2", JWT_SECRET: "s3cr3t", STRIPE_KEY: "sk_live_x", NAME: "visible" }),
    (err: Error) => {
      for (const v of ["tok-123456", "hunter2", "s3cr3t", "sk_live_x"]) assert.ok(!err.message.includes(v), `${v} leaked`);
      assert.match(err.message, /API_TOKEN must be an integer$/m);
      assert.match(err.message, /DB_PASSWORD must be at least 40 characters/);
      assert.match(err.message, /NAME must be an integer, got "visible"/);
      return true;
    },
  );
});

test("env: reads process.env by default", () => {
  process.env.INKAN_TEST_ENV_PORT = "1234";
  try {
    assert.equal(env(t.object({ INKAN_TEST_ENV_PORT: t.int() })).INKAN_TEST_ENV_PORT, 1234);
  } finally {
    delete process.env.INKAN_TEST_ENV_PORT;
  }
});
