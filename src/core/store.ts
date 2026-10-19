// One store for everything in inkan that keeps state between requests: jobs, rate limits,
// and the middleware packages (auth, session, idempotency). An adapter package (Redis, a
// database) implements `Store` once, takes the user's own client, and works everywhere.
//
//   const store = redisStore(client);               // some adapter
//   app.job("/exports", { store }, run);
//   app.register(rateLimit({ max: 100, store }));
//
// `memoryStore()` is the one inkan has: this process only. Adapter authors run
// `storeConformance` from "@vxnsin/inkan/testing" against theirs.

/**
 * A key-value store with a time to live, shared by whatever needs one. What an adapter must
 * guarantee:
 *
 * - **Keys** are opaque strings, any characters (`:`, `*`, `%`, `_`, spaces, unicode). Two
 *   keys are the same only when equal; none is a pattern or a prefix of another. An adapter
 *   may put a prefix of its own in front of every key and channel.
 * - **Values** are JSON: objects, arrays, strings, finite numbers, booleans and `null`. What
 *   `get` returns equals what was set after a trip through `JSON.stringify` (a `Date` comes
 *   back as a string, `undefined` properties are gone). `undefined` is never stored: it is
 *   what `get` and `take` return for a key that is not there, never `null` for that.
 * - **TTL** is in milliseconds (Redis `PX`; SQL `expires_at = now + ttl`) and optional:
 *   without it the key stays until it is deleted. A key must not be gone before its TTL, and
 *   must not be returned once its TTL is over by a second or more, so a store that counts
 *   in whole seconds rounds up. `set` replaces the value and the TTL: a `set` without one
 *   makes the key stay.
 * - **`add`, `take` and `increment` are atomic** across every process that shares the store
 *   (Redis `SET NX`, `GETDEL`, `INCRBY`; an `INSERT … ON CONFLICT`, a `DELETE … RETURNING`):
 *   of fifty concurrent `add`s on one key exactly one wins, of fifty `take`s exactly one gets
 *   the value, fifty `increment`s count to fifty.
 * - **`publish`/`subscribe`** are both there or both missing. A message is JSON like a value;
 *   it reaches every subscriber of its channel in every process that shares the store, at
 *   most once, in the order it was published from one process. A message published while
 *   nobody listens is lost.
 * - **`shared`** is true when several processes see the same keys. inkan refuses to run jobs
 *   with `workers` on a store that is not.
 */
export interface Store {
  /** The value under `key`, or `undefined` when there is none or its TTL is over. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Keeps `value` under `key`, for `ttl` ms when given, replacing what was there and its TTL. */
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  /** Forgets `key`. One that is not there is fine. */
  delete(key: string): Promise<void>;
  /** Keeps `value` only when `key` is free (or its TTL over), and says whether it did. Atomic. */
  add(key: string, value: unknown, ttl?: number): Promise<boolean>;
  /** Reads and removes `key` in one step: its value, or `undefined` when there was none. Atomic. */
  take<T = unknown>(key: string): Promise<T | undefined>;
  /**
   * Adds `by` (default 1) to the number under `key` and returns the new number. A key that is
   * not there counts as 0 and gets `ttl` ms; one that is there keeps its TTL, so a window
   * stays fixed. `get` reads the number back. Atomic.
   */
  increment(key: string, by?: number, ttl?: number): Promise<number>;
  /** Sends `message` (JSON) to every subscriber of `channel`. */
  publish?(channel: string, message: unknown): Promise<void>;
  /** Calls `fn` with every message on `channel` until the function it resolves to is called. */
  subscribe?(channel: string, fn: (message: unknown) => void): Promise<() => void>;
  /** Whether several processes see the same data. Missing means no. */
  readonly shared?: boolean;
}

export type MemoryStoreOptions = {
  /** Keys kept at most; past that the one used longest ago goes first. Default 10000. */
  max?: number;
  /** The time in ms, for tests. Default `Date.now()`. */
  clock?: () => number;
};

type Entry = { value: unknown; until: number };

/**
 * A `Store` in this process's memory: fast, lost when the process ends, not seen by other
 * workers (`shared: false`). Bounded by `max` keys, the least recently used going first;
 * expired keys are dropped as they are met and once a minute on a write. `add`, `take` and
 * `increment` are atomic in this process, and `publish` reaches this process's subscribers
 * at once. Values are kept as they are given, not copied: do not change one after setting it.
 */
export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const max = Math.max(1, options.max ?? 10_000);
  const clock = options.clock ?? (() => Date.now());
  const map = new Map<string, Entry>();
  const channels = new Map<string, Set<(message: unknown) => void>>();
  let sweepAt = 0;

  const live = (key: string, now = clock()): Entry | undefined => {
    const e = map.get(key);
    if (!e) return undefined;
    if (e.until <= now) {
      map.delete(key);
      return undefined;
    }
    return e;
  };
  const touch = (key: string, e: Entry) => {
    map.delete(key);
    map.set(key, e);
  };
  const put = (key: string, value: unknown, ttl: number | undefined, now: number) => {
    if (now >= sweepAt) {
      for (const [k, e] of map) if (e.until <= now) map.delete(k);
      sweepAt = now + 60_000;
    }
    map.delete(key);
    map.set(key, { value, until: ttl === undefined ? Infinity : now + ttl });
    if (map.size > max) map.delete(map.keys().next().value!);
  };

  return {
    shared: false,
    async get<T>(key: string) {
      const e = live(key);
      if (!e) return undefined;
      touch(key, e);
      return e.value as T;
    },
    async set(key, value, ttl) {
      put(key, value, ttl, clock());
    },
    async delete(key) {
      map.delete(key);
    },
    async add(key, value, ttl) {
      const now = clock();
      if (live(key, now)) return false;
      put(key, value, ttl, now);
      return true;
    },
    async take<T>(key: string) {
      const e = live(key);
      map.delete(key);
      return e?.value as T | undefined;
    },
    async increment(key, by = 1, ttl) {
      if (typeof by !== "number" || !Number.isFinite(by)) throw new TypeError(`increment needs a finite number, got ${String(by)}`);
      const now = clock();
      const e = live(key, now);
      if (!e) {
        put(key, by, ttl, now);
        return by;
      }
      // as every adapter does: a value that is not a JSON number is left alone, never counted as 0
      if (typeof e.value !== "number") throw new TypeError(`${key} does not hold a number`);
      e.value = e.value + by;
      touch(key, e);
      return e.value as number;
    },
    async publish(channel, message) {
      const fns = channels.get(channel);
      if (fns) for (const fn of [...fns]) fn(message);
    },
    async subscribe(channel, fn) {
      let set = channels.get(channel);
      if (!set) channels.set(channel, (set = new Set()));
      // its own wrapper, so the same function subscribed twice is called twice and unsubscribed once
      const one = (m: unknown) => fn(m);
      set.add(one);
      return () => {
        set.delete(one);
        if (!set.size && channels.get(channel) === set) channels.delete(channel);
      };
    },
  };
}
