import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, t, type Schema, type Infer } from "../src/index.ts";

test("dates parse ISO timestamps and reject invalid dates without coercing arbitrary values", async () => {
  const date = t.date();
  assert.equal(date.parse("2024-02-29T12:30:00+02:00").toISOString(), "2024-02-29T10:30:00.000Z");
  const original = new Date("2024-02-29T00:00:00Z");
  assert.deepEqual(date.parse(original), original);
  assert.notEqual(date.parse(original), original);
  for (const value of ["2023-02-29T00:00:00Z", "2024-04-31T00:00:00Z", "2024-13-01T00:00:00Z", "2024-01-01", "tomorrow", 0, new Date(NaN)]) {
    assert.equal(date.safeParse(value).ok, false);
  }
  assert.deepEqual(date.toJSONSchema(), { type: "string", format: "date-time" });
  const app = inkan({ log: false }).post("/date", {
    body: t.object({ at: date }), response: { 200: t.object({ at: date }) },
  }, ({ body }) => { assert.ok(body.at instanceof Date); return body; });
  const response = await app.inject({ method: "POST", url: "/date", body: { at: original.toISOString() } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { at: original.toISOString() });
});

test("refinements and transformations run in order only on valid input", () => {
  let calls = 0;
  const schema = t.string().min(2).refine(value => value.startsWith("a"), "must start with a")
    .transform(value => { calls++; return value.length; }).refine(value => value < 4, "too long");
  const length: Infer<typeof schema> = schema.parse("abc");
  assert.equal(length, 3);
  assert.equal(schema.safeParse("x").ok, false);
  assert.equal(schema.safeParse("bc").ok, false);
  assert.equal(calls, 1);
  const result = t.object({ value: schema }).safeParse({ value: "abcd" });
  assert.deepEqual(result, { ok: false, issues: [{ path: "value", message: "too long" }] });
  assert.deepEqual(schema.toJSONSchema(), { type: "string", minLength: 2 });
  assert.equal(schema.optional().parse(undefined), undefined);
  assert.equal(schema.nullable().parse(null), null);
  assert.equal(schema.default(2).parse(undefined), 2);
  assert.equal(t.string().default("abc").transform(value => value.length).parse(undefined), 3);
  assert.equal(t.string().optional().transform(value => value?.length ?? 0).parse(undefined), 0);
  assert.equal(t.string().nullable().transform(value => value?.length ?? 0).parse(null), 0);
  const named = t.string().named("Text").transform(value => value.length);
  assert.deepEqual(named.toJSONSchema(), { $ref: "#/$defs/Text", $defs: { Text: { type: "string" } } });
});

test("discriminated unions validate only the selected branch and document named mappings", () => {
  const schema = t.discriminated("kind", {
    cat: t.object({ kind: t.literal("cat"), lives: t.int() }).named("Cat"),
    dog: t.object({ kind: t.literal("dog"), bark: t.boolean() }).named("Dog"),
  });
  const animal: Infer<typeof schema> = schema.parse({ kind: "cat", lives: 9 });
  if (animal.kind === "cat") assert.equal(animal.lives, 9);
  assert.deepEqual(schema.safeParse({ kind: "cat", lives: "nine" }), {
    ok: false, issues: [{ path: "lives", message: 'expected an integer, got "nine"' }],
  });
  for (const kind of [undefined, "bird", "toString", "__proto__", 1]) {
    const result = t.object({ animal: schema }).safeParse({ animal: { kind } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issues[0]!.path, "animal.kind");
  }
  assert.throws(() => t.discriminated("kind", { cat: t.object({ kind: t.literal("dog") }) }), /must declare/);
  const ctx = { components: new Map() };
  assert.deepEqual(schema._schema(ctx), {
    oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
    discriminator: { propertyName: "kind", mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" } },
  });
  assert.equal(ctx.components.size, 2);
});

test("lazy schemas validate recursive values and export finite references", () => {
  type Node = { name: string; children: Node[] };
  const node: Schema<Node> = t.object({ name: t.string(), children: t.array(t.lazy(() => node)) }).named("Node");
  const value = { name: "root", children: [{ name: "leaf", children: [] }] };
  assert.deepEqual(node.parse(value), value);
  const result = node.safeParse({ name: "root", children: [{ name: 1, children: [] }] });
  assert.deepEqual(result, { ok: false, issues: [{ path: "children[0].name", message: "expected a string, got number" }] });
  const standalone = node.toJSONSchema();
  assert.equal(standalone.$ref, "#/$defs/Node");
  assert.match(JSON.stringify(standalone.$defs), /#\/\$defs\/Node/);
  const app = inkan({ log: false }).get("/tree", { response: { 200: node } }, () => value);
  assert.match(JSON.stringify(app.openapi()), /#\/components\/schemas\/Node/);
  assert.deepEqual(t.lazy(() => t.string()).toJSONSchema(), { type: "string" });
  const unnamed: Schema<Node> = t.object({ name: t.string(), children: t.array(t.lazy(() => unnamed)) });
  assert.throws(() => unnamed.toJSONSchema(), /Name recursive schemas/);
});
