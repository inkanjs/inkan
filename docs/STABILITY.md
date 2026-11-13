# Stability

From 0.8.0, exports marked stable follow these rules: nothing is removed or changes meaning
in a minor release. A rename or removal ships first as a deprecated alias (`@deprecated` in
the types, plus a one-time `console.warn` in development) for at least two minor releases
and at least 6 months, and only then is removed in a later minor, listed under "Removed" in
the CHANGELOG. Changing a default or a type in a way that breaks code follows the same rule.
Exports marked `@experimental` may change in any minor; the CHANGELOG names every such
change. Anything not exported from `@inkanjs/inkan` or `@inkanjs/inkan/client`, anything named
`_x`, and anything marked `@internal` is not API. Security fixes may break behaviour
immediately; they are announced in the CHANGELOG. Plugins should declare
`inkan: ">=0.8.0 <1.0.0"`.

New members of the request context (`ctx`) are announced a release ahead: the name is
reserved first, and a decoration that already uses it gets a warning in development. Reserved
now: `ctx.log`, `ctx.startedAt` and, since 0.10.0, `ctx.mcp` (`ctx.httpVersion` arrived in 0.8.0).

The whole public surface, as its types say it, is committed in
[`api/inkan.d.ts.txt`](../api/inkan.d.ts.txt). A test fails when it changes without that file
being updated (`npm run api:update`), so every change to the API shows in review.

## Stable

- `inkan`, `App` (its public methods), `Scope`, `plugin`, `Plugin`, `PluginOptions`,
  `register`, `decorate`, `decorateRequest` (the form without options)
- the five request hooks: `onRequest`, `preHandler`, `onSend`, `onResponse`, `onProblem`
- `Routes`, `routes`, `mount`, `route`, `FileRoute`, `load`
- `get`, `post`, `put`, `patch`, `delete`, `all`
- `reply`, `Reply`, `ReplyHeaders`, `Context`, `Handler`, `Middleware`, `RouteSpec`,
  `Responses`, `Example`, `Security`, `RouteInfo`, `RouteMeta`, `PathParams`
- `t`, `Schema`, `ValidationError`, `Infer`, `Issue`, `SafeResult`, `JsonSchema`,
  `UploadedFile`
- `problem`, `HttpProblem`, `ProblemBody`, `ProblemOptions`
- `sse`, `EventStream`, `SseEvent`, `ServerEvent`
- `html`, `raw`, `SafeHtml`, `parseCookies`, `serializeCookie`, `CookieOptions`,
  `CsvOptions`, `RedirectStatus`
- `cors`, `rateLimit`, `serveStatic`, `compress` and their option types; `Origins`,
  `PreContext`
- `inject`, `InjectOptions`, `InjectResponse`, `listener`, `fetch`, `exchange`,
  `AdapterRequest`, `AdapterResponse`, `bodyFor`, `logRequest`, `listen`, `ListenOptions`,
  `RequestLog`, `RegisterOptions`, `joinPath`
- `Layout`, `TrustProxy`, `CacheRule`, `fileExample`, `env`, `Store`, `memoryStore`
- from `@inkanjs/inkan/client`: `client`, `Client`, `ClientOptions`, `Answer`, `Input`,
  `Jsonify`, `StreamError`

## Stable: the command line

From 0.9.0 the CLI follows the same rules, for what scripts and CI read from it:

- the exit codes of `inkan check`, `inkan diff`, `inkan openapi` and `inkan routes`: `0` all
  good; `1` the result failed (an example broke, with `--strict` also a promised status no
  example shows, or a change breaks clients); `2` nothing was checked: a usage error (a
  missing argument, an unknown option, an option without its value, a `--format` it does not
  know) or a load error (no such file, the entry throws while it loads or in `app.ready()`,
  it exports no app, a JSON file it cannot read, `-o` it cannot write)
- `inkan openapi <entry> [-o <file>]`: the app's OpenAPI 3.1 document as JSON, to the file or
  to stdout
- `inkan diff <before> <after> --json` (or `--format json`): a JSON array of
  `{ breaking: boolean, kind: string, where: string, message: string }`, the breaking ones
  first. `where` is `METHOD /path` as OpenAPI writes the path; `kind` is one of `ChangeKind`;
  `message` is for people, and its wording may change. New kinds may come in a minor release
  (for changes not told apart before); an existing kind keeps its name and meaning.
- `inkan check <entry> --json` (or `--format json`): a `CheckReport`, `{ ok, passed, failed,
  results, unchecked, uncovered, untested }`, each result `{ method, path, example, ok, status,
  ms, problems }` (`problems` is a list of strings for people, worded as they may be).
- the flags `--json`, `--format terminal|json|markdown`, `--strict`, `--only`, `-o`/`--out`

New fields may be added to these objects in a minor release; none is removed or changes its
meaning. The terminal and Markdown text is for people and is not stable.

## Experimental

- MCP: the app's `mcp` option, a route's `mcp`, `app.mcp()`, `McpOptions`, `McpRoute`,
  `McpTool`, `McpServer`, `McpAnnotations`, `inkan mcp`, `inkan check --mcp` and
  `CheckOptions.mcp`, `CheckResult.via`, and the tool results' `_meta["dev.inkan/status"]`
- `untested` on a route, and `CheckOptions.untested` (with the CLI reading an entry's
  `export const untested`)
- `formatDiffMarkdown`, `formatReportMarkdown`, `ChangeKind`
- jobs: `job`, `Job*` types, the `schedule` option
- WebSockets: `ws`, `Ws*` types, `client.ws`, `upgradeListener`, the app's `ws` option
- `app.upgrade` and its types for adapters: `WsUpgrade`, `WsRefusal`, `WsTransport`, `WsEvents`
- `client.events`
- `pressure` (the option, `app.pressure()`, `Pressure*` types)
- `currentContext()` and the `context` option
- `seal`, `Seal`, `sealed()`
- `decorateRequest` with options (`resolve`, `when`)
- `onOperation`, `OperationHook`, `OperationRoute`
- the hook `order` option (`HookOptions`)
- `workers`
- `diffOpenAPI`, `formatDiff`, `Change`
- `check`, `CheckOptions`, `CheckReport`, `CheckResult`, `formatReport`, `FormatOptions`,
  `partialMatch`
- `PluginOptions.inkan`
- `around()`
- `stateKey`, `StateKey`

## Deprecated in 0.8.0

| Old | New |
| --- | --- |
| `scope.describe(fn)` | `scope.onOperation(fn)` |
| `decorateRequest(…, { before: "handler" })` | `decorateRequest(…, { resolve: "preHandler" })` |
| `onSend(fn, { last: true })` | `onSend(fn, { order: "last" })` |
| `register(plugin, { prefix })` | `register(plugin, options, { prefix })` |
| a plugin reading `options.prefix` | `scope.prefix` |
| `app.job(path, { keep })`, seconds | `{ retain }`, milliseconds |
| `app.job(path, { every })` | `{ schedule }` |
| route `cache: { seconds }` | `cache: { ttl }`, milliseconds |
| `wsOrigins` option, `WsOrigins` | `ws: { origins }`, `Origins` |
| `cors({ origin })` | `cors({ origins })` |
| `app.use(cors())` | `app.register(cors())` |
| `context()` | `currentContext()` |
| `buildOpenAPI(routes)` | `app.openapi()` |
| `JobStore` | `Store` |
