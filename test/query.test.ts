import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, queryObject } from "../src/core/context.ts";

const platform = (s: string) => queryObject(new URLSearchParams(s));

test("a query reads exactly as URLSearchParams reads it", () => {
  const cases = ["?a=1", "?a=1&b=2", "?a", "?a=", "?=x", "?&&a=1&&", "?a=1&a=2&a=3", "?a==b", "?a=b=c&d", "?x=%20y", "?x=a+b", "?é=ü", "?a=%zz", "?a=1;b=2"];
  for (const c of cases) assert.deepEqual(parseQuery(c), platform(c), c);
});

test("random queries read the same as with URLSearchParams", () => {
  const chars = "ab=&;é%+2";
  for (let n = 0; n < 5000; n++) {
    let s = "?";
    for (let j = 0; j < (n % 12); j++) s += chars[(n * 7 + j * 13) % chars.length];
    assert.deepEqual(parseQuery(s), platform(s), s);
  }
});
