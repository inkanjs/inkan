# Changelog

## Unreleased

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

### Changed

- `toJSONSchema()` keeps named schemas in `$defs` and refers to them, instead of writing them
  out inline, so recursive schemas work there too.
- In production, requests are now logged as JSON lines by default (before: not at all).
  `log: false` keeps it quiet. Development keeps the short coloured line.
- Inspector log entries carry `example` and `request.clipped`. A request whose body was too
  long to keep whole is not offered for replay, and its example leaves the body out instead
  of guessing.

### License

- **inkan is no longer MIT.** From this release on it is under the
  [Non-Sale & No Misrepresentation License](LICENSE). You may still use, copy, change and
  share it for free, also inside commercial products and services. What is new: inkan itself
  may not be sold, rented or licensed for money, and nobody may claim to be its original
  author. The license text has to travel with every copy. Versions up to 0.2.0 stay under
  MIT, as they were published.

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
