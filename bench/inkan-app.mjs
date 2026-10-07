// The bench routes, as an inkan app. Shared by servers.mjs and inproc.mjs.
import { inkan, t } from "../src/index.ts";

const user = (id, fields) => ({ id, fields: fields ?? null });

export const app = (dev = false) =>
  inkan({ dev, log: false, gracefulShutdown: false, inspector: false })
    .get("/hello", { response: { 200: t.object({ hello: t.string() }) } }, () => ({ hello: "world" }))
    .get(
      "/users/:id",
      {
        params: t.object({ id: t.int() }),
        query: t.object({ fields: t.string().optional() }),
        response: { 200: t.object({ id: t.int(), fields: t.string().nullable() }) },
      },
      ({ params, query }) => user(params.id, query.fields),
    )
    .post(
      "/users",
      {
        body: t.object({ name: t.string().min(1), age: t.int() }),
        response: { 201: t.object({ id: t.int(), name: t.string(), age: t.int() }) },
      },
      ({ body }) => ({ id: 1, ...body }),
    );
