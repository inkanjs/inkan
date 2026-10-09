# Changelog

## 0.7.0 (unreleased)

### New

- **Background jobs.** `app.job(path, { body, progress, result, concurrency, queue, keep, timeout, owner }, run)`
  defines five ordinary routes around a queue, so the docs, OpenAPI, hooks, security, the
  typed client and `inkan check` see them like any other: `POST path` starts a job (202,
  with its `location`; 503 when the queue is full or the server stops), `GET path/:id` tells
  how it stands, `GET path/:id/events` follows it as server-sent events (its status, the
  latest progress only, then the end, and the stream closes), `GET path/:id/result?wait=10`
  waits for what it made, and `DELETE path/:id` cancels it or forgets it once it is over.
  The work gets `job.input`, `job.signal` and `job.progress(p)`; ids are random, a job of
  someone else is a 404 with `owner`, a thrown problem is the job's `error`, and in
  development a progress or result that breaks its contract fails the job. Finished jobs are
  kept for `keep` seconds. On SIGINT or SIGTERM waiting jobs are canceled, event streams
  end at once, and running jobs get a few seconds before their signal is aborted.
  **Jobs run in the process that started them: one still running when it ends is lost.**
  With `workers`, `listen` refuses jobs kept in memory; `JobStore` is the interface for a
  store the processes share, `memoryStore()` the one inkan has. The routes get examples made
  from the first start example, so `inkan check` covers them.
- **`client.events(path, { params })`** reads a route that answers with `t.events(...)` as an
  async iterator, each event narrowed by its name; leaving the loop closes the stream.
- **Per-request decorations.** `scope.decorateRequest("user", (ctx) => …)` puts a value on
  the context that is made the first time a request reads it and kept for the rest of that
  request; a request that never asks never makes it. Typed like `decorate`, refused for the
  same names, and only the scopes that use it carry its getter.
- **Types out of shared plugins.** A plugin made with `shared: true` that returns its scope
  (`(app) => app.decorateRequest("user", …)`) hands its decorations on: after
  `app.register(auth)` the handlers see `ctx.user` typed. `Plugin` has a third type
  parameter for what it adds.
- **`ctx.route.security` and `ctx.route.meta`.** Hooks see the credentials a route asks
  for, its own or its group's, and a free-form `meta` from its spec
  (`{ meta: { auth: { roles: ["admin"] } } }`). Plugins name what they read by extending
  the exported `RouteMeta` interface. Worked out once per route, before the first request.
- **`scope.describe((operation, route, components) => …)`** lets a plugin add to the
  OpenAPI operation of every route in its scope: header parameters, answers, descriptions,
  and details of a security scheme such as `bearerFormat: "JWT"`.
- **`trustProxy`** on the app: `true`, a number of hops, or a function that names your
  proxies. `ctx.ip`, and with it `rateLimit`, then reads `x-forwarded-for` or `forwarded`.
  Off by default; an app without it pays nothing for it.
- **`onSend(fn, { last: true })`** runs a hook after every other onSend hook of a route.
  `compress` uses it, so a hook that reads the body (an ETag) sees it before it is packed,
  wherever either was registered.
- **`ctx.rawHeaders`**: the request's headers as they arrived, names in lower case, even
  where a route's header schema cut `ctx.headers` down to its contract. The request's own
  object, not a copy: read it, do not change it.
- **`ctx.secure` and `ctx.protocol`** (`"http"` or `"https"`): the TLS socket under
  `listen`, the URL's scheme under `app.fetch`, `secure` on an adapter's request, and with
  `trustProxy` what the trusted proxies forward in `x-forwarded-proto` or forwarded's
  `proto=`. `ctx.url` takes its scheme from it.
- **`ref(schema, name?)` for `describe` hooks**, their fourth argument: lists a `t.*`
  schema once under `components.schemas` and returns `{ $ref }` to it, as a route's named
  schemas are. An unnamed schema needs `name`.
- **The route a `describe` hook gets is public**: the frozen `ctx.route` view (`method`,
  `path`, `security`, `meta`) plus the `spec` it was written with, typed `OperationRoute`;
  no internal fields of the route record.
- **`scope.dev` and `scope.prefix`**, read-only: whether the app runs in development, and
  the path prefix of the scope a plugin was given (`""` for the app).
- `RouteMeta` takes symbol keys as well, so a plugin can keep its key to itself.
- The pages inkan serves itself (`/docs`, `/openapi.json`, `/_inkan`) are answered before
  any hook runs, so hooks such as secure headers do not apply to them. Turn a page off
  (`docs: false`, …) or serve it from a route of your own to put hooks on it.
- `serializeCookie` and `parseCookies` are exported, for plugins that read or write
  cookies outside a context. So are the types `RouteInfo`, `RouteMeta`, `Security`,
  `OperationHook`, `OperationRoute` and `TrustProxy`.
- **`env(schema, source = process.env)`** checks environment variables with a `t.object`
  schema, coerced like a query string (numbers, booleans, enums, defaults, optional), and
  hands back the typed value, frozen. An empty variable counts as unset. It throws one error
  that lists every problem (`PORT must be an integer, got "abc"`, `DATABASE_URL is
  required`), never with the value of a name that looks secret (SECRET, TOKEN, KEY, PASSWORD).
- **Overload protection: `pressure`** on the app, `{ eventLoopDelay, heapUsed, rss,
  retryAfter, check, exempt, interval }`. A timer (unref'd, every second) samples the event
  loop's delay, the heap (bytes or `"90%"` of its limit), resident memory and your own
  `check()`, and sets one flag. While it is set every request gets a 503 `under-pressure`
  problem with `retry-after`, before its body is read and before any hook; inkan's own pages
  and the `exempt` paths still answer. `app.pressure()` hands back the last sample for a
  health route. Off by default: no timer, and nothing to read per request.
- **Request context: `context: true` and `context()`.** Each request runs inside an
  AsyncLocalStorage holding its context, so code far from the handler (a logger, a database
  helper) reads `context()?.id` or `context()?.user` without having it passed. Outside a
  request it is undefined; with no app in the process that turned it on it throws. A
  background job runs with its own `job.ctx`, never inside the store of the request that
  started it, and timers inkan makes during a request (the job sweeper) do not keep that
  store either. Off by default; on, it costs about 0.5-1 µs a request (`bench/inproc.mjs`:
  113 % of the time without it, geomean).

### Faster

- **Objects check by their own keys.** An object's fields are read in the order the value
  holds them, mostly the contract's, and each field's check is called directly: a body of
  50 items checks in about 70 % of the time, a small body in two thirds. Every field is
  still checked once, in the contract's order, with the same issues.
- **Answers fit without `Object.keys`.** Whether an answer can go to the native writer as
  it is is told by a for-in over it: half the time for a list of 100, a quarter less to
  write it.
- **Middleware routes answer in one async frame**, without a closure per request; a route
  with a `timeout` races its work as before.

### Changed

- `compress` runs after every other onSend hook instead of in the order it was registered.
- `register()` returns the app or scope typed with what a shared plugin added, instead of
  `this`; for any other plugin the type is the same as before.
- A plugin may return a value (its scope); anything but a promise is ignored as before.
- `app.dev` is read-only, like `scope.dev`; set development mode with the `dev` option.
- On SIGINT or SIGTERM a connection whose answer ends during the shutdown is closed right
  after it, instead of when the client lets it go.

## 0.6.0

### New

- **More than JSON, from the context.** `ctx.text(body)`, `ctx.html(markup)`,
  `ctx.redirect(to, status)` (301, 302, 303, 307 or 308) and `ctx.notFound(detail)`, the
  same 404 problem an unknown route gets, through `onProblem` like any other. Each can be
  taken apart like `status` (`({ html }) => …`) and costs nothing until used.
- **The `html` tag**, which escapes every value put into it, joins lists and writes nothing
  for `null`, `undefined` and `false`. A handler can return `` html`…` `` as it is.
  `raw(markup)` lets markup you made yourself through.
- **Layouts.** `app.layout((content, props, ctx) => …)` and `ctx.render(content, props)`:
  pages in the look of their scope; a plugin can have its own, and the closest wins.
- **Cookies.** `ctx.cookies` reads them, `ctx.setCookie(name, value, options)` sets one,
  HttpOnly and SameSite=Lax unless told otherwise, and `ctx.clearCookie(name)` lets one
  expire. Every cookie goes out as a Set-Cookie of its own, over node:http, `fetch` and
  `inject` (`res.cookies`).

- **Rows as they come.** A handler can return a generator of rows for a list in its
  contract, such as one over a database cursor: the rows go out as they are read, as a JSON
  array or as NDJSON for `accept: application/x-ndjson`, each written to the contract and
  checked in development.
- **`ctx.csv(rows, options)`** writes rows as CSV the same way, with a separator, a BOM,
  a file name, and formulas defused unless told otherwise.
- **`ctx.signal`** aborts when the client goes away or the route's time is up; `timeout`
  on a route or the app answers 504 past it.
- **`cache` on a route** keeps the handler's answers per input and caller for a while, and
  asks once for many requests that come in at the same time.

### Faster

- **Less work per request.** A request id from a counter instead of a random UUID, route
  data worked out once when the app is built, a request with a body routed once, no context
  for a request no route takes, and the answer written into one object.
- **Schemas check through stamps**: one function per schema, made once from its rules, in
  place of a walk over the schema tree on every request. They check exactly as before.
- **Answers trimmed to the contract in one step.** A plain object that holds just what the
  contract lists goes to the native writer as it is; anything else is copied with only the
  declared fields first. The copy is faster than the writer it replaces.
- **Middleware without async frames of its own**, and bodies read without a promise.
- The numbers, phase by phase, are in [`bench/reports/0.6.0.md`](bench/reports/0.6.0.md).

### Fixed

- An answer can no longer carry a key its contract does not list through an object whose
  declared field came from its prototype or was not enumerable; such objects are copied
  with only the declared fields first.
- A declared field named like an `Object.prototype` member (`constructor`, `toString`) is
  left out when missing, instead of being written as `null`.
- An invalid `Date` in a `t.date()` field is written as `null` instead of throwing.
- Functions and symbols in object fields and records are left out, as `JSON.stringify`
  leaves them out, instead of being written as `null`.
- An event name like `constructor` is a contract error for `t.events()`, not a crash.

### Changed

- **The request id is no longer a UUID.** A fresh id is a random prefix made once per
  process, the cluster worker, and a counter: `0k3f9a2w3-1c8`. It is unique per process
  and worker, but not unguessable; an id a client sends is still used when it looks safe.
- **Seals are format 2.** `inkan seal` now stamps the checks only, and writing stays the
  schema's own, so a sealed contract can never write differently. A seal made by 0.5 is
  not used (with a warning) until `inkan seal` runs again.
- An answer that had to be trimmed is written in the order of its contract's fields; one
  that already fits keeps its own order, as before.

### For adapters

- `AdapterResponse.cookies` holds the Set-Cookie headers, one per cookie; an adapter writes
  each as a header of its own.

## 0.5.0

### New

- **Bodies as they come.** `t.binary()` takes the whole body as bytes, of any media type,
  for a file sent as the body itself. `t.stream()` hands the body to the handler unread, chunk
  by chunk as it arrives, for uploads larger than memory; past its limit the stream throws a
  413 problem, and an answer before the body is read (a 401, a problem the handler threw)
  still reaches the client. Both take `.max(bytes)` and `.accept(...types)`; anything else
  is a 415. OpenAPI lists the media types, and the typed client sends a `Blob`, bytes or a
  `ReadableStream` as they are.
- **A body limit per route.** `bodyLimit` on a route, or the `max` of a `t.binary()` or
  `t.stream()` body, instead of the app's. The limit is known before the body is read, so a
  request that says it is too large is a 413 at once. For adapters, `app.bodyFor(method,
  url)` names the limit and whether to hand the body over unread, as `stream` on
  `app.exchange()`; `app.fetch()` and `app.exchange()` keep to it.
- **`serveStatic({ dir, spa, exclude })`**, a plugin for the built frontend next to the API:
  hashed assets cached for a year, everything else asked for again, ETag and 304, HEAD, and
  with `spa` the `index.html` for every path without a file, except under `exclude`. Every
  route of the app wins against the files; nothing outside the folder and no dotfile is
  served.
- **`compress()`**, a plugin on one onSend hook: brotli or gzip, as the client's
  accept-encoding takes it, for text, JSON, JavaScript and SVG above a threshold, streams
  too, event streams not. `inject` unpacks what it gets, as `fetch` does.
- **`ctx.ip`**, the client's address, from the socket or from the platform (`app.fetch(req,
  { remote })`, an adapter's `remote`). `rateLimit` counts by it, so clients on Bun, Deno or
  an adapter are told apart too.
- **File routes under Vite.** The import that loads them is marked `@vite-ignore`, so a
  bundler that sees inkan as source no longer warns about it.

### Changed

- **@inkanjs/uws moved** to [inkanjs/integrations](https://github.com/inkanjs/integrations),
  next to `@inkanjs/next`, `@inkanjs/vite` and `@inkanjs/query`, and is on npm. The bench uses
  it from there.
- **Node 22 or newer.** The package said 20, which reached its end of life in April 2026
  and was never in CI; CI tests 22, 24 and 26.

## 0.4.0

### License

- inkan is under the [MIT license](LICENSE), and that covers 0.3.0 as well.

### New

- **Hooks.** `onRequest` (a route was found, the body is not read yet), `preHandler` (the
  input is checked and typed), `onSend` (every answer, problems too, and it may change it),
  `onResponse` (after the answer is written) and `onProblem` (every problem, before it is
  written, and it may change it or hand back another). `onRequest` and `preHandler` may
  answer by returning a value. Every route gets the hooks of its scope chain joined once,
  before the first request; a route with none takes the same path as before.
  ([#23](https://github.com/inkanjs/inkan/issues/23))
- **Plugins.** `app.register(plugin, { prefix, ...options })` runs a plugin with a scope of its
  own: its routes, hooks and decorations stay there, under its prefix. `plugin(fn, { shared:
  true })` makes one that adds to the scope it is registered in instead. Plugins load in
  order, an async one holds back the ones after it, `await app.ready()` waits for all of them,
  and one that fails stops `listen()`. `inject`, `check` and the CLI wait too. Their routes
  are in OpenAPI, on the docs page and in `inkan check` like any other.
  ([#23](https://github.com/inkanjs/inkan/issues/23))
- **Decorators.** `app.decorate("db", pool)` puts a value on every context in its scope,
  typed: the handler's `ctx.db` has the type of `pool`. It lives on the context's prototype,
  so it costs nothing per request. A name the context already has, by itself or from another
  decoration, is refused. ([#23](https://github.com/inkanjs/inkan/issues/23))
- **`rateLimit({ max, window, key })`**, a plugin built on nothing but these APIs: a 429
  problem with `retry-after` after `max` requests per client, and `x-ratelimit-remaining` on
  every answer. Registered in a plugin, it limits only that plugin's routes.
- **`inkan seal`: contracts as plain code.** `npx inkan seal src/app.ts` writes every contract
  out as code of its own into `inkan.seal.js` (with a `.d.ts`), and `inkan({ seal })` runs on
  it. The engine can tune code that only ever sees one shape: checking a body of 50 objects
  and writing an answer of 100 both take about half the time. A sealed contract does exactly
  what its schema does: the same values, the same messages and paths, and it keeps back every
  key the contract does not list. No eval and no `new Function`: what is in the file is what
  runs. At start the app writes the code again from the live contract and uses an entry only
  while the hashes match, so a contract that changed since runs unsealed and inkan says
  which; a seal of another format is not used at all. Equal contracts share one entry.
  `refine`, `transform`, unions, records, dates and lazy schemas run unsealed for now.
  ([#18](https://github.com/inkanjs/inkan/issues/18))
- **`app.fetch(request)`**: the app as a web-standard handler, a `Request` in and a `Response`
  out, for Bun, Deno and serverless platforms, with the same contracts, hooks, problems and
  streams. The body limit holds while the body is read, with or without a `content-length`;
  a stream the client stops reading stops its source; it waits for plugins like `listen`
  does. `{ remote }` passes the client's address where the platform knows it: the inspector
  answers only a loopback address, so without one it stays shut. CI runs the same requests
  on Bun and Deno. ([#14](https://github.com/inkanjs/inkan/issues/14))
- **Security schemes.** `security: "bearer" | "basic" | { apiKey, in }` on a route, a list for
  alternatives, `.security(…)` for a group, a plugin or the whole app, and `security: false`
  to open one route again. A request without the credentials is a 401 problem with
  `www-authenticate`, before its input is looked at; whether they are good stays the job of a
  hook or middleware. OpenAPI gets `components.securitySchemes`, `security` per operation
  and an implied 401; the docs page shows a lock and its token field starts on the right
  header. ([#12](https://github.com/inkanjs/inkan/issues/12))
- **Response headers in the contract.** `responseHeaders: { 201: { location: t.string() } }`
  goes into OpenAPI and onto the docs page, and in development an answer without a promised
  header (or with one of the wrong shape) breaks the contract like a wrong body does.
  ([#12](https://github.com/inkanjs/inkan/issues/12))
- **Routes from the file tree.** `app.load(new URL("./routes", import.meta.url))` defines a
  route for every file in a folder: `teas/[id].ts` exporting `GET` and `DELETE` is
  `/teas/:id`, `index` is its folder, `[...rest]` takes the rest. `route(spec, handler)` types
  the handler from the contract as `app.get` does. Nothing happens at import time; `load`
  runs in order with the plugins, `listen` waits for it, and in a plugin the routes go under
  its prefix. Files starting with `_`, `.d.ts` and test files are left alone. A file that
  exports no route says so by name. ([#6](https://github.com/inkanjs/inkan/issues/6))
- **Every core: `workers`.** `inkan({ workers: "auto" })` (or a number) runs one process per
  core on one port with `node:cluster`. The first process only looks after them: it replaces
  a worker that dies, stops instead of looping when they keep dying, and on SIGINT or SIGTERM
  asks every worker to finish its open requests and run its `onClose`. Log lines, the
  `listening` line and the inspector say which worker answered. The bench has an
  `inkan-cluster` entry next to the one-core ones. ([#24](https://github.com/inkanjs/inkan/issues/24))
- **Adapters: `app.exchange()`**, the one door for any server: a request in plain values, the
  answer in plain values, plus `app.started()` and `app.stopped()` for the onListen and
  onClose hooks. `listen` and `fetch` go through it too. The first adapter,
  [`@inkanjs/uws`](adapters/uws), runs an app on uWebSockets.js; it is installed apart, with
  uWebSockets.js as a peer you add on purpose (it comes from GitHub, which npm 12 only
  allows when asked), so inkan keeps no dependencies. One set of requests runs in CI against
  `listen`, `fetch` and every adapter, and the bench has an `inkan-uws` entry.
  ([#25](https://github.com/inkanjs/inkan/issues/25))
- **`inkan learn`, a tutorial in the terminal.** `npx @vxnsin/inkan learn` sets up a practice
  app and gives twelve quests, one idea each: a first route, typed params, rules for a body,
  examples as tests, problems, groups, security, hooks, the docs page (it sees you press
  send there), changes that break clients, the seal and plugins. Every save is checked
  through `inject` and answered with what is still missing; `h` gives a hint and then a
  clearer one, `s` skips, `o` saves the OpenAPI document, `w` writes the seal. The app runs
  on a port meanwhile, for `/docs` and `/_inkan`. inkan is linked into the practice folder
  instead of installed, so it works at once and offline, and the progress is kept. Every
  quest has a test that solves it, so CI keeps the tutorial working.
  ([#26](https://github.com/inkanjs/inkan/issues/26))
- **How fast, in the README.** Twelve scenarios next to node:http, Fastify, Hono and Express,
  every answer checked before it is measured. The bench now runs every server at once and
  measures each scenario for all of them back to back, in a turning order, so a runner that
  slows down over the hour slows everybody alike. On a 4-core GitHub runner inkan scores
  85.4 against bare node:http, next to Hono (85.0) and Fastify (88.1), and 133.5 on
  uWebSockets.js. ([#18](https://github.com/inkanjs/inkan/issues/18))
- **`bench/cpu.mjs`**: the CPU time one request costs the server, next to the others, which
  does not depend on how fast the load generator is. The bench workflow runs it with
  `kind: cpu` (or `both`).

### Fixed

- **Keys the contract does not list no longer leave the server in production.** The README
  promised that a `passwordHash` on a returned row never goes out, but only development
  dropped such keys: with `NODE_ENV=production` the answer went out as the handler returned
  it. Every answer with a schema is now written by a writer built from that schema, in every
  mode, and it writes only what the schema lists, at every depth: objects, arrays, records,
  discriminated unions and recursive shapes. `.passthrough()` still keeps everything, and a
  `.transform()` writes what it made. Affects every release up to 0.3.0; update.
- **A path that starts with `//` is routed as that path.** The request target was read with
  `new URL()`, which takes `//elsewhere/x` for a host and a path, so such a request was routed
  as `/x`. inkan now splits the target itself; `ctx.url` is still a `URL`, built from the
  `Host` header when a handler asks for it.
- **The docs page and the inspector escape everything they render**, including operation ids,
  methods, statuses and the links from the app's options, and they only send a request (with
  its token) when it stays on the same origin. A replay of a recorded `//elsewhere/x` is
  refused instead of going to another host. Found by Socket's code analysis.
- **Answers have a `content-length` again.** `writeHead` fixed the headers before the body was
  known, so Node sent every answer with chunked encoding: extra framing on each response and
  a higher tail latency under load. A whole body now goes out with its length; streams stay
  chunked, and a `HEAD` tells the length the `GET` has.

### Changed

- Answers with a schema are written by that schema's own writer, built once per schema,
  instead of by `JSON.stringify`.
- **Faster request path.** Static paths are one map lookup instead of a walk, parameters are
  collected without a copy per level, and `decodeURIComponent` only runs on paths that need it.
  A route without middleware calls its handler directly, a sync handler and a request without a
  multipart body cost no extra await, request headers are no longer copied, the socket address
  is only read for the inspector, the body is read with events, and the log entry and the timer
  only exist when something logs, and a context and a request target have one stable shape.
  inkan's own time per request is about halved (`bench/inproc.mjs`: 7.0 → 2.9 µs for a fixed
  answer, 8.8 → 4.6 µs with params and query, 8.7 → 4.8 µs with a JSON body).
- **Errors and big answers are cheap too.** A problem no longer captures a stack trace (nobody
  reads one for a 404 or a 400, and it made every error several times slower than a 200), and
  problem answers are built without copying objects. An answer that holds exactly what its
  contract lists, the usual case, is checked by counting keys and then written by the native
  `JSON.stringify`; only an answer with keys the contract does not list takes the exact writer.
  A list of 100 nested objects: 80 → 51 µs.
- **Big bodies and big answers, without a seal.** A checked value no longer builds the path of
  every field on the way (`items[3].name`); children are checked relative to their parent, and
  only an issue gets its full path. And the check that an answer holds nothing extra tests
  primitive fields inline instead of calling out for each. Checking a body of 50 objects:
  21.7 → 11.3 µs; writing an answer of 100: 64 → 46 µs. Messages and paths are the same.
- **No promise unless something is asynchronous.** A request without a body whose handler
  answers at once now goes from socket to answer in one turn, without a promise, a closure
  per step or a trip through the microtask queue; only a body to read, middleware or an async
  handler makes it asynchronous. A 404 or 405 is answered, not thrown, and a problem is no
  longer built by the `Error` constructor, which records a stack even when told not to
  (`instanceof Error` still holds, and `.stack` is its first line). The router walks the path
  in place instead of splitting it into an array. Per request in `bench/inproc.mjs`: 404
  6.9 → 4.4 µs, 400 14.0 → 10.9 µs, a deep parameter route 3.9 → 3.5 µs, an async handler
  7.3 → 6.5 µs.

## 0.3.0

### New

- **More schema power.** `t.date()` takes ISO date-time strings (or `Date`s) and hands the
  handler a `Date`; answers send it back as an ISO string. `.refine(fn, message)` adds your
  own rules, `.transform(fn)` changes the parsed value, `t.discriminated(key, options)` picks
  one branch by its tag (OpenAPI `oneOf` with a `discriminator`), and `t.lazy(() => schema)`
  makes recursive shapes possible. Thanks [@AndrewCMD](https://github.com/AndrewCMD)!
  ([#13](https://github.com/inkanjs/inkan/issues/13), [#22](https://github.com/inkanjs/inkan/pull/22))
- The help text is coloured, and so are logs in GitHub Actions (`NO_COLOR` still turns it off).
- **Request ids.** Every request gets one: the `x-request-id` it came with when that looks safe,
  a fresh UUID otherwise. It is `ctx.id` in the handler, goes back out as a header, and lands in
  the log line, the inspector and every problem document as `requestId`. `requestId: "x-correlation-id"`
  picks another header, `requestId: false` turns it off. ([#15](https://github.com/inkanjs/inkan/issues/15))
- **Structured logs.** `log: "json"` writes one JSON line per request (time, id, method, path,
  route, status, ms, notes), and `logger: (entry) => …` hands every entry to your own logger
  instead of the console. ([#15](https://github.com/inkanjs/inkan/issues/15))
- **Edit a request on the docs page.** Every example has an **edit** button: params, query,
  headers and body, filled in from the example, sent as you changed them. An edited request
  says so and never counts towards a route's seal. **reset** brings the example back, and
  **curl** copies the request as a curl command. ([#8](https://github.com/inkanjs/inkan/issues/8))
- **A token for the docs page.** A field at the top puts an `authorization` or `x-api-key`
  header on every request from the page. It lives in `sessionStorage`, so it is gone with
  the tab, never lands in a URL, and shows as ••• in a copied curl command.
  ([#8](https://github.com/inkanjs/inkan/issues/8))
- **Inspector: replay.** Sends a request again and shows the old and the new answer side by
  side, with whether they match (a `requestId` alone does not count as a change). Secret
  headers are not sent again, and the page says so. The replay shows up in the log as
  `replay of #n`. ([#7](https://github.com/inkanjs/inkan/issues/7))
- **Inspector: copy as example.** Turns a request into a ready `examples: [...]` entry with
  its params, query, body and status, plus any custom headers, but never secret headers or
  the ones every client sends. Paste it into the route and `inkan check` holds it from then on.
  ([#7](https://github.com/inkanjs/inkan/issues/7))
- **`inkan examples`.** Pulls a complete example project into a folder, explained file by file:
  a README per example that says what to read in which order, numbered comments in the code,
  something to change first, and a "try this: break it on purpose" list that shows what inkan
  catches. Six of them, in reading order: `hello`, `tea-shop`, `auth`, `testing`, `openapi`,
  `deploy`. `npx @vxnsin/inkan examples` asks which one, `--list` lists them,
  `inkan examples tea-shop my-shop` goes straight there. A folder that is not empty needs
  `--force`. The templates ship inside the package, so it works offline and fits the installed
  version, and every one of them passes `inkan check --strict` in CI.
  ([#1](https://github.com/inkanjs/inkan/issues/1))
- **`inkan diff`.** Compares a saved OpenAPI document with the app, or two documents, and says
  what would break a client written against the old one: a route or a status that is gone, a
  field or parameter that is required now, a value a request may no longer send, a tighter
  limit or pattern, a field an answer may leave out or set to null now. Requests may only get
  looser and answers only stricter. Everything else is listed as safe. It exits with `1` when
  something breaks, so CI can ask for a major version; `--json` for tools. Also as
  `diffOpenAPI(before, after)`. ([#11](https://github.com/inkanjs/inkan/issues/11))
- **Examples that build on each other.** An example can `keep` values from its answer
  (`keep: { id: "body.id" }`, also `headers.…` and `status`), and another one can run
  `after` it (`after: "POST /teas > a new oolong"`) and use them as `{id}` in its params,
  query, headers and body. `beforeEach` runs once before the whole chain, the order comes from
  `after` rather than from the files, and a broken step, an `after` that points nowhere or a
  circle each fail with a sentence that says which. The docs page runs the chain when you
  press send, and the tea-shop example shows it. ([#10](https://github.com/inkanjs/inkan/issues/10))
- **Streams.** A handler may return a Node `Readable`, a web `ReadableStream` or any async
  iterable; it goes out piece by piece, with backpressure, and stops when the client leaves.
  ([#5](https://github.com/inkanjs/inkan/issues/5))
- **Server-sent events.** `sse(async function* (signal) { … })` answers with an event stream,
  and `t.events({ tick: … })` puts one schema per event into the contract and into OpenAPI as
  `text/event-stream`. The signal fires when the client goes away, quiet streams get a
  keep-alive comment, and in development an event that breaks its schema ends the stream with
  an `error` event. `inkan check`, `app.inject({ events: n })` and the docs page read as many
  events as an example expects, so endless streams can be examples too.
  ([#5](https://github.com/inkanjs/inkan/issues/5))
- **Uploads.** `t.file().max(bytes).accept("image/*")` in a body makes it
  `multipart/form-data`, parsed by the platform itself, with no dependency. Files arrive as
  `{ name, type, size, data }`, the fields next to them are coerced like a query, and a file
  that is too big or of the wrong type is a 400 that says which. `fileExample(name, content,
  type)` puts a file into an example; `inject` takes a `FormData` too.
  ([#5](https://github.com/inkanjs/inkan/issues/5))
- **A typed client, with no codegen.** `client<typeof api>(baseUrl)` from
  `@vxnsin/inkan/client` takes its types from the app: paths, params, query, body and every
  answer per status, with Dates as the strings they arrive as. A wrong path, a missing param
  or a body of the wrong shape does not compile. Failures come back as problem documents,
  never as thrown errors. It is a few lines around `fetch` with no server code in it, so it
  runs in a browser too; `{ fetch }` and `{ headers }` (also as a function, for fresh tokens)
  are optional. The routes have to be defined in a chain (`inkan().get(…).post(…)`, also
  `mount`) for the type to see them. ([#2](https://github.com/inkanjs/inkan/issues/2))

### Changed

- `toJSONSchema()` keeps named schemas in `$defs` and refers to them, instead of writing them
  out inline, so recursive schemas work there too.
- In production, requests are now logged as JSON lines by default (before: not at all).
  `log: false` keeps it quiet. Development keeps the short coloured line.
- Inspector log entries carry `example` and `request.clipped`. A request whose body was too
  long to keep whole is not offered for replay, and its example leaves the body out instead
  of guessing.

## 0.2.0

### New

- **CORS out of the box.** `OPTIONS` answers on its own with an `Allow` header, and
  `app.use(cors({ origin, credentials, maxAge }))` handles preflights for one origin,
  a list, a function or any. Error answers keep the CORS headers, so a page can read
  a 404 instead of hitting a CORS error. ([#3](https://github.com/inkanjs/inkan/issues/3))
- **`inkan check` shows what no example covers.** A status the contract promises but no
  example answers with is listed under its route and on the docs page. `--strict`
  (or `app.check({ strict: true })`) turns it into a failure, for CI.
  ([#9](https://github.com/inkanjs/inkan/issues/9))
- **Lifecycle hooks.** `app.onListen()` runs before `listen()` resolves, and a throw rejects it.
  `app.onClose()` runs on SIGINT and SIGTERM after the last request, still within
  the ten seconds. Thanks [@RinZ27](https://github.com/RinZ27)!
  ([#16](https://github.com/inkanjs/inkan/issues/16), [#20](https://github.com/inkanjs/inkan/pull/20))
- **Colour in the terminal.** The start banner, the request log, `check` and `routes` are
  coloured: the seal is red, methods and statuses have their own colours. Off when the
  output is not a terminal or `NO_COLOR` is set, on with `FORCE_COLOR`.

### Changed

- The `Allow` header of a 405 now lists `OPTIONS` too.
- Headers that middleware set stay on error answers.
- `CheckReport` has a new `uncovered` list.

### Behind the scenes

- The CLI has its own tests: exit codes, `--json`, `--only`, `--strict`, `openapi`, `routes`
  and the usage errors. ([#17](https://github.com/inkanjs/inkan/issues/17))
- One GitHub release publishes to npmjs.com (trusted publishing, with provenance) and to GitHub Packages, and
  only when the tag matches `package.json`. ([#4](https://github.com/inkanjs/inkan/issues/4))

## 0.1.0

The first release: one contract per route gives you validation, typed handlers, response
checks, OpenAPI 3.1, a docs page, examples that run as tests, a request inspector and
RFC 9457 errors, with no runtime dependencies.
