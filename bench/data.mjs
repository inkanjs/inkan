// The data every server in the bench answers with, so they all send the same bytes.

export const ROUTE_COUNT = 200; // ×2: a static and a parameter route each

export const user = (id, fields) => ({ id, fields: fields ?? null });

export const LIST = Array.from({ length: 100 }, (_, i) => ({
  id: i,
  name: `Tea ${i}`,
  tags: ["green", "organic", "loose"],
  price: 9.5 + i,
  inStock: i % 2 === 0,
  meta: { created: "2026-01-02T03:04:05.000Z", updated: "2026-10-07T08:00:00.000Z" },
}));

/** A bulk upload: 50 teas, each one checked by every server. */
export const BULK = JSON.stringify({
  items: Array.from({ length: 50 }, (_, i) => ({ name: `Tea ${i}`, kind: ["green", "black", "oolong"][i % 3], grams: 50 + i, price: 4 + i / 10 })),
});

/** The checks Express and Hono do by hand, where Fastify and inkan use schemas. */
export const isUser = (b) => b && typeof b.name === "string" && b.name.length > 0 && Number.isInteger(b.age);
export const isTea = (x) =>
  x && typeof x.name === "string" && x.name.length > 0 && ["green", "black", "oolong"].includes(x.kind) &&
  Number.isInteger(x.grams) && x.grams >= 1 && typeof x.price === "number" && x.price >= 0;
export const isBulk = (b) => b && Array.isArray(b.items) && b.items.length <= 500 && b.items.every(isTea);
