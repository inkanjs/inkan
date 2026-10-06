# Changelog

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
- One GitHub release publishes to npmjs.com (with provenance) and to GitHub Packages, and
  only when the tag matches `package.json`. ([#4](https://github.com/vxnsin/inkan/issues/4))

## 0.1.0

The first release: one contract per route gives you validation, typed handlers, response
checks, OpenAPI 3.1, a docs page, examples that run as tests, a request inspector and
RFC 9457 errors, with no runtime dependencies.
