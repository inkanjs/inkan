<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/wordmark-dark.svg"><img src="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/wordmark-light.svg" alt="inkan" width="340"></picture>

**An API server for Node where the docs can't lie.**

[![npm](https://img.shields.io/npm/v/@vxnsin/inkan?color=c4381f&labelColor=2b2420&label=npm)](https://www.npmjs.com/package/@vxnsin/inkan)
[![CI](https://img.shields.io/github/actions/workflow/status/inkanjs/inkan/ci.yml?branch=main&color=3d7a4b&labelColor=2b2420&label=ci)](https://github.com/inkanjs/inkan/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-ece1cf?labelColor=2b2420)](package.json)
[![License](https://img.shields.io/badge/license-MIT-a87fe0?labelColor=2b2420)](LICENSE)
[![supports warden](https://raw.githubusercontent.com/vxnsin/warden/main/assets/supports-warden.svg)](https://github.com/vxnsin/warden)

<!-- cozy:cards -->
<div align="center">

<a href="https://github.com/inkanjs/inkan"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/repo-dark.svg?v=f0d908ffdd"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/repo-light.svg?v=f0d908ffdd" width="840" alt="inkanjs/inkan: An API server for Node where the docs can't lie: one contract per route gives you validation, types, OpenAPI, docs and tests."></picture></a>

<a href="https://github.com/inkanjs/inkan#install"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-start-dark.svg?v=c2e08cb92e"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-start-light.svg?v=c2e08cb92e" width="95" alt="install →"></picture></a><a href="https://www.npmjs.com/package/@vxnsin/inkan"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-npm-dark.svg?v=513902168b"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-npm-light.svg?v=513902168b" width="50" alt="npm"></picture></a><a href="https://github.com/vxnsin/warden"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-warden-dark.svg?v=0e950205da"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-warden-light.svg?v=0e950205da" width="69" alt="warden"></picture></a>

<a href="https://github.com/inkanjs/inkan/commits"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/commits-dark.svg?v=d7d13846e0"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/commits-light.svg?v=d7d13846e0" width="840" alt="latest commits of inkanjs/inkan"></picture></a>

<a href="https://github.com/inkanjs/inkan/releases"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/releases-dark.svg?v=bded98a8b2"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/releases-light.svg?v=bded98a8b2" width="840" alt="releases: v0.3.0, v0.2.0"></picture></a>

<a href="https://github.com/inkanjs/inkan/graphs/contributors"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/contributors-dark.svg?v=fb3a6d2b28"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/contributors-light.svg?v=fb3a6d2b28" width="840" alt="contributors: vxnsin, AndrewCMD, RinZ27"></picture></a>

</div>
<!-- /cozy:cards -->

An *inkan* (印鑑) is the seal a Japanese contract gets stamped with. Here every
route carries one: params, query, body, responses and a few examples, written
once. From that one definition inkan checks what comes in, types your handler,
checks what goes out, writes OpenAPI 3.1, serves the docs, and runs every
example as a test.

```ts
import { inkan, problem, t } from "@vxnsin/inkan";

const Tea = t.object({ id: t.int(), name: t.string(), kind: t.enum(["green", "black", "oolong"]) });
const teas = [{ id: 1, name: "Sencha", kind: "green" as const }];

const app = inkan({ title: "Tea Shop", version: "1.0.0" });

app.get(
  "/teas/:id",
  {
    params: t.object({ id: t.int() }),
    response: { 200: Tea, 404: t.problem() },
    examples: [
      { name: "found", params: { id: 1 }, expect: { name: "Sencha" } },
      { name: "missing", params: { id: 99 }, status: 404 },
    ],
  },
  ({ params }) => {
    const tea = teas.find((x) => x.id === params.id); // params.id is a number, not a string
    if (!tea) throw problem(404, "tea-not-found", `There is no tea with id ${params.id}`);
    return tea; // has to be a Tea, or it does not compile
  },
);

app.listen();
```

The examples are what the docs show, and they are what this runs. Say the 404 got lost in a refactor:

```sh
$ npx inkan check src/app.ts

  印 inkan check  ·  Tea Shop 1.0.0

  GET    /teas/:id
    ✓ found                              200  0.8ms
    ✗ missing                            200  0.4ms
        answered 200, expected 404

  2 examples · 1 sealed · 1 broken
```

A docs page that is tested is a docs page you can trust. When the handler
drifts, the check goes red before anyone reads something false.

## Why another one

Express gets out of the way, Fastify is fast, Hono runs everywhere. inkan wants to be
easy to start and deep when you need it, plus the one thing none of them does: holding the
server to what its docs say.

| | Express | Fastify | Hono | inkan |
| --- | :-: | :-: | :-: | :-: |
| Handler types come from the schema | – | with a type provider | with a validator | ✓ |
| OpenAPI document | plugin | plugin | plugin | ✓ |
| Docs page | plugin | plugin | plugin | ✓ no CDN, works offline |
| Answers trimmed to the contract | – | ✓ | – | ✓ and checked in dev |
| **Examples run as tests** | – | – | – | ✓ `inkan check` |
| **Live request inspector** | – | – | – | ✓ `/_inkan` |
| Every error in one shape ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) | – | – | – | ✓ |
| Runtime dependencies | several | several | none | **none** |

## Install

```sh
npm install @vxnsin/inkan
```

The package is scoped because npm keeps the plain name `inkan` free of look-alikes. The command it installs is `inkan` either way.

Node 20 or newer. On Node 22.18 and newer, `.ts` files run as they are,
with no build step and no loader.

## What it does

| | |
| --- | --- |
| **Checks what comes in** | `params`, `query`, `headers` and `body` are validated together. Path and query strings become the numbers and booleans the schema asks for. Bad input is one 400 that lists every issue, not just the first. |
| **Types the handler** | No generics to write. `params.id` is what the schema says, and so is the return value. Without a schema, `:id` in the path is still typed. |
| **Checks what goes out** | In development, an answer that breaks its contract is a 500 that says where, not a silent surprise for the frontend. Keys the contract does not list are dropped, so a `passwordHash` never leaves by accident. |
| **Writes OpenAPI 3.1** | At `/openapi.json`, from the same schemas. Named schemas land in `components` once. |
| **Serves the docs** | At `/docs`. Every example has a send button, and a route gets its seal 印 when all of its examples answer as promised. |
| **Runs examples as tests** | `inkan check` or `app.check()`, in-process, no port. Routes without examples are listed, so nothing hides. |
| **Shows what happened** | `/_inkan` is a live log of the last 200 requests and what broke the contract. Development only, loopback only, secret headers hidden. |
| **Errors in one shape** | `throw problem(404, "tea-not-found", "…")` gives an RFC 9457 document. Every built-in error has the same shape, with a stable `type` to switch on. |

## A route

```ts
app.post(
  "/teas",
  {
    summary: "Add a tea",
    tags: ["teas"],
    body: NewTea,
    response: { 201: Tea, 409: t.problem() },
    examples: [
      { name: "a new oolong", body: { name: "Da Hong Pao", kind: "oolong" }, expect: { id: 2 } },
      { name: "no name", body: { kind: "green" }, status: 400 },
    ],
  },
  ({ body, reply }) => {
    const tea = store.add(body);
    return reply(201, tea, { location: `/teas/${tea.id}` });
  },
);
```

| field | |
| --- | --- |
| `params`, `query`, `headers`, `body` | schemas for the input. Header names are lowercase. |
| `response` | status → schema. The first 2xx is the default status, and no body means 204. |
| `examples` | `{ name, params, query, headers, body, status, expect, keep, after }`. `status` defaults to the first 2xx. `expect` is a part of the answer that has to be there. `keep` and `after` chain examples, see below. |
| `summary`, `description`, `tags`, `deprecated`, `operationId` | for the docs |
| `hidden` | keeps the route out of the docs and OpenAPI |
| `use` | middleware for this route only, after validation |

A handler returns a value, or `reply(status, body, headers)` for anything
else. `ctx.reply` is typed to the statuses in the contract, so `reply(418)`
on a route that never promised a teapot does not compile.

## Schemas

```ts
t.string().min(1).max(60).email().uuid().pattern(/x/).format("date-time").trim()
t.int().min(0)   t.number().positive()   t.boolean()
t.enum(["a", "b"])   t.literal("a")   t.union(t.string(), t.int())
t.array(Tea).min(1)   t.record(t.int())   t.any()   t.empty()   t.problem()
t.object({ … }).strict() .passthrough() .pick() .omit() .extend() .partial()

.optional()  .nullable()  .default(v)  .describe("…")  .example(v)  .named("Tea")  .deprecated()
```

`Infer<typeof Tea>` is the TypeScript type. `Tea.parse(x)` throws a
`ValidationError`, `Tea.safeParse(x)` does not, and `Tea.toJSONSchema()`
gives JSON Schema 2020-12.

`t.date()` accepts ISO date-time strings (including a timezone) or valid `Date`
instances and returns a `Date`. Responses serialize dates back to ISO strings;
the wire schema is `{ type: "string", format: "date-time" }`.

```ts
const Even = t.int().refine(n => n % 2 === 0, "must be even");
const Length = t.string().transform(text => text.length); // Infer: number
const Pet = t.discriminated("kind", {
  cat: t.object({ kind: t.literal("cat"), lives: t.int() }).named("Cat"),
  dog: t.object({ kind: t.literal("dog"), bark: t.boolean() }).named("Dog"),
});

type Node = { name: string; children: Node[] };
const Node: Schema<Node> = t.object({
  name: t.string(), children: t.array(t.lazy(() => Node)),
}).named("Node"); // import type { Schema } from "@vxnsin/inkan"
```

Refinements and transforms are synchronous, run in chain order after successful
validation, and remain outside JSON Schema. Transforms document their original
input shape; use them on request schemas when the parsed handler value differs
from the wire value. Optional, nullable and default modifiers added after an effect
bypass that effect for their missing/null/default values. Modifiers before an
effect supply its input.

Each discriminated branch declares its matching literal tag. OpenAPI uses
`oneOf` and a `discriminator`, with mappings for named branches. Name recursive
shapes so OpenAPI can reference components; `toJSONSchema()` includes named
schemas in `$defs`, making its references self-contained.

## Examples are tests

```sh
npx inkan check src/app.ts            # every route
npx inkan check src/app.ts --only /teas
npx inkan check src/app.ts --json     # for CI
npx inkan check src/app.ts --strict   # a promised status without an example fails too
```

A route that promises a 404 no example ever shows is listed under the route,
and on the docs page. Nothing tests that 404 yet; `--strict` turns it into a
failure.

The entry file exports the app (`export default app` or `export const app`).
`app.listen()` stays quiet while the CLI loads it. If the examples change data,
export a `beforeEach` that puts it back. It runs before every example:

```ts
export function beforeEach() {
  store.reset();
}
```

Or inside your own tests:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { app, beforeEach } from "./app.ts";

test("the contract holds", async () => {
  const report = await app.check({ beforeEach });
  assert.equal(report.failed, 0);
});
```

### Examples that build on each other

"Create a tea, then fetch it" needs the id from the first answer. One example `keep`s it,
the next one runs `after` it and uses it as a placeholder:

```ts
// POST /teas
{ name: "a new oolong", body: { name: "Da Hong Pao", kind: "oolong" }, keep: { id: "body.id" } },

// GET /teas/:id
{ name: "the one just added", after: "POST /teas > a new oolong", params: { id: "{id}" }, expect: { name: "Da Hong Pao" } },
```

`keep` reads `body.…`, `headers.…` or `status`. A placeholder alone (`"{id}"`) keeps the
value's type; inside text (`"/teas/{id}"`) it becomes text. `beforeEach` runs once before
the whole chain, so the examples in it see each other's data, and the order comes from
`after`, never from the order of the files. The docs page runs the chain too when you
press send.

For everything the examples do not cover, `app.inject()` sends a request
straight in, without a socket:

```ts
const res = await app.inject({ method: "POST", url: "/teas", body: { name: "Gyokuro" } });
res.status; // 400
res.body.errors; // [{ in: "body", path: "kind", message: "is required" }, …]
```

## Streams, events and uploads

A handler may return a stream instead of a value: a Node `Readable`, a web `ReadableStream`
or any async iterable. It goes out piece by piece, as it comes.

**Server-sent events** have a contract like any other answer, one schema per event:

```ts
import { sse, t } from "@vxnsin/inkan";

app.get(
  "/clock",
  {
    response: { 200: t.events({ tick: t.object({ n: t.int() }) }) },
    examples: [{ name: "three ticks", expect: [{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }] }],
  },
  () =>
    sse(async function* (signal) {
      for (let n = 1; !signal.aborted; n++) {
        yield { event: "tick", data: { n } };
        await sleep(1000);
      }
    }),
);
```

The `signal` fires when the client goes away, so the loop stops. Quiet streams get a
keep-alive comment every 15 seconds. In development, an event that breaks its schema ends the
stream with an `error` event and a line on the console. `inkan check` and the docs page read
as many events as an example expects, so a stream that never ends can still be an example.

**Uploads** are a `t.file()` in the body. A body with a file is read as
`multipart/form-data`, and OpenAPI says so:

```ts
import { fileExample, t } from "@vxnsin/inkan";

app.post(
  "/avatars",
  {
    body: t.object({ user: t.int(), image: t.file().max(200_000).accept("image/png", "image/jpeg") }),
    examples: [{ name: "a tiny png", body: { user: 1, image: fileExample("me.png", "…", "image/png") } }],
  },
  ({ body }) => save(body.user, body.image.data), // name, type, size and data: a Buffer
);
```

Fields next to the file are coerced like a query (`"1"` becomes `1`). A file that is too big
or of the wrong type is a 400 that says which, and `bodyLimit` still caps the whole upload.

## A typed client

The contract already knows every path, input and answer, so a client can take its types
from the app itself. No code generation, no OpenAPI step in between:

```ts
// server.ts: define the routes in a chain, so the type of `api` sees them
export const api = inkan()
  .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: Tea, 404: t.problem() } }, getTea)
  .post("/teas", { body: NewTea, response: { 201: Tea } }, addTea)
  .mount("/admin", admin);

// web.ts: only the type crosses over, none of the server
import type { api } from "./server.ts";
import { client } from "@vxnsin/inkan/client";

const shop = client<typeof api>("https://shop.example.com", { headers: () => ({ authorization: `Bearer ${token}` }) });

const res = await shop.get("/teas/:id", { params: { id: 1 } });
if (res.ok) res.data.name;               // typed as the contract's Tea, Dates as strings
else if (res.status === 404) res.problem; // every failure is a problem document, never a throw
```

A wrong path, a missing param or a body of the wrong shape does not compile. Check `ok`
first: any status can also come from a proxy on the way, so `status` alone cannot promise
which answer it is. The client is a few lines around `fetch` and runs anywhere fetch does;
pass your own with `{ fetch }`.

Routes written one statement at a time (`app.get(...);`) work as always, but their type
cannot collect them: a type only grows along a chain.

## Middleware and groups

```ts
app.use(async (ctx, next) => {
  const started = Date.now();
  await next();
  ctx.header("server-timing", `app;dur=${Date.now() - started}`);
});

const admin = routes().use(requireAdmin).get("/stats", () => stats());
app.mount("/admin", admin);
```

`ctx.state` carries things from middleware to the handler. A thrown
`problem()` stops everything, wherever it is thrown.

### CORS

`OPTIONS` answers on its own with an `Allow` header. For browsers on another
origin, add `cors()`:

```ts
import { cors } from "@vxnsin/inkan";

app.use(cors());                                                  // any origin
app.use(cors({ origin: "https://shop.example", credentials: true })); // one origin, with cookies
app.use(cors({ origin: ["https://a.example", "https://b.example"], maxAge: 600 }));
app.use(cors({ origin: (o) => o.endsWith(".shop.example") }));
```

Preflights are answered before routing, and error answers carry the headers
too, so the page can read a 404 instead of a CORS error. `allowHeaders`,
`exposeHeaders` and `methods` are there when the defaults are not enough.

## Hooks, plugins and decorators

Hooks run at fixed points of every request, in this order:

```ts
app
  .onRequest((ctx) => { /* a route was found; the body is not read yet: auth, rate limits */ })
  .preHandler((ctx) => { /* the input is checked and typed: rules that need it */ })
  .onSend((ctx, answer) => { answer.headers["x-took"] = "…"; })   // every answer, problems too
  .onResponse((ctx, done) => metrics.observe(done.route, done.ms)) // after it is written
  .onProblem((ctx, problem) => { problem.extra.help = docsFor(problem.type); });
```

`onRequest` and `preHandler` may return a value, and that is the answer, as if
a handler had returned it. A thrown `problem()` stops the request wherever it is
thrown, and `onProblem` sees it before it is written.

A plugin is a function that gets a scope of its own. What it adds there (routes,
hooks, decorations) stays there, under its prefix, unless it says `shared: true`:

```ts
import { plugin, problem, rateLimit } from "@vxnsin/inkan";

const admin = plugin(async (app, opts: { token: string }) => {
  app.register(rateLimit({ max: 10 }));      // only these routes
  app.onRequest((ctx) => { if (ctx.headers.authorization !== opts.token) throw problem(401, "unauthorized"); });
  app.get("/stats", () => stats());
});

app.register(admin, { prefix: "/admin", token: process.env.ADMIN_TOKEN! });
await app.ready();                           // or just listen(): it waits for every plugin
```

Plugins load in the order they are registered, an async one holds back the
ones after it, and one that fails stops `listen()`. Their routes are routes
like any other: in OpenAPI, on the docs page and in `inkan check`.

`decorate` puts a value on every context in its scope, typed:

```ts
const app = inkan().decorate("db", pool);
app.get("/teas/:id", { params: t.object({ id: t.int() }) }, (ctx) => ctx.db.find(ctx.params.id));
```

A name the context already has is refused, so a decoration cannot hide `params`
or another decoration. A route with no hooks anywhere above it takes the same
path it took before there were hooks: they cost nothing until you use them.

## Running it

`app.listen()` takes the port from its argument, then `$PORT`, then 3000. So it
runs under [warden](https://github.com/vxnsin/warden), a container or a PaaS
without changes:

```sh
warden run -- node src/app.ts
```

On SIGINT or SIGTERM it lets open requests finish (up to ten seconds) before it
exits. `app.listener` is a plain `(req, res)` function for your own
`http.createServer`.

Hooks open and close what the app needs around that:

```ts
app.onListen(() => db.connect()); // awaited before listen() resolves; a throw rejects it
app.onClose(() => db.end());      // awaited after the last request, within the ten seconds
```

`onClose` runs on SIGINT or SIGTERM while `gracefulShutdown` is on.

```ts
inkan({
  title: "Tea Shop", version: "1.0.0", description: "…", servers: [{ url: "https://api.example.com" }],
  docs: "/docs",                  // or false
  openapi: "/openapi.json",       // or false
  inspector: "/_inkan",           // default: on in development, always loopback only
  validateResponses: true,        // default: on in development
  bodyLimit: 1024 * 1024,
  log: "pretty",                  // "pretty", "json" or false; default: pretty in development, json in production
  logger: (entry) => pino.info(entry), // takes every request log entry instead of the console
  requestId: "x-request-id",      // or false
  gracefulShutdown: true,
  dev: process.env.NODE_ENV !== "production",
  onError: (err, ctx) => report(err),
});
```

Every request has an id: the one in `x-request-id` when it looks safe, a fresh UUID
otherwise. It is `ctx.id` in the handler, goes back out as a header, sits in every log
line and in every problem document as `requestId`, so a bug report points at the right
line in the logs.

## CLI

```sh
npx inkan check   src/app.ts [--only <text>] [--json] [--strict]
npx inkan openapi src/app.ts [-o openapi.json]
npx inkan routes  src/app.ts
npx inkan diff    openapi.json src/app.ts [--json]
npx inkan examples [name] [folder] [--list] [--force]
```

`inkan diff` compares a saved OpenAPI document with the app (or two documents) and names
what would break a client written against the old one: a route or status that is gone, a
field that is required now, a value a request may no longer send, a value an answer may
send now. Requests may only get looser and answers only stricter; it exits with `1` when
something breaks, so CI can ask for a major version.

Exit codes: `0` everything sealed, `1` something broke, `2` the command was
used wrong. Colours turn off when the output is not a terminal or `NO_COLOR`
is set; `FORCE_COLOR` turns them on.

## Try the example

```sh
npx @vxnsin/inkan examples         # pick one, and it lands in a folder of its own
```

Six example projects, in reading order, each explained file by file:

| | |
| --- | --- |
| `hello` | one route, one example, `inkan check`. Five minutes. |
| `tea-shop` | CRUD with named schemas, `problem()`, groups and `beforeEach` |
| `auth` | middleware, `ctx.state`, route-level `use`, a 401 and a 403 in the contract |
| `testing` | `app.check()` and `app.inject()` in `node:test`, plus a CI workflow |
| `openapi` | export the document, generate a client, keep both in sync |
| `deploy` | Dockerfile, `$PORT`, JSON logs, graceful shutdown, warden |

Every one has a README that says what to read in which order, something to change first,
and a list of ways to break it on purpose to see what inkan catches.

Or the one in this repo:

```sh
git clone https://github.com/inkanjs/inkan && cd inkan && npm install
node examples/shop.ts              # then open http://localhost:3000/docs
node src/cli.ts check examples/shop.ts
```

## Not yet

What comes next lives in the [issues](https://github.com/inkanjs/inkan/issues) and the
[milestones](https://github.com/inkanjs/inkan/milestones): routes from the file tree,
`app.fetch()` for Bun, Deno and serverless, security schemes in OpenAPI, honest benchmarks.
What changed lives in the [changelog](CHANGELOG.md). Issues marked
[good first issue](https://github.com/inkanjs/inkan/labels/good%20first%20issue) are a good place to start.

Where things live:

```
src/
  index.ts  client.ts  cli.ts    the three entry points: the package, /client and the inkan command
  core/       the server: app, routes, context, input, router, problems, streams
  schema/     t, validation and the writers that keep answers to their contract
  openapi/    the OpenAPI document and inkan diff
  testing/    inkan check, examples that build on each other, examples from real requests
  pages/      the docs page and the inspector
  plugins/    cors, and more to come
  cli/        inkan examples
```

## License

[MIT](LICENSE)
