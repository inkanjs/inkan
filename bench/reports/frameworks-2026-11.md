# Five more frameworks: Koa, hapi, h3, Elysia, NestJS (2026-11)

The release bench compares inkan with node:http, Fastify, Hono and Express. This run adds
the frameworks people also ask about on Node, each doing the same work in the same twelve
scenarios, with every answer checked before it is measured. They are opt-in servers: the
default of the `bench` workflow stays `node,fastify,hono,inkan,express`.

| server | what runs | checks |
| --- | --- | --- |
| koa | Koa 3 with `@koa/router` and `@koa/bodyparser` | by hand, like Express |
| hapi | `@hapi/hapi` 21, its own payload parsing; the three middlewares are route `onPreHandler` extensions | by hand |
| h3 | h3 2 (`H3`, `serve`), route middleware | by hand |
| elysia | Elysia 1.4 on Node through `@elysiajs/node` | its TypeBox schemas (`t`), 422 mapped to 400 |
| nest | NestJS 12 on its default platform, Express; route middleware through `MiddlewareConsumer` | by hand, `HttpException` for the 400 |

Not added: Restify and tinyhttp. Few people choose between them and the others today, and
tinyhttp is an Express-compatible API, so it would show what Express shows. NestJS runs on its
default platform only; on Fastify it would mostly measure Fastify plus Nest's layer.

## On the GitHub runner

One run of the `bench` workflow, kind http, 15 s per measurement after a 3 s warm-up,
3 rounds, the median: run 43431066749, 2026-11-13, Node 24.22.2, 4 cores, all ten servers
at once and taking turns per scenario.

| rank | server | score (geometric mean, node = 100) |
| ---: | --- | ---: |
| 1 | node | 100.0 |
| 2 | fastify | 88.8 |
| 3 | inkan | 88.5 |
| 4 | hono | 81.0 |
| 5 | h3 | 75.8 |
| 6 | elysia | 54.7 |
| 7 | hapi | 46.5 |
| 8 | express | 40.1 |
| 9 | nest | 34.4 |
| 10 | koa | 25.2 |

Per scenario, as % of node:http:

| scenario | fastify | inkan | hono | h3 | elysia | hapi | express | nest | koa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hello · 10 connections | 91 | 93 | 89 | 82 | 80 | 50 | 46 | 41 | 24 |
| hello · 100 connections | 88 | 89 | 85 | 75 | 76 | 45 | 43 | 36 | 20 |
| hello · 512 connections | 95 | 93 | 83 | 74 | 79 | 49 | 44 | 38 | 21 ¹ |
| params + query | 96 | 90 | 71 | 72 | 39 | 40 | 39 | 34 | 20 |
| small JSON body | 89 | 96 | 89 | 79 | 40 | 39 | 44 | 40 | 25 |
| big JSON body (50 items) | 95 | 89 | 88 | 88 | 41 | 52 | 59 | 54 | 38 |
| big answer (100 items) | 80 | 88 | 97 | 95 | 93 | 76 | 68 | 63 | 51 |
| router with 400 routes | 91 | 93 | 72 | 72 | 43 | 44 | 18 | 17 | 22 |
| 3 middlewares | 89 | 79 | 67 | 65 | 68 | 40 | 41 | 31 | 20 |
| async handler | 98 | 88 | 81 | 77 | 66 | 51 | 55 | 50 | 33 |
| 404 | 83 | 88 | 71 | 60 | 59 | 45 | 16 | 14 | 20 |
| 400 (invalid body) | 73 | 78 | 84 | 80 | 22 | 38 | 43 | 30 | 24 |

¹ 54 sockets dropped at 512 connections.

Peak memory was between 209 MB (h3) and 268 MB (fastify) for all of them.

What stands out:

- **h3** is the fastest of the new five and close behind Hono, which is built the same way
  (web-standard request and response). It is strong on the big answer and the bodies, weaker
  on the 404.
- **Elysia** on Node is fast where nothing is parsed (hello, the big answer), and loses
  about half where its schemas run on params or bodies: on Node the request goes through the
  adapter's web-standard bridge first. Bun is its home and this says nothing about Bun.
- **hapi** is about level with Express, ahead of it on routing (45 % on 404 and 400 routes
  against Express's 16–18 %).
- **NestJS** on Express pays for Express and then its own layer on top: below Express in
  most scenarios, about the same on routing.
- **Koa** is the surprise, at about a fifth of node:http in almost every scenario, the 404 and
  the plain hello included. With `@koa/router` every request is tested against every route,
  and this app has 400 routes plus 400 static ones; with two routes Koa is level with Express
  in a quick local check. The number is fair for a large Koa app on the standard router, not
  for Koa itself.

Within the run, fastify and inkan are level (88.8 and 88.5); in the three runs of the 0.10.0
release bench inkan was a point or two ahead. That is the noise of one run, which is why the
release numbers stay the median of three.

Run it yourself: `cd bench && npm install && node run.mjs node,fastify,hono,inkan,express,koa,hapi,h3,elysia,nest`,
or the `bench` workflow with those servers (about two hours on the runner).
