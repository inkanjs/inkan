// The seal: a contract stamped into plain code.
//
// inkan checks and writes every route through the same few functions, one per kind of
// schema. That is small and easy to trust, but V8 sees every shape of every route go
// through them and cannot specialise them for any one. `inkan seal` writes each contract
// out as its own code instead, ahead of time, into a file you can read and commit: no
// eval, no new Function. At start the app writes the same code again from the live
// contract and uses the stamped version only when the two hash the same, so a seal that
// no longer fits its contract is never used.
//
// The code a schema compiles to has to do exactly what the schema does: the same value,
// the same issues with the same paths, in the same order.

import { createHash } from "node:crypto";
import {
  AnySchema,
  ArraySchema,
  BooleanSchema,
  EnumSchema,
  FORMATS,
  NumberSchema,
  ObjectSchema,
  StringSchema,
  type Issue,
  type Schema,
} from "../schema/schema.ts";

/** The version of the code a seal is written in. A seal of another version is not used. */
export const SEAL_FORMAT = 2;

/** A contract's check, stamped into code. Writing is the schema's own, so a seal never writes differently. */
export type SealedEntry = {
  parse: (value: unknown, coerce: boolean) => { ok: true; value: unknown } | { ok: false; issues: Issue[] };
};
export type Seal = { inkan: number; entries: Record<string, SealedEntry> };

/** Thrown for a schema the seal cannot write yet; that contract then runs unsealed. */
export class Unsealable extends Error {}

/** What every entry in a seal file can lean on. Fixed per SEAL_FORMAT, so not part of a hash. */
export const PRELUDE = `const F = Symbol("fail");
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const json = (v) => JSON.stringify(v) ?? "null";`;

/** A schema as an expression that evaluates to its entry, and the hash that finds it again. */
export function compile(schema: Schema<any>): { source: string; hash: string } {
  const g = new Gen();
  const parse = g.parser(schema);
  const source = `(() => {\n${g.hoisted.join("\n")}\nreturn { parse: ${parse} };\n})()`;
  return { source, hash: createHash("sha256").update(source).digest("base64url").slice(0, 22) };
}

// The schema classes keep their rules to themselves; the compiler is the one reader allowed.
const rulesOf = (s: Schema<any>) => (s as unknown as { rules: Record<string, any> }).rules ?? {};
const unknownKeysOf = (s: ObjectSchema<any>) => (s as unknown as { unknownKeys: "strip" | "strict" | "keep" }).unknownKeys;
const lit = (v: unknown) => JSON.stringify(v);
const num = (v: number) => {
  if (!Number.isFinite(v)) throw new Unsealable("a limit that is not a finite number");
  return String(v);
};

/** A path while the code is written: a string known now, or an expression known per request. */
type Path = { known: string } | { expr: string };
const pathExpr = (p: Path) => ("known" in p ? lit(p.known) : p.expr);
const child = (p: Path, key: string): Path =>
  "known" in p ? { known: p.known ? `${p.known}.${key}` : key } : { expr: `${p.expr} + ${lit("." + key)}` };

function isPlainJson(v: unknown): boolean {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return typeof v !== "number" || Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isPlainJson);
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v as object).every(isPlainJson);
  return false;
}

class Gen {
  hoisted: string[] = [];
  private n = 0;
  private name(prefix: string) {
    return `${prefix}${this.n++}`;
  }
  private hoist(prefix: string, code: (name: string) => string) {
    const name = this.name(prefix);
    this.hoisted.push(code(name));
    return name;
  }

  // ---------- checking ----------

  parser(schema: Schema<any>): string {
    const r = this.name("r");
    return `function (v, coerce) {
const issues = [];
${this.run(schema, "v", { known: "" }, r)}
return ${r} === F || issues.length ? { ok: false, issues } : { ok: true, value: ${r} };
}`;
  }

  /** Statements that leave in `r` what Schema._run returns: the value, or F. */
  private run(schema: Schema<any>, x: string, p: Path, r: string): string {
    const m = schema.meta;
    let missing: string;
    if (m.hasDefault) {
      if (!isPlainJson(m.default)) throw new Unsealable("a default that is not plain JSON");
      missing = `${r} = ${typeof m.default === "object" && m.default !== null ? `structuredClone(${lit(m.default)})` : lit(m.default)};`;
    } else if (m.optional) missing = `${r} = undefined;`;
    else missing = `issues.push({ path: ${pathExpr(p)}, message: "is required" }); ${r} = F;`;
    const nullable = m.nullable ? ` else if (${x} === null) { ${r} = null; }` : "";
    return `let ${r};\nif (${x} === undefined) { ${missing} }${nullable} else {\n${this.check(schema, x, p, r)}\n}`;
  }

  private check(schema: Schema<any>, x: string, p: Path, r: string): string {
    const at = pathExpr(p);
    const issue = (message: string) => `issues.push({ path: ${at}, message: ${message} });`;

    if (schema instanceof StringSchema) {
      const { min, max, pattern, format, trim } = rulesOf(schema);
      const s = this.name("s");
      const lines = [
        `if (typeof ${x} !== "string") { ${issue(`"expected a string, got " + typeOf(${x})`)} ${r} = F; } else {`,
        `const ${s} = ${trim ? `${x}.trim()` : x};`,
      ];
      if (min !== undefined) lines.push(`if (${s}.length < ${min}) ${issue(lit(`must be at least ${min} characters`))}`);
      if (max !== undefined) lines.push(`if (${s}.length > ${max}) ${issue(lit(`must be at most ${max} characters`))}`);
      if (pattern) {
        // a global or sticky regex remembers where it stopped; a copy would not share that
        if (pattern.global || pattern.sticky) throw new Unsealable("a global or sticky pattern");
        const re = this.hoist("RE", (n) => `const ${n} = new RegExp(${lit(pattern.source)}, ${lit(pattern.flags)});`);
        lines.push(`if (!${re}.test(${s})) ${issue(lit(`must match ${pattern}`))}`);
      }
      if (format) {
        const f = FORMATS[format];
        const re = this.hoist("RE", (n) => `const ${n} = new RegExp(${lit(f.source)}, ${lit(f.flags)});`);
        lines.push(`if (!${re}.test(${s})) ${issue(lit(`must be a valid ${format}`))}`);
      }
      lines.push(`${r} = ${s};`, "}");
      return lines.join("\n");
    }

    if (schema instanceof NumberSchema) {
      const { int, min, max } = rulesOf(schema);
      const n = this.name("n");
      const kind = int ? "an integer" : "a number";
      const lines = [
        `let ${n} = ${x};`,
        `if (coerce && typeof ${x} === "string" && ${x}.trim() !== "") ${n} = Number(${x});`,
        `if (typeof ${n} !== "number" || Number.isNaN(${n}) || !Number.isFinite(${n})) { ${issue(`${lit(`expected ${kind}, got `)} + (typeof ${x} === "string" ? JSON.stringify(${x}) : typeOf(${x}))`)} ${r} = F; }`,
      ];
      if (int) lines.push(`else if (!Number.isInteger(${n})) { ${issue(`"expected an integer, got " + ${n}`)} ${r} = F; }`);
      lines.push("else {");
      if (min !== undefined) lines.push(`if (${n} < ${num(min)}) ${issue(lit(`must be ${min} or more`))}`);
      if (max !== undefined) lines.push(`if (${n} > ${num(max)}) ${issue(lit(`must be ${max} or less`))}`);
      lines.push(`${r} = ${n};`, "}");
      return lines.join("\n");
    }

    if (schema instanceof BooleanSchema) {
      return [
        `if (typeof ${x} === "boolean") ${r} = ${x};`,
        `else if (coerce && (${x} === "true" || ${x} === "1" || ${x} === "")) ${r} = true;`,
        `else if (coerce && (${x} === "false" || ${x} === "0")) ${r} = false;`,
        `else { ${issue(`"expected a boolean, got " + typeOf(${x})`)} ${r} = F; }`,
      ].join("\n");
    }

    if (schema instanceof EnumSchema) {
      // the first value that matches wins, as with Array.prototype.find
      const values = schema.values as readonly (string | number | boolean)[];
      const tests = values.map((value) => `if (${x} === ${lit(value)} || (coerce && ${x} === ${lit(String(value))})) ${r} = ${lit(value)};`);
      const message = `must be one of ${values.map((v) => JSON.stringify(v)).join(", ")}`;
      return [...tests.map((t, i) => (i ? `else ${t}` : t)), `else { ${issue(lit(message))} ${r} = F; }`].join("\n");
    }

    if (schema instanceof AnySchema) return `${r} = ${x};`;

    if (schema instanceof ArraySchema) {
      const { min, max } = rulesOf(schema);
      const [list, out, i, item, ir] = [this.name("l"), this.name("o"), this.name("i"), this.name("x"), this.name("r")];
      const lines = [
        // ?tag=a reads as "a", ?tag=a&tag=b as ["a","b"]: both are a list here
        `const ${list} = coerce && !Array.isArray(${x}) ? [${x}] : ${x};`,
        `if (!Array.isArray(${list})) { ${issue(`"expected an array, got " + typeOf(${x})`)} ${r} = F; } else {`,
      ];
      if (min !== undefined) lines.push(`if (${list}.length < ${min}) ${issue(lit(`must have at least ${min} items`))}`);
      if (max !== undefined) lines.push(`if (${list}.length > ${max}) ${issue(lit(`must have at most ${max} items`))}`);
      const itemPath: Path = { expr: `${pathExpr(p)} + "[" + ${i} + "]"` };
      lines.push(
        `const ${out} = [];`,
        // forEach skips holes, so this does too
        `for (let ${i} = 0; ${i} < ${list}.length; ${i}++) { if (!(${i} in ${list})) continue; const ${item} = ${list}[${i}];`,
        this.run(schema.item, item, itemPath, ir),
        `if (${ir} !== F) ${out}.push(${ir}); }`,
        `${r} = ${out};`,
        "}",
      );
      return lines.join("\n");
    }

    if (schema instanceof ObjectSchema) {
      const mode = unknownKeysOf(schema);
      const out = this.name("o");
      const lines = [
        `if (typeof ${x} !== "object" || ${x} === null || Array.isArray(${x})) { ${issue(`"expected an object, got " + typeOf(${x})`)} ${r} = F; } else {`,
        `const ${out} = ${mode === "keep" ? `{ ...${x} }` : "{}"};`,
      ];
      for (const [key, field] of Object.entries(schema.shape as Record<string, Schema<any>>)) {
        const [fx, fr] = [this.name("x"), this.name("r")];
        lines.push(`const ${fx} = ${x}[${lit(key)}];`, this.run(field, fx, child(p, key), fr), `if (${fr} !== F && ${fr} !== undefined) ${out}[${lit(key)}] = ${fr};`);
      }
      if (mode === "strict") {
        // `in` looks at the prototype too, as the schema does with its shape
        const shape = this.hoist("SHAPE", (n) => `const ${n} = ${lit(Object.fromEntries(Object.keys(schema.shape).map((k) => [k, 1])))};`);
        const k = this.name("k");
        const keyPath = "known" in p ? (p.known ? `${lit(p.known + ".")} + ${k}` : k) : `${p.expr} + "." + ${k}`;
        lines.push(`for (const ${k} of Object.keys(${x})) if (!(${k} in ${shape})) issues.push({ path: ${keyPath}, message: "is not allowed" });`);
      }
      lines.push(`${r} = ${out};`, "}");
      return lines.join("\n");
    }

    throw new Unsealable(`a ${schema.constructor.name}`);
  }
}
