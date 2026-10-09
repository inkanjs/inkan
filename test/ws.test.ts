import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { inkan, t, type App } from "../src/index.ts";
import { client } from "../src/client.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Say = t.discriminated("type", {
  say: t.object({ type: t.literal("say"), text: t.string().max(20) }),
  leave: t.object({ type: t.literal("leave") }),
});
const Said = t.object({ type: t.enum(["said", "joined"]), text: t.string(), from: t.string() });

const chat = () =>
  inkan(quiet).ws(
    "/rooms/:room",
    { summary: "A chat room", params: t.object({ room: t.string() }), query: t.object({ name: t.string() }), message: Say, send: Said },
    (socket, ctx) => {
      void socket.send({ type: "joined", text: ctx.params.room, from: ctx.query.name });
      socket.on("message", (m) => {
        if (m.type === "leave") return socket.close(4000, "bye");
        void socket.send({ type: "said", text: m.text, from: ctx.query.name });
      });
    },
  );

async function served(app: App) {
  const server = await app.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  return { server, port, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const parsed = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
/** The next messages of a platform WebSocket, parsed when they are JSON. */
function inbox(ws: WebSocket) {
  const got: unknown[] = [];
  const waiting: ((v: unknown) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const v = typeof e.data === "string" ? parsed(e.data) : e.data;
    const w = waiting.shift();
    w ? w(v) : got.push(v);
  });
  return () => (got.length ? Promise.resolve(got.shift()) : new Promise((r) => waiting.push(r)));
}
const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("did not open")), { once: true });
  });
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.addEventListener("close", (e) => r({ code: e.code, reason: e.reason }), { once: true }));

// ---------- a client that writes frames by hand ----------

type Frame = { fin: boolean; op: number; payload: Buffer };
type Raw = { status: number; head: string; sock: Socket; send: (op: number, payload: Buffer | string, o?: { fin?: boolean; mask?: boolean }) => void; next: (ms?: number) => Promise<Frame | null> };

function raw(port: number, path: string, extra = ""): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${extra}\r\n`);
    let buf = Buffer.alloc(0);
    let head: string | undefined;
    const frames: (Frame | null)[] = [];
    const waiting: ((f: Frame | null) => void)[] = [];
    const push = (f: Frame | null) => {
      const w = waiting.shift();
      w ? w(f) : frames.push(f);
    };
    sock.on("error", reject);
    sock.on("close", () => push(null));
    sock.on("data", (b: Buffer) => {
      buf = Buffer.concat([buf, b]);
      if (head === undefined) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        resolve({ status: Number(head.split(" ")[1]), head, sock, send, next });
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) (len = buf.readUInt16BE(2)), (at = 4);
        else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (at = 10);
        if (buf.length < at + len) return;
        push({ fin: (buf[0]! & 0x80) !== 0, op: buf[0]! & 0x0f, payload: Buffer.from(buf.subarray(at, at + len)) });
        buf = buf.subarray(at + len);
      }
    });
    function send(op: number, data: Buffer | string, o: { fin?: boolean; mask?: boolean } = {}) {
      const payload = Buffer.from(data);
      const mask = o.mask ?? true;
      const len = payload.length;
      const head = Buffer.alloc(2 + (len >= 126 ? (len >= 65536 ? 8 : 2) : 0));
      head[0] = ((o.fin ?? true) ? 0x80 : 0) | op;
      if (len < 126) head[1] = len;
      else if (len < 65536) (head[1] = 126), head.writeUInt16BE(len, 2);
      else (head[1] = 127), head.writeBigUInt64BE(BigInt(len), 2);
      if (!mask) return void sock.write(Buffer.concat([head, payload]));
      head[1]! |= 0x80;
      const key = randomBytes(4);
      const body = Buffer.from(payload.map((x, i) => x ^ key[i & 3]!));
      sock.write(Buffer.concat([head, key, body]));
    }
    function next(ms = 2000): Promise<Frame | null> {
      if (frames.length) return Promise.resolve(frames.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame came")), ms);
        waiting.push((f) => (clearTimeout(timer), resolve(f)));
      });
    }
  });
}
const closeCode = (f: Frame | null) => (f && f.op === 8 ? { code: f.payload.readUInt16BE(0), reason: f.payload.subarray(2).toString() } : f);

// ---------- the handshake and messages ----------

test("handshake and echo with the platform WebSocket: params, query, typed messages both ways", async () => {
  const s = await served(chat());
  try {
    const ws = new WebSocket(`${s.url}/rooms/tea?name=ana`);
    const next = inbox(ws);
    await opened(ws);
    assert.deepEqual(await next(), { type: "joined", text: "tea", from: "ana" });
    ws.send(JSON.stringify({ type: "say", text: "hello" }));
    assert.deepEqual(await next(), { type: "said", text: "hello", from: "ana" });
    const end = closed(ws);
    ws.send(JSON.stringify({ type: "leave" }));
    assert.deepEqual(await end, { code: 4000, reason: "bye" });
  } finally {
    await s.close();
  }
});

test("the 101 carries the accept key and the answer's own headers", async () => {
  const s = await served(chat());
  try {
    const r = await raw(s.port, "/rooms/a?name=x", "x-request-id: abc-123\r\n");
    assert.equal(r.status, 101);
    assert.match(r.head, /sec-websocket-accept: [A-Za-z0-9+/=]{28}/i);
    assert.match(r.head, /x-request-id: abc-123/);
    r.sock.destroy();
  } finally {
    await s.close();
  }
});

test("a message that breaks the contract closes with 1007 and says why; so does one that is not JSON", async () => {
  const s = await served(chat());
  try {
    const a = new WebSocket(`${s.url}/rooms/a?name=x`);
    await opened(a);
    const endA = closed(a);
    a.send(JSON.stringify({ type: "say", text: "x".repeat(30) }));
    const ca = await endA;
    assert.equal(ca.code, 1007);
    assert.match(ca.reason, /text/);

    const b = new WebSocket(`${s.url}/rooms/a?name=x`);
    await opened(b);
    const endB = closed(b);
    b.send("not json");
    assert.deepEqual(await endB, { code: 1007, reason: "the message is not JSON" });

    const c = await raw(s.port, "/rooms/a?name=x");
    await c.next(); // joined
    c.send(0x2, Buffer.from([1, 2, 3]));
    assert.equal((closeCode(await c.next()) as { code: number }).code, 1003, "binary where the contract wants JSON");
  } finally {
    await s.close();
  }
});

test("a message larger than maxMessage closes with 1009, fragments counted together", async () => {
  const app = inkan(quiet).ws("/big", { maxMessage: 16 }, (socket) => socket.on("message", (m) => void socket.sendRaw(m)));
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/big`);
    await opened(ws);
    const end = closed(ws);
    ws.send("x".repeat(17));
    assert.equal((await end).code, 1009);

    const r = await raw(s.port, "/big");
    r.send(0x1, "x".repeat(10), { fin: false });
    r.send(0x0, "x".repeat(10));
    assert.equal((closeCode(await r.next()) as { code: number }).code, 1009);
  } finally {
    await s.close();
  }
});

test("without a contract, text arrives as a string and binary as a Buffer; big messages both ways", async () => {
  const seen: unknown[] = [];
  const app = inkan(quiet).ws("/echo", {}, (socket) =>
    socket.on("message", (m) => {
      seen.push(typeof m === "string" ? "string" : Buffer.isBuffer(m) ? "buffer" : typeof m);
      void socket.sendRaw(m);
    }),
  );
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/echo`);
    ws.binaryType = "arraybuffer";
    const next = inbox(ws);
    await opened(ws);
    ws.send("plain text");
    assert.equal(await next(), "plain text");
    ws.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual([...new Uint8Array((await next()) as ArrayBuffer)], [1, 2, 3]);
    const big = "y".repeat(200_000); // a 64-bit length both ways
    ws.send(big);
    assert.equal(((await next()) as string).length, 200_000);
    assert.deepEqual(seen, ["string", "buffer", "string"]);
    ws.close();
  } finally {
    await s.close();
  }
});

test("fragments are put together, with a ping between them answered by a pong", async () => {
  const app = inkan(quiet).ws("/echo", {}, (socket) => socket.on("message", (m) => void socket.sendRaw(m)));
  const s = await served(app);
  try {
    const r = await raw(s.port, "/echo");
    r.send(0x1, "hel", { fin: false });
    r.send(0x9, "are you there");
    r.send(0x0, "lo ", { fin: false });
    r.send(0x0, "wörld");
    const pong = await r.next();
    assert.equal(pong?.op, 0xa);
    assert.equal(pong?.payload.toString(), "are you there");
    const msg = await r.next();
    assert.equal(msg?.op, 0x1);
    assert.equal(msg?.payload.toString(), "hello wörld");

    // a character split across two fragments is still one character
    const e = Buffer.from("é");
    r.send(0x1, e.subarray(0, 1), { fin: false });
    r.send(0x0, e.subarray(1));
    assert.equal((await r.next())?.payload.toString(), "é");

    r.send(0x1, Buffer.from([0xff, 0xfe]));
    assert.equal((closeCode(await r.next()) as { code: number }).code, 1007, "text that is not UTF-8");
  } finally {
    await s.close();
  }
});

test("protocol errors close with 1002: unmasked frames, a stray continuation, a fragmented ping, a bad close code", async () => {
  const app = inkan(quiet).ws("/x", {}, () => {});
  const s = await served(app);
  try {
    const cases: [string, (r: Raw) => void][] = [
      ["unmasked", (r) => r.send(0x1, "hi", { mask: false })],
      ["continuation", (r) => r.send(0x0, "hi")],
      ["fragmented ping", (r) => r.send(0x9, "hi", { fin: false })],
      ["opcode 3", (r) => r.send(0x3, "hi")],
      ["close code 1005", (r) => r.send(0x8, Buffer.from([0x03, 0xed]))],
    ];
    for (const [name, act] of cases) {
      const r = await raw(s.port, "/x");
      act(r);
      assert.equal((closeCode(await r.next()) as { code: number }).code, 1002, name);
      assert.equal(await r.next(), null, `${name}: the server ends the connection`);
    }
  } finally {
    await s.close();
  }
});

test("close codes: the client's comes to the server and is echoed; the server's reaches the client", async () => {
  let got: [number, string] | undefined;
  const app = inkan(quiet)
    .ws("/hear", {}, (socket) => socket.on("close", (code, reason) => (got = [code, reason])))
    .ws("/kick", {}, (socket) => socket.close(4001, "go away"));
  const s = await served(app);
  try {
    const r = await raw(s.port, "/hear");
    const payload = Buffer.alloc(5);
    payload.writeUInt16BE(4002, 0);
    payload.write("bye", 2);
    r.send(0x8, payload);
    assert.equal((closeCode(await r.next()) as { code: number }).code, 4002, "echoed");
    assert.equal(await r.next(), null);
    await sleep(20);
    assert.deepEqual(got, [4002, "bye"]);

    const ws = new WebSocket(`${s.url}/kick`);
    assert.deepEqual(await closed(ws), { code: 4001, reason: "go away" });
  } finally {
    await s.close();
  }
});

test("heartbeat: a peer that answers pings stays, one that does not is cut off", async () => {
  const app = inkan(quiet).ws("/hb", { heartbeat: 30 }, (socket) => socket.on("message", (m) => void socket.sendRaw(m)));
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/hb`); // answers pings by itself
    const next = inbox(ws);
    await opened(ws);
    await sleep(150);
    ws.send('"still here"');
    assert.equal(await next(), "still here");
    ws.close();

    const r = await raw(s.port, "/hb"); // never answers
    assert.equal((await r.next())?.op, 0x9, "the server pings");
    assert.equal(await r.next(500), null, "and hangs up without a pong");
  } finally {
    await s.close();
  }
});

// ---------- the upgrade request is a request ----------

test("security, hooks and input checks answer the upgrade with their status before any socket", async () => {
  const app = inkan(quiet)
    .ws("/secure", { security: "bearer" }, (socket) => void socket.sendRaw("in"))
    .ws("/q", { query: t.object({ n: t.int() }) }, () => {});
  app.onRequest((ctx) => {
    if (ctx.rawHeaders.authorization === "Bearer banned") return ctx.reply(403 as never, { no: true } as never);
  });
  const s = await served(app);
  try {
    const upgrade = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
        const req = request(`${s.http}${path}`, {
          headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers },
        });
        req.on("response", (res) => {
          let body = "";
          res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
        });
        req.on("upgrade", (res, sock) => (sock.destroy(), resolve({ status: 101, body: "", headers: res.headers })));
        req.on("error", reject);
        req.end();
      });

    const no = await upgrade("/secure");
    assert.equal(no.status, 401);
    assert.equal(JSON.parse(no.body).type, "unauthorized");
    assert.equal(no.headers["www-authenticate"], "Bearer");
    assert.equal((await upgrade("/secure", { authorization: "Bearer banned" })).status, 403);
    assert.equal((await upgrade("/secure", { authorization: "Bearer good" })).status, 101);
    assert.equal((await upgrade("/q?n=abc")).status, 400);
    assert.equal((await upgrade("/q?n=1")).status, 101);
    assert.equal((await upgrade("/nowhere")).status, 404);
    assert.equal((await upgrade("/q?n=1", { "sec-websocket-version": "8" })).status, 426);
    assert.equal((await upgrade("/q?n=1", { "sec-websocket-key": "short" })).status, 400);

    // Node's WebSocket takes headers: the bearer token goes with the upgrade
    const ws = new WebSocket(`${s.url}/secure`, { headers: { authorization: "Bearer t" } } as never);
    const next = inbox(ws);
    await opened(ws);
    assert.equal(await next(), "in");
    ws.close();
  } finally {
    await s.close();
  }
});

test("a plain request to a WebSocket path is a 426; HTTP routes beside it are untouched", async () => {
  const app = inkan(quiet)
    .ws("/live", {}, () => {})
    .get("/live/info", () => ({ ok: true }));
  const res = await app.inject({ url: "/live" });
  assert.equal(res.status, 426);
  assert.equal(res.headers.upgrade, "websocket");
  assert.equal(res.body.type, "upgrade-required");
  assert.equal((await app.inject({ url: "/live/info" })).status, 200);
  assert.equal((await app.inject({ method: "WS", url: "/live" })).status, 426, "no socket, no upgrade");
});

test("an app without WebSocket routes does not listen for upgrades at all", async () => {
  const s = await served(inkan(quiet).get("/", () => "hi"));
  try {
    assert.equal(s.server.listenerCount("upgrade"), 0);
  } finally {
    await s.close();
  }
});

// ---------- the handler ----------

test("messages wait for a handler that listens late; the iterator reads them; ctx.signal aborts on close", async () => {
  let aborted = false;
  const app = inkan(quiet).ws("/late", { message: t.object({ n: t.int() }), send: t.object({ sum: t.int() }) }, async (socket, ctx) => {
    ctx.signal.addEventListener("abort", () => (aborted = true));
    await sleep(50); // the client sends before anybody listens
    let sum = 0;
    for await (const m of socket) {
      sum += m.n;
      if (sum >= 6) await socket.send({ sum });
    }
  });
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/late`);
    const next = inbox(ws);
    await opened(ws);
    for (const n of [1, 2, 3]) ws.send(JSON.stringify({ n }));
    assert.deepEqual(await next(), { sum: 6 });
    const end = closed(ws);
    ws.close(1000);
    await end;
    await sleep(20);
    assert.equal(aborted, true);
  } finally {
    await s.close();
  }
});

test("in development a message that breaks `send` throws: reported, and the socket closes with 1011", async () => {
  const errors: unknown[] = [];
  const app = inkan({ ...quiet, onError: (e) => void errors.push(e) }).ws("/bad", { send: t.object({ n: t.int() }) }, (socket) => {
    socket.send({ n: "one" } as never);
  });
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/bad`);
    assert.equal((await closed(ws)).code, 1011);
    assert.match(String(errors[0]), /WS \/bad sent a message that breaks its contract: n/);
  } finally {
    await s.close();
  }
});

test("in production `send` is not checked, but only what the contract lists goes out", async () => {
  const app = inkan({ ...quiet, dev: false }).ws("/out", { send: t.object({ n: t.int() }) }, (socket) => {
    void socket.send({ n: 1, secret: "x" } as never);
  });
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/out`);
    assert.deepEqual(await inbox(ws)(), { n: 1 });
    ws.close();
  } finally {
    await s.close();
  }
});

test("send resolves once the socket can take more, and bufferedAmount says how much waits", async () => {
  let done = false;
  let buffered = -1;
  const app = inkan(quiet).ws("/flood", {}, async (socket) => {
    const chunk = "z".repeat(64 * 1024);
    for (let i = 0; i < 64; i++) await socket.sendRaw(chunk);
    buffered = socket.bufferedAmount;
    done = true;
  });
  const s = await served(app);
  try {
    const ws = new WebSocket(`${s.url}/flood`);
    let count = 0;
    ws.addEventListener("message", () => count++);
    await opened(ws);
    while (count < 64) await sleep(10);
    assert.equal(done, true);
    assert.equal(typeof buffered, "number");
    ws.close();
  } finally {
    await s.close();
  }
});

test("SIGINT/SIGTERM close every open socket with 1001 before the server stops", async () => {
  const app = inkan({ log: false }).ws("/stay", {}, () => {});
  const server = await app.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stay`);
  await opened(ws);
  const exit = process.exit;
  let code: number | undefined;
  (process as any).exit = (c?: number) => void (code = c);
  const log = console.log;
  console.log = () => {};
  try {
    const end = closed(ws);
    process.emit("SIGTERM" as any);
    assert.deepEqual(await end, { code: 1001, reason: "the server is shutting down" });
    for (let i = 0; i < 100 && code === undefined; i++) await sleep(20);
    assert.equal(code, 0);
  } finally {
    (process as any).exit = exit;
    console.log = log;
  }
});

// ---------- the typed client ----------

test("client.ws: typed both ways, messages narrowed by their tag", async () => {
  const api = chat();
  const s = await served(api);
  try {
    const c = client<typeof api>(s.http);
    const room = c.ws("/rooms/:room", { params: { room: "tea" }, query: { name: "ana" } });
    const got: string[] = [];
    room.on("message", (m) => {
      const kind: "said" | "joined" = m.type;
      got.push(`${kind}:${m.text}`);
    });
    await room.ready;
    room.send({ type: "say", text: "hi" });
    for await (const m of room) {
      if (m.type === "said") break;
    }
    assert.deepEqual(got, ["joined:tea", "said:hi"]);

    if (false as boolean) {
      // @ts-expect-error there is no such WebSocket
      c.ws("/nowhere");
      // @ts-expect-error the route needs its params
      c.ws("/rooms/:room", { query: { name: "x" } });
      // @ts-expect-error "shout" is not a message the contract takes
      room.send({ type: "shout", text: "x" });
      // @ts-expect-error a say needs its text
      room.send({ type: "say" });
    }

    const missing = c.ws("/rooms/:room", { params: { room: "x" } }); // no name: a 400, never open
    await assert.rejects(missing.ready, /closed before it opened/);
  } finally {
    await s.close();
  }
});

// ---------- the docs ----------

test("OpenAPI lists a WebSocket as a GET with x-inkan-websocket; beside a GET of its own, on the path item", async () => {
  const app = chat()
    .ws("/feed", {}, () => {})
    .get("/feed", () => "the feed");
  const doc = app.openapi() as any;
  const op = doc.paths["/rooms/{room}"].get;
  assert.equal(op.summary, "A chat room");
  assert.equal(op.operationId, "wsRoomsByRoom");
  assert.ok(op.responses["101"]);
  assert.ok(op.responses["400"], "the upgrade's input is checked");
  assert.deepEqual(op.parameters.map((p: any) => p.name), ["room", "name"]);
  assert.ok(op["x-inkan-websocket"].message.oneOf, "the client's messages, as a discriminated union");
  assert.deepEqual(op["x-inkan-websocket"].send.properties.type, { enum: ["said", "joined"] });
  assert.equal(doc.paths["/feed"].get["x-inkan-websocket"], undefined);
  assert.ok(doc.paths["/feed"]["x-inkan-websocket"]["x-inkan-websocket"]);

  const page = await app.inject({ url: "/docs" });
  assert.match(page.text, /client sends/);
  assert.match(page.text, /m-ws/);
});
