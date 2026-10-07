import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inkan, t, type Schema, type Seal } from "../src/index.ts";
import { compile } from "../src/seal/compile.ts";
import { writeSeal } from "../src/seal/seal.ts";

const dir = mkdtempSync(join(tmpdir(), "inkan-seal-"));
let files = 0;
/** Writes a seal file the way `inkan seal` does and imports it, as an app would. */
async function sealOf(app: ReturnType<typeof inkan>): Promise<Seal> {
  const file = join(dir, `seal-${files++}.js`);
  writeFileSync(file, writeSeal(app.routes(), "test").code);
  return (await import(pathToFileURL(file).href)).default;
}

const Tea = t.object({
  name: t.string().min(1).max(20).trim(),
  kind: t.enum(["green", "black", 3, true]),
  grams: t.int().min(1).max(1000),
  price: t.number().min(0),
  tags: t.array(t.string().pattern(/^[a-z]+$/i)).min(1).max(3).optional(),
  organic: t.boolean().default(false),
  note: t.string().nullable().optional(),
  meta: t.object({ id: t.string().uuid(), mail: t.string().email().optional() }).strict().optional(),
  extra: t.any().optional(),
  list: t.array(t.object({ a: t.int(), b: t.array(t.int().nullable()) })).default([]),
});
const Loose = t.object({ a: t.string() }).passthrough();

const schemas: Schema<any>[] = [Tea, Loose, t.array(Tea), t.string(), t.int().nullable(), t.object({ n: t.number().optional() })];

// good, broken and odd inputs, built so that every rule above trips somewhere
const good = { name: " Sencha ", kind: "green", grams: 50, price: 4.5, tags: ["a", "B"], meta: { id: "123e4567-e89b-12d3-a456-426614174000" }, list: [{ a: 1, b: [1, null] }] };
const inputs: unknown[] = [
  good,
  { ...good, extraKey: 1 },
  { ...good, name: "", grams: 0, price: -1, tags: [] },
  { ...good, name: "x".repeat(30), tags: ["a", "b", "c", "d"], meta: { id: "nope", mail: "a@b", more: 1 } },
  { ...good, kind: "3", grams: "50", price: "4.5", organic: "true", tags: "solo", list: [{ a: "1", b: "2" }] },
  { ...good, kind: 3, organic: "0", note: null, extra: { deep: [1, 2] } },
  { ...good, grams: 1.5, price: Infinity, tags: ["ok", "not ok!"], list: [{ a: 1 }, null, "x"] },
  { ...good, kind: "red", grams: NaN, organic: 1, note: 5 },
  { ...good, list: [, { a: 2, b: [] }] }, // a hole, skipped like forEach skips it
  {},
  [],
  null,
  undefined,
  "text",
  42,
  "  ",
  { a: "x", b: 2, toJSON: () => "custom" },
  { a: 5 },
  { n: "7" },
  { n: " " },
];

test("a sealed contract checks exactly as its schema does, with and without coercion", async () => {
  const app = inkan();
  schemas.forEach((s, i) => app.post(`/s${i}`, { body: s }, () => undefined));
  const seal = await sealOf(app);
  for (const schema of schemas) {
    const entry = seal.entries[compile(schema).hash];
    assert.ok(entry, "every schema here is sealable");
    for (const input of inputs) {
      for (const coerce of [false, true]) {
        assert.deepEqual(entry.parse(input, coerce), schema.safeParse(input, { coerce }), `${JSON.stringify(input)} coerce=${coerce}`);
      }
    }
  }
});

test("a sealed contract writes exactly what its schema writes", async () => {
  const app = inkan();
  schemas.forEach((s, i) => app.get(`/s${i}`, { response: { 200: s } }, () => undefined));
  const seal = await sealOf(app);
  for (const schema of schemas) {
    const entry = seal.entries[compile(schema).hash]!;
    for (const input of inputs) {
      if (input === undefined) continue;
      assert.equal(entry.write(input), schema._serializer()(input), JSON.stringify(input));
    }
  }
});

test("an app runs on its seal, and a contract that changed since runs unsealed", async () => {
  const route = (min: number) => t.object({ name: t.string().min(min) });
  const Out = t.object({ name: t.string() });
  const seal = await sealOf(inkan({ log: false }).post("/teas", { body: route(1), response: { 201: Out } }, () => undefined));

  const app = inkan({ log: false, seal }).post("/teas", { body: route(1), response: { 201: Out } }, ({ body, reply }) =>
    // on purpose a key the contract does not list, as a row from a database might have
    reply(201, { ...body, secret: "never sent" } as { name: string }),
  );
  const ok = await app.inject({ method: "POST", url: "/teas", body: { name: "Mio" } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body, { name: "Mio" }, "the sealed writer still keeps back what the contract does not list");
  const bad = await app.inject({ method: "POST", url: "/teas", body: { name: "" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors[0].path, "name");
  assert.equal(app.sealed()?.sealed, 2);
  assert.deepEqual(app.sealed()?.stale, []);

  // the same route with a stricter rule: its code hashes differently, so the seal is not used for it
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const changed = inkan({ log: false, seal }).post("/teas", { body: route(3) }, () => undefined);
    const r = await changed.inject({ method: "POST", url: "/teas", body: { name: "Mi" } });
    assert.equal(r.status, 400, "the live contract decides, not the stale seal");
    assert.deepEqual(changed.sealed()?.stale, ["POST /teas · body"]);
    assert.match(warned[0] ?? "", /changed since the seal was made/);
  } finally {
    console.warn = warn;
  }
});

test("a seal of another format is not used", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const app = inkan({ log: false, seal: { inkan: 999, entries: {} } }).get("/x", { query: t.object({ n: t.int() }) }, () => ({}));
    assert.equal((await app.inject({ url: "/x?n=a" })).status, 400);
    assert.equal(app.sealed()?.wrongFormat, true);
  } finally {
    console.warn = warn;
  }
});

test("a schema made from a sealed one does not inherit its seal", async () => {
  const base = t.string().min(1);
  const seal = await sealOf(inkan({ log: false }).post("/x", { body: base }, () => undefined));
  const app = inkan({ log: false, seal }).post("/x", { body: base }, () => undefined);
  assert.equal(app.sealed()?.sealed, 1);
  const stricter = base.max(2);
  assert.equal(stricter.safeParse("abc").ok, false, "max(2) holds, though the schema it came from is sealed");
  assert.equal(base.safeParse("abc").ok, true);
});
