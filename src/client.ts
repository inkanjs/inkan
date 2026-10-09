// A typed client for an inkan app, with no code generation: its types come from
// the app itself. At runtime it is a small wrapper around fetch and holds none
// of the server, so it runs in a browser, in Node, anywhere fetch does.
//
//   import type { api } from "./server.ts";
//   import { client } from "@vxnsin/inkan/client";
//
//   const shop = client<typeof api>(baseUrl);
//   const res = await shop.get("/teas/:id", { params: { id: 1 } });
//   if (res.ok) res.data.name; // typed from the contract
//   else res.problem.detail;   // every error is a problem document

import type { Responses, RouteDef, Routes } from "./core/route.ts";
import type { ProblemBody } from "./core/problem.ts";
import type { EventsSchema, Infer } from "./schema/schema.ts";
import { parseEvents } from "./core/sse.ts";

type DefsOf<A> = A extends Routes<infer D> ? D : never;

/** What a value looks like after a trip through JSON: a Date arrives as a string. */
export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

type PathsOf<D, M extends string> = { [K in keyof D & string]: K extends `${M} ${infer P}` ? P : never }[keyof D & string];

// Read one part of a route without intersecting it with RouteDef: that would bring in the
// index signature of Responses and blur every status into `number`.
type Field<R, K extends keyof RouteDef> = R extends { [P in K]: infer V } ? V : unknown;
type DefAt<D, K> = K extends keyof D ? D[K] : never;

type ParamsInput<P> = keyof P extends never ? { params?: undefined } : { params: P };
/** What a body taken as it comes (`t.binary()`, `t.stream()`) is sent as: bytes, as they are. */
export type RawBody = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
type BodyInput<B> = unknown extends B
  ? { body?: unknown }
  : [B] extends [undefined]
    ? { body?: undefined }
    : [B] extends [Uint8Array | AsyncIterable<Uint8Array>]
      ? { body: RawBody }
      : { body: B | FormData };
export type Input<R> = ParamsInput<Field<R, "params">> &
  BodyInput<Field<R, "body">> & { query?: Partial<Field<R, "query">>; headers?: Record<string, string> };
type InputArgs<R> = {} extends Input<R> ? [input?: Input<R>] : [input: Input<R>];

type Success = 200 | 201 | 202 | 203 | 204 | 206 | 207;
type Failure<S, P> = { ok: false; status: S; problem: P; headers: Headers };

/**
 * One answer. `ok` tells success from failure; `status` narrows it further. Every status
 * the contract does not list arrives as a problem too: a 400 for bad input, a 500, a 502
 * from a proxy on the way.
 */
export type Answer<R extends Responses> =
  | ({} extends R
      ? { ok: true; status: number; data: unknown; headers: Headers }
      : {
          [K in keyof R & number]: K extends Success
            ? { ok: true; status: K; data: K extends 204 ? undefined : Jsonify<Infer<R[K]>>; headers: Headers }
            : Failure<K, Jsonify<Infer<R[K]>>>;
        }[keyof R & number])
  | Failure<number, ProblemBody>;

type ResponseOf<X> = X extends { response: infer R extends Responses } ? R : {};

type Call<D, M extends string> = <P extends PathsOf<D, M>>(
  path: P,
  ...input: InputArgs<DefAt<D, `${M} ${P}`>>
) => Promise<Answer<ResponseOf<DefAt<D, `${M} ${P}`>>>>;

/** One event of a stream the contract lists, after a trip through JSON; `event` narrows `data`. */
export type EventOf<R> = R extends { 200: EventsSchema<infer E> }
  ? { [K in keyof E & string]: { event: K; data: Jsonify<Infer<E[K]>>; id?: string } }[keyof E & string]
  : never;
type EventPaths<D> = {
  [K in keyof D & string]: K extends `GET ${infer P}` ? (ResponseOf<D[K]> extends { 200: EventsSchema<any> } ? P : never) : never;
}[keyof D & string];
type EventInput<R> = ParamsInput<Field<R, "params">> & {
  query?: Partial<Field<R, "query">>;
  headers?: Record<string, string>;
  /** Stops reading and closes the stream. Leaving the loop does too. */
  signal?: AbortSignal;
};
type EventArgs<R> = {} extends EventInput<R> ? [input?: EventInput<R>] : [input: EventInput<R>];
type Events<D> = <P extends EventPaths<D>>(path: P, ...input: EventArgs<DefAt<D, `GET ${P}`>>) => AsyncIterable<EventOf<ResponseOf<DefAt<D, `GET ${P}`>>>>;

type WsInput<R> = ParamsInput<Field<R, "params">> & {
  query?: Partial<Field<R, "query">>;
  /** Headers for the upgrade request. Only where the WebSocket takes them (Node); a browser sends none. */
  headers?: Record<string, string>;
};
type WsArgs<R> = {} extends WsInput<R> ? [input?: WsInput<R>] : [input: WsInput<R>];

/**
 * A WebSocket opened with `client.ws`: what it sends is what the route's `message` asks for,
 * what arrives is what its `send` promises, after a trip through JSON.
 */
export type TypedSocket<In, Out> = {
  /** The platform's socket underneath. */
  readonly raw: WebSocket;
  /** Resolves once the socket is open; rejects when it closes before that (a 401, a 404). */
  readonly ready: Promise<void>;
  /** Sends a value as JSON. */
  send(value: In): void;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (message: Jsonify<Out>) => void): TypedSocket<In, Out>;
  on(event: "close", fn: (code: number, reason: string) => void): TypedSocket<In, Out>;
  /** The messages as they come, until the socket closes. Leaving the loop closes it. */
  [Symbol.asyncIterator](): AsyncIterator<Jsonify<Out>>;
};
type WsPaths<D> = PathsOf<D, "WS">;
type Part<R, K extends string> = R extends { [P in K]: infer V } ? V : unknown;
type WsCall<D> = <P extends WsPaths<D>>(
  path: P,
  ...input: WsArgs<DefAt<D, `WS ${P}`>>
) => TypedSocket<Part<DefAt<D, `WS ${P}`>, "message">, Part<DefAt<D, `WS ${P}`>, "send">>;

/** What `client.events` throws when the stream does not open: the status and its problem. */
export class StreamError extends Error {
  status: number;
  problem: ProblemBody;
  constructor(status: number, problem: ProblemBody) {
    super(problem.detail ?? problem.title);
    this.name = "StreamError";
    this.status = status;
    this.problem = problem;
  }
}

export type Client<A> = {
  get: Call<DefsOf<A>, "GET">;
  post: Call<DefsOf<A>, "POST">;
  put: Call<DefsOf<A>, "PUT">;
  patch: Call<DefsOf<A>, "PATCH">;
  delete: Call<DefsOf<A>, "DELETE">;
  /**
   * The events of a route that answers with `t.events(...)`, as they come. A stream that does
   * not open throws a StreamError with its problem.
   *
   *   for await (const e of api.events("/exports/:id/events", { params: { id } }))
   *     if (e.event === "progress") e.data.done;
   */
  events: Events<DefsOf<A>>;
  /**
   * Opens a WebSocket route: `http` becomes `ws`, `https` `wss`. Messages are sent and read
   * as JSON, typed from the route's `message` and `send`.
   *
   *   const room = api.ws("/rooms/:room", { params: { room: "tea" }, query: { name: "ana" } });
   *   room.on("message", (m) => m.type === "said" && show(m.text));
   *   await room.ready;
   *   room.send({ type: "say", text: "hello" });
   */
  ws: WsCall<DefsOf<A>>;
};

export type ClientOptions = {
  /** Another fetch: one with retries, a test double, or undici with a proxy. */
  fetch?: typeof fetch;
  /** Headers for every request, or a function that makes them, e.g. to put in a fresh token. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Another WebSocket class for `client.ws`; default the platform's. */
  WebSocket?: typeof WebSocket;
};

type RawInput = { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> };

function fill(path: string, params: Record<string, unknown> = {}): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":") && !seg.startsWith("*")) return seg;
      const name = seg.slice(1) || "rest";
      if (params[name] === undefined) throw new Error(`${path} needs a value for ${seg}`);
      return seg.startsWith("*") ? String(params[name]) : encodeURIComponent(String(params[name]));
    })
    .join("/");
}

const isRaw = (v: unknown): v is RawBody =>
  v instanceof Blob || v instanceof ArrayBuffer || v instanceof Uint8Array || (typeof ReadableStream !== "undefined" && v instanceof ReadableStream);

function queryString(q: Record<string, unknown> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) sp.append(k, String(x));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** A client for the app `A`, typed from its routes. Define the routes in a chain, so the type sees them. */
export function client<A extends Routes<any>>(base: string, options: ClientOptions = {}): Client<A> {
  const urlOf = (path: string, input: RawInput) => base.replace(/\/+$/, "") + fill(path, input.params) + queryString(input.query);
  const sharedHeaders = async () => (typeof options.headers === "function" ? await options.headers() : options.headers);
  const call = async (method: string, path: string, input: RawInput = {}) => {
    const url = urlOf(path, input);
    const shared = await sharedHeaders();
    const headers: Record<string, string> = { accept: "application/json", ...shared, ...input.headers };
    let body: RequestInit["body"];
    let duplex: "half" | undefined;
    if (input.body instanceof FormData) body = input.body; // fetch writes the multipart boundary itself
    else if (isRaw(input.body)) {
      body = input.body as RequestInit["body"]; // bytes go as they are; a Blob brings its own type
      if (input.body instanceof ReadableStream) duplex = "half"; // fetch asks for it with a stream body
      if (!(input.body instanceof Blob)) headers["content-type"] ??= "application/octet-stream";
    } else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers["content-type"] ??= "application/json";
    }
    const res = await (options.fetch ?? fetch)(url, { method, headers, body, ...(duplex && { duplex }) } as RequestInit);
    const text = await res.text();
    let value: unknown = text === "" ? undefined : text;
    if (text && /json/.test(res.headers.get("content-type") ?? "")) value = JSON.parse(text);
    if (res.ok) return { ok: true, status: res.status, data: value, headers: res.headers };
    const problem = value && typeof value === "object" ? value : { type: "about:blank", title: res.statusText, status: res.status, detail: value };
    return { ok: false, status: res.status, problem, headers: res.headers };
  };
  const method = (m: string) => (path: string, input?: RawInput) => call(m, path, input);
  const events = (path: string, input: RawInput & { signal?: AbortSignal } = {}): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      const stop = new AbortController();
      const outer = input.signal;
      if (outer?.aborted) return;
      const forward = () => stop.abort(outer?.reason);
      outer?.addEventListener("abort", forward);
      try {
        const headers: Record<string, string> = { accept: "text/event-stream", ...(await sharedHeaders()), ...input.headers };
        const res = await (options.fetch ?? fetch)(urlOf(path, input), { method: "GET", headers, signal: stop.signal });
        if (!res.ok || !res.body) {
          const text = await res.text();
          let problem: ProblemBody = { type: "about:blank", title: res.statusText, status: res.status, detail: text || undefined };
          try {
            if (text) problem = JSON.parse(text);
          } catch {}
          throw new StreamError(res.status, problem);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            buffered += (done ? decoder.decode() : decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
            // an event ends at an empty line; what comes after it waits for the rest
            for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
              yield* parseEvents(buffered.slice(0, end));
              buffered = buffered.slice(end + 2);
            }
            if (done) return yield* parseEvents(buffered);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      } finally {
        outer?.removeEventListener("abort", forward);
        stop.abort(); // a loop left early closes the stream
      }
    },
  });
  const ws = (path: string, input: RawInput = {}) => {
    const url = urlOf(path, input).replace(/^http/, "ws");
    const Ws = options.WebSocket ?? globalThis.WebSocket;
    // a second argument with headers is what Node's WebSocket (undici) takes; a browser has no way to send them
    const raw = input.headers ? new (Ws as unknown as new (url: string, init: object) => WebSocket)(url, { headers: input.headers }) : new Ws(url);
    return typedSocket(raw);
  };
  return { get: method("GET"), post: method("POST"), put: method("PUT"), patch: method("PATCH"), delete: method("DELETE"), events, ws } as never;
}

/** JSON when it parses, the text as it is otherwise; bytes as they came. */
function messageOf(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function typedSocket(raw: WebSocket): TypedSocket<unknown, unknown> {
  const ready = new Promise<void>((resolve, reject) => {
    raw.addEventListener("open", () => resolve(), { once: true });
    raw.addEventListener("close", (e) => reject(new Error(`The WebSocket closed before it opened (${e.code})`)), { once: true });
  });
  ready.catch(() => {}); // nobody has to wait for it
  const socket: TypedSocket<unknown, unknown> = {
    raw,
    ready,
    send: (value) => raw.send(JSON.stringify(value)),
    close: (code, reason) => raw.close(code, reason),
    on(event: "message" | "close", fn: (...args: any[]) => void) {
      if (event === "message") raw.addEventListener("message", (e) => fn(messageOf(e.data)));
      else raw.addEventListener("close", (e) => fn(e.code, e.reason));
      return socket;
    },
    [Symbol.asyncIterator]() {
      const queue: unknown[] = [];
      let ended = raw.readyState === 3;
      let wake: (() => void) | undefined;
      const onMessage = (e: MessageEvent) => {
        queue.push(messageOf(e.data));
        wake?.();
      };
      const onClose = () => {
        ended = true;
        wake?.();
      };
      raw.addEventListener("message", onMessage);
      raw.addEventListener("close", onClose);
      const stop = () => {
        raw.removeEventListener("message", onMessage);
        raw.removeEventListener("close", onClose);
      };
      return {
        async next() {
          while (!queue.length && !ended) await new Promise<void>((r) => (wake = r));
          wake = undefined;
          if (queue.length) return { value: queue.shift() as never, done: false };
          stop();
          return { value: undefined, done: true };
        },
        async return() {
          stop();
          if (raw.readyState < 2) raw.close(); // a loop left early closes the socket
          return { value: undefined, done: true };
        },
      };
    },
  };
  return socket;
}
