// Compares two OpenAPI documents and names what would break a client that was
// written against the first one. Requests may only get looser, answers may only
// get stricter; everything else is a breaking change.

type Json = Record<string, any>;
type Doc = { paths?: Record<string, Record<string, Json>>; components?: { schemas?: Record<string, Json> } };
type Dir = "request" | "response";

export type Change = { breaking: boolean; where: string; message: string };

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

export function diffOpenAPI(before: Doc, after: Doc): Change[] {
  const out: Change[] = [];
  const note = (breaking: boolean, where: string, message: string) => out.push({ breaking, where, message });

  function schemas(a: Json | undefined, b: Json | undefined, dir: Dir, where: string, at: string, seen: Set<string>) {
    if (!a || !b) return;
    if (a.$ref && b.$ref) {
      const key = `${a.$ref}|${b.$ref}|${dir}|${where}`;
      if (seen.has(key)) return; // a recursive schema, already being compared
      seen.add(key);
    }
    const ua = unwrapNull(resolve(a, before));
    const ub = unwrapNull(resolve(b, after));
    if (dir === "request" && ua.nullable && !ub.nullable) note(true, where, `${at} no longer takes null`);
    if (dir === "response" && !ua.nullable && ub.nullable) note(true, where, `${at} may be null now`);
    const A = ua.schema;
    const B = ub.schema;
    if (!A || !B) return;

    if (A.type && B.type && A.type !== B.type) {
      const wider = dir === "request" ? A.type === "integer" && B.type === "number" : A.type === "number" && B.type === "integer";
      note(!wider, where, `${at} is ${B.type} now, was ${A.type}`);
      return;
    }

    const va = values(A);
    const vb = values(B);
    if (va && vb) {
      const gone = va.filter((v) => !vb.includes(v));
      const fresh = vb.filter((v) => !va.includes(v));
      if (dir === "request") {
        for (const v of gone) note(true, where, `${at} no longer takes ${show(v)}`);
        for (const v of fresh) note(false, where, `${at} also takes ${show(v)} now`);
      } else {
        for (const v of fresh) note(true, where, `${at} may be ${show(v)} now`);
        for (const v of gone) note(false, where, `${at} is never ${show(v)} now`);
      }
    } else if (!va && vb && dir === "request") note(true, where, `${at} only takes ${vb.map(show).join(", ")} now`);
    else if (va && !vb && dir === "response") note(true, where, `${at} may be any value now, not only ${va.map(show).join(", ")}`);

    if (dir === "request") {
      for (const k of ["minimum", "minLength", "minItems"]) {
        if (B[k] !== undefined && (A[k] === undefined || B[k] > A[k])) note(true, where, `${at} needs ${k} ${B[k]} now`);
      }
      for (const k of ["maximum", "maxLength", "maxItems"]) {
        if (B[k] !== undefined && (A[k] === undefined || B[k] < A[k])) note(true, where, `${at} allows ${k} ${B[k]} now`);
      }
      if (B.pattern && B.pattern !== A.pattern) note(true, where, `${at} has to match /${B.pattern}/ now`);
      if (B.format && B.format !== A.format) note(true, where, `${at} has to be a ${B.format} now`);
      if (B.additionalProperties === false && A.additionalProperties !== false) note(true, where, `${at} refuses keys it does not list now`);
    }

    if (A.properties || B.properties) {
      const reqA = new Set<string>(A.required ?? []);
      const reqB = new Set<string>(B.required ?? []);
      const pa = A.properties ?? {};
      const pb = B.properties ?? {};
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        const field = `${at}.${k}`;
        if (dir === "request") {
          if (!pa[k] && pb[k]) note(reqB.has(k), where, reqB.has(k) ? `${field} is required now` : `${field} is taken now`);
          else if (pa[k] && !pb[k]) note(false, where, `${field} is ignored now`);
          else if (!reqA.has(k) && reqB.has(k)) note(true, where, `${field} is required now`);
        } else {
          if (pa[k] && !pb[k]) note(reqA.has(k), where, reqA.has(k) ? `${field} is gone` : `${field} is no longer sent`);
          else if (!pa[k] && pb[k]) note(false, where, `${field} is sent now`);
          else if (reqA.has(k) && !reqB.has(k)) note(true, where, `${field} may be missing now`);
        }
        if (pa[k] && pb[k]) schemas(pa[k], pb[k], dir, where, field, seen);
      }
    }
    if (A.items && B.items) schemas(A.items, B.items, dir, where, `${at}[]`, seen);
    if (typeof A.additionalProperties === "object" && typeof B.additionalProperties === "object") {
      schemas(A.additionalProperties, B.additionalProperties, dir, where, `${at}{}`, seen);
    }
    for (const k of ["anyOf", "oneOf"]) {
      if ((A[k] || B[k]) && JSON.stringify(A[k]) !== JSON.stringify(B[k])) note(true, where, `${at} has a different shape now`);
    }
  }

  function operation(a: Json, b: Json, where: string) {
    const params = (op: Json) => new Map<string, Json>((op.parameters ?? []).map((p: Json) => [`${p.in} ${p.name}`, p]));
    const pa = params(a);
    const pb = params(b);
    for (const [key, p] of pb) {
      const old = pa.get(key);
      if (!old) note(Boolean(p.required), where, p.required ? `needs the ${p.in} parameter ${p.name} now` : `takes the ${p.in} parameter ${p.name} now`);
      else {
        if (!old.required && p.required) note(true, where, `the ${p.in} parameter ${p.name} is required now`);
        schemas(old.schema, p.schema, "request", where, `${p.in} ${p.name}`, new Set());
      }
    }
    for (const [key, p] of pa) if (!pb.has(key) && p.in !== "path") note(false, where, `the ${p.in} parameter ${p.name} is ignored now`);

    const ra = a.requestBody;
    const rb = b.requestBody;
    if (!ra && rb?.required) note(true, where, "needs a body now");
    else if (ra && rb) {
      if (!ra.required && rb.required) note(true, where, "the body is required now");
      schemas(firstSchema(ra.content), firstSchema(rb.content), "request", where, "body", new Set());
    }

    const sa = a.responses ?? {};
    const sb = b.responses ?? {};
    for (const status of Object.keys(sa)) {
      if (!sb[status]) note(true, where, `no longer answers ${status}`);
      else schemas(firstSchema(sa[status].content), firstSchema(sb[status].content), "response", where, `the ${status} answer`, new Set());
    }
    for (const status of Object.keys(sb)) if (!sa[status]) note(false, where, `may answer ${status} now`);
  }

  const paths = new Set([...Object.keys(before.paths ?? {}), ...Object.keys(after.paths ?? {})]);
  for (const path of [...paths].sort()) {
    for (const m of METHODS) {
      const a = before.paths?.[path]?.[m];
      const b = after.paths?.[path]?.[m];
      const where = `${m.toUpperCase()} ${path}`;
      if (a && !b) note(true, where, "is gone");
      else if (!a && b) note(false, where, "is new");
      else if (a && b) operation(a, b, where);
    }
  }
  return out.sort((x, y) => Number(y.breaking) - Number(x.breaking));
}

export function formatDiff(changes: Change[], title: string, color = false): string {
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
