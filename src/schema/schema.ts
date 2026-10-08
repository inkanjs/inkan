// A small schema builder. One definition gives you a runtime check,
// a TypeScript type and a JSON Schema, so they cannot drift apart.

import { Buffer } from "node:buffer"; // explicit, for runtimes without a global Buffer

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
/** @internal What `_into` hands back for a value that breaks its schema. */
export const INVALID = FAIL;

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

/**
 * A schema's check, as a plain function: the value (coerced, defaulted, stripped), or FAIL
 * with what is wrong pushed onto `issues`. Built once per schema, the first time it is used.
 */
export type Check<T> = (value: unknown, path: string, coerce: boolean, issues: Issue[]) => T | Fail;

const required = (path: string, issues: Issue[]): Fail => {
  issues.push({ path, message: "is required" });
  return FAIL;
};

export abstract class Schema<T = unknown> {
  declare readonly _type: T;
  meta: Meta = {};

  /**
   * The check of this kind of schema, made once from its rules: its stamp. Every rule is
   * read here, not per value, so the function it returns only does what this schema asks.
   */
  protected abstract stamp(): Check<T>;
  protected abstract json(ctx?: RefContext): JsonSchema;

  private _check?: Check<T>;

  /** @internal */
  _run(value: unknown, path: string, coerce: boolean, issues: Issue[]): T | Fail {
    return (this._check ??= this.runner())(value, path, coerce, issues);
  }

  /** The stamp, with what every schema does first: a missing value, a default, null. */
  protected runner(): Check<T> {
    const check = this.stamp();
    const { hasDefault, optional, nullable } = this.meta;
    const fallback = this.meta.default;
    if (!hasDefault && !optional && !nullable) {
      return (v, path, coerce, issues) => (v === undefined ? required(path, issues) : check(v, path, coerce, issues));
    }
    return (v, path, coerce, issues) => {
      if (v === undefined) {
        if (hasDefault) return structuredClone(fallback) as T;
        if (optional) return undefined as T;
        return required(path, issues);
      }
      if (v === null && nullable) return null as T;
      return check(v, path, coerce, issues);
    };
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
    copy._ser = undefined; // a copy with other rules writes its own way
    copy._exactSer = undefined;
    copy._check = undefined; // and checks its own way, from its own rules
    copy._sealedParse = undefined; // a seal belongs to one contract
    copy._sealedBy = undefined;
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
    return new EffectSchema(
      this,
      (value, path, issues) => {
        if (!fn(value)) issues.push({ path, message });
        return value;
      },
      true,
    );
  }
  /** Changes the parsed value, while documenting the original wire schema. */
  transform<U>(fn: (value: T) => U): Schema<U> {
    return new EffectSchema(this, fn, false);
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

  /**
   * @internal safeParse without its result object, for the request path: the value, or
   * INVALID with every issue pushed onto `issues` (which must come in empty). A seal is used
   * when there is one, as in safeParse.
   */
  _into(value: unknown, coerce: boolean, issues: Issue[]): T | typeof INVALID {
    if (this._sealedParse) {
      const r = this._sealedParse(value, coerce) as SafeResult<T>;
      if (r.ok) return r.value;
      issues.push(...r.issues);
      return FAIL;
    }
    const out = this._run(value, "", coerce, issues);
    return out === FAIL || issues.length ? FAIL : out;
  }

  safeParse(value: unknown, opts: { coerce?: boolean } = {}): SafeResult<T> {
    if (this._sealedParse) return this._sealedParse(value, opts.coerce ?? false) as SafeResult<T>;
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

  private _ser?: (v: unknown) => string;
  private _sealedParse?: (v: unknown, coerce: boolean) => SafeResult<unknown>;
  /** @internal The seal this schema runs on, if any. */
  _sealedBy?: object;

  /**
   * @internal Hands checking and writing to code stamped from this very contract by
   * `inkan seal`. Only called once the stamped code is known to match (see seal/apply.ts).
   */
  _seal(by: object, parse: (v: unknown, coerce: boolean) => SafeResult<unknown>, write: (v: unknown) => string) {
    this._sealedBy = by;
    this._sealedParse = parse;
    this._ser = write;
  }

  /**
   * @internal A function that writes a value as JSON with only what this schema lists, in
   * one pass, built once per schema and kept. It does not validate; it is what keeps keys
   * the contract does not list on the server, in production too. A declared field is read
   * once, as any property is (a getter on a class works); one that is undefined, a function
   * or a symbol is left out, as JSON.stringify leaves it out.
   */
  _serializer(): (v: unknown) => string {
    return (this._ser ??= this._exact());
  }

  private _exactSer?: (v: unknown) => string;
  /** @internal The writer that writes only what this schema lists, without asking first. Children use it too. */
  _exact(): (v: unknown) => string {
    if (!this._exactSer) {
      const inner = this.serialize();
      this._exactSer = this.meta.nullable ? (v) => (v === null ? "null" : inner(v)) : inner;
    }
    return this._exactSer;
  }




  /** How this kind of schema writes a value. The fallback lets the parser strip, then writes that. */
  protected serialize(): (v: unknown) => string {
    return (v) => {
      const r = this.safeParse(v);
      return JSON.stringify(r.ok ? r.value : v) ?? "null";
    };
  }
}

const json = (v: unknown) => JSON.stringify(v) ?? "null";

// Text with nothing to escape, which is most of it, goes out between quotes; the rest as
// JSON.stringify writes it (quotes, backslashes, control characters, lone surrogates).
const PLAIN = /^[^"\\\u0000-\u001f\ud800-\udfff]*$/;
const writeString = (s: string) => (PLAIN.test(s) ? `"${s}"` : JSON.stringify(s));

/** What JSON.stringify leaves out of an object, and writes as null in a list: nothing, a function, a symbol. */
const absent = (x: unknown) => x === undefined || typeof x === "function" || typeof x === "symbol";

class EffectSchema<T, U> extends Schema<U> {
  private source: Schema<T>;
  private effect: (value: T, path: string, issues: Issue[]) => U;
  private outerOptional = false;
  private outerNullable = false;
  private outerDefault = false;
  /** A refinement keeps the value's shape, a transform makes a new one. */
  private sameShape: boolean;
  constructor(source: Schema<T>, effect: (value: T, path: string, issues: Issue[]) => U, sameShape: boolean) {
    super();
    this.source = source;
    this.effect = effect;
    this.sameShape = sameShape;
    this.meta = { ...source.meta };
  }
  protected override serialize() {
    // a refined value still has the source's shape; a transformed one has none we know
    return this.sameShape ? this.source._exact() : json;
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
  // Its own optional, nullable and default are the ones set on it; the source's are the
  // source's business, checked when the source runs.
  protected override runner(): Check<U> {
    const check = this.stamp();
    const { outerDefault, outerOptional, outerNullable } = this;
    const fallback = this.meta.default;
    return (value, path, coerce, issues) => {
      if (value === undefined) {
        if (outerDefault) return structuredClone(fallback) as U;
        if (outerOptional) return undefined as U;
      }
      if (value === null && outerNullable) return null as U;
      return check(value, path, coerce, issues);
    };
  }
  protected stamp(): Check<U> {
    const { source, effect } = this;
    return (value, path, coerce, issues) => {
      const count = issues.length;
      const parsed = source._run(value, path, coerce, issues);
      if (parsed === FAIL || issues.length !== count) return FAIL;
      return effect(parsed, path, issues);
    };
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

/**
 * Children are checked with a path relative to their parent, and only the issues they
 * report get the parent's part put in front. A value that checks out costs no path at all;
 * before, every field of every item built its full path on the way, used or not.
 */
function under(issues: Issue[], from: number, at: string) {
  for (let i = from; i < issues.length; i++) {
    const p = issues[i].path;
    issues[i].path = p === "" ? at : p.charCodeAt(0) === 91 /* [ */ ? at + p : `${at}.${p}`;
  }
}

// ---------- primitives ----------

export const FORMATS: Record<string, RegExp> = {
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

  protected stamp(): Check<string> {
    const { min, max, pattern, format, trim } = this.rules;
    const shape = format ? FORMATS[format] : undefined;
    const plain = min === undefined && max === undefined && !pattern && !shape;
    return (v, path, _coerce, issues) => {
      if (typeof v !== "string") {
        issues.push({ path, message: `expected a string, got ${typeOf(v)}` });
        return FAIL;
      }
      const s = trim ? v.trim() : v;
      if (plain) return s;
      if (min !== undefined && s.length < min) issues.push({ path, message: `must be at least ${min} characters` });
      if (max !== undefined && s.length > max) issues.push({ path, message: `must be at most ${max} characters` });
      if (pattern && !pattern.test(s)) issues.push({ path, message: `must match ${pattern}` });
      if (shape && !shape.test(s)) issues.push({ path, message: `must be a valid ${format}` });
      return s;
    };
  }

  protected override serialize() {
    return (v: unknown) => (typeof v === "string" ? writeString(v) : json(v));
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

  protected stamp(): Check<number> {
    const { int, min, max } = this.rules;
    const kind = int ? "an integer" : "a number";
    return (v, path, coerce, issues) => {
      let n = v;
      if (coerce && typeof v === "string" && v.trim() !== "") n = Number(v);
      if (typeof n !== "number" || !Number.isFinite(n)) {
        issues.push({ path, message: `expected ${kind}, got ${typeof v === "string" ? JSON.stringify(v) : typeOf(v)}` });
        return FAIL;
      }
      if (int && !Number.isInteger(n)) {
        issues.push({ path, message: `expected an integer, got ${n}` });
        return FAIL;
      }
      if (min !== undefined && n < min) issues.push({ path, message: `must be ${min} or more` });
      if (max !== undefined && n > max) issues.push({ path, message: `must be ${max} or less` });
      return n;
    };
  }

  protected override serialize() {
    return (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : json(v));
  }


  protected json() {
    const s: JsonSchema = { type: this.rules.int ? "integer" : "number" };
    if (this.rules.min !== undefined) s.minimum = this.rules.min;
    if (this.rules.max !== undefined) s.maximum = this.rules.max;
    return s;
  }
}

export class BooleanSchema extends Schema<boolean> {
  protected stamp(): Check<boolean> {
    return (v, path, coerce, issues) => {
      if (typeof v === "boolean") return v;
      if (coerce && typeof v === "string") {
        if (v === "true" || v === "1" || v === "") return true;
        if (v === "false" || v === "0") return false;
      }
      issues.push({ path, message: `expected a boolean, got ${typeOf(v)}` });
      return FAIL;
    };
  }
  protected override serialize() {
    return (v: unknown) => (v === true ? "true" : v === false ? "false" : json(v));
  }
  protected json() {
    return { type: "boolean" };
  }
}

export class DateSchema extends Schema<Date> {
  protected stamp(): Check<Date> {
    const iso = FORMATS["date-time"];
    return (value, path, _coerce, issues) => {
      if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
      if (typeof value === "string" && iso.test(value)) {
        const date = new Date(value);
        const [year, month, day] = value.slice(0, 10).split("-").map(Number);
        const calendar = new Date(0);
        calendar.setUTCFullYear(year!, month! - 1, day!);
        if (Number.isFinite(date.getTime()) && calendar.getUTCMonth() === month! - 1 && calendar.getUTCDate() === day) return date;
      }
      issues.push({ path, message: "expected a valid ISO date-time or Date" });
      return FAIL;
    };
  }
  protected override serialize() {
    return (v: unknown) => (v instanceof Date ? (Number.isFinite(v.getTime()) ? `"${v.toISOString()}"` : "null") : json(v));
  }
  protected json() { return { type: "string", format: "date-time" }; }
}

export class EnumSchema<const V extends string | number | boolean> extends Schema<V> {
  values: readonly V[];
  constructor(values: readonly V[]) {
    super();
    this.values = values;
  }
  protected stamp(): Check<V> {
    // a set for the values as they are, and the first value for each spelling, for text that is coerced
    const values = new Set<unknown>(this.values);
    const spelled = new Map<string, V>();
    for (const x of this.values) if (!spelled.has(String(x))) spelled.set(String(x), x);
    const message = `must be one of ${this.values.map((x) => JSON.stringify(x)).join(", ")}`;
    return (v, path, coerce, issues) => {
      if (coerce && typeof v === "string") {
        const hit = spelled.get(v);
        if (hit !== undefined) return hit;
      } else if (values.has(v)) return v as V;
      issues.push({ path, message });
      return FAIL;
    };
  }
  protected override serialize() {
    return json;
  }
  protected json() {
    return this.values.length === 1 ? { const: this.values[0] } : { enum: [...this.values] };
  }
}

export class AnySchema<T = unknown> extends Schema<T> {
  protected stamp(): Check<T> {
    return (v) => v as T;
  }
  protected override serialize() {
    return json;
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

  protected stamp(): Check<Infer<S>[]> {
    const { item } = this;
    const { min, max } = this.rules;
    return (v, path, coerce, issues) => {
      // ?tag=a reads as "a", ?tag=a&tag=b as ["a","b"]: both are a list here.
      const list = coerce && !Array.isArray(v) ? [v] : v;
      if (!Array.isArray(list)) {
        issues.push({ path, message: `expected an array, got ${typeOf(v)}` });
        return FAIL;
      }
      if (min !== undefined && list.length < min) issues.push({ path, message: `must have at least ${min} items` });
      if (max !== undefined && list.length > max) issues.push({ path, message: `must have at most ${max} items` });
      const out: Infer<S>[] = [];
      for (let i = 0; i < list.length; i++) {
        if (!(i in list)) continue; // a hole, skipped as forEach skips it
        const start = issues.length;
        const r = item._run(list[i], "", coerce, issues);
        if (issues.length > start) under(issues, start, `${path}[${i}]`);
        if (r !== FAIL) out.push(r);
      }
      return out;
    };
  }

  protected override serialize() {
    const item = this.item._exact();
    return (v: unknown) => {
      if (!Array.isArray(v)) return json(v);
      let out = "[";
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        out += (i ? "," : "") + (absent(x) ? "null" : item(x));
      }
      return out + "]";
    };
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

  protected stamp(): Check<InferShape<S>> {
    const { shape, unknownKeys } = this;
    const keys = Object.keys(shape);
    const schemas = keys.map((k) => shape[k]!);
    return (v, path, coerce, issues) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        issues.push({ path, message: `expected an object, got ${typeOf(v)}` });
        return FAIL;
      }
      const input = v as Record<string, unknown>;
      const out: Record<string, unknown> = unknownKeys === "keep" ? { ...input } : {};
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const start = issues.length;
        const r = schemas[i]!._run(input[key], "", coerce, issues);
        if (issues.length > start) under(issues, start, path ? `${path}.${key}` : key);
        if (r !== FAIL && r !== undefined) out[key] = r;
      }
      if (unknownKeys === "strict") {
        for (const key of Object.keys(input)) {
          if (!(key in shape)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
        }
      }
      return out as InferShape<S>;
    };
  }

  protected override serialize() {
    if (this.unknownKeys === "keep") return json; // passthrough: everything goes, by definition
    // the key and its colon, written once; per request only the values are written
    const keys = Object.keys(this.shape);
    const heads = keys.map((key) => `${JSON.stringify(key)}:`);
    const writers = keys.map((key) => this.shape[key]!._exact());
    return (v: unknown) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return json(v);
      const o = v as Record<string, unknown>;
      let out = "{";
      for (let i = 0; i < keys.length; i++) {
        const x = o[keys[i]!]; // read once: a getter runs once
        if (absent(x)) continue;
        out += (out.length > 1 ? "," : "") + heads[i] + writers[i]!(x);
      }
      return out + "}";
    };
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
  protected stamp(): Check<Record<string, Infer<S>>> {
    const { value } = this;
    return (v, path, coerce, issues) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        issues.push({ path, message: `expected an object, got ${typeOf(v)}` });
        return FAIL;
      }
      const out: Record<string, Infer<S>> = {};
      for (const [k, x] of Object.entries(v)) {
        const start = issues.length;
        const r = value._run(x, "", coerce, issues);
        if (issues.length > start) under(issues, start, path ? `${path}.${k}` : k);
        if (r !== FAIL) out[k] = r;
      }
      return out;
    };
  }
  protected override serialize() {
    const write = this.value._exact();
    return (v: unknown) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return json(v);
      let out = "{";
      let first = true;
      for (const [k, x] of Object.entries(v)) {
        if (absent(x)) continue;
        out += (first ? "" : ",") + writeString(k) + ":" + write(x);
        first = false;
      }
      return out + "}";
    };
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
  protected stamp(): Check<Infer<S[number]>> {
    const { options } = this;
    return (v, path, coerce, issues) => {
      for (const option of options) {
        const local: Issue[] = [];
        const r = option._run(v, path, coerce, local);
        if (r !== FAIL && local.length === 0) return r;
      }
      issues.push({ path, message: "matches none of the allowed shapes" });
      return FAIL;
    };
  }
  protected json(ctx?: RefContext) {
    return { anyOf: this.options.map((o) => o._schema(ctx)) };
  }
}

// ---------- the builder ----------

export class LazySchema<T> extends Schema<T> {
  private resolve: () => Schema<T>;
  constructor(resolve: () => Schema<T>) { super(); this.resolve = resolve; }
  protected stamp(): Check<T> {
    // resolved on first use, so a shape that contains itself can be defined before it exists
    let target: Schema<T> | undefined;
    return (value, path, coerce, issues) => (target ??= this.resolve())._run(value, path, coerce, issues);
  }
  protected override serialize() {
    // resolved on first use, so a recursive shape does not build itself forever
    let write: ((v: unknown) => string) | undefined;
    return (v: unknown) => (write ??= this.resolve()._exact())(v);
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
  protected stamp(): Check<this["_type"]> {
    const { key, options } = this;
    const message = `must be one of ${Object.keys(options).map((x) => JSON.stringify(x)).join(", ")}`;
    return (value, path, coerce, issues) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ path, message: "expected an object" });
        return FAIL;
      }
      const tag = (value as Record<string, unknown>)[key];
      if (typeof tag !== "string" || !Object.hasOwn(options, tag)) {
        issues.push({ path: path ? `${path}.${key}` : key, message });
        return FAIL;
      }
      return options[tag]!._run(value, path, coerce, issues) as this["_type"] | Fail;
    };
  }
  protected override serialize() {
    // the tag says which option it is, so that option's writer is used
    const writers = new Map(Object.entries(this.options).map(([tag, option]) => [tag, option._exact()]));
    return (v: unknown) => {
      const tag = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[this.key] : undefined;
      const write = typeof tag === "string" ? writers.get(tag) : undefined;
      return write ? write(v) : json(v);
    };
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

// ---------- files and server-sent events ----------

/** A file from a multipart/form-data upload. */
export type UploadedFile = { name: string; type: string; size: number; data: Buffer };

const isUploaded = (v: unknown): v is UploadedFile =>
  typeof v === "object" && v !== null && Buffer.isBuffer((v as UploadedFile).data) && typeof (v as UploadedFile).name === "string";

export class FileSchema extends Schema<UploadedFile> {
  private rules: { max?: number; accept?: string[] } = {};

  /** The largest file in bytes. The request body limit of the app still applies to the whole upload. */
  max(bytes: number) { const c = this.clone(); c.rules = { ...this.rules, max: bytes }; return c; }
  /** Media types that may come in: `"image/png"`, or `"image/*"` for a whole family. */
  accept(...types: string[]) { const c = this.clone(); c.rules = { ...this.rules, accept: types }; return c; }

  protected stamp(): Check<UploadedFile> {
    const { max, accept } = this.rules;
    return (v, path, _coerce, issues) => {
      if (!isUploaded(v)) {
        issues.push({ path, message: "expected a file, sent as multipart/form-data" });
        return FAIL;
      }
      if (max !== undefined && v.size > max) issues.push({ path, message: `is ${v.size} bytes, at most ${max} are allowed` });
      if (accept && !accept.some((a) => (a.endsWith("/*") ? v.type.startsWith(a.slice(0, -1)) : v.type === a))) {
        issues.push({ path, message: `has to be ${accept.join(" or ")}, got ${v.type || "no type"}` });
      }
      return v;
    };
  }

  protected json() {
    const s: JsonSchema = { type: "string", format: "binary" };
    if (this.rules.accept?.length === 1) s.contentMediaType = this.rules.accept[0];
    if (this.rules.max !== undefined) s["x-max-bytes"] = this.rules.max;
    return s;
  }
}

// ---------- bodies as they come ----------

/**
 * A request body taken as it comes, not parsed: a file sent as the body itself, a
 * webhook's signed bytes. `max` is also the route's body limit, so it may be larger than
 * the app's; `accept` names the media types it takes, and anything else is a 415.
 */
export abstract class RawBodySchema<T> extends Schema<T> {
  /** @internal */
  rules: { max?: number; accept?: string[] } = {};

  /** The most bytes the body may have. It is this route's body limit, past the app's `bodyLimit` too. */
  max(bytes: number) { const c = this.clone(); c.rules = { ...this.rules, max: bytes }; return c; }
  /** Media types the body may have: `"image/png"`, or `"image/*"` for a whole family. Default: any. */
  accept(...types: string[]) { const c = this.clone(); c.rules = { ...this.rules, accept: types }; return c; }

  /** @internal Whether a body of this media type may come in. */
  accepts(type: string) {
    const { accept } = this.rules;
    return !accept || accept.some((a) => (a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));
  }
  /** @internal The media types for the OpenAPI document. */
  mediaTypes() {
    return this.rules.accept?.length ? this.rules.accept : ["application/octet-stream"];
  }

  protected json() {
    const s: JsonSchema = { type: "string", format: "binary" };
    if (this.rules.max !== undefined) s["x-max-bytes"] = this.rules.max;
    return s;
  }
}

/** The whole body as bytes, read before the handler runs. */
export class BinarySchema extends RawBodySchema<Buffer> {
  protected stamp(): Check<Buffer> {
    const optional = this.meta.optional;
    return (v, path, _coerce, issues) => {
      if (!Buffer.isBuffer(v)) {
        issues.push({ path, message: `expected the body as bytes, got ${typeOf(v)}` });
        return FAIL;
      }
      if (v.length === 0 && !optional) {
        issues.push({ path, message: "is empty" });
        return FAIL;
      }
      return v;
    };
  }
}

/**
 * The body as a stream of chunks, read by the handler while it arrives: for an upload too
 * large to hold in memory. Nothing is read before the handler, and past `max` the stream
 * throws a 413 problem. Without `max` there is no limit.
 */
export class StreamSchema extends RawBodySchema<AsyncIterable<Buffer>> {
  protected stamp(): Check<AsyncIterable<Buffer>> {
    return (v, path, _coerce, issues) => {
      if (typeof v !== "object" || v === null || typeof (v as AsyncIterable<Buffer>)[Symbol.asyncIterator] !== "function") {
        issues.push({ path, message: `expected the body as a stream, got ${typeOf(v)}` });
        return FAIL;
      }
      return v as AsyncIterable<Buffer>;
    };
  }
}

/** One event of a server-sent event stream, as a handler yields it and a client reads it. */
export type ServerEvent<E extends Record<string, Schema<any>>> = {
  [K in keyof E & string]: { event: K; data: Infer<E[K]>; id?: string };
}[keyof E & string];

/** The events a stream may send, by name. Every event is checked against its schema. */
export class EventsSchema<E extends Record<string, Schema<any>>> extends Schema<ServerEvent<E>> {
  events: E;
  constructor(events: E) {
    super();
    this.events = events;
  }
  protected stamp(): Check<ServerEvent<E>> {
    const { events } = this;
    return (v, path, coerce, issues) => {
      const e = v as { event?: unknown; data?: unknown; id?: unknown };
      const name = typeof e?.event === "string" ? e.event : "message";
      const schema = Object.hasOwn(events, name) ? events[name] : undefined;
      if (!schema) {
        issues.push({ path, message: `the event ${JSON.stringify(name)} is not in the contract` });
        return FAIL;
      }
      const data = schema._run(e?.data, path ? `${path}.data` : "data", coerce, issues);
      if (data === FAIL) return FAIL;
      return { ...e, event: name, data } as ServerEvent<E>;
    };
  }
  protected json(ctx?: RefContext) {
    return {
      oneOf: Object.entries(this.events).map(([name, s]) => ({
        type: "object",
        properties: { event: { const: name }, data: s._schema(ctx), id: { type: "string" } },
        required: ["event", "data"],
      })),
    };
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
  /** A file in a multipart/form-data body. A body with a file in it is read as multipart. */
  file: () => new FileSchema(),
  /** The whole request body as bytes, any media type: an upload sent as the body itself. */
  binary: () => new BinarySchema(),
  /** The request body as a stream of chunks, for the handler to read as it arrives: an upload too large for memory. */
  stream: () => new StreamSchema(),
  /** A server-sent event stream: the events it may send, each with the schema of its data. */
  events: <E extends Record<string, Schema<any>>>(events: E) => new EventsSchema(events),
  /** An RFC 9457 problem document, the shape every inkan error has. */
  problem: () =>
    new ObjectSchema(problemShape).passthrough().named("Problem").describe("An RFC 9457 problem document"),
};
