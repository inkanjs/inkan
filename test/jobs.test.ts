import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { inkan, memoryStore, problem, t, type App } from "../src/index.ts";
import { parseEvents } from "../src/core/stream.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean | Promise<boolean>, what = "the condition", ms = 3000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
/** A promise opened from outside. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return Object.assign(p, { open });
}
const stateOf = async (app: App, path: string) => (await app.inject({ url: path })).body?.state;

const Progress = t.object({ done: t.int(), total: t.int() });
const Result = t.object({ url: t.string(), rows: t.int() });

test("POST answers 202 with the job and its location; the job runs, finishes, and its result is trimmed", async () => {
  const go = gate();
  const app = inkan(quiet).job(
    "/exports",
    { summary: "Export orders", body: t.object({ rows: t.int() }), progress: Progress, result: Result },
    async (job) => {
      await go;
      job.progress({ done: 1, total: 2 });
      const out = { url: "/x.csv", rows: job.input.rows, secret: "not in the contract" };
      return out;
    },
  );
  const res = await app.inject({ method: "POST", url: "/exports", body: { rows: 7 } });
  assert.equal(res.status, 202);
  assert.equal(res.headers.location, `/exports/${res.body.id}`);
  assert.equal(res.body.state, "running");
  assert.ok(res.body.createdAt && res.body.startedAt);

  const bad = await app.inject({ method: "POST", url: "/exports", body: { rows: "many" } });
  assert.equal(bad.status, 400);

  go.open();
  await until(async () => (await stateOf(app, res.headers.location)) === "done", "the job to be done");
  const done = await app.inject({ url: res.headers.location });
  assert.deepEqual(done.body.progress, { done: 1, total: 2 });
  assert.ok(done.body.finishedAt);
  assert.equal(done.body.position, undefined);

  const result = await app.inject({ url: `${res.headers.location}/result` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { url: "/x.csv", rows: 7 }, "only what the contract lists");
});

/** A job that waits, sends a hundred progress updates at once, waits again, and ends. */
function progressApp() {
  const first = gate();
  const second = gate();
  const app = inkan(quiet).job("/exports", { progress: Progress, result: Result }, async (job) => {
    await first;
    for (let i = 1; i <= 100; i++) job.progress({ done: i, total: 100 });
    await second;
    return { url: "/x.csv", rows: 100 };
  });
  return { app, first, second };
}

test("events: the status first, then only the latest progress, then the end, and the stream closes (inject)", async () => {
  const { app, first, second } = progressApp();
  const { body } = await app.inject({ method: "POST", url: "/exports" });
  const reading = app.inject({ url: `/exports/${body.id}/events` });
  await sleep(20);
  first.open();
  await sleep(20);
  second.open();
  const res = await reading; // it ends by itself: no event count needed
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.deepEqual(
    res.body.map((e: { event: string }) => e.event),
    ["status", "progress", "end"],
  );
  assert.equal(res.body[0].data.state, "running");
  assert.deepEqual(res.body[1].data, { done: 100, total: 100 }, "a hundred updates while nobody read: only the last one");
  assert.equal(res.body[2].data.state, "done");

  // a finished job: its status and its end
  const again = await app.inject({ url: `/exports/${body.id}/events` });
  assert.deepEqual(
    again.body.map((e: { event: string; data: { state: string } }) => [e.event, e.data.state]),
    [
      ["status", "done"],
      ["end", "done"],
    ],
  );
  assert.equal((await app.inject({ url: "/exports/nope/events" })).status, 404);
});

test("events over app.fetch end and close the same way", async () => {
  const { app, first, second } = progressApp();
  const started = await app.fetch(new Request("http://x.local/exports", { method: "POST" }));
  const { id } = (await started.json()) as { id: string };
  const res = await app.fetch(new Request(`http://x.local/exports/${id}/events`));
  const text = res.text();
  await sleep(20);
  first.open();
  await sleep(20);
  second.open();
  const events = parseEvents(await text);
  assert.deepEqual(
    events.map((e) => e.event),
    ["status", "progress", "end"],
  );
});

test("concurrency: two run, the rest wait in order, and their positions stay current", async () => {
  const gates = [gate(), gate(), gate(), gate()];
  let n = 0;
  const app = inkan(quiet).job("/work", { concurrency: 2 }, async () => {
    await gates[n++];
    return null;
  });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await app.inject({ method: "POST", url: "/work" })).body.id);
  const look = async (i: number) => (await app.inject({ url: `/work/${ids[i]}` })).body;
  assert.equal((await look(0)).state, "running");
  assert.equal((await look(1)).state, "running");
  assert.deepEqual([(await look(2)).state, (await look(2)).position], ["queued", 1]);
  assert.deepEqual([(await look(3)).state, (await look(3)).position], ["queued", 2]);

  gates[0].open();
  await until(async () => (await look(2)).state === "running", "the third to start");
  assert.equal((await look(0)).state, "done");
  assert.deepEqual([(await look(3)).state, (await look(3)).position], ["queued", 1]);
  for (const g of gates) g.open();
  await until(async () => (await look(3)).state === "done", "the last to be done");
});

test("a full queue is a 503 with retry-after", async () => {
  const go = gate();
  const app = inkan(quiet).job("/work", { queue: 1 }, () => go);
  assert.equal((await app.inject({ method: "POST", url: "/work" })).status, 202); // running
  assert.equal((await app.inject({ method: "POST", url: "/work" })).status, 202); // waiting
  const full = await app.inject({ method: "POST", url: "/work" });
  assert.equal(full.status, 503);
  assert.equal(full.body.type, "job-queue-full");
  assert.equal(full.headers["retry-after"], "5");
  go.open();
});

test("cancel: a waiting job at once, a running one once it stops, a finished one is forgotten", async () => {
  let sawAbort = false;
  const app = inkan(quiet).job("/work", {}, async (job) => {
    await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
    sawAbort = true;
    return "too late"; // nobody wants it any more
  });
  const running = (await app.inject({ method: "POST", url: "/work" })).body.id;
  const waiting = (await app.inject({ method: "POST", url: "/work" })).body.id;

  const q = await app.inject({ method: "DELETE", url: `/work/${waiting}` });
  assert.equal(q.status, 202);
  assert.equal(q.body.state, "canceled");

  const r = await app.inject({ method: "DELETE", url: `/work/${running}` });
  assert.equal(r.status, 202);
  await until(async () => (await stateOf(app, `/work/${running}`)) === "canceled", "the running job to be canceled");
  assert.ok(sawAbort);
  const result = await app.inject({ url: `/work/${running}/result` });
  assert.equal(result.status, 409);
  assert.equal(result.body.type, "job-canceled");

  const gone = await app.inject({ method: "DELETE", url: `/work/${running}` });
  assert.equal(gone.status, 204);
  assert.equal((await app.inject({ url: `/work/${running}` })).status, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/work/missing" })).status, 404);
});

test("a thrown problem is the job's error; anything else is a job-failed problem, reported, without its message outside development", async () => {
  const reported: unknown[] = [];
  const make = (dev: boolean) =>
    inkan({ ...quiet, dev, onError: (err) => reported.push(err) }).job("/work", { body: t.object({ how: t.string() }) }, async (job) => {
      if (job.input.how === "problem") throw problem(422, "bad-range", "The range is empty");
      throw new Error("boom");
    });
  for (const dev of [true, false]) {
    const app = make(dev);
    const p = (await app.inject({ method: "POST", url: "/work", body: { how: "problem" } })).body.id;
    const e = (await app.inject({ method: "POST", url: "/work", body: { how: "error" } })).body.id;
    await until(async () => (await stateOf(app, `/work/${e}`)) === "failed", "the job to fail");
    const pj = (await app.inject({ url: `/work/${p}` })).body;
    assert.equal(pj.state, "failed");
    assert.deepEqual(pj.error, { type: "bad-range", title: "Unprocessable Entity", status: 422, detail: "The range is empty" });
    const ej = (await app.inject({ url: `/work/${e}` })).body;
    assert.equal(ej.error.type, "job-failed");
    assert.equal(ej.error.detail, dev ? "boom" : "Something went wrong on our side");
    const result = await app.inject({ url: `/work/${p}/result` });
    assert.equal(result.status, 409);
    assert.equal(result.body.type, "job-failed");
    assert.equal(result.body.error.type, "bad-range");
  }
  assert.equal(reported.length, 2, "only the plain errors are reported");
  assert.equal((reported[0] as Error).message, "boom");
});

test("a job past its timeout fails and its signal says why", async () => {
  let reason: unknown;
  const app = inkan(quiet).job("/work", { timeout: 30 }, async (job) => {
    await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
    reason = job.signal.reason;
  });
  const { id } = (await app.inject({ method: "POST", url: "/work" })).body;
  await until(async () => (await stateOf(app, `/work/${id}`)) === "failed", "the timeout");
  const job = (await app.inject({ url: `/work/${id}` })).body;
  assert.equal(job.error.type, "job-timeout");
  await until(() => reason !== undefined, "the handler to see the abort");
  assert.equal((reason as DOMException).name, "TimeoutError");
});

test("finished jobs are forgotten after keep seconds, and the store holds at most max", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    const app = inkan(quiet).job("/work", { keep: 1 }, () => "ok");
    const { id } = (await app.inject({ method: "POST", url: "/work" })).body;
    await until(async () => (await stateOf(app, `/work/${id}`)) === "done", "the job");
    mock.timers.tick(500);
    assert.equal((await app.inject({ url: `/work/${id}` })).status, 200, "kept for a second");
    mock.timers.tick(1000);
    assert.equal((await app.inject({ url: `/work/${id}` })).status, 404, "then swept");
  } finally {
    mock.timers.reset();
  }

  const app = inkan(quiet).job("/work", { store: memoryStore({ max: 2 }) }, () => "ok");
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await app.inject({ method: "POST", url: "/work" })).body.id);
    await until(async () => (await stateOf(app, `/work/${ids[i]}`)) === "done", "the job");
  }
  assert.equal((await app.inject({ url: `/work/${ids[0]}` })).status, 404, "the oldest finished one made room");
  assert.equal((await app.inject({ url: `/work/${ids[2]}` })).status, 200);
});

test("owner: someone else's job is a 404", async () => {
  const app = inkan(quiet).job("/work", { owner: (ctx) => ctx.headers["x-user"] }, () => "mine");
  const { id } = (await app.inject({ method: "POST", url: "/work", headers: { "x-user": "ada" } })).body;
  assert.equal((await app.inject({ url: `/work/${id}`, headers: { "x-user": "bob" } })).status, 404);
  assert.equal((await app.inject({ url: `/work/${id}/result`, headers: { "x-user": "bob" } })).status, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/work/${id}`, headers: { "x-user": "bob" } })).status, 404);
  assert.equal((await app.inject({ url: `/work/${id}`, headers: { "x-user": "ada" } })).status, 200);
});

test("ids are random, not a counter", async () => {
  const app = inkan(quiet).job("/work", {}, () => null);
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) ids.add((await app.inject({ method: "POST", url: "/work" })).body.id);
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^[\w-]{22}$/);
  const prefixes = new Set([...ids].map((id) => id.slice(0, 8)));
  assert.ok(prefixes.size > 15, "no shared prefix as a request id has");
});

test("result?wait waits for the job; without it a running job is a 409 with retry-after", async () => {
  const app = inkan(quiet).job("/work", { result: t.object({ n: t.int() }) }, async () => {
    await sleep(60);
    return { n: 1 };
  });
  const { id } = (await app.inject({ method: "POST", url: "/work" })).body;
  const early = await app.inject({ url: `/work/${id}/result` });
  assert.equal(early.status, 409);
  assert.equal(early.body.type, "job-not-done");
  assert.equal(early.headers["retry-after"], "1");
  assert.equal((await app.inject({ url: `/work/${id}/result?wait=31` })).status, 400);
  const waited = await app.inject({ url: `/work/${id}/result?wait=5` });
  assert.equal(waited.status, 200);
  assert.deepEqual(waited.body, { n: 1 });
});

test("in development a progress or result that breaks the contract fails the job", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    const app = inkan(quiet).job("/work", { body: t.object({ what: t.string() }), progress: Progress, result: Result }, async (job) => {
      if (job.input.what === "progress") job.progress({ done: "half" } as never);
      return { url: 5 } as never;
    });
    for (const what of ["progress", "result"]) {
      const { id } = (await app.inject({ method: "POST", url: "/work", body: { what } })).body;
      await until(async () => (await stateOf(app, `/work/${id}`)) === "failed", "the job to fail");
      const job = (await app.inject({ url: `/work/${id}` })).body;
      assert.equal(job.error.type, "job-contract");
      assert.match(job.error.detail, new RegExp(what));
    }
    assert.ok(errors.mock.callCount() >= 2);
  } finally {
    errors.mock.restore();
  }
});

test("job.ctx keeps decorations and state, but its signal points at job.signal", async () => {
  let seen: unknown;
  let signalError: unknown;
  const app = inkan(quiet)
    .decorate("db", { name: "orders" })
    .onRequest((ctx) => void (ctx.state.user = "ada"))
    .job("/work", {}, (job) => {
      seen = [job.ctx.db.name, job.ctx.state.user];
      try {
        void job.ctx.signal;
      } catch (err) {
        signalError = err;
      }
    });
  await app.inject({ method: "POST", url: "/work" });
  await until(() => seen !== undefined, "the job to run");
  assert.deepEqual(seen, ["orders", "ada"]);
  assert.match((signalError as Error).message, /use job\.signal/);
});

test("a job path with :id is refused; a job in a plugin lives under its prefix", async () => {
  assert.throws(() => inkan(quiet).job("/work/:id", {}, () => null), /has an :id already/);
  const app = inkan(quiet).register(
    (scope) => {
      scope.job("/exports", {}, () => "ok");
    },
    { prefix: "/teams/:team" },
  );
  const res = await app.inject({ method: "POST", url: "/teams/blue/exports" });
  assert.equal(res.status, 202);
  assert.equal(res.headers.location, `/teams/blue/exports/${res.body.id}`);
  assert.equal((await app.inject({ url: res.headers.location })).status, 200, "the other path params are kept");
});

test("OpenAPI: five operations, a 202 with its location, an event stream and a named job schema", () => {
  const app = inkan(quiet).job("/exports", { summary: "Export orders", body: t.object({ rows: t.int() }), progress: Progress, result: Result }, () => ({ url: "", rows: 0 }));
  const doc = app.openapi() as any;
  const ops = Object.entries(doc.paths).flatMap(([p, o]) => Object.keys(o as object).map((m) => `${m.toUpperCase()} ${p}`));
  assert.deepEqual(ops.sort(), ["DELETE /exports/{id}", "GET /exports/{id}", "GET /exports/{id}/events", "GET /exports/{id}/result", "POST /exports"]);
  const post = doc.paths["/exports"].post;
  assert.equal(post.summary, "Export orders");
  assert.deepEqual(post.responses["202"].headers.location.schema, { type: "string" });
  assert.deepEqual(post.responses["202"].content["application/json"].schema, { $ref: "#/components/schemas/ExportsJob" });
  assert.ok(post.responses["503"]);
  assert.ok(doc.paths["/exports/{id}/events"].get.responses["200"].content["text/event-stream"]);
  assert.ok(doc.paths["/exports/{id}/result"].get.responses["409"]);
  assert.ok(doc.paths["/exports/{id}"].delete.responses["204"]);
  assert.deepEqual(doc.components.schemas.ExportsJob.properties.state.enum, ["queued", "running", "done", "failed", "canceled"]);
});

test("inkan check covers the job routes with the examples made from the first one", async () => {
  const app = inkan(quiet).job(
    "/exports",
    {
      body: t.object({ rows: t.int() }),
      progress: Progress,
      result: Result,
      examples: [{ name: "seven rows", body: { rows: 7 } }],
    },
    async (job) => {
      job.progress({ done: 1, total: 1 });
      return { url: "/x.csv", rows: job.input.rows };
    },
  );
  const report = await app.check();
  assert.deepEqual(
    report.results.filter((r) => !r.ok),
    [],
  );
  assert.equal(report.results.length, 9);
  assert.deepEqual(report.unchecked, []);
  const forget = report.results.find((r) => r.method === "DELETE" && r.status === 204);
  assert.ok(forget, "the finished job is forgotten");

  // without a body, a start example is made too
  const bare = await inkan(quiet).job("/ping", {}, () => "pong").check();
  assert.ok(bare.ok);
  assert.equal(bare.results.length, 9);
});

test("shutdown: no new jobs, waiting ones canceled, streams end, running ones get their grace", async () => {
  const slow = gate();
  let n = 0;
  const app = inkan(quiet).job("/work", { concurrency: 2 }, async (job) => {
    if (n++ === 0) return slow; // finishes within the grace
    await new Promise((resolve) => job.signal.addEventListener("abort", resolve)); // only stops when told
    return "late";
  });
  const a = (await app.inject({ method: "POST", url: "/work" })).body.id;
  const b = (await app.inject({ method: "POST", url: "/work" })).body.id;
  const c = (await app.inject({ method: "POST", url: "/work" })).body.id;
  const stream = app.inject({ url: `/work/${b}/events` });
  await sleep(10);

  const stopped = app._jobs!.stop(100);
  const events = (await stream).body;
  assert.deepEqual(
    events.map((e: { event: string }) => e.event),
    ["status", "end"],
    "the stream ended at once",
  );
  const refused = await app.inject({ method: "POST", url: "/work" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.type, "shutting-down");
  const waiting = (await app.inject({ url: `/work/${c}` })).body;
  assert.equal(waiting.state, "canceled");
  assert.equal(waiting.error.type, "shutting-down");

  setTimeout(() => slow.open(), 20);
  await stopped;
  assert.equal(await stateOf(app, `/work/${a}`), "done", "finished within its grace");
  assert.equal(await stateOf(app, `/work/${b}`), "canceled", "aborted after it");
});

test("SIGTERM: event streams end before the server waits, and onClose runs after the jobs", async () => {
  const order: string[] = [];
  const app = inkan({ log: false })
    .job("/work", {}, async () => {
      await sleep(150);
      order.push("job done");
    })
    .onClose(() => void order.push("onClose"));
  const server = await app.listen(0);
  const port = (server.address() as { port: number }).port;
  const { id } = (await (await fetch(`http://127.0.0.1:${port}/work`, { method: "POST" })).json()) as { id: string };
  const res = await fetch(`http://127.0.0.1:${port}/work/${id}/events`);
  const text = res.text();
  await sleep(20);

  const exit = process.exit;
  let code: number | undefined;
  (process as any).exit = (c?: number) => void (code = c);
  try {
    process.emit("SIGTERM" as any);
    const events = parseEvents(await text);
    assert.deepEqual(
      events.map((e) => e.event),
      ["status", "end"],
    );
    await until(() => code !== undefined, "the process to exit", 12_000);
    assert.equal(code, 0);
    assert.deepEqual(order, ["job done", "onClose"]);
  } finally {
    (process as any).exit = exit;
  }
});

test("result?wait is not cut short by an app-wide timeout", async () => {
  const app = inkan({ ...quiet, timeout: 20 }).job("/slow", { result: t.object({ ok: t.boolean() }) }, async () => {
    await sleep(80);
    return { ok: true };
  });
  const started = await app.inject({ method: "POST", url: "/slow" });
  const res = await app.inject({ url: `/slow/${started.body.id}/result?wait=5` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});
