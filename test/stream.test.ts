import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fileExample, inkan, sse, t } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const Tick = t.object({ n: t.int() });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("sse: events go out in the wire format and come back parsed", async () => {
  const app = inkan(quiet).get("/ticks", { response: { 200: t.events({ tick: Tick, done: t.object({}) }) } }, () =>
    sse(async function* () {
      for (let n = 1; n <= 3; n++) yield { event: "tick", data: { n }, id: String(n) };
      yield { event: "done", data: {} };
    }),
  );
  const res = await app.inject({ url: "/ticks" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.match(res.text, /^event: tick\nid: 1\ndata: \{"n":1\}\n\n/);
  assert.deepEqual(res.body, [
    { event: "tick", data: { n: 1 }, id: "1" },
    { event: "tick", data: { n: 2 }, id: "2" },
    { event: "tick", data: { n: 3 }, id: "3" },
    { event: "done", data: {} },
  ]);
});

test("an endless stream stops when the reader has enough, and the source hears it", async () => {
  let stopped = false;
  const app = inkan(quiet).get("/forever", () =>
    sse(async function* (signal) {
      try {
        for (let n = 0; !signal.aborted; n++) yield { data: { n } };
      } finally {
        stopped = true;
      }
    }),
  );
  const res = await app.inject({ url: "/forever", events: 3 });
  assert.equal(res.body.length, 3);
  await wait(10);
  assert.ok(stopped, "the generator was closed");
});

test("an event that breaks the contract ends the stream with an error event", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const app = inkan(quiet).get("/bad", { response: { 200: t.events({ tick: Tick }) } }, () =>
      sse(async function* () {
        yield { event: "tick", data: { n: 1 } };
        yield { event: "tick", data: { n: "two" } };
        yield { event: "tick", data: { n: 3 } };
      }),
    );
    const res = await app.inject({ url: "/bad" });
    assert.equal(res.body.length, 2);
    assert.equal(res.body[1].event, "error");
    assert.match(res.body[1].data.detail, /data\.n expected an integer/);
  } finally {
    console.error = orig;
  }
});

test("quiet streams get keep-alive comments, which readers skip", async () => {
  const app = inkan(quiet).get("/slow", () =>
    sse(
      async function* () {
        await wait(60);
        yield { data: "late" };
      },
      { keepAlive: 15 },
    ),
  );
  const res = await app.inject({ url: "/slow" });
  assert.match(res.text, /^: ping\n\n/);
  assert.deepEqual(res.body, [{ event: "message", data: "late" }]);
});

test("check reads as many events as the example expects, and checks each", async () => {
  const route = (bad: boolean) =>
    inkan(quiet).get(
      "/ticks",
      { response: { 200: t.events({ tick: Tick }) }, examples: [{ name: "two ticks", expect: [{ data: { n: 1 } }, { data: { n: 2 } }] }] },
      () =>
        sse(async function* (signal) {
          for (let n = 1; !signal.aborted; n++) yield { event: "tick", data: { n: bad && n === 2 ? -0.5 : n } };
        }),
    );
  const good = await route(false).check();
  assert.equal(good.ok, true, JSON.stringify(good.results));
  const orig = console.error;
  console.error = () => {};
  try {
    const broken = await route(true).check();
    assert.equal(broken.ok, false);
    assert.ok(broken.results[0].problems.some((p) => /event 2/.test(p)), JSON.stringify(broken.results[0].problems));
  } finally {
    console.error = orig;
  }
});

test("any stream can be returned: it goes out as it comes", async () => {
  const app = inkan(quiet)
    .get("/csv", ({ header }) => {
      header("content-type", "text/csv");
      return Readable.from(["id,name\n", "1,Sencha\n"]);
    })
    .get("/web", () => new Blob(["from a web stream"]).stream());
  const csv = await app.inject({ url: "/csv" });
  assert.equal(csv.text, "id,name\n1,Sencha\n");
  assert.equal(csv.headers["content-type"], "text/csv");
  assert.equal((await app.inject({ url: "/web" })).text, "from a web stream");
});

test("over a real socket: events arrive one by one, and a client that leaves stops the source", async () => {
  let stopped = false;
  const app = inkan(quiet).get("/live", () =>
    sse(async function* (signal) {
      try {
        for (let n = 0; !signal.aborted; n++) {
          yield { data: { n } };
          await wait(5);
        }
      } finally {
        stopped = true;
      }
    }),
  );
  const server = await app.listen(0, "127.0.0.1");
  const { port } = server.address() as { port: number };
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/live`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /data: \{"n":0\}/);
    controller.abort();
    for (let i = 0; i < 50 && !stopped; i++) await wait(10);
    assert.ok(stopped, "the source was told");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("HEAD on a stream sends no body", async () => {
  const app = inkan(quiet).get("/live", () => sse(async function* () { yield { data: 1 }; }));
  const res = await app.inject({ method: "HEAD", url: "/live" });
  assert.equal(res.status, 200);
  assert.equal(res.text, "");
});

// ---------- uploads ----------

const Upload = t.object({
  title: t.string(),
  copies: t.int().min(1),
  file: t.file().max(16).accept("text/*"),
});

const uploads = () =>
  inkan(quiet).post(
    "/notes",
    {
      body: Upload,
      response: { 201: t.object({ title: t.string(), copies: t.int(), name: t.string(), size: t.int(), text: t.string() }) },
      examples: [
        { name: "a small note", body: { title: "hi", copies: 2, file: fileExample("note.txt", "hello", "text/plain") }, expect: { size: 5, text: "hello" } },
        { name: "too big", body: { title: "hi", copies: 1, file: fileExample("big.txt", "x".repeat(40), "text/plain") }, status: 400 },
        { name: "not text", body: { title: "hi", copies: 1, file: fileExample("cat.png", "png", "image/png") }, status: 400 },
      ],
    },
    ({ body }) => ({ title: body.title, copies: body.copies, name: body.file.name, size: body.file.size, text: body.file.data.toString() }),
  );

test("uploads: fields are coerced, files arrive with name, type, size and data", async () => {
  const form = new FormData();
  form.append("title", "hi");
  form.append("copies", "3");
  form.append("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
  const res = await uploads().inject({ method: "POST", url: "/notes", body: form });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body, { title: "hi", copies: 3, name: "note.txt", size: 5, text: "hello" });
});

test("uploads: too big and the wrong type are 400s that say why", async () => {
  const res = await uploads().inject({ method: "POST", url: "/notes", body: { title: "x", copies: 1, file: fileExample("a.png", "x".repeat(20), "image/png") } });
  assert.equal(res.status, 400);
  assert.deepEqual(
    res.body.errors.map((e: { message: string }) => e.message),
    ["is 20 bytes, at most 16 are allowed", "has to be text/*, got image/png"],
  );
});

test("uploads: examples with files run in check, and OpenAPI says multipart", async () => {
  const app = uploads();
  const report = await app.check();
  assert.equal(report.ok, true, JSON.stringify(report.results));
  const op = (app.openapi() as any).paths["/notes"].post;
  assert.ok(op.requestBody.content["multipart/form-data"]);
  assert.deepEqual(op.requestBody.content["multipart/form-data"].schema.properties.file, {
    type: "string",
    format: "binary",
    contentMediaType: "text/*",
    "x-max-bytes": 16,
  });
  const stream = inkan(quiet).get("/s", { response: { 200: t.events({ tick: Tick }) } }, () => sse(async function* () {}));
  assert.ok((stream.openapi() as any).paths["/s"].get.responses["200"].content["text/event-stream"]);
});

test("uploads over a real socket still obey the body limit", async () => {
  const app = inkan({ ...quiet, bodyLimit: 200 }).post("/up", { body: t.object({ file: t.file() }) }, ({ body }) => ({ size: body.file.size }));
  const server = await app.listen(0, "127.0.0.1");
  const { port } = server.address() as { port: number };
  try {
    const small = new FormData();
    small.append("file", new Blob(["tiny"]), "a.bin");
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/up`, { method: "POST", body: small })).json(), { size: 4 });
    const big = new FormData();
    big.append("file", new Blob(["x".repeat(1000)]), "b.bin");
    assert.equal((await fetch(`http://127.0.0.1:${port}/up`, { method: "POST", body: big })).status, 413);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
