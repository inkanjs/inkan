import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, memoryStore, rateLimit, type JobRecord, type JobStore, type Store } from "../src/index.ts";
import { storeConformance } from "../src/testing.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean | Promise<boolean>, what = "the condition", ms = 3000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// the suite on a clock of its own: no real waiting
let now = 1_000_000;
storeConformance(() => memoryStore({ clock: () => now }), {
  name: "memoryStore conformance (its own clock)",
  wait: async (ms) => void (now += ms),
});

// and once in real time, as an adapter runs it
storeConformance(() => memoryStore(), { name: "memoryStore conformance (real time)" });

test("memoryStore: at most max keys, the one used longest ago goes first", async () => {
  const store = memoryStore({ max: 2 });
  await store.set("a", 1);
  await store.set("b", 2);
  await store.get("a"); // a is used: b is the oldest now
  await store.set("c", 3);
  assert.equal(await store.get("b"), undefined);
  assert.equal(await store.get("a"), 1);
  assert.equal(await store.get("c"), 3);
  assert.equal(store.shared, false);
});

test("a shared store wrapped by hand is what the cluster check sees", () => {
  const shared: Store = { ...memoryStore(), shared: true };
  assert.equal(shared.shared, true);
});

test("rateLimit with a store counts there: two apps sharing it share the limit", async () => {
  const store = memoryStore();
  const one = inkan(quiet).register(rateLimit({ max: 2, store })).get("/", () => "ok");
  const two = inkan(quiet).register(rateLimit({ max: 2, store })).get("/", () => "ok");
  const a = await one.inject({ url: "/" });
  assert.equal(a.status, 200);
  assert.equal(a.headers["x-ratelimit-remaining"], "1");
  assert.equal((await two.inject({ url: "/" })).status, 200);
  const third = await one.inject({ url: "/" });
  assert.equal(third.status, 429);
  assert.equal(third.body.type, "rate-limited");
  assert.ok(Number(third.headers["retry-after"]) >= 1);
  // another prefix: counted apart
  const apart = inkan(quiet).register(rateLimit({ max: 2, store, prefix: "other:" })).get("/", () => "ok");
  assert.equal((await apart.inject({ url: "/" })).status, 200);
});

test("jobs on a shared Store: another process follows, sees progress, and cancels through publish", async () => {
  const store: Store = { ...memoryStore(), shared: true };
  let aborted = false;
  const runner = inkan(quiet).job("/work", { store }, async (job) => {
    job.progress({ step: 1 });
    await new Promise<void>((resolve) =>
      job.signal.addEventListener("abort", () => {
        aborted = true;
        resolve();
      }),
    );
  });
  // the same routes in "another process": a second app on the same store that runs nothing itself
  const other = inkan(quiet).job("/work", { store }, () => null);

  const { id } = (await runner.inject({ method: "POST", url: "/work" })).body;
  await until(async () => (await other.inject({ url: `/work/${id}` })).body?.progress?.step === 1, "the progress in the other app");
  const seen = (await other.inject({ url: `/work/${id}` })).body;
  assert.equal(seen.state, "running");
  assert.ok(typeof seen.createdAt === "string" && !Number.isNaN(Date.parse(seen.createdAt)), "dates as the contract says");

  const res = await other.inject({ method: "DELETE", url: `/work/${id}` });
  assert.equal(res.status, 202);
  await until(() => aborted, "the cancel to reach the runner");
  await until(async () => (await other.inject({ url: `/work/${id}` })).body?.state === "canceled", "the end in the other app");
  assert.equal(runner._jobs?.local(), false);
});

test("jobs keep their records as JSON with ms timestamps", async () => {
  const store = memoryStore();
  const app = inkan(quiet).job("/work", { store }, () => "ok");
  const { id } = (await app.inject({ method: "POST", url: "/work" })).body;
  await until(async () => (await app.inject({ url: `/work/${id}` })).body?.state === "done", "the job");
  const rec = (await store.get<JobRecord>(`inkan:job:${id}`))!;
  assert.equal(typeof rec.createdAt, "number");
  assert.equal(typeof rec.finishedAt, "number");
  assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
});

test("a 0.7 JobStore still works (deprecated)", async () => {
  const jobs = new Map<string, JobRecord>();
  const watchers = new Map<string, Set<(j: JobRecord) => void>>();
  const legacy: JobStore = {
    shared: false,
    get: (id) => jobs.get(id),
    set(job) {
      jobs.set(job.id, job);
      for (const fn of watchers.get(job.id) ?? []) fn(job);
    },
    delete: (id) => void jobs.delete(id),
    sweep() {},
    watch(id, fn) {
      const set = watchers.get(id) ?? new Set();
      watchers.set(id, set.add(fn));
      return () => set.delete(fn);
    },
    cancel(id) {
      const j = jobs.get(id);
      if (j) legacy.set({ ...j, cancelRequested: true });
    },
  };
  const app = inkan(quiet).job("/work", { store: legacy }, () => "ok");
  const { id } = (await app.inject({ method: "POST", url: "/work" })).body;
  await until(async () => (await app.inject({ url: `/work/${id}` })).body?.state === "done", "the job");
  assert.equal(jobs.get(id)?.state, "done");
});
