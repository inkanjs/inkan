import { t, type Infer } from "@vxnsin/inkan";

// 1. Schemas live in their own file, so routes, tests and other code can share them.
export const Kind = t.enum(["green", "black", "oolong", "white", "herbal"]);

// 2. `.named("Tea")` puts the schema into the OpenAPI document once, under its name.
//    The docs page links to it from every route that uses it.
export const Tea = t
  .object({
    id: t.int().example(1),
    name: t.string().trim().min(1).max(60).example("Sencha"),
    kind: Kind,
    grams: t.int().min(1).describe("Grams per pack"),
    price: t.number().min(0).describe("Euro per pack"),
    inStock: t.boolean(),
  })
  .named("Tea");

// 3. New shapes from old ones, instead of repeating fields:
//    what a client sends to create a tea (no id yet), and to change one (every field optional).
export const NewTea = Tea.omit("id").named("NewTea");
export const TeaChange = NewTea.partial().named("TeaChange");

// 4. The TypeScript types come from the same schemas, so they cannot drift apart.
export type Tea = Infer<typeof Tea>;
export type NewTea = Infer<typeof NewTea>;
