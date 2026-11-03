// app.upgrade, the door for servers with WebSockets of their own: the decision on the
// upgrade, then the socket on a transport in memory. No sockets, no frames: what the app
// does with messages, close codes, limits and backpressure, as a platform's adapter sees it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { inkan, t, type AdapterRequest, type WsEvents, type WsTransport, type WsUpgrade, type WsRefusal } from "../src/index.ts";

// The app's timers are unref'd, since a server keeps the process alive; here nothing else does.
const alive = setInterval(() => {}, 1000);
after(() => clearInterval(alive));

const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Say = t.discriminated("type", {
  say: t.object({ type: t.literal("say"), text: t.string().max(20) }),
  leave: t.object({ type: t.literal("leave") }),
});
const Said = t.object({ type: t.enum(["said", "joined"]), text: t.string(), from: t.string() });

const chat = () =>
  inkan(quiet).ws("/rooms/:room", { params: t.object({ room: t.string() }), query: t.object({ name: t.string() }), message: Say, send: Said }, (socket, ctx) => {
    void socket.send({ type: "joined", text: ctx.params.room, from: ctx.query.name });
    socket.on("message", (m) => {
      if (m.type === "leave") return socket.close(4000, "bye");
      void socket.send({ type: "said", text: m.text, from: ctx.query.name });
    });
  });

const upgradeRequest = (url: string, headers: Record<string, string> = {}, more: Partial<AdapterRequest> = {}): AdapterRequest => ({
  method: "GET",
  url,
  headers: { host: "x", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers },
  ...more,
});

/** A platform's socket in memory: what the app sends and closes with, and a switch for "my buffer is full". */
type Memory = { sent: (string | Buffer)[]; closes: [number, string][]; full: boolean; buffered: number; readonly pings: number; json: () => any[]; transport: WsTransport };
function memory(o: { ping?: boolean } = {}): Memory {
  const sent: (string | Buffer)[] = [];
  const closes: [number, string][] = [];
  let pings = 0;
  const m: Memory = {
    sent,
    closes,
    full: false,
    buffered: 0,
    get pings() {
      return pings;
    },
    /** What was sent, JSON parsed. */
    json: () => sent.map((s) => JSON.parse(String(s))),
    transport: {
      send(data: string | Uint8Array, binary: boolean) {
        sent.push(binary ? Buffer.from(data as Uint8Array) : (data as string));
        return !m.full;
      },
      close(code: number, reason: string) {
        closes.push([code, reason]);
      },
      get bufferedAmount() {
        return m.buffered;
      },
      ...(o.ping !== false && { ping: () => void pings++ }),
    } as WsTransport,
  };
  return m;
}

function switched(r: WsUpgrade | WsRefusal): WsUpgrade {
  if (r.status !== 101) assert.fail(`expected a 101, got ${r.response?.status}: ${r.response?.body}`);
  return r;
}
function refused(r: WsUpgrade | WsRefusal): NonNullable<WsRefusal["response"]> & { json: any } {
  if (r.status === 101) assert.fail("expected a refusal, got a 101");
  assert.ok(r.response, "expected an answer");
  return Object.assign(r.response, { json: r.response.body === undefined ? undefined : JSON.parse(String(r.response.body)) });
}

test("app.upgrade: a 101 with the answer's own headers; accept runs the handler, typed both ways, trimmed to `send`", async () => {
  const app = chat();
  const r = switched(await app.upgrade(upgradeRequest("/rooms/tea?name=ana", { "x-request-id": "abc-123" })));
  assert.equal(r.headers["x-request-id"], "abc-123");
  for (const name of ["content-length", "content-type", "upgrade", "connection", "sec-websocket-accept"]) assert.equal(r.headers[name], undefined, name);
  assert.deepEqual(r.cookies, []);

  const m = memory();
  const ev = r.accept(m.transport);
  assert.deepEqual(m.json(), [{ type: "joined", text: "tea", from: "ana" }]);
  ev.message(JSON.stringify({ type: "say", text: "hello" }), false);
  ev.message(new TextEncoder().encode(JSON.stringify({ type: "say", text: "bytes" })), false); // text as UTF-8 bytes, as uWS hands it over
  assert.deepEqual(m.json().slice(1), [
    { type: "said", text: "hello", from: "ana" },
    { type: "said", text: "bytes", from: "ana" },
  ]);
  ev.message(JSON.stringify({ type: "leave" }), false);
  assert.deepEqual(m.closes, [[4000, "bye"]]);
  ev.close(4000, "bye");
  assert.throws(() => r.accept(m.transport), /once/);
});

test("app.upgrade: without a contract text is a string and binary a copy of its own; the client's close code reaches the handler", async () => {
  const got: unknown[] = [];
  let closed: [number, string] | undefined;
  let aborted = false;
  const app = inkan(quiet).ws("/raw", {}, (socket, ctx) => {
    ctx.signal.addEventListener("abort", () => (aborted = true));
    socket.on("message", (msg) => {
      got.push(msg);
      void socket.sendRaw(msg);
    });
    socket.on("close", (code, reason) => (closed = [code, reason]));
  });
  const m = memory();
  const ev = switched(await app.upgrade(upgradeRequest("/raw"))).accept(m.transport);
  const ab = new Uint8Array([1, 2, 3]).buffer;
  ev.message("hi", false);
  ev.message(ab, true);
  new Uint8Array(ab).fill(9); // the platform takes its memory back
  assert.equal(got[0], "hi");
  assert.ok(Buffer.isBuffer(got[1]));
  assert.deepEqual([...(got[1] as Buffer)], [1, 2, 3]);
  assert.deepEqual(m.sent, ["hi", Buffer.from([1, 2, 3])]);
  assert.equal(aborted, false);
  ev.close(4002, "bye");
  assert.deepEqual(closed, [4002, "bye"]);
  assert.equal(aborted, true, "ctx.signal aborts once the connection is gone");
  ev.message("late", false);
  assert.equal(got.length, 2, "nothing is delivered after the close");
});

test("app.upgrade refuses with an answer: 403 for another origin before any hook, 401, 400, 404, 426", async () => {
  let hooks = 0;
  const app = inkan(quiet)
    .ws("/secure", { security: "bearer" }, () => {})
    .ws("/q", { query: t.object({ n: t.int() }) }, () => {})
    .get("/plain", () => ({ ok: true }));
  app.onRequest(() => void hooks++);

  const evil = refused(await app.upgrade(upgradeRequest("/q?n=1", { origin: "http://evil.example", cookie: "sid=abc" })));
  assert.equal(evil.status, 403);
  assert.equal(evil.json.type, "origin-not-allowed");
  assert.equal(evil.headers["content-type"], "application/problem+json");
  assert.equal(hooks, 0, "no hook ran");
  switched(await app.upgrade(upgradeRequest("/q?n=1", { origin: "http://x" }))).cancel();
  switched(await app.upgrade(upgradeRequest("/q?n=1", { origin: "https://x" }, { secure: true }))).cancel();

  const no = refused(await app.upgrade(upgradeRequest("/secure")));
  assert.equal(no.status, 401);
  assert.equal(no.json.type, "unauthorized");
  assert.equal(no.headers["www-authenticate"], "Bearer");
  switched(await app.upgrade(upgradeRequest("/secure", { authorization: "Bearer t" }))).cancel();
  assert.equal(refused(await app.upgrade(upgradeRequest("/q?n=abc"))).status, 400);
  assert.equal(refused(await app.upgrade(upgradeRequest("/nowhere"))).status, 404);
  assert.equal(refused(await app.upgrade(upgradeRequest("/plain"))).status, 404, "an HTTP route is no WebSocket");
  assert.equal(refused(await app.upgrade(upgradeRequest("/q?n=1", { "sec-websocket-key": "short" }))).status, 400);
  assert.equal(refused(await app.upgrade(upgradeRequest("/q?n=1", { "sec-websocket-version": "8" }))).status, 426);
  assert.equal(refused(await app.upgrade(upgradeRequest("/q?n=1", {}, { method: "POST" }))).status, 400);
  assert.equal(refused(await app.upgrade(upgradeRequest("/q?n=1", {}, { httpVersion: "1.0" }))).status, 400);
  assert.equal(refused(await app.upgrade(upgradeRequest("/q?n=1", { "content-length": "5" }))).status, 400);
});

test("app.upgrade: a message that breaks the contract, is not JSON, is binary or too large closes with its code", async () => {
  const app = inkan(quiet)
    .ws("/c", { message: t.object({ n: t.int() }), maxMessage: 64 }, (socket) => socket.on("message", () => {}))
    .ws("/r", { maxMessage: 16 }, (socket) => socket.on("message", () => {}));
  const open = async (path: string) => {
    const m = memory();
    return { m, ev: switched(await app.upgrade(upgradeRequest(path))).accept(m.transport) };
  };
  const cases: [string, (ev: WsEvents) => void, number, RegExp][] = [
    ["/c", (ev) => ev.message("not json", false), 1007, /^the message is not JSON$/],
    ["/c", (ev) => ev.message(JSON.stringify({ n: "secret-value" }), false), 1007, /^n /],
    ["/c", (ev) => ev.message(new Uint8Array([1]), true), 1003, /not binary/],
    ["/r", (ev) => ev.message("x".repeat(17), false), 1009, /at most 16 bytes/],
    ["/r", (ev) => ev.message("é".repeat(9), false), 1009, /at most 16 bytes/], // 9 characters, 18 bytes
    ["/r", (ev) => ev.message(new Uint8Array(17), true), 1009, /at most 16 bytes/],
    ["/r", (ev) => ev.message(new Uint8Array([0xff, 0xfe]), false), 1007, /UTF-8/],
  ];
  for (const [path, send, code, reason] of cases) {
    const { m, ev } = await open(path);
    send(ev);
    assert.equal(m.closes.length, 1, `${path} ${code}`);
    assert.equal(m.closes[0]![0], code);
    assert.match(m.closes[0]![1], reason);
    assert.doesNotMatch(m.closes[0]![1], /secret-value/, "the reason echoes no input");
    send(ev);
    assert.equal(m.closes.length, 1, "closed once; what comes after is dropped");
  }
  const { m, ev } = await open("/r");
  ev.message("x".repeat(16), false);
  assert.deepEqual(m.closes, [], "the limit itself is fine");
});

test("app.upgrade: a handler that throws is reported and closes with 1011; in development a broken `send` throws", async () => {
  const errors: unknown[] = [];
  const app = inkan({ ...quiet, onError: (e) => void errors.push(e) })
    .ws("/boom", {}, () => {
      throw new Error("boom");
    })
    .ws("/bad", { send: t.object({ n: t.int() }) }, (socket) => void socket.send({ n: "one" } as never));
  const a = memory();
  switched(await app.upgrade(upgradeRequest("/boom"))).accept(a.transport);
  assert.deepEqual(a.closes, [[1011, "internal error"]]);
  const b = memory();
  switched(await app.upgrade(upgradeRequest("/bad"))).accept(b.transport);
  assert.deepEqual(b.closes, [[1011, "internal error"]]);
  assert.match(String(errors[0]), /boom/);
  assert.match(String(errors[1]), /WS \/bad sent a message that breaks its contract: n/);
});

test("app.upgrade: send waits for drain when the transport says it is full; past the buffer limit the socket is cut off with 1008", async () => {
  let socket!: import("../src/index.ts").WsSocket;
  let code: number | undefined;
  const app = inkan(quiet).ws("/flood", { maxMessage: 1024 }, (s) => {
    socket = s;
    s.on("close", (c) => (code = c));
  });
  const m = memory();
  const ev = switched(await app.upgrade(upgradeRequest("/flood"))).accept(m.transport);
  let resolved = false;
  m.full = true;
  void socket.sendRaw("a").then(() => (resolved = true));
  await sleep(5);
  assert.equal(resolved, false, "it waits for the drain");
  m.full = false;
  ev.drain();
  await sleep(0);
  assert.equal(resolved, true);
  m.buffered = 4321;
  assert.equal(socket.bufferedAmount, 4321, "bufferedAmount is the transport's");

  m.buffered = 1024 * 1024 + 1; // four times maxMessage is less than 1 MiB: the cap is 1 MiB
  await socket.sendRaw("b");
  assert.deepEqual(m.closes, [[1006, ""]], "cut without a close frame");
  assert.equal(m.sent.includes("b"), false);
  assert.equal(socket.readyState, 2);
  ev.close(1006, "");
  assert.equal(code, 1008, "the handler hears why");
  assert.equal(socket.readyState, 3);
});

test("app.upgrade: the heartbeat pings through the transport and cuts a silent peer off; a transport without ping is not pinged", async () => {
  const app = inkan(quiet).ws("/hb", { heartbeat: 20 }, () => {});
  const a = memory();
  const evA = switched(await app.upgrade(upgradeRequest("/hb"))).accept(a.transport);
  const b = memory();
  const evB = switched(await app.upgrade(upgradeRequest("/hb"))).accept(b.transport);
  const c = memory({ ping: false });
  const evC = switched(await app.upgrade(upgradeRequest("/hb"))).accept(c.transport);
  for (let i = 0; i < 8; i++) {
    await sleep(15);
    evA.pong();
  }
  assert.ok(a.pings >= 3, `pinged ${a.pings} times`);
  assert.deepEqual(a.closes, [], "a peer that answers stays");
  assert.deepEqual(b.closes, [[1006, ""]], "one that does not is cut off");
  assert.deepEqual(c.closes, []);
  for (const ev of [evA, evB, evC]) ev.close(1006, "");
});

test("app.upgrade: maxConnections counts handshakes and sockets; a refusal, cancel() and the close free the slot", async () => {
  const app = inkan(quiet).ws("/one", { maxConnections: 1, query: t.object({ n: t.int() }) }, () => {});
  const first = switched(await app.upgrade(upgradeRequest("/one?n=1")));
  const busy = refused(await app.upgrade(upgradeRequest("/one?n=1")));
  assert.equal(busy.status, 503);
  assert.equal(busy.json.type, "too-many-connections");
  first.cancel();
  assert.equal(refused(await app.upgrade(upgradeRequest("/one?n=x"))).status, 400, "the slot is free again");
  const m = memory();
  const ev = switched(await app.upgrade(upgradeRequest("/one?n=1"))).accept(m.transport);
  assert.equal(refused(await app.upgrade(upgradeRequest("/one?n=1"))).status, 503, "an open socket holds it");
  ev.close(1000, "");
  switched(await app.upgrade(upgradeRequest("/one?n=1"))).cancel();
});

test("app.upgrade: a handshake that never gets its answer ends without one, and frees its slot", async () => {
  let aborted = false;
  const app = inkan(quiet).ws("/slow", { handshakeTimeout: 50, maxConnections: 1 }, () => {});
  app.onRequest((ctx) => {
    ctx.signal.addEventListener("abort", () => (aborted = true));
    return ctx.query.wait ? new Promise<void>(() => {}) : undefined;
  });
  const started = Date.now();
  const r = await app.upgrade(upgradeRequest("/slow?wait=1"));
  assert.equal(r.status, undefined);
  assert.equal((r as WsRefusal).response, undefined, "no answer: the adapter ends the connection");
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true, "ctx.signal aborts");
  switched(await app.upgrade(upgradeRequest("/slow"))).cancel();
});

test("app.upgrade: stopped() closes every open socket with 1001 and waits until the platform says it is gone", async () => {
  const events: string[] = [];
  const app = inkan(quiet)
    .ws("/stay", {}, (socket) => socket.on("close", (code) => void events.push(`socket ${code}`)))
    .onClose(() => void events.push("onClose"));
  const m = memory();
  const ev = switched(await app.upgrade(upgradeRequest("/stay"))).accept(m.transport);
  let stopped = false;
  const stopping = app.stopped().then(() => (stopped = true));
  await sleep(10);
  assert.deepEqual(m.closes, [[1001, "the server is shutting down"]]);
  assert.equal(stopped, false, "it waits for the close");
  ev.close(1001, "the server is shutting down");
  await stopping;
  assert.deepEqual(events, ["socket 1001", "onClose"]);
});

test("app.upgrade: the iterator reads the messages that came before anybody listened", async () => {
  const app = inkan(quiet).ws("/late", { message: t.object({ n: t.int() }), send: t.object({ sum: t.int() }) }, async (socket) => {
    await sleep(20);
    let sum = 0;
    for await (const msg of socket) {
      sum += msg.n;
      if (sum >= 6) await socket.send({ sum });
    }
  });
  const m = memory();
  const ev = switched(await app.upgrade(upgradeRequest("/late"))).accept(m.transport);
  for (const n of [1, 2, 3]) ev.message(JSON.stringify({ n }), false);
  await sleep(50);
  assert.deepEqual(m.json(), [{ sum: 6 }]);
  ev.close(1000, "");
});

test("app.upgrade: a transport that never says it is closed counts as gone after 3 s: cut once, the slot freed, stopped() resolves", { timeout: 10_000 }, async () => {
  let heard: [number, string] | undefined;
  const app = inkan(quiet).ws("/deaf", { maxConnections: 1 }, (socket) => socket.on("close", (code, reason) => (heard = [code, reason])));
  const m = memory();
  switched(await app.upgrade(upgradeRequest("/deaf"))).accept(m.transport);
  const started = Date.now();
  await app.stopped();
  const took = Date.now() - started;
  assert.ok(took >= 2900 && took < 4500, `took ${took} ms`);
  assert.deepEqual(m.closes, [[1001, "the server is shutting down"], [1006, ""]]);
  assert.deepEqual(heard, [1001, "the server is shutting down"], "the handler hears the close it began");
  switched(await app.upgrade(upgradeRequest("/deaf"))).cancel(); // the slot is free
});

test("app.upgrade: a transport with pause/resume is paused while 16 messages wait unread, and resumed once they are read", async () => {
  const calls: string[] = [];
  const got: unknown[] = [];
  const app = inkan(quiet).ws("/slow", {}, async (socket) => {
    await sleep(30); // listens late: what comes meanwhile waits
    socket.on("message", (msg) => void got.push(msg));
  });
  const m = memory();
  const transport: WsTransport = Object.assign(m.transport, { pause: () => void calls.push("pause"), resume: () => void calls.push("resume") });
  const ev = switched(await app.upgrade(upgradeRequest("/slow"))).accept(transport);
  for (let i = 0; i < 15; i++) ev.message(String(i), false);
  assert.deepEqual(calls, []);
  for (let i = 15; i < 20; i++) ev.message(String(i), false);
  assert.deepEqual(calls, ["pause"], "paused once");
  await sleep(60);
  assert.equal(got.length, 20, "nothing is lost");
  assert.deepEqual(calls, ["pause", "resume"]);

  // without them nothing is paused, and nothing breaks
  const plain = memory();
  const ev2 = switched(await app.upgrade(upgradeRequest("/slow"))).accept(plain.transport);
  for (let i = 0; i < 20; i++) ev2.message(String(i), false);
  await sleep(60);
  assert.equal(got.length, 40);
  ev.close(1000, "");
  ev2.close(1000, "");
});

test("app.upgrade: events.error reaches the route's error listeners", async () => {
  const errors: string[] = [];
  const app = inkan(quiet).ws("/e", {}, (socket) => socket.on("error", (e) => void errors.push(e.message)));
  const ev = switched(await app.upgrade(upgradeRequest("/e"))).accept(memory().transport);
  ev.error(new Error("reset by peer"));
  assert.deepEqual(errors, ["reset by peer"]);
  ev.close(1006, "");
});
