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

import type { Responses, RouteDef, Routes } from "./app.ts";
import type { ProblemBody } from "./problem.ts";
import type { Infer } from "./schema.ts";

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
type BodyInput<B> = unknown extends B ? { body?: unknown } : [B] extends [undefined] ? { body?: undefined } : { body: B | FormData };
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

export type Client<A> = {
  get: Call<DefsOf<A>, "GET">;
  post: Call<DefsOf<A>, "POST">;
  put: Call<DefsOf<A>, "PUT">;
  patch: Call<DefsOf<A>, "PATCH">;
  delete: Call<DefsOf<A>, "DELETE">;
};

export type ClientOptions = {
  /** Another fetch: one with retries, a test double, or undici with a proxy. */
  fetch?: typeof fetch;
  /** Headers for every request, or a function that makes them, e.g. to put in a fresh token. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
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

function queryString(q: Record<string, unknown> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) sp.append(k, String(x));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** A client for the app `A`, typed from its routes. Define the routes in a chain, so the type sees them. */
export function client<A extends Routes<any>>(base: string, options: ClientOptions = {}): Client<A> {
  const call = async (method: string, path: string, input: RawInput = {}) => {
    const url = base.replace(/\/+$/, "") + fill(path, input.params) + queryString(input.query);
    const shared = typeof options.headers === "function" ? await options.headers() : options.headers;
    const headers: Record<string, string> = { accept: "application/json", ...shared, ...input.headers };
    let body: string | FormData | undefined;
    if (input.body instanceof FormData) body = input.body; // fetch writes the multipart boundary itself
    else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers["content-type"] ??= "application/json";
    }
    const res = await (options.fetch ?? fetch)(url, { method, headers, body });
    const text = await res.text();
    let value: unknown = text === "" ? undefined : text;
    if (text && /json/.test(res.headers.get("content-type") ?? "")) value = JSON.parse(text);
    if (res.ok) return { ok: true, status: res.status, data: value, headers: res.headers };
    const problem = value && typeof value === "object" ? value : { type: "about:blank", title: res.statusText, status: res.status, detail: value };
    return { ok: false, status: res.status, problem, headers: res.headers };
  };
  const method = (m: string) => (path: string, input?: RawInput) => call(m, path, input);
  return { get: method("GET"), post: method("POST"), put: method("PUT"), patch: method("PATCH"), delete: method("DELETE") } as never;
}
