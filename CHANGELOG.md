# Changelog

## Unreleased

### License

- inkan is under the [MIT license](LICENSE), and that covers 0.3.0 as well.

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

## 0.3.0

### New

- **More schema power.** `t.date()` takes ISO date-time strings (or `Date`s) and hands the
  handler a `Date`; answers send it back as an ISO string. `.refine(fn, message)` adds your
  own rules, `.transform(fn)` changes the parsed value, `t.discriminated(key, options)` picks
  one branch by its tag (OpenAPI `oneOf` with a `discriminator`), and `t.lazy(() => schema)`
  makes recursive shapes possible. Thanks [@AndrewCMD](https://github.com/AndrewCMD)!
  ([#13](https://github.com/vxnsin/inkan/issues/13), [#22](https://github.com/vxnsin/inkan/pull/22))
- The help text is coloured, and so are logs in GitHub Actions (`NO_COLOR` still turns it off).
- **Request ids.** Every request gets one: the `x-request-id` it came with when that looks safe,
  a fresh UUID otherwise. It is `ctx.id` in the handler, goes back out as a header, and lands in
  the log line, the inspector and every problem document as `requestId`. `requestId: "x-correlation-id"`
  picks another header, `requestId: false` turns it off. ([#15](https://github.com/vxnsin/inkan/issues/15))
- **Structured logs.** `log: "json"` writes one JSON line per request (time, id, method, path,
  route, status, ms, notes), and `logger: (entry) => …` hands every entry to your own logger
  instead of the console. ([#15](https://github.com/vxnsin/inkan/issues/15))
- **Edit a request on the docs page.** Every example has an **edit** button: params, query,
  headers and body, filled in from the example, sent as you changed them. An edited request
  says so and never counts towards a route's seal. **reset** brings the example back, and
  **curl** copies the request as a curl command. ([#8](https://github.com/vxnsin/inkan/issues/8))
- **A token for the docs page.** A field at the top puts an `authorization` or `x-api-key`
  header on every request from the page. It lives in `sessionStorage`, so it is gone with
  the tab, never lands in a URL, and shows as ••• in a copied curl command.
  ([#8](https://github.com/vxnsin/inkan/issues/8))
- **Inspector: replay.** Sends a request again and shows the old and the new answer side by
  side, with whether they match (a `requestId` alone does not count as a change). Secret
  headers are not sent again, and the page says so. The replay shows up in the log as
  `replay of #n`. ([#7](https://github.com/vxnsin/inkan/issues/7))
- **Inspector: copy as example.** Turns a request into a ready `examples: [...]` entry with
  its params, query, body and status, plus any custom headers, but never secret headers or
  the ones every client sends. Paste it into the route and `inkan check` holds it from then on.
  ([#7](https://github.com/vxnsin/inkan/issues/7))
- **`inkan examples`.** Pulls a complete example project into a folder, explained file by file:
  a README per example that says what to read in which order, numbered comments in the code,
  something to change first, and a "try this: break it on purpose" list that shows what inkan
  catches. Six of them, in reading order: `hello`, `tea-shop`, `auth`, `testing`, `openapi`,
  `deploy`. `npx @vxnsin/inkan examples` asks which one, `--list` lists them,
  `inkan examples tea-shop my-shop` goes straight there. A folder that is not empty needs
  `--force`. The templates ship inside the package, so it works offline and fits the installed
  version, and every one of them passes `inkan check --strict` in CI.
  ([#1](https://github.com/vxnsin/inkan/issues/1))
- **`inkan diff`.** Compares a saved OpenAPI document with the app, or two documents, and says
  what would break a client written against the old one: a route or a status that is gone, a
  field or parameter that is required now, a value a request may no longer send, a tighter
  limit or pattern, a field an answer may leave out or set to null now. Requests may only get
  looser and answers only stricter. Everything else is listed as safe. It exits with `1` when
  something breaks, so CI can ask for a major version; `--json` for tools. Also as
  `diffOpenAPI(before, after)`. ([#11](https://github.com/vxnsin/inkan/issues/11))
- **Examples that build on each other.** An example can `keep` values from its answer
  (`keep: { id: "body.id" }`, also `headers.…` and `status`), and another one can run
  `after` it (`after: "POST /teas > a new oolong"`) and use them as `{id}` in its params,
  query, headers and body. `beforeEach` runs once before the whole chain, the order comes from
  `after` rather than from the files, and a broken step, an `after` that points nowhere or a
  circle each fail with a sentence that says which. The docs page runs the chain when you
  press send, and the tea-shop example shows it. ([#10](https://github.com/vxnsin/inkan/issues/10))
- **Streams.** A handler may return a Node `Readable`, a web `ReadableStream` or any async
  iterable; it goes out piece by piece, with backpressure, and stops when the client leaves.
  ([#5](https://github.com/vxnsin/inkan/issues/5))
- **Server-sent events.** `sse(async function* (signal) { … })` answers with an event stream,
  and `t.events({ tick: … })` puts one schema per event into the contract and into OpenAPI as
  `text/event-stream`. The signal fires when the client goes away, quiet streams get a
  keep-alive comment, and in development an event that breaks its schema ends the stream with
  an `error` event. `inkan check`, `app.inject({ events: n })` and the docs page read as many
  events as an example expects, so endless streams can be examples too.
  ([#5](https://github.com/vxnsin/inkan/issues/5))
- **Uploads.** `t.file().max(bytes).accept("image/*")` in a body makes it
  `multipart/form-data`, parsed by the platform itself, with no dependency. Files arrive as
  `{ name, type, size, data }`, the fields next to them are coerced like a query, and a file
  that is too big or of the wrong type is a 400 that says which. `fileExample(name, content,
  type)` puts a file into an example; `inject` takes a `FormData` too.
  ([#5](https://github.com/vxnsin/inkan/issues/5))
- **A typed client, with no codegen.** `client<typeof api>(baseUrl)` from
  `@vxnsin/inkan/client` takes its types from the app: paths, params, query, body and every
  answer per status, with Dates as the strings they arrive as. A wrong path, a missing param
  or a body of the wrong shape does not compile. Failures come back as problem documents,
  never as thrown errors. It is a few lines around `fetch` with no server code in it, so it
  runs in a browser too; `{ fetch }` and `{ headers }` (also as a function, for fresh tokens)
  are optional. The routes have to be defined in a chain (`inkan().get(…).post(…)`, also
  `mount`) for the type to see them. ([#2](https://github.com/vxnsin/inkan/issues/2))

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
  a 404 instead of hitting a CORS error. ([#3](https://github.com/vxnsin/inkan/issues/3))
- **`inkan check` shows what no example covers.** A status the contract promises but no
  example answers with is listed under its route and on the docs page. `--strict`
  (or `app.check({ strict: true })`) turns it into a failure, for CI.
  ([#9](https://github.com/vxnsin/inkan/issues/9))
- **Lifecycle hooks.** `app.onListen()` runs before `listen()` resolves, and a throw rejects it.
  `app.onClose()` runs on SIGINT and SIGTERM after the last request, still within
  the ten seconds. Thanks [@RinZ27](https://github.com/RinZ27)!
  ([#16](https://github.com/vxnsin/inkan/issues/16), [#20](https://github.com/vxnsin/inkan/pull/20))
- **Colour in the terminal.** The start banner, the request log, `check` and `routes` are
  coloured: the seal is red, methods and statuses have their own colours. Off when the
  output is not a terminal or `NO_COLOR` is set, on with `FORCE_COLOR`.

### Changed

- The `Allow` header of a 405 now lists `OPTIONS` too.
- Headers that middleware set stay on error answers.
- `CheckReport` has a new `uncovered` list.

### Behind the scenes

- The CLI has its own tests: exit codes, `--json`, `--only`, `--strict`, `openapi`, `routes`
  and the usage errors. ([#17](https://github.com/vxnsin/inkan/issues/17))
- One GitHub release publishes to npmjs.com (trusted publishing, with provenance) and to GitHub Packages, and
  only when the tag matches `package.json`. ([#4](https://github.com/vxnsin/inkan/issues/4))

## 0.1.0

The first release: one contract per route gives you validation, typed handlers, response
checks, OpenAPI 3.1, a docs page, examples that run as tests, a request inspector and
RFC 9457 errors, with no runtime dependencies.
