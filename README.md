<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/wordmark-dark.svg"><img src="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/wordmark-light.svg" alt="inkan" width="340"></picture>

**An API framework for Node where the docs can't lie.** It runs on `node:http`, and on Bun, Deno and serverless through `app.fetch`.

**[Docs](https://inkan-dev.vercel.app/docs)** · [API](https://inkan-dev.vercel.app/docs/api/app) · [Benchmarks](https://inkan-dev.vercel.app/benchmarks) · [Changelog](CHANGELOG.md)

[![docs](https://img.shields.io/badge/docs-inkan--dev.vercel.app-c4381f?labelColor=2b2420)](https://inkan-dev.vercel.app/docs)
[![npm](https://img.shields.io/npm/v/@vxnsin/inkan?color=c4381f&labelColor=2b2420&label=npm)](https://www.npmjs.com/package/@vxnsin/inkan)
[![CI](https://img.shields.io/github/actions/workflow/status/inkanjs/inkan/ci.yml?branch=main&color=3d7a4b&labelColor=2b2420&label=ci)](https://github.com/inkanjs/inkan/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-ece1cf?labelColor=2b2420)](package.json)
[![License](https://img.shields.io/badge/license-MIT-a87fe0?labelColor=2b2420)](LICENSE)
[![supports warden](https://raw.githubusercontent.com/vxnsin/warden/main/assets/supports-warden.svg)](https://github.com/vxnsin/warden)

<p align="center"><img src="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/demo.svg" width="840" alt="A route with its contract, a request that breaks it and gets a 400 naming the field, and inkan check passing every example"></p>

<!-- cozy:cards -->
<div align="center">

<a href="https://github.com/inkanjs/inkan"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/repo-dark.svg?v=341b4d3b58"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/repo-light.svg?v=341b4d3b58" width="840" alt="inkanjs/inkan: An API server for Node where the docs can't lie: one contract per route gives you validation, types, OpenAPI, docs and tests."></picture></a>

<a href="https://github.com/inkanjs/inkan#install"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-start-dark.svg?v=c2e08cb92e"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-start-light.svg?v=c2e08cb92e" width="95" alt="install →"></picture></a><a href="https://www.npmjs.com/package/@vxnsin/inkan"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-npm-dark.svg?v=513902168b"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-npm-light.svg?v=513902168b" width="50" alt="npm"></picture></a><a href="https://github.com/vxnsin/warden"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-warden-dark.svg?v=0e950205da"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/nav-warden-light.svg?v=0e950205da" width="69" alt="warden"></picture></a>

<a href="https://github.com/inkanjs/inkan/commits"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/commits-dark.svg?v=c039ece1ba"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/commits-light.svg?v=c039ece1ba" width="840" alt="latest commits of inkanjs/inkan"></picture></a>

<a href="https://github.com/inkanjs/inkan/releases"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/releases-dark.svg?v=2bd5e1e0a4"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/releases-light.svg?v=2bd5e1e0a4" width="840" alt="releases: v0.6.0, v0.5.0, v0.4.0, v0.3.0"></picture></a>

<a href="https://github.com/inkanjs/inkan/graphs/contributors"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/output/contributors-dark.svg?v=3e8ddd5683"><img src="https://raw.githubusercontent.com/inkanjs/inkan/output/contributors-light.svg?v=3e8ddd5683" width="840" alt="contributors: vxnsin, AndrewCMD, RinZ27"></picture></a>

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
| Credentials in the contract, refused with a 401 when missing | middleware | plugin | middleware | ✓ `security`, in OpenAPI too |
| Contracts as compiled code | – | at runtime, with `new Function` | – | ✓ ahead of time, `inkan seal`, no eval |
| Hooks, plugins, decorators | middleware | ✓ | middleware | ✓ |
| Bun, Deno, serverless | – | – | ✓ | ✓ `app.fetch` |
| **A tutorial in the terminal** | – | – | – | ✓ `inkan learn` |
| Runtime dependencies | several | several | none | **none** |

## Install

```sh
npm install @vxnsin/inkan
```

The package is scoped because npm keeps the plain name `inkan` free of look-alikes. The command it installs is `inkan` either way.

Node 22 or newer. On Node 22.18 and newer, `.ts` files run as they are,
with no build step and no loader.

**New here? Start with the tutorial.** It runs in your terminal, offline:

```sh
npx @vxnsin/inkan learn
```

It sets up a small tea shop and gives you twelve quests, one idea each: a first
route, typed params, rules for a body, examples as tests, problems, groups,
security, hooks, the docs page, changes that break clients, the seal and plugins.
inkan checks your work every time you save, says what is still missing, and
gives a hint (then a clearer one) when you press `h`. It keeps your progress, so
`npx @vxnsin/inkan learn` again goes on where you stopped.

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

## Learn more

Everything else lives on **[the website](https://inkan-dev.vercel.app/docs)**:

| | |
| --- | --- |
| [Routes](https://inkan-dev.vercel.app/docs/routes) and [Schemas](https://inkan-dev.vercel.app/docs/schemas) | the contract: params, query, body, responses, examples |
| [Examples are tests](https://inkan-dev.vercel.app/docs/examples) | `inkan check`, examples that build on each other |
| [Streams, events and uploads](https://inkan-dev.vercel.app/docs/streams) | server-sent events, rows as they come, CSV, files, bodies larger than memory |
| [Typed client](https://inkan-dev.vercel.app/docs/client) | a client typed from the app itself, no code generation |
| [Middleware](https://inkan-dev.vercel.app/docs/middleware) and [Hooks](https://inkan-dev.vercel.app/docs/hooks) | groups, credentials, CORS, plugins, decorators |
| [API](https://inkan-dev.vercel.app/docs/api/app) | the app, routing, the context (text, html, cookies, redirects), schemas and problems |
| [Sealed contracts](https://inkan-dev.vercel.app/docs/seal) | contracts compiled ahead of time, no `eval` |
| [Running it](https://inkan-dev.vercel.app/docs/deploy) | node, systemd, pm2, containers, workers, Bun, Deno, serverless |
| [Integrations](https://inkan-dev.vercel.app/docs/integrations) | Next.js, Vite, TanStack Query, uWebSockets.js |
| [CLI](https://inkan-dev.vercel.app/docs/cli) | `inkan check`, `inkan seal`, `inkan learn`, `inkan examples`, `inkan create plugin` |

## How fast

Twelve scenarios, every server doing the same work and every answer checked before it is
measured, with a bare `node:http` server as 100:

| | node:http | **inkan** | Fastify | Hono | Express |
| --- | ---: | ---: | ---: | ---: | ---: |
| score | 100 | **89.1** | 88.6 | 84.9 | 42.4 |

inkan and Fastify are level within the spread of a run. Every scenario, how it is measured
and how to run it yourself are on **[the benchmarks page](https://inkan-dev.vercel.app/benchmarks)**;
how 0.6.0 got there is in [`bench/reports/0.6.0.md`](bench/reports/0.6.0.md), and the bench
itself in [`bench/`](bench).

## How inkan is made

inkan is designed and maintained by Vensin. Much of the code is written together with an AI
assistant (Claude Code), and none of it goes in unchecked: I read every change, run it on my
own hardware and put it through a full security review before it is merged. Every change
lands with tests, over 200 of them, run on every commit, and every example in the docs is
one of them. I make mistakes too; this process is there to catch them before you do.

## License

[MIT](LICENSE)
