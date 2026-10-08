// The stamps check exactly as the walker before them did: the same value, the same issues,
// the same paths. Every schema is built twice, once with each, from the same recipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { t as now } from "../src/schema/schema.ts";
import { t as before } from "./reference/walker.ts";

type T = typeof now;
type Recipe = (t: T) => { safeParse(v: unknown, o?: { coerce?: boolean }): unknown };

function same(recipe: Recipe, values: unknown[], label: string) {
  const a = recipe(now);
  const b = recipe(before as unknown as T);
  for (const v of values) {
    for (const coerce of [false, true]) {
      assert.deepEqual(a.safeParse(v, { coerce }), b.safeParse(v, { coerce }), `${label}: ${JSON.stringify(v)} (coerce ${coerce})`);
    }
  }
}

const odd = [undefined, null, 0, -1, 1.5, NaN, Infinity, "", " ", "1", "0", "true", "false", "x", "2026-01-02T03:04:05Z", true, false, [], [1], {}, { a: 1 }];

test("primitives check as before", () => {
  same((t) => t.string(), odd, "string");
  same((t) => t.string().min(2).max(4).trim(), [...odd, "  ab  ", "abcde"], "string rules");
  same((t) => t.string().email(), [...odd, "a@b.co", "a@b"], "email");
  same((t) => t.string().uuid(), [...odd, "123e4567-e89b-12d3-a456-426614174000"], "uuid");
  same((t) => t.string().pattern(/^t/), [...odd, "tea"], "pattern");
  same((t) => t.number(), odd, "number");
  same((t) => t.int().min(1).max(10), [...odd, "5", "11", 3.2], "int");
  same((t) => t.number().positive(), odd, "positive");
  same((t) => t.boolean(), [...odd, "1", "0"], "boolean");
  same((t) => t.date(), [...odd, new Date(0), new Date(NaN), "2026-02-30T00:00:00Z"], "date");
  same((t) => t.enum(["green", "black", 3, true]), [...odd, "green", "3", 3, "true"], "enum");
  same((t) => t.enum([1, "1"]), ["1", 1], "enum spellings");
  same((t) => t.literal("tea"), [...odd, "tea"], "literal");
  same((t) => t.any(), odd, "any");
});

test("optional, nullable and defaults check as before", () => {
  same((t) => t.string().optional(), odd, "optional");
  same((t) => t.string().nullable(), odd, "nullable");
  same((t) => t.int().default(7), odd, "default");
  same((t) => t.object({ tags: t.array(t.string()).default([]) }), [{}, { tags: ["a"] }], "default is a copy");
});

test("objects, arrays, records and unions check as before, with the same paths", () => {
  const Tea = (t: T) => t.object({ id: t.int(), name: t.string().min(1), tags: t.array(t.string()).optional(), meta: t.object({ at: t.date() }) });
  const teas = [
    { id: 1, name: "Sencha", meta: { at: "2026-01-02T03:04:05Z" } },
    { id: "x", name: "", tags: [1, "a", null], meta: {} },
    { id: 1, name: "a", extra: true, meta: { at: "nope", more: 1 } },
    [],
    null,
  ];
  same(Tea, [...teas, ...odd], "object");
  same((t) => Tea(t).strict(), teas, "strict");
  same((t) => Tea(t).passthrough(), teas, "passthrough");
  same((t) => t.array(Tea(t)).min(1).max(2), [teas, [teas[0]], [], [teas[1], teas[1], teas[1]], "a"], "array of objects");
  // eslint-disable-next-line no-sparse-arrays
  same((t) => t.array(t.int()), [[1, , 3], ["1", "2"], "4"], "array holes and coerced lists");
  same((t) => t.record(t.int()), [{ a: 1, b: "2", c: "x" }, {}, [], null], "record");
  same((t) => t.union(t.int(), t.string().min(3)), [...odd, "abcd", 4], "union");
  same(
    (t) => t.discriminated("kind", { tea: t.object({ kind: t.literal("tea"), g: t.int() }), cup: t.object({ kind: t.literal("cup"), ml: t.int() }) }),
    [{ kind: "tea", g: 5 }, { kind: "cup", ml: "x" }, { kind: "pot" }, { kind: "constructor" }, "x", null],
    "discriminated",
  );
});

test("refine, transform, lazy and events check as before", () => {
  same((t) => t.int().refine((n) => n % 2 === 0, "must be even"), [...odd, 2, 3], "refine");
  same((t) => t.string().transform((s) => s.length).optional(), [...odd, "abc"], "transform");
  const Node = (t: T): ReturnType<T["object"]> => t.object({ name: t.string(), kids: t.array(t.lazy(() => Node(t))).optional() }) as never;
  same(Node, [{ name: "a", kids: [{ name: "b" }, { name: 1 }] }, { name: "a", kids: [{ kids: "x" }] }], "lazy");
  same((t) => t.events({ temp: t.object({ c: t.int() }) }), [{ event: "temp", data: { c: 5 } }, { event: "temp", data: {} }, { event: "other" }, { data: 1 }], "events");
});

// ---------- a few thousand random schemas and values ----------

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type Gen = { schema: Recipe; value: () => unknown };

function randomCase(rnd: () => number, depth = 0): Gen {
  const pick = <X>(xs: X[]) => xs[Math.floor(rnd() * xs.length)]!;
  const anyValue = (): unknown => pick([undefined, null, 0, 7, -3.5, "7", "a", "", true, "true", [], [1, "x"], {}, { k: 1 }, NaN]);
  const wrap = (g: Gen): Gen => {
    const r = rnd();
    if (r < 0.15) return { schema: (t) => (g.schema(t) as any).optional(), value: () => (rnd() < 0.3 ? undefined : g.value()) };
    if (r < 0.25) return { schema: (t) => (g.schema(t) as any).nullable(), value: () => (rnd() < 0.3 ? null : g.value()) };
    return g;
  };
  const kinds = depth > 2 ? ["string", "int", "number", "boolean", "enum"] : ["string", "int", "number", "boolean", "enum", "object", "array", "union", "record"];
  const kind = pick(kinds);
  switch (kind) {
    case "string": {
      const min = rnd() < 0.5 ? Math.floor(rnd() * 3) : undefined;
      return wrap({ schema: (t) => (min === undefined ? t.string() : t.string().min(min)), value: () => (rnd() < 0.7 ? pick(["", "a", "ab", "abc", " x "]) : anyValue()) });
    }
    case "int":
      return wrap({ schema: (t) => t.int().min(0), value: () => (rnd() < 0.7 ? pick([0, 1, 5, -1, 2.5, "3"]) : anyValue()) });
    case "number":
      return wrap({ schema: (t) => t.number().max(100), value: () => (rnd() < 0.7 ? pick([0, 99.5, 101, "4.5", Infinity]) : anyValue()) });
    case "boolean":
      return wrap({ schema: (t) => t.boolean(), value: () => (rnd() < 0.7 ? pick([true, false, "1", "0", "yes"]) : anyValue()) });
    case "enum":
      return wrap({ schema: (t) => t.enum(["a", "b", 1]), value: () => pick(["a", "b", "c", 1, "1", 2]) });
    case "array": {
      const item = randomCase(rnd, depth + 1);
      return wrap({ schema: (t) => t.array(item.schema(t) as any), value: () => (rnd() < 0.8 ? Array.from({ length: Math.floor(rnd() * 4) }, item.value) : anyValue()) });
    }
    case "record": {
      const item = randomCase(rnd, depth + 1);
      return wrap({ schema: (t) => t.record(item.schema(t) as any), value: () => ({ x: item.value(), y: item.value() }) });
    }
    case "union": {
      const a = randomCase(rnd, depth + 1);
      const b = randomCase(rnd, depth + 1);
      return wrap({ schema: (t) => t.union(a.schema(t) as any, b.schema(t) as any), value: () => (rnd() < 0.5 ? a.value() : b.value()) });
    }
    default: {
      const n = 1 + Math.floor(rnd() * 4);
      const fields = Array.from({ length: n }, (_, i) => [`f${i}`, randomCase(rnd, depth + 1)] as const);
      const mode = pick(["strip", "strip", "strict", "keep"]);
      return wrap({
        schema: (t) => {
          const o = t.object(Object.fromEntries(fields.map(([k, g]) => [k, g.schema(t)])) as never);
          return mode === "strict" ? o.strict() : mode === "keep" ? o.passthrough() : o;
        },
        value: () => {
          if (rnd() < 0.1) return anyValue();
          const v: Record<string, unknown> = {};
          for (const [k, g] of fields) if (rnd() < 0.9) v[k] = g.value();
          if (rnd() < 0.2) v.extra = 1;
          return v;
        },
      });
    }
  }
}

test("2000 random schemas and values check as before", () => {
  const rnd = mulberry32(20261008);
  for (let i = 0; i < 2000; i++) {
    const g = randomCase(rnd);
    same(g.schema, [g.value(), g.value(), g.value()], `case ${i}`);
  }
});
