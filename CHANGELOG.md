# Changelog

## Unreleased

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
