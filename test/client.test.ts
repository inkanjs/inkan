import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, problem, routes, t, type App } from "../src/index.ts";
import { client } from "../src/client.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const Tea = t.object({ id: t.int(), name: t.string(), added: t.date() }).named("Tea");
const teas = [{ id: 1, name: "Sencha", added: new Date("2026-01-02T03:04:05Z") }];

// Routes defined in a chain, so the type of `api` knows every one of them.
const admin = routes().get("/stats", { response: { 200: t.object({ teas: t.int() }) } }, () => ({ teas: teas.length }));
const api = inkan(quiet)
  .get(
    "/teas/:id",
    { params: t.object({ id: t.int() }), response: { 200: Tea, 404: t.problem() } },
    ({ params }) => teas.find((x) => x.id === params.id) ?? Promise.reject(problem(404, "tea-not-found", `No tea ${params.id}`)),
  )
  .get("/teas", { query: t.object({ name: t.string().optional() }), response: { 200: t.array(Tea) } }, ({ query }) =>
    teas.filter((x) => !query.name || x.name === query.name),
  )
  .post(
    "/teas",
    { body: t.object({ name: t.string().min(1) }), response: { 201: Tea, 409: t.problem() } },
    ({ body, reply }) => reply(201, { id: 2, name: body.name, added: new Date() }),
  )
  .delete("/teas/:id", { params: t.object({ id: t.int() }), response: { 204: t.empty() } }, () => {})
  .get("/echo/:word", ({ params, headers }) => ({ word: params.word, auth: headers.authorization ?? null }))
  .mount("/admin", admin);

/** A fetch that goes straight into the app, so the test needs no port. */
const viaInject = (app: App) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r = await app.inject({
      method: init?.method,
      url: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      body: init?.body ?? undefined,
    });
    return new Response(r.status === 204 ? null : r.text, { status: r.status, headers: r.headers });
  }) as typeof fetch;

const shop = client<typeof api>("http://shop.local/", { fetch: viaInject(api), headers: () => ({ authorization: "Bearer t0k3n" }) });

test("a success: typed data, after a trip through JSON", async () => {
  const res = await shop.get("/teas/:id", { params: { id: 1 } });
  assert.equal(res.ok, true);
  if (res.ok) {
    const name: string = res.data.name;
    const added: string = res.data.added; // a Date on the server, a string on the wire
    assert.equal(name, "Sencha");
    assert.equal(added, "2026-01-02T03:04:05.000Z");
  }
});

test("a failure: a problem, never a thrown error", async () => {
  const res = await shop.get("/teas/:id", { params: { id: 9 } });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 404);
    assert.equal(res.problem.type, "tea-not-found");
  }
  const bad = await shop.post("/teas", { body: { name: "" } });
  assert.equal(bad.status, 400, "a status the contract does not list is a problem too");
  if (!bad.ok) assert.equal(bad.problem.type, "validation");
});

test("bodies, queries, 204s, shared headers and mounted groups", async () => {
  const made = await shop.post("/teas", { body: { name: "Gyokuro" } });
  assert.equal(made.status, 201);
  if (made.ok) assert.equal(made.data.name, "Gyokuro"); // ok first: any status may also come from a proxy

  const found = await shop.get("/teas", { query: { name: "Sencha" } });
  if (found.ok) assert.deepEqual(found.data.map((x) => x.id), [1]);

  const gone = await shop.delete("/teas/:id", { params: { id: 1 } });
  assert.equal(gone.status, 204);
  if (gone.ok) assert.equal(gone.data, undefined);

  const echo = await shop.get("/echo/:word", { params: { word: "a b/c" } });
  if (echo.ok) assert.deepEqual(echo.data, { word: "a b/c", auth: "Bearer t0k3n" });

  const stats = await shop.get("/admin/stats");
  if (stats.ok) assert.equal(stats.data.teas, 1);
});

test("the types follow the contract", () => {
  const typesOnly = () => {
    // @ts-expect-error there is no such route
    void shop.get("/coffee");
    // @ts-expect-error the route needs its params
    void shop.get("/teas/:id");
    // @ts-expect-error id is a number in the contract
    void shop.get("/teas/:id", { params: { id: "one" } });
    // @ts-expect-error name has to be a string
    void shop.post("/teas", { body: { name: 5 } });
    // @ts-expect-error POST /teas/:id does not exist, only DELETE and GET do
    void shop.post("/teas/:id", { params: { id: 1 } });
    void shop.get("/teas/:id", { params: { id: 1 } }).then((res) => {
      // @ts-expect-error data is only there once ok says so
      void res.data;
      if (res.ok) void res.data.id;
      if (res.status === 404) void res.problem.detail;
    });
  };
  assert.equal(typeof typesOnly, "function");
});

test("a missing path value is caught before anything is sent", async () => {
  const loose = client<typeof api>("http://shop.local", { fetch: viaInject(api) });
  await assert.rejects(() => (loose.get as any)("/teas/:id", { params: {} }), /needs a value for :id/);
});

test("events: a job followed through the client, every event narrowed by its name", async () => {
  const { t: s } = await import("../src/index.ts");
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  const jobs = inkan(quiet).job(
    "/exports",
    { body: s.object({ rows: s.int() }), progress: s.object({ done: s.int(), total: s.int() }), result: s.object({ url: s.string() }) },
    async (job) => {
      await ready;
      job.progress({ done: job.input.rows, total: job.input.rows });
      return { url: "/x.csv" };
    },
  );
  const api = client<typeof jobs>("http://jobs.local", { fetch: viaInject(jobs) });
  const started = await api.post("/exports", { body: { rows: 3 } });
  assert.equal(started.status, 202);
  if (!started.ok) return assert.fail("the job did not start");
  const id: string = started.data.id;
  const state: "queued" | "running" | "done" | "failed" | "canceled" = started.data.state;
  const created: string = started.data.createdAt; // a Date on the server, a string on the wire
  assert.ok(state && created);

  setTimeout(release, 20);
  const seen: string[] = [];
  for await (const e of api.events("/exports/:id/events", { params: { id } })) {
    seen.push(e.event);
    if (e.event === "progress") {
      const done: number = e.data.done;
      assert.equal(done, 3);
    } else {
      const st: string = e.data.state;
      assert.ok(st);
    }
  }
  assert.deepEqual(seen, ["status", "progress", "end"]);

  const result = await api.get("/exports/:id/result", { params: { id }, query: { wait: 1 } });
  if (result.ok) assert.equal(result.data.url, "/x.csv");
  else assert.fail("no result");

  await assert.rejects(
    async () => {
      for await (const _ of api.events("/exports/:id/events", { params: { id: "missing" } })) void _;
    },
    (err: { status: number; problem: { type: string } }) => err.status === 404 && err.problem.type === "job-not-found",
  );

  const typesOnly = () => {
    void (async () => {
      for await (const e of api.events("/exports/:id/events", { params: { id } })) {
        // @ts-expect-error a status event has no done; only progress does
        if (e.event === "status") void e.data.done;
      }
      // @ts-expect-error only routes that answer with events can be followed
      void api.events("/exports/:id", { params: { id } });
      // @ts-expect-error the stream needs its id
      void api.events("/exports/:id/events");
      const del = await api.delete("/exports/:id", { params: { id } });
      if (del.ok && del.status === 204) void del.data;
    })();
  };
  assert.equal(typeof typesOnly, "function");
});
