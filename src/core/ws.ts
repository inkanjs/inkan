// WebSockets, RFC 6455, on the socket Node hands over after an upgrade: the handshake, the
// frames (masked from the client, fragmented, text checked as UTF-8), ping and pong, and the
// closing handshake. No extensions: permessage-deflate is not offered, so every frame goes
// as it is.
//
// The route is an ordinary route of the method "WS": the upgrade request goes through the
// router, the hooks, the security and the input checks like a GET, and only once all of
// them let it through does it become a socket. Before all of them come the checks that cost
// nothing: a GET over HTTP/1.1 without a body, a page of an allowed origin, a free slot
// under `maxConnections`; and the whole handshake has `handshakeTimeout` to finish.
//
// Limits: a message has at most `maxMessage` bytes and MAX_FRAGMENTS frames (each frame
// after the first costs FRAME_COST bytes more), text is checked as UTF-8 frame by frame,
// and at most four times `maxMessage` (1 MiB at least) may wait to be written before the
// socket is cut off with 1008. While the peer reads nothing, only its latest ping is answered.
//
// Broadcasting needs no helper, a Set will do (one per process when the app runs `workers`):
//
//   const room = new Set<WsSocket<Infer<typeof Say>, Infer<typeof Said>>>();
//   app.ws("/room", { message: Say, send: Said }, (socket) => {
//     room.add(socket).forEach((s) => void s.send({ type: "joined" }));
//     socket.on("close", () => room.delete(socket));
//     socket.on("message", (m) => room.forEach((s) => void s.send({ type: "said", text: m.text })));
//   });
//
// `app.fetch` (Bun, Deno, serverless) has no WebSockets: those platforms upgrade their own way.

import { createHash } from "node:crypto";
import { Buffer, isUtf8 } from "node:buffer";
import type { Duplex } from "node:stream";
import { problem } from "./problem.ts";
import type { Schema } from "../schema/schema.ts";
import type { Context, DecoOf, Middleware, PathParams, RawHeaders, RawQuery, RouteMeta, Security, WithRoutes } from "./route.ts";

// ---------- the contract ----------

export type WsSpec<P, Q, H, In, Out> = {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  /** Keeps the route out of the docs and the OpenAPI document. */
  hidden?: boolean;
  params?: Schema<P>;
  query?: Schema<Q>;
  headers?: Schema<H>;
  /**
   * What the client sends. With it, every message is JSON checked against it: one that is not
   * JSON or breaks it closes the socket with 1007 and says why. Without it, text arrives as
   * a string and binary as a Buffer.
   */
  message?: Schema<In>;
  /** What the server sends: `socket.send` writes it as JSON, and in development checks it first. */
  send?: Schema<Out>;
  /** Credentials the upgrade request has to carry, as for a route: without them it is a 401 and no socket. */
  security?: Security | Security[] | false;
  /** Middleware for the upgrade request. It runs after the input was validated. */
  use?: Middleware[];
  meta?: RouteMeta;
  /**
   * The most bytes one message may have, fragments together, each fragment after the first
   * counted 64 bytes more; a message comes in at most 1024 frames. Past either the socket
   * closes with 1009. Four times this (1 MiB at least) may wait to be written before the
   * socket is cut off with 1008. Default 1 MiB.
   */
  maxMessage?: number;
  /** Milliseconds between pings; a peer that has not answered the last one by the next is cut off. Default 30 000, false for none. */
  heartbeat?: number | false;
  /**
   * The pages that may open the socket, by the Origin header browsers send. Default (or the
   * app's `wsOrigins`): only the app's own origin (the Host header and `ctx.protocol`), and
   * requests without an Origin, which are not browsers. A list adds those origins to the own
   * one; a function decides alone (its `ctx` is the request before hooks and input checks:
   * headers, protocol, path); `"*"` lets every page in. Anything else is a 403
   * `origin-not-allowed` before any hook runs, so another site cannot open the socket with
   * the user's cookies (cross-site WebSocket hijacking).
   */
  origins?: WsOrigins;
  /** The most sockets this route holds open at once, handshakes on the way counted; past it the upgrade is a 503. Default: no limit. */
  maxConnections?: number;
  /** Milliseconds the upgrade request has to get its answer (hooks, security, middleware) before the connection is cut. Default 10 000. */
  handshakeTimeout?: number;
};

/** Which pages may open a WebSocket: see `WsSpec.origins`. */
export type WsOrigins = string[] | "*" | ((origin: string | undefined, ctx: Context<any, any, any, any, any>) => boolean);

/** The socket a WebSocket route's handler gets. `In` is what the client sends, `Out` what the server does. */
export interface WsSocket<In = string | Buffer, Out = unknown> extends AsyncIterable<In> {
  /** 1 while open, 2 while closing, 3 once closed. */
  readonly readyState: 0 | 1 | 2 | 3;
  /** Bytes written but not yet handed to the network. */
  readonly bufferedAmount: number;
  /**
   * Sends a value as JSON. It resolves once the socket can take more, so `await` it in a loop
   * that sends a lot. On a socket that is closing it does nothing. In development a value that
   * breaks the route's `send` contract throws.
   */
  send(value: Out): Promise<void>;
  /** Sends text or bytes as they are, past the contract. */
  sendRaw(data: string | Uint8Array): Promise<void>;
  /** Starts the closing handshake. Default 1000; a reason has at most 123 bytes. */
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (message: In) => void): this;
  on(event: "close", fn: (code: number, reason: string) => void): this;
  on(event: "error", fn: (error: Error) => void): this;
  off(event: "message" | "close" | "error", fn: (...args: any[]) => void): this;
}

export type WsHandler<P, Q, H, In, Out, Deco = {}> = (socket: WsSocket<In, Out>, ctx: Context<P, Q, undefined, H, {}> & Deco) => unknown;

export type WsMethod<Self> = <Path extends string, P = PathParams<Path>, Q = RawQuery, H = RawHeaders, In = string | Buffer, Out = unknown>(
  path: Path,
  spec: WsSpec<P, Q, H, In, Out>,
  handler: WsHandler<P, Q, H, In, Out, DecoOf<Self>>,
) => WithRoutes<Self, { [K in `WS ${Path}`]: { params: P; query: Q; body: undefined; headers: H; response: {}; message: In; send: Out } }>;

// ---------- the handshake ----------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const acceptKey = (key: string) => createHash("sha1").update(key + GUID).digest("base64");

/** Whether a sec-websocket-key is 16 bytes in canonical base64: decoded and encoded again, it is the same text. */
export const canonicalKey = (key: unknown): key is string =>
  typeof key === "string" && key.length === 24 && Buffer.from(key, "base64").toString("base64") === key;

/**
 * Whether the page an upgrade comes from may open the socket. `own` is the app's origin as the
 * request names it (scheme and Host). Origins are compared as URL origins, so `http://X:80`
 * is `http://x`.
 */
export function originAllowed(rule: WsOrigins | undefined, origin: string | undefined, own: () => string, ctx: () => Context<any, any, any, any, any>): boolean {
  if (rule === "*") return true;
  if (typeof rule === "function") return rule(origin, ctx()) === true;
  if (origin === undefined) return true; // not a browser: no cookies of somebody else's to ride on
  const o = originOf(origin);
  if (!o) return false; // "null", or not a URL
  if (o === originOf(own())) return true;
  return Array.isArray(rule) && rule.some((r) => originOf(r) === o);
}

function originOf(s: string): string | undefined {
  try {
    const o = new URL(s).origin;
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

/** Marks an IncomingMessage that came in through the upgrade event; the route's acceptor finds it there. */
export const UPGRADING = Symbol("inkan.upgrading");
export type Upgrading = { ctx?: Context<any, any, any, any, any> };

/** What a WebSocket route runs as its handler: the request may become a socket. The answer is a 101 with no body. */
export function acceptor(ctx: Context<any, any, any, any, any>): undefined {
  const req = ctx.req as (Record<symbol, Upgrading | undefined> & { headers: Record<string, string | string[] | undefined> }) | undefined;
  const state = req?.[UPGRADING];
  const h = req?.headers ?? {};
  // strict on purpose: the header is "websocket" and nothing else, not a list to pick from
  if (!state || String(h.upgrade).toLowerCase() !== "websocket") {
    const p = problem(426, "upgrade-required", `${ctx.path} is a WebSocket: open it with an upgrade to websocket`);
    p.headers.upgrade = "websocket";
    throw p;
  }
  if (ctx.method !== "GET") throw problem(400, "bad-handshake", "A WebSocket handshake is a GET");
  if (h["sec-websocket-version"] !== "13") {
    const p = problem(426, "upgrade-required", "This server speaks WebSocket version 13");
    p.headers["sec-websocket-version"] = "13";
    throw p;
  }
  const key = h["sec-websocket-key"];
  if (!canonicalKey(key)) throw problem(400, "bad-handshake", "sec-websocket-key is not 16 bytes in base64");
  state.ctx = ctx;
  ctx.status(101);
  return undefined;
}

// ---------- frames ----------

const CONTINUATION = 0x0;
const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

/** The codes a close frame may carry on the wire (RFC 6455 7.4, and the registry). */
export const validCode = (c: number) => (c >= 1000 && c <= 1014 && c !== 1004 && c !== 1005 && c !== 1006) || (c >= 3000 && c <= 4999);

function frame(op: number, payload: Buffer): Buffer[] {
  const len = payload.length;
  const head = Buffer.allocUnsafe(len < 126 ? 2 : len < 65536 ? 4 : 10);
  head[0] = 0x80 | op; // FIN, no extension bits
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  return len < 4096 ? [Buffer.concat([head, payload], head.length + len)] : [head, payload];
}

/** A reason cut to the 123 bytes a close frame has room for, without splitting a character. */
function reasonBytes(reason: string): Buffer {
  let b = Buffer.from(reason);
  if (b.length <= 123) return b;
  let end = 123;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--; // back to the start of a character
  return b.subarray(0, end);
}

/** Bytes of their own: a message that is a view into a socket's chunk would keep the whole chunk alive. */
function own(b: Buffer): Buffer {
  if (b.byteOffset === 0 && b.buffer.byteLength === b.length) return b;
  const copy = Buffer.allocUnsafeSlow(b.length);
  b.copy(copy);
  return copy;
}

/** An issue's rule without the value the client sent ("expected an integer, got ..."): a close reason echoes no input. */
const withoutValue = (message: string) => {
  const i = message.indexOf(", got ");
  return i < 0 ? message : message.slice(0, i);
};

/** Bytes as they arrive, taken off the front in the sizes the frames ask for. */
class Bytes {
  chunks: Buffer[] = [];
  size = 0;
  push(b: Buffer) {
    if (!b.length) return;
    this.chunks.push(b);
    this.size += b.length;
  }
  at(i: number): number {
    for (const c of this.chunks) {
      if (i < c.length) return c[i]!;
      i -= c.length;
    }
    return 0;
  }
  take(n: number): Buffer {
    this.size -= n;
    const first = this.chunks[0]!;
    if (n === first.length) return this.chunks.shift()!;
    if (n < first.length) {
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const want = n - at;
      if (c.length <= want) {
        c.copy(out, at);
        at += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, at, 0, want);
        this.chunks[0] = c.subarray(want);
        at += want;
      }
    }
    return out;
  }
}

export type SocketOptions = {
  maxMessage: number;
  heartbeat: number | false;
  message?: Schema<any>;
  send?: Schema<any>;
  /** Whether `send` checks what goes out against the contract: development. */
  check: boolean;
  /** `WS /path`, for the messages of a broken contract. */
  label: string;
  /** Where an error of the handler or a listener goes. */
  report: (err: unknown) => void;
};

const CLOSE_WAIT = 3000; // ms the client has to answer a close frame before the socket is cut
const HOLD = 16; // messages kept for a handler that does not listen yet, before reading pauses
/** The most frames one message may come in; past it the socket closes with 1009. Not an option. */
export const MAX_FRAGMENTS = 1024;
/** What each frame after a message's first costs against `maxMessage`, on top of its bytes: empty frames are not free. */
const FRAME_COST = 64;
/** The least the write buffer may hold before a socket is cut off with 1008; otherwise four times `maxMessage`. */
const MIN_BUFFER = 1024 * 1024;

type Listeners = { message: ((m: any) => void)[]; close: ((code: number, reason: string) => void)[]; error: ((e: Error) => void)[] };

/** One WebSocket connection, server side. */
export class Connection implements WsSocket<any, any> {
  readyState: 0 | 1 | 2 | 3 = 1;
  private socket: Duplex;
  private o: SocketOptions;
  private write?: (v: unknown) => string;
  private bytes = new Bytes();
  private listeners: Listeners = { message: [], close: [], error: [] };
  /** Messages that came before anybody listened. */
  private held: unknown[] = [];
  // the frame being read
  private head = true;
  private fin = false;
  private op = 0;
  private len = 0;
  private mask?: Buffer;
  // the message being put together from fragments
  private parts: Buffer[] = [];
  private partsOp = 0;
  private partsSize = 0;
  private frames = 0;
  /** A fragmented text message, decoded as it comes so bad UTF-8 is caught at once. */
  private decoder?: TextDecoder;
  private texts: string[] = [];
  /** The payload of the latest ping not yet answered, while the socket cannot take more. */
  private pong?: Buffer;
  /** The most bytes waiting to be written before the socket is cut off. */
  private bufferCap: number;
  private alive = true;
  private pinger?: ReturnType<typeof setInterval>;
  private closer?: ReturnType<typeof setTimeout>;
  private sentClose = false;
  /** Set once nothing more is read: the peer broke the protocol, or its close frame came. */
  private stopped = false;
  private code = 1006;
  private reason = "";
  /** Resolves once the TCP connection is gone. */
  closed: Promise<void>;

  constructor(socket: Duplex, options: SocketOptions) {
    this.socket = socket;
    this.o = options;
    this.bufferCap = Math.max(4 * options.maxMessage, MIN_BUFFER);
    if (options.send) this.write = options.send._serializer();
    let done!: () => void;
    this.closed = new Promise((r) => (done = r));
    socket.on("close", () => {
      this.readyState = 3;
      clearInterval(this.pinger);
      clearTimeout(this.closer);
      done();
      for (const fn of this.listeners.close.slice()) this.guard(() => fn(this.code, this.reason));
    });
    // the peer ended its side without a close frame (the server socket allows half-open): end ours too
    socket.on("end", () => this.socket.end());
    socket.on("error", (err: Error) => {
      for (const fn of this.listeners.error.slice()) this.guard(() => fn(err));
    });
  }

  /** Starts reading: the bytes that came with the upgrade request first, then the socket. */
  start(head: Buffer) {
    const s = this.socket as Duplex & { setNoDelay?: (on: boolean) => void; setTimeout?: (ms: number) => void };
    s.setNoDelay?.(true);
    s.setTimeout?.(0);
    if (this.o.heartbeat) {
      this.pinger = setInterval(() => {
        if (!this.alive) return void this.socket.destroy(); // no pong since the last ping: 1006
        this.alive = false;
        this.raw(PING, Buffer.alloc(0));
      }, this.o.heartbeat);
      this.pinger.unref();
    }
    this.socket.on("data", (b: Buffer) => this.read(b));
    if (head.length) this.read(head);
  }

  get bufferedAmount(): number {
    return (this.socket as Duplex & { writableLength: number }).writableLength;
  }

  on(event: "message" | "close" | "error", fn: (...args: any[]) => void): this {
    (this.listeners[event] as unknown[]).push(fn);
    if (event === "message" && this.held.length) queueMicrotask(() => this.flush());
    return this;
  }

  off(event: "message" | "close" | "error", fn: (...args: any[]) => void): this {
    const list = this.listeners[event] as unknown[];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  send(value: unknown): Promise<void> {
    let text: string;
    if (this.write) {
      const contract = this.o.send!;
      if (this.o.check) {
        const r = contract.safeParse(value);
        if (!r.ok) {
          const lines = r.issues.map((i) => `${i.path || "(message)"} ${i.message}`).join("; ");
          throw new Error(`inkan: ${this.o.label} sent a message that breaks its contract: ${lines}`);
        }
        value = r.value;
      }
      text = this.write(value);
    } else text = JSON.stringify(value) ?? "null";
    return this.raw(TEXT, Buffer.from(text));
  }

  sendRaw(data: string | Uint8Array): Promise<void> {
    return typeof data === "string" ? this.raw(TEXT, Buffer.from(data)) : this.raw(BINARY, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  close(code = 1000, reason = ""): void {
    if (!validCode(code)) throw new RangeError(`${code} is not a close code a socket may send`);
    if (this.readyState !== 1) return;
    this.code = code;
    this.reason = reason;
    this.sendClose(code, reason);
    this.closer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT);
    this.closer.unref();
  }

  /** Breaks the connection off for something the peer did: the close frame, then the end, without waiting. */
  private fail(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.code = code;
    this.reason = reason;
    this.stopped = true;
    this.bytes = new Bytes();
    this.parts = [];
    this.texts = [];
    this.sendClose(code, reason);
    this.socket.end();
    this.closer ??= setTimeout(() => this.socket.destroy(), CLOSE_WAIT);
    this.closer.unref();
  }

  private sendClose(code: number, reason: string) {
    if (this.sentClose) return;
    this.sentClose = true;
    this.readyState = 2;
    const r = reasonBytes(reason);
    const payload = Buffer.allocUnsafe(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.put(CLOSE, payload);
  }

  /** A frame out; resolves once the socket can take more. */
  private raw(op: number, payload: Buffer): Promise<void> {
    if (this.readyState !== 1) return Promise.resolve();
    return this.put(op, payload) ? Promise.resolve() : this.drained();
  }

  private put(op: number, payload: Buffer): boolean {
    const s = this.socket;
    if (s.destroyed || !s.writable) return true;
    if (this.sentClose && op !== CLOSE) return true; // nothing goes out after our close frame
    if ((s as Duplex & { writableLength: number }).writableLength > this.bufferCap) {
      // the peer does not read, or the handler writes without waiting: cut it off
      this.code = 1008;
      this.reason = "too much is waiting to be written";
      this.readyState = 2;
      s.destroy();
      return true;
    }
    const parts = frame(op, payload);
    if (parts.length === 1) return s.write(parts[0]);
    s.cork();
    s.write(parts[0]);
    const ok = s.write(parts[1]);
    s.uncork();
    return ok;
  }

  private drained(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.socket.off("drain", done).off("close", done);
        resolve();
      };
      this.socket.on("drain", done).on("close", done);
    });
  }

  /** Runs a listener; one that throws is reported and closes the socket with 1011. */
  private guard(fn: () => unknown) {
    try {
      const v = fn();
      if (v instanceof Promise) v.catch((err) => this.broke(err));
    } catch (err) {
      this.broke(err);
    }
  }

  /** @internal The handler or a listener threw. */
  broke(err: unknown) {
    this.o.report(err);
    if (this.readyState === 1) this.close(1011, "internal error");
  }

  // ----- reading -----

  private read(chunk: Buffer) {
    if (this.stopped) return;
    this.alive = true;
    const b = this.bytes;
    b.push(chunk);
    for (;;) {
      if (this.head) {
        if (b.size < 2) return;
        const b0 = b.at(0);
        const b1 = b.at(1);
        const len7 = b1 & 0x7f;
        const masked = (b1 & 0x80) !== 0;
        const need = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (masked ? 4 : 0);
        if (b.size < need) return;
        const head = b.take(need);
        this.fin = (b0 & 0x80) !== 0;
        this.op = b0 & 0x0f;
        if (b0 & 0x70) return this.fail(1002, "reserved bits are set, and no extension was agreed");
        if (!masked) return this.fail(1002, "frames from a client must be masked");
        let len = len7;
        if (len7 === 126) len = head.readUInt16BE(2);
        else if (len7 === 127) {
          const hi = head.readUInt32BE(2);
          if (hi > 0x1fffff) return this.fail(1009, "the frame is too large");
          len = hi * 2 ** 32 + head.readUInt32BE(6);
        }
        this.mask = head.subarray(need - 4, need);
        const op = this.op;
        if (op >= 0x8) {
          if (op !== CLOSE && op !== PING && op !== PONG) return this.fail(1002, `unknown opcode ${op}`);
          if (!this.fin) return this.fail(1002, "a control frame cannot be fragmented");
          if (len > 125) return this.fail(1002, "a control frame has at most 125 bytes");
        } else {
          if (op !== CONTINUATION && op !== TEXT && op !== BINARY) return this.fail(1002, `unknown opcode ${op}`);
          if (op === CONTINUATION && !this.partsOp) return this.fail(1002, "a continuation without a message to continue");
          if (op !== CONTINUATION && this.partsOp) return this.fail(1002, "a new message before the last one ended");
          const frames = op === CONTINUATION ? this.frames + 1 : 1;
          if (frames > MAX_FRAGMENTS) return this.fail(1009, `a message may come in at most ${MAX_FRAGMENTS} frames`);
          if (this.partsSize + len + (frames - 1) * FRAME_COST > this.o.maxMessage) return this.fail(1009, `messages may have at most ${this.o.maxMessage} bytes`);
        }
        this.len = len;
        this.head = false;
      }
      if (b.size < this.len) return;
      const payload = this.len ? b.take(this.len) : Buffer.alloc(0);
      const mask = this.mask!;
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.head = true;
      this.frameIn(payload);
      if (this.stopped) return; // what is left is not read
    }
  }

  private frameIn(payload: Buffer) {
    const op = this.op;
    if (op === PING) return this.pingIn(payload);
    if (op === PONG) return;
    if (op === CLOSE) return this.closeIn(payload);
    if (this.sentClose) return; // closing: data is no longer delivered
    if (op !== CONTINUATION) {
      if (this.fin) return this.message(op, payload); // one frame, the usual case
      this.partsOp = op;
      this.frames = 0;
      if (op === TEXT) this.decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    }
    this.frames++;
    this.partsSize += payload.length;
    if (this.decoder) {
      let text: string;
      try {
        text = this.decoder.decode(payload, { stream: !this.fin }); // a character split across frames waits for its rest
      } catch {
        return this.fail(1007, "a text message that is not valid UTF-8");
      }
      if (text) this.texts.push(text);
    } else if (payload.length) this.parts.push(payload);
    if (!this.fin) return;
    const kind = this.partsOp;
    const whole = this.decoder ? this.texts.join("") : this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.partsSize);
    this.parts = [];
    this.texts = [];
    this.decoder = undefined;
    this.partsOp = 0;
    this.partsSize = 0;
    this.frames = 0;
    this.message(kind, whole);
  }

  /** A ping is answered with a pong; while the socket cannot take more, only the latest one is. */
  private pingIn(payload: Buffer) {
    if (this.sentClose) return;
    const s = this.socket as Duplex & { writableNeedDrain?: boolean };
    if (!s.writableNeedDrain) return void this.put(PONG, payload);
    const waiting = this.pong !== undefined;
    this.pong = Buffer.from(payload);
    if (waiting) return;
    s.once("drain", () => {
      const p = this.pong;
      this.pong = undefined;
      if (p) this.put(PONG, p);
    });
  }

  private closeIn(payload: Buffer) {
    let code = 1005;
    let reason = "";
    if (payload.length === 1) return this.fail(1002, "a close frame with one byte");
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCode(code)) return this.fail(1002, `${code} is not a valid close code`);
      const r = payload.subarray(2);
      if (!isUtf8(r)) return this.fail(1007, "the close reason is not valid UTF-8");
      reason = r.toString();
    }
    if (!this.sentClose) {
      // the client began: answer with its code, and the server ends the TCP connection
      this.code = code;
      this.reason = reason;
      this.sentClose = true;
      this.readyState = 2;
      const echo = Buffer.allocUnsafe(payload.length >= 2 ? 2 : 0);
      if (echo.length) echo.writeUInt16BE(code, 0);
      this.put(CLOSE, echo);
    }
    this.stopped = true;
    this.bytes = new Bytes();
    this.socket.end();
  }

  private message(kind: number, data: Buffer | string) {
    let value: unknown;
    if (typeof data === "string") value = data; // decoded frame by frame already
    else if (kind === TEXT) {
      if (!isUtf8(data)) return this.fail(1007, "a text message that is not valid UTF-8");
      value = data.toString();
    } else value = own(data);
    const contract = this.o.message;
    if (contract) {
      if (kind !== TEXT) return this.fail(1003, "messages are JSON text, not binary");
      try {
        value = JSON.parse(value as string);
      } catch {
        return this.fail(1007, "the message is not JSON");
      }
      const r = contract.safeParse(value);
      if (!r.ok) return this.fail(1007, r.issues.map((i) => `${i.path || "(message)"} ${withoutValue(i.message)}`).join("; "));
      value = r.value;
    }
    if (!this.listeners.message.length || this.held.length) {
      this.held.push(value);
      if (this.held.length >= HOLD) this.socket.pause();
      return;
    }
    this.deliver(value);
  }

  private deliver(value: unknown) {
    for (const fn of this.listeners.message.slice()) this.guard(() => fn(value));
  }

  private flush() {
    while (this.held.length && this.listeners.message.length) this.deliver(this.held.shift());
    if (!this.held.length && this.socket.isPaused()) this.socket.resume();
  }

  /** The messages as they come, until the socket closes. Reading pauses while too many wait for the loop. */
  [Symbol.asyncIterator](): AsyncIterator<any> {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = this.readyState === 3;
    const onMessage = (m: unknown) => {
      queue.push(m);
      if (queue.length >= HOLD) this.socket.pause();
      wake?.();
    };
    const onClose = () => {
      ended = true;
      wake?.();
    };
    const stop = () => {
      this.off("message", onMessage).off("close", onClose);
      ended = true;
    };
    this.on("message", onMessage).on("close", onClose);
    return {
      next: async () => {
        while (!queue.length && !ended) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        if (queue.length) {
          const value = queue.shift();
          if (queue.length < HOLD && this.socket.isPaused() && !this.held.length) this.socket.resume();
          return { value, done: false };
        }
        stop();
        return { value: undefined, done: true };
      },
      return: async () => {
        stop();
        return { value: undefined, done: true };
      },
    };
  }
}

// ---------- the 101 and the answers that are not one ----------

const SAFE_HEADER = /^[^\r\n]*$/;

/** An answer written straight onto the socket, for an upgrade that did not become one; then the connection ends. */
export function writeAnswer(socket: Duplex, status: number, reasonPhrase: string, headers: Record<string, string>, cookies: string[] = [], body?: string | Buffer) {
  if (socket.destroyed) return;
  const bytes = body === undefined ? undefined : Buffer.from(body);
  const lines = [`HTTP/1.1 ${status} ${reasonPhrase}`];
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name === "content-length" || name === "connection" || name === "transfer-encoding") continue;
    if (SAFE_HEADER.test(k) && SAFE_HEADER.test(String(v))) lines.push(`${k}: ${v}`);
  }
  for (const c of cookies) if (SAFE_HEADER.test(c)) lines.push(`set-cookie: ${c}`);
  lines.push(`content-length: ${bytes?.length ?? 0}`, "connection: close", "", "");
  socket.end(bytes ? Buffer.concat([Buffer.from(lines.join("\r\n")), bytes]) : lines.join("\r\n"));
}

/** The 101 that makes the request a socket: the answer's own headers (request id, cookies) go with it. */
export function writeSwitch(socket: Duplex, key: string, headers: Record<string, string>, cookies: string[] = []) {
  const lines = ["HTTP/1.1 101 Switching Protocols", "upgrade: websocket", "connection: Upgrade", `sec-websocket-accept: ${acceptKey(key)}`];
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name === "content-length" || name === "content-type" || name === "connection" || name === "upgrade" || name === "sec-websocket-accept" || name === "transfer-encoding") continue;
    if (SAFE_HEADER.test(k) && SAFE_HEADER.test(String(v))) lines.push(`${k}: ${v}`);
  }
  for (const c of cookies) if (SAFE_HEADER.test(c)) lines.push(`set-cookie: ${c}`);
  lines.push("", "");
  socket.write(lines.join("\r\n"));
}
