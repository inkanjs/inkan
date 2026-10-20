// The public API, as its types say it, is committed in api/inkan.d.ts.txt: a change to it
// shows in review. After changing the API on purpose, run `npm run api:update`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error a plain script, without types
import { SNAPSHOT, surface } from "../scripts/api.mjs";

const now: string = surface();

test("the public types match api/inkan.d.ts.txt (npm run api:update after a change on purpose)", () => {
  const kept = readFileSync(SNAPSHOT, "utf8").replaceAll("\r\n", "\n");
  assert.ok(now === kept, "the public API changed: look at `git diff` after `npm run api:update`, and update the CHANGELOG");
});

test("the public types hold no internals", () => {
  const code = now.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.deepEqual(code.match(/^\s*(?:readonly |private |protected |static |declare |abstract )*_\w+\??[(:<;]/gm) ?? [], [], "no _-prefixed members");
  assert.ok(!/\bRouteRecord\b/.test(code), "no RouteRecord");
});
