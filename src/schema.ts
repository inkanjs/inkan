// A small schema builder. One definition gives you a runtime check,
// a TypeScript type and a JSON Schema, so they cannot drift apart.

export type Issue = { path: string; message: string };
export type JsonSchema = Record<string, unknown>;

export type SafeResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export class ValidationError extends Error {
  issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Collects component schemas while a document is written. */
export type RefContext = { components: Map<string, JsonSchema>; refPrefix?: string; active?: Set<Schema<any>> };

const FAIL: unique symbol = Symbol("fail");
type Fail = typeof FAIL;

type Meta = {
  description?: string;
  examples?: unknown[];
  optional?: boolean;
  nullable?: boolean;
  hasDefault?: boolean;
  default?: unknown;
  name?: string;
  deprecated?: boolean;
};

export abstract class Schema<T = unknown> {
  declare readonly _type: T;
  meta: Meta = {};

  protected abstract check(value: unknown, path: string, coerce: boolean, issues: Issue[]): T | Fail;
  protected abstract json(ctx?: RefContext): JsonSchema;

  /** @internal */
  _run(value: unknown, path: string, coerce: boolean, issues: Issue[]): T | Fail {
    if (value === undefined) {
      if (this.meta.hasDefault) return structuredClone(this.meta.default) as T;
      if (this.meta.optional) return undefined as T;
      issues.push({ path, message: "is required" });
      return FAIL;
    }
    if (value === null && this.meta.nullable) return null as T;
    return this.check(value, path, coerce, issues);
  }

  /** @internal */
  _schema(ctx?: RefContext): JsonSchema {
    if (ctx && !this.meta.name) {
      ctx.active ??= new Set();
      if (ctx.active.has(this)) throw new Error("Name recursive schemas with .named() before exporting JSON Schema");
      ctx.active.add(this);
      try { return this.inlineSchema(ctx); } finally { ctx.active.delete(this); }
    }
    if (ctx && this.meta.name) {
      if (!ctx.components.has(this.meta.name)) {
        ctx.components.set(this.meta.name, {}); // reserve first, so recursive shapes terminate
        ctx.components.set(this.meta.name, this.decorate(this.json(ctx)));
      }
      const ref = { $ref: `${ctx.refPrefix ?? "#/components/schemas/"}${this.meta.name.replace(/~/g, "~0").replace(/\//g, "~1")}` };
      return this.meta.nullable ? { anyOf: [ref, { type: "null" }] } : ref;
    }
    return this.inlineSchema(ctx);
  }

  private inlineSchema(ctx?: RefContext): JsonSchema {
    const out = this.decorate(this.json(ctx));
    return this.meta.nullable ? { anyOf: [out, { type: "null" }] } : out;
  }

  private decorate(s: JsonSchema): JsonSchema {
    const out = { ...s };
    if (this.meta.description) out.description = this.meta.description;
    if (this.meta.examples) out.examples = this.meta.examples;
    if (this.meta.hasDefault) out.default = this.meta.default;
    if (this.meta.deprecated) out.deprecated = true;
    return out;
  }

  protected clone(patch: Partial<Meta> = {}): this {
    const copy = Object.create(Object.getPrototypeOf(this));
    Object.assign(copy, this);
    copy.meta = { ...this.meta, ...patch };
    return copy;
  }

  optional(): Schema<T | undefined> {
    return this.clone({ optional: true });
  }
  nullable(): Schema<T | null> {
    return this.clone({ nullable: true });
  }
  /** The value used when the field is missing. The field becomes optional for callers. */
  default(value: Exclude<T, undefined>): Schema<Exclude<T, undefined>> {
    return this.clone({ hasDefault: true, default: value }) as never;
  }
  describe(description: string): this {
    return this.clone({ description });
  }
  example(...examples: T[]): this {
    return this.clone({ examples });
  }
  deprecated(): this {
    return this.clone({ deprecated: true });
  }
  /** Runs after validation. Custom rules have no JSON Schema representation. */
  refine(fn: (value: T) => boolean, message: string): Schema<T> {
    return new EffectSchema(this, (value, path, issues) => {
      if (!fn(value)) issues.push({ path, message });
      return value;
    });
  }
  /** Changes the parsed value, while documenting the original wire schema. */
  transform<U>(fn: (value: T) => U): Schema<U> {
    return new EffectSchema(this, fn);
  }
  /** Names the schema, so OpenAPI lists it once under components and refers to it. */
  named(name: string): this {
    return this.clone({ name });
  }

  parse(value: unknown, opts: { coerce?: boolean } = {}): T {
    const r = this.safeParse(value, opts);
    if (!r.ok) throw new ValidationError(r.issues);
    return r.value;
  }

  safeParse(value: unknown, opts: { coerce?: boolean } = {}): SafeResult<T> {
    const issues: Issue[] = [];
    const out = this._run(value, "", opts.coerce ?? false, issues);
    if (out === FAIL || issues.length) return { ok: false, issues };
    return { ok: true, value: out };
  }

  toJSONSchema(): JsonSchema {
    const ctx: RefContext = { components: new Map(), refPrefix: "#/$defs/" };
    const schema = this._schema(ctx);
    return ctx.components.size ? { ...schema, $defs: Object.fromEntries(ctx.components) } : schema;
  }
}

class EffectSchema<T, U> extends Schema<U> {
  private source: Schema<T>;
  private effect: (value: T, path: string, issues: Issue[]) => U;
  private outerOptional = false;
  private outerNullable = false;
  private outerDefault = false;
  constructor(source: Schema<T>, effect: (value: T, path: string, issues: Issue[]) => U) {
    super();
    this.source = source;
    this.effect = effect;
    this.meta = { ...source.meta };
  }
  override optional(): Schema<U | undefined> {
    const copy = this.clone({ optional: true });
    copy.outerOptional = true;
    return copy;
  }
  override nullable(): Schema<U | null> {
    const copy = this.clone({ nullable: true });
    copy.outerNullable = true;
    return copy;
  }
  override default(value: Exclude<U, undefined>): Schema<Exclude<U, undefined>> {
    const copy = this.clone({ hasDefault: true, default: value });
    copy.outerDefault = true;
    return copy as never;
  }
  override _run(value: unknown, path: string, coerce: boolean, issues: Issue[]): U | Fail {
    if (value === undefined) {
      if (this.outerDefault) return structuredClone(this.meta.default) as U;
      if (this.outerOptional) return undefined as U;
    }
    if (value === null && this.outerNullable) return null as U;
    return this.check(value, path, coerce, issues);
  }
  protected check(value: unknown, path: string, coerce: boolean, issues: Issue[]) {
    const count = issues.length;
    const parsed = this.source._run(value, path, coerce, issues);
    if (parsed === FAIL || issues.length !== count) return FAIL;
    return this.effect(parsed, path, issues);
  }
  protected json(ctx?: RefContext) {
    // The wrapper owns the name; avoid a self-reference to that same component.
    const source = Object.create(this.source) as Schema<T>;
    source.meta = { ...this.source.meta, name: undefined, nullable: false };
    return source._schema(ctx);
  }
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// ---------- primitives ----------

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
};

export type StringFormat = "email" | "uuid" | "date-time" | "date" | "uri";

export class StringSchema extends Schema<string> {
  private rules: { min?: number; max?: number; pattern?: RegExp; format?: StringFormat; trim?: boolean } = {};

  min(n: number) { const c = this.clone(); c.rules = { ...this.rules, min: n }; return c; }
  max(n: number) { const c = this.clone(); c.rules = { ...this.rules, max: n }; return c; }
  pattern(re: RegExp) { const c = this.clone(); c.rules = { ...this.rules, pattern: re }; return c; }
  format(f: StringFormat) { const c = this.clone(); c.rules = { ...this.rules, format: f }; return c; }
  email() { return this.format("email"); }
  uuid() { return this.format("uuid"); }
  /** Trims whitespace before the other rules run. */
  trim() { const c = this.clone(); c.rules = { ...this.rules, trim: true }; return c; }

  protected check(v: unknown, path: string, _coerce: boolean, issues: Issue[]) {
    if (typeof v !== "string") {
      issues.push({ path, message: `expected a string, got ${typeOf(v)}` });
      return FAIL;
    }
    const s = this.rules.trim ? v.trim() : v;
    const { min, max, pattern, format } = this.rules;
    if (min !== undefined && s.length < min) issues.push({ path, message: `must be at least ${min} characters` });
    if (max !== undefined && s.length > max) issues.push({ path, message: `must be at most ${max} characters` });
    if (pattern && !pattern.test(s)) issues.push({ path, message: `must match ${pattern}` });
    if (format && !FORMATS[format].test(s)) issues.push({ path, message: `must be a valid ${format}` });
    return s;
  }

  protected json() {
    const { min, max, pattern, format } = this.rules;
    const s: JsonSchema = { type: "string" };
    if (min !== undefined) s.minLength = min;
    if (max !== undefined) s.maxLength = max;
    if (pattern) s.pattern = pattern.source;
    if (format) s.format = format;
    return s;
  }
}

export class NumberSchema extends Schema<number> {
  private rules: { int?: boolean; min?: number; max?: number } = {};

  constructor(int = false) {
    super();
    this.rules.int = int;
  }
  min(n: number) { const c = this.clone(); c.rules = { ...this.rules, min: n }; return c; }
  max(n: number) { const c = this.clone(); c.rules = { ...this.rules, max: n }; return c; }
  positive() { return this.min(this.rules.int ? 1 : Number.MIN_VALUE); }

  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    let n = v;
    if (coerce && typeof v === "string" && v.trim() !== "") n = Number(v);
    const kind = this.rules.int ? "an integer" : "a number";
    if (typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n)) {
      issues.push({ path, message: `expected ${kind}, got ${typeof v === "string" ? JSON.stringify(v) : typeOf(v)}` });
      return FAIL;
    }
    if (this.rules.int && !Number.isInteger(n)) {
      issues.push({ path, message: `expected an integer, got ${n}` });
      return FAIL;
    }
    const { min, max } = this.rules;
    if (min !== undefined && n < min) issues.push({ path, message: `must be ${min} or more` });
    if (max !== undefined && n > max) issues.push({ path, message: `must be ${max} or less` });
    return n;
  }

  protected json() {
    const s: JsonSchema = { type: this.rules.int ? "integer" : "number" };
    if (this.rules.min !== undefined) s.minimum = this.rules.min;
    if (this.rules.max !== undefined) s.maximum = this.rules.max;
    return s;
  }
}

export class BooleanSchema extends Schema<boolean> {
  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    if (typeof v === "boolean") return v;
    if (coerce && typeof v === "string") {
      if (v === "true" || v === "1" || v === "") return true;
      if (v === "false" || v === "0") return false;
    }
    issues.push({ path, message: `expected a boolean, got ${typeOf(v)}` });
    return FAIL;
  }
  protected json() {
    return { type: "boolean" };
  }
}

export class DateSchema extends Schema<Date> {
  protected check(value: unknown, path: string, _coerce: boolean, issues: Issue[]) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
    if (typeof value === "string" && FORMATS["date-time"].test(value)) {
      const date = new Date(value);
      const [year, month, day] = value.slice(0, 10).split("-").map(Number);
      const calendar = new Date(0);
      calendar.setUTCFullYear(year!, month! - 1, day!);
      if (Number.isFinite(date.getTime()) && calendar.getUTCMonth() === month! - 1 && calendar.getUTCDate() === day) return date;
    }
    issues.push({ path, message: "expected a valid ISO date-time or Date" });
    return FAIL;
  }
  protected json() { return { type: "string", format: "date-time" }; }
}

export class EnumSchema<const V extends string | number | boolean> extends Schema<V> {
  values: readonly V[];
  constructor(values: readonly V[]) {
    super();
    this.values = values;
  }
  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    const hit = this.values.find((x) => x === v || (coerce && typeof v === "string" && String(x) === v));
    if (hit === undefined) {
      issues.push({ path, message: `must be one of ${this.values.map((x) => JSON.stringify(x)).join(", ")}` });
      return FAIL;
    }
    return hit;
  }
  protected json() {
    return this.values.length === 1 ? { const: this.values[0] } : { enum: [...this.values] };
  }
}

export class AnySchema<T = unknown> extends Schema<T> {
  protected check(v: unknown) {
    return v as T;
  }
  protected json() {
    return {};
  }
}

// ---------- composites ----------

export class ArraySchema<S extends Schema<any>> extends Schema<Infer<S>[]> {
  item: S;
  private rules: { min?: number; max?: number } = {};
  constructor(item: S) {
    super();
    this.item = item;
  }
  min(n: number) { const c = this.clone(); c.rules = { ...this.rules, min: n }; return c; }
  max(n: number) { const c = this.clone(); c.rules = { ...this.rules, max: n }; return c; }

  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    // ?tag=a reads as "a", ?tag=a&tag=b as ["a","b"]: both are a list here.
    const list = coerce && !Array.isArray(v) ? [v] : v;
    if (!Array.isArray(list)) {
      issues.push({ path, message: `expected an array, got ${typeOf(v)}` });
      return FAIL;
    }
    const { min, max } = this.rules;
    if (min !== undefined && list.length < min) issues.push({ path, message: `must have at least ${min} items` });
    if (max !== undefined && list.length > max) issues.push({ path, message: `must have at most ${max} items` });
    const out: Infer<S>[] = [];
    list.forEach((x, i) => {
      const r = this.item._run(x, `${path}[${i}]`, coerce, issues);
      if (r !== FAIL) out.push(r);
    });
    return out;
  }

  protected json(ctx?: RefContext) {
    const s: JsonSchema = { type: "array", items: this.item._schema(ctx) };
    if (this.rules.min !== undefined) s.minItems = this.rules.min;
    if (this.rules.max !== undefined) s.maxItems = this.rules.max;
    return s;
  }
}

export type Shape = Record<string, Schema<any>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
export type InferShape<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

export class ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  shape: S;
  private unknownKeys: "strip" | "strict" | "keep" = "strip";
  constructor(shape: S) {
    super();
    this.shape = shape;
  }
  /** Unknown keys become an error instead of being dropped. */
  strict() { const c = this.clone(); c.unknownKeys = "strict"; return c; }
  /** Unknown keys are kept as they are. */
  passthrough() { const c = this.clone(); c.unknownKeys = "keep"; return c; }
  extend<E extends Shape>(more: E): ObjectSchema<Simplify<Omit<S, keyof E> & E>> {
    return new ObjectSchema({ ...this.shape, ...more }) as never;
  }
  pick<K extends keyof S>(...keys: K[]): ObjectSchema<Pick<S, K>> {
    return new ObjectSchema(Object.fromEntries(keys.map((k) => [k, this.shape[k]])) as Pick<S, K>);
  }
  omit<K extends keyof S>(...keys: K[]): ObjectSchema<Omit<S, K>> {
    const s: Shape = { ...this.shape };
    for (const k of keys) delete s[k as string];
    return new ObjectSchema(s as Omit<S, K>);
  }
  partial(): ObjectSchema<{ [K in keyof S]: Schema<Infer<S[K]> | undefined> }> {
    return new ObjectSchema(Object.fromEntries(Object.entries(this.shape).map(([k, s]) => [k, s.optional()]))) as never;
  }

  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      issues.push({ path, message: `expected an object, got ${typeOf(v)}` });
      return FAIL;
    }
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = this.unknownKeys === "keep" ? { ...input } : {};
    for (const [key, schema] of Object.entries(this.shape)) {
      const r = schema._run(input[key], path ? `${path}.${key}` : key, coerce, issues);
      if (r !== FAIL && r !== undefined) out[key] = r;
    }
    if (this.unknownKeys === "strict") {
      for (const key of Object.keys(input)) {
        if (!(key in this.shape)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
      }
    }
    return out as InferShape<S>;
  }

  protected json(ctx?: RefContext) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, schema] of Object.entries(this.shape)) {
      properties[key] = schema._schema(ctx);
      if (!schema.meta.optional && !schema.meta.hasDefault) required.push(key);
    }
    const s: JsonSchema = { type: "object", properties };
    if (required.length) s.required = required;
    if (this.unknownKeys === "strict") s.additionalProperties = false;
    return s;
  }
}

export class RecordSchema<S extends Schema<any>> extends Schema<Record<string, Infer<S>>> {
  value: S;
  constructor(value: S) {
    super();
    this.value = value;
  }
  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      issues.push({ path, message: `expected an object, got ${typeOf(v)}` });
      return FAIL;
    }
    const out: Record<string, Infer<S>> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = this.value._run(x, path ? `${path}.${k}` : k, coerce, issues);
      if (r !== FAIL) out[k] = r;
    }
    return out;
  }
  protected json(ctx?: RefContext) {
    return { type: "object", additionalProperties: this.value._schema(ctx) };
  }
}

export class UnionSchema<S extends Schema<any>[]> extends Schema<Infer<S[number]>> {
  options: S;
  constructor(options: S) {
    super();
    this.options = options;
  }
  protected check(v: unknown, path: string, coerce: boolean, issues: Issue[]) {
    for (const option of this.options) {
      const local: Issue[] = [];
      const r = option._run(v, path, coerce, local);
      if (r !== FAIL && local.length === 0) return r;
    }
    issues.push({ path, message: "matches none of the allowed shapes" });
    return FAIL;
  }
  protected json(ctx?: RefContext) {
    return { anyOf: this.options.map((o) => o._schema(ctx)) };
  }
}

// ---------- the builder ----------

export class LazySchema<T> extends Schema<T> {
  private resolve: () => Schema<T>;
  constructor(resolve: () => Schema<T>) { super(); this.resolve = resolve; }
  protected check(value: unknown, path: string, coerce: boolean, issues: Issue[]) {
    return this.resolve()._run(value, path, coerce, issues);
  }
  protected json(ctx?: RefContext) {
    const target = this.resolve();
    return target._schema(ctx);
  }
}

export class DiscriminatedSchema<K extends string, S extends Record<string, ObjectSchema<any>>>
  extends Schema<{ [V in keyof S]: Infer<S[V]> & Record<K, V> }[keyof S]> {
  private key: K;
  private options: S;
  constructor(key: K, options: S) {
    super();
    this.key = key;
    this.options = options;
    if (!Object.keys(options).length) throw new Error("A discriminated union needs at least one option");
    for (const [tag, option] of Object.entries(options)) {
      const field = option.shape[key];
      if (!(field instanceof EnumSchema) || field.values.length !== 1 || field.values[0] !== tag || field.meta.optional || field.meta.nullable || field.meta.hasDefault) {
        throw new Error(`Option ${tag} must declare ${key}: t.literal(${JSON.stringify(tag)})`);
      }
    }
  }
  protected check(value: unknown, path: string, coerce: boolean, issues: Issue[]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      issues.push({ path, message: "expected an object" });
      return FAIL;
    }
    const tag = (value as Record<string, unknown>)[this.key];
    if (typeof tag !== "string" || !Object.hasOwn(this.options, tag)) {
      issues.push({ path: path ? `${path}.${this.key}` : this.key, message: `must be one of ${Object.keys(this.options).map(x => JSON.stringify(x)).join(", ")}` });
      return FAIL;
    }
    return this.options[tag]!._run(value, path, coerce, issues) as this["_type"] | Fail;
  }
  protected json(ctx?: RefContext) {
    const mapping: Record<string, string> = {};
    const oneOf = Object.entries(this.options).map(([tag, option]) => {
      const schema = option._schema(ctx);
      if (typeof schema.$ref === "string") mapping[tag] = schema.$ref;
      return schema;
    });
    return { oneOf, discriminator: { propertyName: this.key, ...(Object.keys(mapping).length ? { mapping } : {}) } };
  }
}

const problemShape = {
  type: new StringSchema().describe("A stable code for this kind of problem"),
  title: new StringSchema(),
  status: new NumberSchema(true),
  detail: new StringSchema().optional(),
  instance: new StringSchema().optional(),
};

export const t = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(false),
  int: () => new NumberSchema(true),
  boolean: () => new BooleanSchema(),
  date: () => new DateSchema(),
  lazy: <T>(resolve: () => Schema<T>) => new LazySchema(resolve),
  discriminated: <K extends string, S extends Record<string, ObjectSchema<any>>>(key: K, options: S) => new DiscriminatedSchema(key, options),
  literal: <const V extends string | number | boolean>(value: V) => new EnumSchema<V>([value]),
  enum: <const V extends string | number | boolean>(values: readonly V[]) => new EnumSchema<V>(values),
  array: <S extends Schema<any>>(item: S) => new ArraySchema(item),
  object: <S extends Shape>(shape: S) => new ObjectSchema(shape),
  record: <S extends Schema<any>>(value: S) => new RecordSchema(value),
  union: <S extends Schema<any>[]>(...options: S) => new UnionSchema(options),
  any: <T = unknown>() => new AnySchema<T>(),
  /** No body at all, for a 204. */
  empty: () => new AnySchema<undefined>().optional().describe("No content"),
  /** An RFC 9457 problem document, the shape every inkan error has. */
  problem: () =>
    new ObjectSchema(problemShape).passthrough().named("Problem").describe("An RFC 9457 problem document"),
};
