// Compares two OpenAPI documents and names what would break a client that was
// written against the first one. Requests may only get looser, answers may only
// get stricter; everything else is a breaking change.

import { mdCode, mdText, plural, type FormatOptions } from "../testing/check.ts";

type Json = Record<string, any>;
type Doc = { paths?: Record<string, Record<string, Json>>; components?: { schemas?: Record<string, Json> } };
type Dir = "request" | "response";

/**
 * What changed, as a name for machines: `message` is for people and may be worded
 * differently in a later release, `kind` is not. `request-…` and `response-…` kinds
 * name a value in a request (a parameter or the body) or in an answer.
 * @experimental
 */
export type ChangeKind =
  | "route-removed"
  | "route-added"
  | "param-added-required"
  | "param-added-optional"
  | "param-required"
  | "param-removed"
  | "body-added-required"
  | "body-required"
  | "status-removed"
  | "status-added"
  | "request-null-removed"
  | "response-null-added"
  | "request-type-changed"
  | "response-type-changed"
  | "request-value-removed"
  | "request-value-added"
  | "request-values-restricted"
  | "response-value-added"
  | "response-value-removed"
  | "response-values-unrestricted"
  | "request-limit-tightened"
  | "request-pattern-changed"
  | "request-format-changed"
  | "request-extra-keys-refused"
  | "request-field-added-required"
  | "request-field-added-optional"
  | "request-field-required"
  | "request-field-removed"
  | "response-field-removed"
  | "response-optional-field-removed"
  | "response-field-added"
  | "response-field-optional"
  | "request-shape-changed"
  | "response-shape-changed";

/**
 * One difference between two OpenAPI documents. The shape of `inkan diff --json` is a list
 * of these, and is stable (docs/STABILITY.md).
 * @experimental
 */
export type Change = { breaking: boolean; kind: ChangeKind; where: string; message: string };

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

function resolve(s: Json | undefined, doc: Doc): Json | undefined {
  for (let i = 0; s?.$ref && i < 32; i++) s = doc.components?.schemas?.[String(s.$ref).split("/").pop()!];
  return s;
}

// our nullable is `anyOf: [x, { type: "null" }]`
function unwrapNull(s: Json | undefined): { schema: Json | undefined; nullable: boolean } {
  const any = s?.anyOf;
  if (Array.isArray(any) && any.length === 2 && any.some((x) => x?.type === "null")) {
    return { schema: any.find((x) => x?.type !== "null"), nullable: true };
  }
  return { schema: s, nullable: false };
}

const firstSchema = (content: Json | undefined) => {
  const key = content && Object.keys(content)[0];
  return key ? content![key].schema : undefined;
};

const values = (s: Json): unknown[] | undefined => (s.enum ? s.enum : s.const !== undefined ? [s.const] : undefined);
const show = (v: unknown) => JSON.stringify(v);

/** @experimental */
export function diffOpenAPI(before: Doc, after: Doc): Change[] {
  const out: Change[] = [];
  const note = (breaking: boolean, kind: ChangeKind, where: string, message: string) => out.push({ breaking, kind, where, message });

  function schemas(a: Json | undefined, b: Json | undefined, dir: Dir, where: string, at: string, seen: Set<string>) {
    if (!a || !b) return;
    if (a.$ref && b.$ref) {
      const key = `${a.$ref}|${b.$ref}|${dir}|${where}`;
      if (seen.has(key)) return; // a recursive schema, already being compared
      seen.add(key);
    }
    const ua = unwrapNull(resolve(a, before));
    const ub = unwrapNull(resolve(b, after));
    if (dir === "request" && ua.nullable && !ub.nullable) note(true, "request-null-removed", where, `${at} no longer takes null`);
    if (dir === "response" && !ua.nullable && ub.nullable) note(true, "response-null-added", where, `${at} may be null now`);
    const A = ua.schema;
    const B = ub.schema;
    if (!A || !B) return;

    if (A.type && B.type && A.type !== B.type) {
      const wider = dir === "request" ? A.type === "integer" && B.type === "number" : A.type === "number" && B.type === "integer";
      note(!wider, `${dir}-type-changed`, where, `${at} is ${B.type} now, was ${A.type}`);
      return;
    }

    const va = values(A);
    const vb = values(B);
    if (va && vb) {
      const gone = va.filter((v) => !vb.includes(v));
      const fresh = vb.filter((v) => !va.includes(v));
      if (dir === "request") {
        for (const v of gone) note(true, "request-value-removed", where, `${at} no longer takes ${show(v)}`);
        for (const v of fresh) note(false, "request-value-added", where, `${at} also takes ${show(v)} now`);
      } else {
        for (const v of fresh) note(true, "response-value-added", where, `${at} may be ${show(v)} now`);
        for (const v of gone) note(false, "response-value-removed", where, `${at} is never ${show(v)} now`);
      }
    } else if (!va && vb && dir === "request") note(true, "request-values-restricted", where, `${at} only takes ${vb.map(show).join(", ")} now`);
    else if (va && !vb && dir === "response") note(true, "response-values-unrestricted", where, `${at} may be any value now, not only ${va.map(show).join(", ")}`);

    if (dir === "request") {
      for (const k of ["minimum", "minLength", "minItems"]) {
        if (B[k] !== undefined && (A[k] === undefined || B[k] > A[k])) note(true, "request-limit-tightened", where, `${at} needs ${k} ${B[k]} now`);
      }
      for (const k of ["maximum", "maxLength", "maxItems"]) {
        if (B[k] !== undefined && (A[k] === undefined || B[k] < A[k])) note(true, "request-limit-tightened", where, `${at} allows ${k} ${B[k]} now`);
      }
      if (B.pattern && B.pattern !== A.pattern) note(true, "request-pattern-changed", where, `${at} has to match /${B.pattern}/ now`);
      if (B.format && B.format !== A.format) note(true, "request-format-changed", where, `${at} has to be a ${B.format} now`);
      if (B.additionalProperties === false && A.additionalProperties !== false) note(true, "request-extra-keys-refused", where, `${at} refuses keys it does not list now`);
    }

    if (A.properties || B.properties) {
      const reqA = new Set<string>(A.required ?? []);
      const reqB = new Set<string>(B.required ?? []);
      const pa = A.properties ?? {};
      const pb = B.properties ?? {};
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        const field = `${at}.${k}`;
        if (dir === "request") {
          if (!pa[k] && pb[k]) note(reqB.has(k), reqB.has(k) ? "request-field-added-required" : "request-field-added-optional", where, reqB.has(k) ? `${field} is required now` : `${field} is taken now`);
          else if (pa[k] && !pb[k]) note(false, "request-field-removed", where, `${field} is ignored now`);
          else if (!reqA.has(k) && reqB.has(k)) note(true, "request-field-required", where, `${field} is required now`);
        } else {
          if (pa[k] && !pb[k]) note(reqA.has(k), reqA.has(k) ? "response-field-removed" : "response-optional-field-removed", where, reqA.has(k) ? `${field} is gone` : `${field} is no longer sent`);
          else if (!pa[k] && pb[k]) note(false, "response-field-added", where, `${field} is sent now`);
          else if (reqA.has(k) && !reqB.has(k)) note(true, "response-field-optional", where, `${field} may be missing now`);
        }
        if (pa[k] && pb[k]) schemas(pa[k], pb[k], dir, where, field, seen);
      }
    }
    if (A.items && B.items) schemas(A.items, B.items, dir, where, `${at}[]`, seen);
    if (typeof A.additionalProperties === "object" && typeof B.additionalProperties === "object") {
      schemas(A.additionalProperties, B.additionalProperties, dir, where, `${at}{}`, seen);
    }
    for (const k of ["anyOf", "oneOf"]) {
      if ((A[k] || B[k]) && JSON.stringify(A[k]) !== JSON.stringify(B[k])) note(true, `${dir}-shape-changed`, where, `${at} has a different shape now`);
    }
  }

  function operation(a: Json, b: Json, where: string) {
    const params = (op: Json) => new Map<string, Json>((op.parameters ?? []).map((p: Json) => [`${p.in} ${p.name}`, p]));
    const pa = params(a);
    const pb = params(b);
    for (const [key, p] of pb) {
      const old = pa.get(key);
      if (!old) note(Boolean(p.required), p.required ? "param-added-required" : "param-added-optional", where, p.required ? `needs the ${p.in} parameter ${p.name} now` : `takes the ${p.in} parameter ${p.name} now`);
      else {
        if (!old.required && p.required) note(true, "param-required", where, `the ${p.in} parameter ${p.name} is required now`);
        schemas(old.schema, p.schema, "request", where, `${p.in} ${p.name}`, new Set());
      }
    }
    for (const [key, p] of pa) if (!pb.has(key) && p.in !== "path") note(false, "param-removed", where, `the ${p.in} parameter ${p.name} is ignored now`);

    const ra = a.requestBody;
    const rb = b.requestBody;
    if (!ra && rb?.required) note(true, "body-added-required", where, "needs a body now");
    else if (ra && rb) {
      if (!ra.required && rb.required) note(true, "body-required", where, "the body is required now");
      schemas(firstSchema(ra.content), firstSchema(rb.content), "request", where, "body", new Set());
    }

    const sa = a.responses ?? {};
    const sb = b.responses ?? {};
    for (const status of Object.keys(sa)) {
      if (!sb[status]) note(true, "status-removed", where, `no longer answers ${status}`);
      else schemas(firstSchema(sa[status].content), firstSchema(sb[status].content), "response", where, `the ${status} answer`, new Set());
    }
    for (const status of Object.keys(sb)) if (!sa[status]) note(false, "status-added", where, `may answer ${status} now`);
  }

  const paths = new Set([...Object.keys(before.paths ?? {}), ...Object.keys(after.paths ?? {})]);
  for (const path of [...paths].sort()) {
    for (const m of METHODS) {
      const a = before.paths?.[path]?.[m];
      const b = after.paths?.[path]?.[m];
      const where = `${m.toUpperCase()} ${path}`;
      if (a && !b) note(true, "route-removed", where, "is gone");
      else if (!a && b) note(false, "route-added", where, "is new");
      else if (a && b) operation(a, b, where);
    }
  }
  return out.sort((x, y) => Number(y.breaking) - Number(x.breaking));
}

/**
 * The changes as text for a terminal: `formatDiff(changes, { title, color })`.
 * `formatDiff(changes, title, color)` works too.
 * @experimental
 */
export function formatDiff(changes: readonly Omit<Change, "kind">[], options: FormatOptions | string = {}, colored?: boolean): string {
  const { title = "", color = false } = typeof options === "object" ? options : { title: options, color: colored };
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines = ["", `  ${c("31", "印")} inkan diff  ·  ${title}`, ""];
  if (!changes.length) lines.push(`  ${c("32", "nothing changed that a client could notice")}`);
  const breaking = changes.filter((x) => x.breaking);
  const fine = changes.filter((x) => !x.breaking);
  if (breaking.length) {
    lines.push(`  ${c("31", "breaks clients")}`);
    for (const x of breaking) lines.push(`    ${c("31", "✗")} ${c("1", x.where)}  ${x.message}`);
  }
  if (fine.length) {
    if (breaking.length) lines.push("");
    lines.push(`  ${c("32", "safe")}`);
    for (const x of fine) lines.push(`    ${c("32", "·")} ${c("1", x.where)}  ${x.message}`);
  }
  lines.push("", `  ${[breaking.length ? c("31", `${breaking.length} breaking`) : "0 breaking", `${fine.length} safe`].join(" · ")}`, "");
  return lines.join("\n");
}

/**
 * The changes as Markdown, what a pull request comment shows: a headline, then one table,
 * the breaking changes first. `inkan diff --format markdown` prints it.
 * @experimental
 */
export function formatDiffMarkdown(changes: readonly (Omit<Change, "kind"> & { kind?: ChangeKind })[], options: Pick<FormatOptions, "title"> = {}): string {
  const breaking = changes.filter((x) => x.breaking);
  const safe = changes.filter((x) => !x.breaking);
  const head = breaking.length ? `**✗ ${plural(breaking.length, "breaking change")}**` : "**✓ no breaking changes**";
  const tail = !changes.length ? ["nothing changed that a client could notice"] : safe.length ? [plural(safe.length, "safe change")] : [];
  const lines = [`### 印 inkan diff${options.title ? ` · ${mdCode(options.title)}` : ""}`, "", [head, ...tail].join(" · "), ""];
  if (changes.length) {
    lines.push("| | Route | Change | Kind |", "|---|---|---|---|");
    for (const x of [...breaking, ...safe]) lines.push(`| ${x.breaking ? "✗" : "·"} | ${mdCode(x.where)} | ${mdText(x.message)} | ${x.kind ? mdCode(x.kind) : ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}
