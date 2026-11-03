<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/wordmark-dark.svg"><img src="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/wordmark-light.svg" alt="inkan" width="300"></picture>

An API framework for Node where the docs can't lie.

[![npm](https://img.shields.io/npm/v/@vxnsin/inkan?color=c4381f&labelColor=2b2420&label=npm)](https://www.npmjs.com/package/@vxnsin/inkan)
[![ci](https://img.shields.io/github/actions/workflow/status/inkanjs/inkan/ci.yml?branch=main&color=3d7a4b&labelColor=2b2420&label=ci)](https://github.com/inkanjs/inkan/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-ece1cf?labelColor=2b2420)](LICENSE)

[Docs](https://inkan-dev.vercel.app/docs) · [Benchmarks](https://inkan-dev.vercel.app/benchmarks) · [Hanko](https://inkan-dev.vercel.app/hanko) · [Changelog](CHANGELOG.md)

<img src="https://raw.githubusercontent.com/inkanjs/inkan/main/assets/demo.svg" width="840" alt="A route with its contract, a request that breaks it and gets a 400 naming the field, and inkan check passing every example">

An *inkan* (印鑑) is the seal a Japanese contract gets stamped with. In inkan every route
has one: its params, query, body, responses and a few examples, written once. From that
inkan checks what comes in, types your handler, trims what goes out, writes OpenAPI 3.1,
serves a docs page and runs the examples as tests.

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
    const tea = teas.find((x) => x.id === params.id); // params.id is a number here
    if (!tea) throw problem(404, "tea-not-found", `There is no tea with id ${params.id}`);
    return tea; // has to be a Tea, or it doesn't compile
  },
);

app.listen({ port: 3000 }); // docs on /docs
```

The examples are what the docs page shows, and they are what `inkan check` runs. If the
404 gets lost in a refactor, the check says so before anyone reads the docs and believes
them:

```sh
$ npx inkan check src/app.ts

  GET    /teas/:id
    ✓ found                              200  0.8ms
    ✗ missing                            200  0.4ms
        answered 200, expected 404

  2 examples · 1 sealed · 1 broken
```

## Getting started

```sh
npm install @vxnsin/inkan
```

You need Node 22 or newer. From 22.18 on, `.ts` files run as they are, without a build step.
The package is scoped because npm keeps the plain name `inkan` free of look-alikes; the
command is `inkan` either way.

If you'd rather learn by doing, there is a tutorial that runs in your terminal, offline. It
sets up a small tea shop and walks you through twelve short tasks, checking your code every
time you save:

```sh
npx @vxnsin/inkan learn
```

`npx @vxnsin/inkan examples` gives you six explained projects to start from instead.

To start a project of your own:

```sh
npm create inkan@latest my-api
npm create inkan@latest my-api -- --store postgres --auth --frontend next
```

It asks where the data lives (memory, Postgres, Redis, MongoDB or MySQL), whether you want
logins, and whether a Next.js or Vite frontend goes with it, then writes a project that
passes `inkan check` and its own tests, with a CI workflow. `npx @vxnsin/inkan create app`
is the same command; `--help` lists the options.

## What's in it

The core has no dependencies. Besides the contracts, it comes with:

- a typed client for the frontend, built from the app itself, with no generated code
- the docs page at `/docs` and the OpenAPI document at `/openapi.json`
- a live request inspector at `/_inkan` while you develop
- one error format for everything, [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problems
- server-sent events, streams, file uploads and CSV, all under the contract
- WebSockets with a contract per message, and background jobs with progress and schedules
- hooks, plugins and decorators, and `inkan diff` to tell which changes break clients, in
  the terminal, as JSON or as Markdown for a pull request comment
- `inkan seal`, which compiles contracts to plain code ahead of time, without `eval`

It runs on `node:http`, and on Bun, Deno and serverless through `app.fetch`. Auth,
sessions, stores for Redis, Postgres, MongoDB and MySQL, and the other official plugins
live in [inkanjs/middleware](https://github.com/inkanjs/middleware); the Next.js, Vite,
TanStack Query and uWebSockets.js integrations in
[inkanjs/integrations](https://github.com/inkanjs/integrations).

Everything else is in [the docs](https://inkan-dev.vercel.app/docs).

## Compared to the others

Express gets out of your way, Fastify is fast, Hono runs everywhere. inkan is closest to
Fastify in spirit, with schemas on every route, but it keeps the docs and the tests in the
same place as the code, and it gets its speed without generating code at runtime.

On the benchmark (twelve scenarios on a GitHub runner, plain `node:http` as 100) inkan
scores 91.0, Fastify 89.9, Hono 84.5 and Express 46.0. That puts inkan level with Fastify
or a little ahead, not in every scenario. The numbers, how they are measured and how to run
the bench yourself are on [the benchmarks page](https://inkan-dev.vercel.app/benchmarks).
I wrote the other frameworks' apps myself, so if you know a faster way to write one of
them, please open a pull request.

## Stability

Since 0.8 the API is stable. What is marked stable won't be removed or change meaning in a
minor release; a rename keeps the old name working, with a warning, for at least two minor
releases and six months. A few newer parts, like jobs and WebSockets, are still marked
experimental. The details are in [docs/STABILITY.md](docs/STABILITY.md).

## How inkan is made

I'm Vensin, and I design and maintain inkan on my own. A lot of the code is written
together with an AI assistant (Claude Code). None of it goes in unchecked: I read every
change, run it on my own hardware and put it through a security review before it's merged.
Every change comes with tests, close to 400 of them, and every example in the docs is one
of them. I make mistakes too, and this is how I try to catch them before you do.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
