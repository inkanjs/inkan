// The tests every `Store` has to pass, for adapter authors (Redis, a database, …):
//
//   import { storeConformance } from "@vxnsin/inkan/testing";
//   storeConformance(() => redisStore(client, { prefix: `test:${randomUUID()}:` }), { close: () => … });
//
// Run it with `node --test`. Each test makes its own store; keys carry a random part of their
// own as well, so a database that is not emptied between runs passes too. The TTL test waits
// about four seconds of real time, unless `wait` moves the store's clock instead.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Store } from "../core/store.ts";

export type StoreConformanceOptions = {
  /** The name of the suite. Default `"Store conformance"`. */
  name?: string;
  /**
   * Lets `ms` pass for the store's TTLs. Default: real time. A store with a clock of its own
   * (`memoryStore({ clock })`) can move it on instead, and the suite runs in no time.
   */
  wait?: (ms: number) => Promise<void>;
  /** Called after each test with its store, to close it or clear what it kept. */
  close?: (store: Store) => unknown;
  /** Milliseconds each test may take. Default 30000, for a slow database. */
  timeout?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits, in real time, until `ok` holds or `ms` run out. */
async function until(ok: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(10);
}

/** JSON values of every kind, as a store must give them back. */
const VALUES: [string, unknown][] = [
  ["a string", "tea"],
  ["an empty string", ""],
  ["unicode", "Grüner Tee 🍵 \u0000 \\ \" '"],
  ["an integer", 42],
  ["zero", 0],
  ["a negative float", -12.5],
  ["true", true],
  ["false", false],
  ["null", null],
  ["an empty object", {}],
  ["an empty array", []],
  ["a nested object", { a: 1, b: [1, "two", { c: null, d: false }], e: { f: { g: "deep" } } }],
  ["an array", [1, "two", null, true, { x: 1 }]],
  ["a long string", "x".repeat(100_000)],
];

/**
 * Registers node:test cases every `Store` must pass, against stores from `make`: get, set
 * and delete; JSON round trips; TTLs (`set` replaces the TTL, `increment` keeps it); `add`,
 * `take` and `increment` atomic under fifty concurrent calls; keys that look alike kept
 * apart; two stores from `make` not seeing each other's keys (give each a prefix of its
 * own); and publish/subscribe when the store has them.
 */
export function storeConformance(make: () => Store | Promise<Store>, options: StoreConformanceOptions = {}): void {
  const wait = options.wait ?? sleep;
  const timeout = options.timeout ?? 30_000;
  const run = randomBytes(6).toString("hex");
  let n = 0;
  /** A key no other test, run or process uses. */
  const key = (name = "k") => `conformance:${run}:${++n}:${name}`;

  /** A test with a fresh store, closed after it. */
  const check = (name: string, fn: (store: Store) => Promise<void>) =>
    it(name, { timeout }, async () => {
      const store = await make();
      try {
        await fn(store);
      } finally {
        await options.close?.(store);
      }
    });

  describe(options.name ?? "Store conformance", () => {
    check("has every method, and publish and subscribe both or neither", async (store) => {
      for (const m of ["get", "set", "delete", "add", "take", "increment"] as const) assert.equal(typeof store[m], "function", `store.${m}`);
      assert.equal(typeof store.publish, typeof store.subscribe, "publish and subscribe come together");
      if (store.publish) assert.equal(typeof store.publish, "function");
      assert.ok(store.shared === undefined || typeof store.shared === "boolean", "shared is a boolean");
    });

    check("get, set and delete; a missing key is undefined, never null", async (store) => {
      const k = key();
      assert.equal(await store.get(k), undefined);
      await store.set(k, { a: 1 });
      assert.deepEqual(await store.get(k), { a: 1 });
      await store.set(k, "replaced");
      assert.equal(await store.get(k), "replaced");
      await store.delete(k);
      assert.equal(await store.get(k), undefined);
      await store.delete(k); // one that is not there is fine
      await store.delete(key("never-set"));
    });

    check("values come back as JSON", async (store) => {
      const keys = VALUES.map(([name]) => key(name));
      await Promise.all(VALUES.map(([, v], i) => store.set(keys[i]!, v)));
      for (const [i, [name, v]] of VALUES.entries()) {
        assert.deepEqual(await store.get(keys[i]!), JSON.parse(JSON.stringify(v)), name);
      }
      const k = key("date");
      await store.set(k, JSON.parse(JSON.stringify({ at: new Date(0) })));
      assert.deepEqual(await store.get(k), { at: "1970-01-01T00:00:00.000Z" });
    });

    check("keys that look alike are kept apart", async (store) => {
      const base = key("user");
      const names = [base, `${base}:1`, `${base}:10`, `${base}1`, `${base}*`, `${base}%`, `${base}_`, `${base}?`, `${base}[1]`, `${base} 1`, `${base}/1`, `${base}.1`, `${base}'1`, `${base}\\1`, `${base}ü`, `${base.toUpperCase()}`];
      await Promise.all(names.map((k, i) => store.set(k, i)));
      for (const [i, k] of names.entries()) assert.equal(await store.get(k), i, k);
      await store.delete(`${base}*`);
      await store.delete(`${base}%`);
      assert.equal(await store.get(`${base}*`), undefined);
      for (const [i, k] of names.entries()) if (!k.endsWith("*") && !k.endsWith("%")) assert.equal(await store.get(k), i, `${k} after deleting the look-alikes`);
      assert.equal(await store.take(`${base}_`), names.indexOf(`${base}_`));
      assert.equal(await store.get(`${base}1`), names.indexOf(`${base}1`));
      assert.equal(await store.increment(`${base}?`, 1), names.indexOf(`${base}?`) + 1);
      assert.equal(await store.get(`${base}:1`), 1);
    });

    check("two stores from make() do not see each other's keys", async (store) => {
      const other = await make();
      try {
        const k = key();
        await store.set(k, "mine");
        assert.equal(await other.get(k), undefined);
        assert.equal(await other.add(k, "theirs"), true);
        assert.equal(await store.get(k), "mine");
      } finally {
        await options.close?.(other);
      }
    });

    check("add keeps a value only when the key is free", async (store) => {
      const k = key();
      assert.equal(await store.add(k, { first: true }), true);
      assert.equal(await store.add(k, { first: false }), false);
      assert.deepEqual(await store.get(k), { first: true });
      await store.delete(k);
      assert.equal(await store.add(k, "again"), true);
    });

    check("take reads and removes", async (store) => {
      const k = key();
      assert.equal(await store.take(k), undefined);
      await store.set(k, { token: "abc" });
      assert.deepEqual(await store.take(k), { token: "abc" });
      assert.equal(await store.take(k), undefined);
      assert.equal(await store.get(k), undefined);
      await store.set(k, null);
      assert.equal(await store.take(k), null, "null is a value, not nothing");
    });

    check("increment counts from 0, by any step, and get reads the number", async (store) => {
      const k = key();
      assert.equal(await store.increment(k), 1);
      assert.equal(await store.increment(k), 2);
      assert.equal(await store.increment(k, 5), 7);
      assert.equal(await store.increment(k, -2), 5);
      assert.equal(await store.get(k), 5);
      await store.delete(k);
      assert.equal(await store.increment(k, 3), 3);
    });

    check("add is atomic: of 50 at once on one key, exactly one wins", async (store) => {
      const k = key();
      const won = await Promise.all(Array.from({ length: 50 }, (_, i) => store.add(k, i, 60_000)));
      const winners = won.flatMap((ok, i) => (ok ? [i] : []));
      assert.equal(winners.length, 1, `winners: ${winners.join(", ")}`);
      assert.equal(await store.get(k), winners[0]);
    });

    check("take is atomic: of 50 at once on one key, exactly one gets the value", async (store) => {
      const k = key();
      await store.set(k, { once: true });
      const got = await Promise.all(Array.from({ length: 50 }, () => store.take(k)));
      assert.equal(got.filter((v) => v !== undefined).length, 1);
      assert.deepEqual(
        got.find((v) => v !== undefined),
        { once: true },
      );
      assert.equal(await store.get(k), undefined);
    });

    check("increment is atomic: 50 at once count to 50, each seeing its own number", async (store) => {
      const k = key();
      const seen = await Promise.all(Array.from({ length: 50 }, () => store.increment(k, 1, 60_000)));
      assert.deepEqual(
        [...seen].sort((a, b) => a - b),
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
      assert.equal(await store.get(k), 50);
    });

    check("TTL: keys go once it is over; set replaces it; increment keeps the first", async (store) => {
      const ttl = 2000;
      const [a, b, c, d, e] = [key("set"), key("add"), key("increment"), key("set-again"), key("long")];
      await Promise.all([store.set(a, "a", ttl), store.add(b, "b", ttl), store.increment(c, 1, ttl), store.set(e, "e", 600_000)]);
      await store.set(d, "d", ttl);
      await store.set(d, "d forever"); // no TTL any more
      assert.equal(await store.get(a), "a", "not gone before its TTL");
      assert.equal(await store.get(b), "b");
      assert.equal(await store.add(b, "too soon", ttl), false);
      await wait(1000);
      assert.equal(await store.increment(c, 1, ttl), 2, "counts on within the TTL");
      await wait(2500); // past the TTL by more than the second a store may be late
      assert.equal(await store.get(a), undefined, "set with a TTL: gone");
      assert.equal(await store.get(b), undefined, "add with a TTL: gone");
      assert.equal(await store.get(c), undefined, "increment keeps the TTL of the first one, it does not extend it");
      assert.equal(await store.take(a), undefined);
      assert.equal(await store.get(d), "d forever", "set without a TTL makes the key stay");
      assert.equal(await store.get(e), "e");
      assert.equal(await store.add(b, "again", ttl), true, "add takes a key whose TTL is over");
      assert.equal(await store.increment(c, 1, ttl), 1, "increment starts over once the TTL is over");
    });

    check("publish reaches every subscriber of the channel, in order, until it unsubscribes", async (store) => {
      if (!store.publish || !store.subscribe) return; // optional: nothing to check
      const channel = key("channel");
      const one: unknown[] = [];
      const two: unknown[] = [];
      const elsewhere: unknown[] = [];
      const offOne = await store.subscribe(channel, (m) => one.push(m));
      const offTwo = await store.subscribe(channel, (m) => two.push(m));
      const offElse = await store.subscribe(key("other-channel"), (m) => elsewhere.push(m));
      try {
        const sent = [{ n: 1, nested: { ok: true } }, "two", 3, null, [4]];
        for (const m of sent) await store.publish(channel, m);
        await until(() => one.length >= sent.length && two.length >= sent.length, 5000);
        assert.deepEqual(one, sent, "every message, in order");
        assert.deepEqual(two, sent, "to every subscriber");
        offOne();
        await store.publish(channel, "after");
        await until(() => two.length > sent.length, 5000);
        await sleep(200);
        assert.deepEqual(two.at(-1), "after");
        assert.equal(one.length, sent.length, "nothing after unsubscribing");
        assert.deepEqual(elsewhere, [], "nothing from another channel");
      } finally {
        offOne();
        offTwo();
        offElse();
      }
    });
  });
}
