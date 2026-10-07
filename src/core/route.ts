// Routes and what they are made of: the contract of a route, its handler, its context,
// and a table of routes that an app or a group holds.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Infer, Schema } from "../schema/schema.ts";
import type { EventStream } from "./stream.ts";
import type { App } from "./app.ts";
import type { Box, Hooks, Scope } from "./scope.ts";

export type Responses = { [status: number]: Schema<any> };

export type Example = {
  name?: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  /** The status this example has to answer with. Defaults to the first 2xx in `response`. */
  status?: number;
  /** A part of the response body that has to be in the answer, compared deeply. */
  expect?: unknown;
  /** Values to keep from this answer for examples that come after it: `{ id: "body.id" }`. */
  keep?: Record<string, string>;
  /**
   * Another example that runs first, as `"POST /teas > a new oolong"`. What it keeps fills
   * `{name}` placeholders in this example's params, query, headers and body.
   */
  after?: string;
};

/**
 * How a caller proves who they are. inkan checks that the credentials are there and
 * documents them; whether they are good is for your hook or middleware to say.
 */
export type Security = "bearer" | "basic" | { apiKey: string; in?: "header" | "query" | "cookie" };

export type RouteSpec<P, Q, B, H, R extends Responses> = {
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
  body?: Schema<B>;
  response?: R;
  /** Headers an answer carries, by status: `{ 201: { location: t.string() } }`. Checked in development, like the body. */
  responseHeaders?: { [status: number]: Record<string, Schema<any>> };
  /**
   * Who may call it: a request without these credentials is a 401 before anything else runs.
   * Several are alternatives, any one will do. `false` opens a route in a secured group.
   */
  security?: Security | Security[] | false;
  examples?: Example[];
  /** Middleware for this route only. It runs after the input was validated. */
  use?: Middleware[];
};

export type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ParamsOf<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & ParamsOf<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : P extends `${string}*${infer W}`
      ? { [K in W extends "" ? "rest" : W]: string }
      : {};
export type PathParams<P extends string> = string extends P ? Record<string, string> : Simplify<ParamsOf<P>>;

export type RawQuery = Record<string, string | string[]>;
export type RawHeaders = Record<string, string | undefined>;

export type SuccessStatus = 200 | 201 | 202 | 203 | 206 | 207;
export type SuccessBody<R> = {} extends R
  ? unknown
  : { [K in keyof R]: K extends SuccessStatus ? Infer<R[K]> : never }[keyof R];

export class Reply<S extends number = number, Body = unknown> {
  status: S;
  body: Body;
  headers: Record<string, string>;
  constructor(status: S, body: Body, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Answers with a status that is not the default one, or with extra headers. */
export const reply = <S extends number, B>(status: S, body?: B, headers?: Record<string, string>) =>
  new Reply(status, body, headers);

export type Context<P = Record<string, string>, Q = RawQuery, B = unknown, H = RawHeaders, R extends Responses = {}> = {
  method: string;
  path: string;
  url: URL;
  /** The request id: taken from the request id header when it looks safe, otherwise a fresh UUID. */
  id: string;
  params: P;
  query: Q;
  headers: H;
  body: B;
  /** Free space for middleware to hand things to the handler. */
  state: Record<string, unknown>;
  /** The route that matched, as it was written. Undefined when no route matched. */
  route?: { method: string; path: string };
  /** Sets the status used when the handler returns a plain value. */
  status(code: number): void;
  header(name: string, value: string): void;
  reply<S extends keyof R & number>(status: S, body: Infer<R[S]>, headers?: Record<string, string>): Reply<S>;
  /** Only there when the request came through a socket, not through `inject`. */
  req?: IncomingMessage;
  res?: ServerResponse;
};

export type Result<R extends Responses> = SuccessBody<R> | Reply | EventStream | AsyncIterable<Uint8Array | string> | void;
/** A route's handler. `Deco` is what `decorate` put on the context of the app or plugin it belongs to. */
export type Handler<P, Q, B, H, R extends Responses, Deco = {}> = (ctx: Context<P, Q, B, H, R> & Deco) => Result<R> | Promise<Result<R>>;
export type Middleware = (ctx: Context<any, any, any, any, any>, next: () => Promise<void>) => unknown;

export type RouteRecord = {
  method: string;
  path: string;
  spec: RouteSpec<any, any, any, any, Responses>;
  handler: Handler<any, any, any, any, any>;
  use: Middleware[];
  /** @internal The credentials it asks for, its own or its group's; empty for none. */
  security?: Security[];
  /** @internal The scope it was defined in: its hooks and its decorations. */
  box?: Box;
  /** @internal Every hook from the app down to this route, joined once before the first request. */
  hooks?: Hooks;
};

/** What the type of an app remembers about one route, for the typed client. */
export type RouteDef = { params: unknown; query: unknown; body: unknown; headers: unknown; response: Responses };
/** Every route of an app or group, by `"METHOD /path"`. */
export type RouteDefs = { [route: string]: RouteDef };

// A table with more routes: the same kind of table, remembering them.
export type WithRoutes<Self, More extends RouteDefs> =
  Self extends App<infer D, infer X>
    ? App<D & More, X>
    : Self extends Scope<infer D, infer X>
      ? Scope<D & More, X>
      : Self extends Routes<infer D, infer X>
        ? Routes<D & More, X>
        : Self;

/** What `decorate` has put on the context so far. */
export type DecoOf<Self> = Self extends { readonly _deco: infer X } ? X : {};
/** The same app or scope, with one more decoration on its context. */
export type WithDeco<Self, More> =
  Self extends App<infer D, infer X> ? App<D, X & More> : Self extends Scope<infer D, infer X> ? Scope<D, X & More> : Self;

export type TrimEnd<S extends string> = S extends `${infer A}/` ? TrimEnd<A> : S;
/** `/teas` + `/:id` is `/teas/:id`, `/teas` + `/` is `/teas`, `/` + `/me` is `/me`. */
export type JoinPath<A extends string, B extends string> = `${TrimEnd<A>}${B extends "/" ? "" : B}` extends ""
  ? "/"
  : `${TrimEnd<A>}${B extends "/" ? "" : B}`;
export type Prefixed<D extends RouteDefs, Pre extends string> = {
  [K in keyof D & string as K extends `${infer M} ${infer P}` ? `${M} ${JoinPath<Pre, P>}` : never]: D[K];
};

export type MountMethod<Self> = <Pre extends string, G extends RouteDefs>(prefix: Pre, group: Routes<G>) => WithRoutes<Self, Prefixed<G, Pre>>;

export type RouteMethod<Self, M extends string> = {
  <
    Path extends string,
    P = PathParams<Path>,
    Q = RawQuery,
    B = undefined,
    H = RawHeaders,
    R extends Responses = {},
  >(
    path: Path,
    spec: RouteSpec<P, Q, B, H, R>,
    handler: Handler<P, Q, B, H, R, DecoOf<Self>>,
  ): WithRoutes<Self, { [K in `${M} ${Path}`]: { params: P; query: Q; body: B; headers: H; response: R } }>;
  <Path extends string>(
    path: Path,
    handler: Handler<PathParams<Path>, RawQuery, unknown, RawHeaders, {}, DecoOf<Self>>,
  ): WithRoutes<Self, { [K in `${M} ${Path}`]: { params: PathParams<Path>; query: RawQuery; body: unknown; headers: RawHeaders; response: {} } }>;
};

// ---------- route tables ----------

/** `security` as a list: undefined to take the group's, empty for none. */
export const securityList = (s: Security | Security[] | false | undefined): Security[] | undefined =>
  s === undefined ? undefined : s === false ? [] : Array.isArray(s) ? s : [s];

export const joinPath = (a: string, b: string) => "/" + [a, b].join("/").split("/").filter(Boolean).join("/");

/**
 * A set of routes that can be mounted under a prefix. Its type remembers every route
 * defined on it in a chain, which is what the typed client reads.
 */
export class Routes<Defs extends RouteDefs = any, Deco = {}> {
  /** Only a type: the routes this table knows. There is nothing here at runtime. */
  declare readonly _defs: Defs;
  /** Only a type: what `decorate` put on the context its handlers get. */
  declare readonly _deco: Deco;
  /** @internal */
  _records: RouteRecord[] = [];
  /** @internal */
  _use: Middleware[] = [];

  /** For a group, middleware that every route in it gets. Add it before mounting. */
  use(...mw: Middleware[]): this {
    this._use.push(...mw);
    return this;
  }

  /** @internal */
  _security?: Security[];
  /**
   * The credentials every route defined here afterwards asks for, unless it says
   * otherwise in its own `security`. On the app it is the default for every route.
   */
  security(scheme: Security | Security[] | false): this {
    this._security = securityList(scheme);
    return this;
  }

  protected define(method: string, path: string, a: unknown, b?: unknown): this {
    const [spec, handler] = typeof a === "function" ? [{}, a] : [a, b];
    const s = spec as RouteRecord["spec"];
    this.add({ method, path, spec: s, handler: handler as RouteRecord["handler"], use: s.use ?? [], security: securityList(s.security) });
    return this;
  }

  /** @internal */
  add(r: RouteRecord) {
    this._records.push({ ...r, use: [...this._use, ...r.use], security: r.security ?? this._security });
  }

  get: RouteMethod<this, "GET"> = ((p: string, a: unknown, b?: unknown) => this.define("GET", p, a, b)) as never;
  post: RouteMethod<this, "POST"> = ((p: string, a: unknown, b?: unknown) => this.define("POST", p, a, b)) as never;
  put: RouteMethod<this, "PUT"> = ((p: string, a: unknown, b?: unknown) => this.define("PUT", p, a, b)) as never;
  patch: RouteMethod<this, "PATCH"> = ((p: string, a: unknown, b?: unknown) => this.define("PATCH", p, a, b)) as never;
  delete: RouteMethod<this, "DELETE"> = ((p: string, a: unknown, b?: unknown) => this.define("DELETE", p, a, b)) as never;

  /** Puts a group's routes under a prefix. In a chain, the type knows them under their new paths. */
  mount: MountMethod<this> = ((prefix: string, group: Routes) => {
    for (const r of group._records) this.add({ ...r, path: joinPath(prefix, r.path) });
    return this;
  }) as never;
}

export const routes = (): Routes<{}> => new Routes();

