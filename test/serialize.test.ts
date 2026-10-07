import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, t, type Schema } from "../src/index.ts";

const write = (s: Schema<any>, v: unknown) => s._serializer()(v);

test("production never sends what the contract does not list", async () => {
  const Tea = t.object({ id: t.int(), name: t.string() });
  const app = inkan({ dev: false, log: false })
    .get("/me", { response: { 200: t.object({ name: t.string(), teas: t.array(Tea), by: t.record(Tea) }) } }, () => ({
      name: "Mio",
      passwordHash: "$2b$10$secret",
      teas: [{ id: 1, name: "Sencha", supplierPrice: 2.1 }],
      by: { green: { id: 1, name: "Sencha", internal: true } },
    }));
  const res = await app.inject({ url: "/me" });
  assert.equal(res.text, '{"name":"Mio","teas":[{"id":1,"name":"Sencha"}],"by":{"green":{"id":1,"name":"Sencha"}}}');
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
});

test("development strips the same way, after checking", async () => {
  const app = inkan({ dev: true, log: false }).get("/me", { response: { 200: t.object({ name: t.string() }) } }, () => ({ name: "Mio", secret: 1 }));
  assert.equal((await app.inject({ url: "/me" })).text, '{"name":"Mio"}');
});

test("the writer agrees with JSON.stringify of the parsed value", () => {
  type Node = { name: string; children: Node[] };
  const node: Schema<Node> = t.object({ name: t.string(), children: t.array(t.lazy(() => node)) }).named("Node");
  const cases: [Schema<any>, unknown][] = [
    [t.string(), 'quote " and \\ and \n and ☃'],
    [t.int(), -0],
    [t.number(), 1.5e300],
    [t.boolean(), false],
    [t.date(), new Date("2026-10-07T09:15:02.123Z")],
    [t.enum(["a", "b"]), "b"],
    [t.string().nullable(), null],
    [t.object({ a: t.int().optional(), b: t.string().nullable() }), { b: null }],
    [t.object({ 'he"y': t.int() }), { 'he"y': 1 }],
    [t.array(t.object({ x: t.int() })), [{ x: 1, y: 2 }, { x: 3 }]],
    [node, { name: "root", children: [{ name: "leaf", children: [], extra: 1 }] }],
    [t.discriminated("kind", { cat: t.object({ kind: t.literal("cat"), meows: t.boolean() }), dog: t.object({ kind: t.literal("dog"), barks: t.int() }) }), { kind: "dog", barks: 3, meows: true }],
    [t.union(t.object({ a: t.int() }), t.string()), { a: 1, b: 2 }],
    [t.object({ n: t.int().refine((x) => x > 0, "positive") }), { n: 2, other: 1 }],
    [t.any(), { anything: [1, "two"] }],
  ];
  for (const [schema, value] of cases) {
    const parsed = schema.parse(value);
    assert.equal(write(schema, value), JSON.stringify(parsed), JSON.stringify(value));
  }
});

test("passthrough keeps everything, a transform writes what it made", () => {
  assert.equal(write(t.object({ a: t.int() }).passthrough(), { a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(write(t.string().transform((s) => s.length), 3), "3");
});

test("modifiers get their own writer: a nullable copy does not change the original", () => {
  const base = t.object({ a: t.int() });
  assert.equal(write(base.nullable(), null), "null");
  assert.equal(write(base, { a: 1 }), '{"a":1}');
});

test("strings and buffers keep their own content types", async () => {
  const app = inkan({ dev: false, log: false })
    .get("/text", { response: { 200: t.string() } }, () => "plain")
    .get("/bin", { response: { 200: t.any() } }, () => Buffer.from("raw"));
  const text = await app.inject({ url: "/text" });
  assert.equal(text.text, "plain");
  assert.equal(text.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal((await app.inject({ url: "/bin" })).headers["content-type"], "application/octet-stream");
});
