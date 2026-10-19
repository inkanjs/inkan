// Development mode nobody chose, on an address other machines reach: one loud warning.
// A file of its own: the warning comes once per process.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { inkan } from "../src/index.ts";

async function warnsOn(app: ReturnType<typeof inkan>, host?: string): Promise<string[]> {
  const seen: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => void seen.push(msg);
  let server: Server | undefined;
  try {
    server = await app.listen({ port: 0, host });
  } finally {
    console.warn = warn;
    server?.close();
  }
  return seen;
}

test("listening in guessed development mode on every interface warns once", { skip: process.env.NODE_ENV === "production" }, async () => {
  const quiet = { log: false, gracefulShutdown: false } as const;
  assert.deepEqual(await warnsOn(inkan(quiet), "127.0.0.1"), [], "loopback is this machine only");
  assert.deepEqual(await warnsOn(inkan({ ...quiet, dev: true })), [], "dev: true says it is on purpose");
  assert.deepEqual(await warnsOn(inkan({ ...quiet, dev: false })), [], "production");
  const said = await warnsOn(inkan(quiet));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /development mode[\s\S]*every network interface[\s\S]*NODE_ENV=production[\s\S]*dev: true/);
  assert.deepEqual(await warnsOn(inkan(quiet)), [], "once per process");
});
