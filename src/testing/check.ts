// Every example in a route is also a test. `check` sends each one into the
// app and holds the answer against the contract: the status, the response
// schema and whatever the example says it `expect`s.

import { contractFor, type App, type InjectResponse } from "../core/app.ts";
import type { Example, RouteRecord } from "../core/route.ts";
import { paint } from "../core/color.ts";
import { EventsSchema } from "../schema/schema.ts";

export type CheckOptions = {
  /** Runs before every example, e.g. to reset an in-memory store. */
  beforeEach?: () => unknown;
  /** Only routes whose `METHOD /path` contains this text. */
  only?: string;
  /** A promised status that no example answers with fails the check. */
  strict?: boolean;
};

export type CheckResult = {
  method: string;
  path: string;
  example: string;
  ok: boolean;
  status: number;
  ms: number;
  problems: string[];
};

export type CheckReport = {
  ok: boolean;
  passed: number;
  failed: number;
  results: CheckResult[];
  /** Routes without a single example: nothing holds them to their contract. */
  unchecked: string[];
  /** Statuses a route promises that none of its examples answers with. */
  uncovered: { method: string; path: string; status: number }[];
};

function fill(path: string, params: Record<string, unknown> = {}): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":") && !seg.startsWith("*")) return seg;
      const name = seg.slice(1) || "rest";
      const v = params[name];
      if (v === undefined) throw new Error(`the example has no value for ${seg}`);
      return seg.startsWith("*") ? String(v) : encodeURIComponent(String(v));
    })
    .join("/");
}

function queryString(q: Record<string, unknown> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) sp.append(k, String(x));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Is everything in `expected` also in `actual`? Returns where it is not. */
export function partialMatch(expected: unknown, actual: unknown, path = "body"): string | undefined {
  if (expected !== null && typeof expected === "object") {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return `${path}: expected an array, got ${JSON.stringify(actual)}`;
      if (expected.length !== actual.length) return `${path}: expected ${expected.length} items, got ${actual.length}`;
      for (const [i, x] of expected.entries()) {
        const miss = partialMatch(x, actual[i], `${path}[${i}]`);
        if (miss) return miss;
      }
      return;
    }
    if (actual === null || typeof actual !== "object") return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    for (const [k, x] of Object.entries(expected)) {
      const miss = partialMatch(x, (actual as Record<string, unknown>)[k], `${path}.${k}`);
      if (miss) return miss;
    }
    return;
  }
  if (!Object.is(expected, actual)) return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function expectedStatus(r: RouteRecord, ex: Example): number | undefined {
  if (ex.status !== undefined) return ex.status;
  const ok = Object.keys(r.spec.response ?? {}).map(Number).filter((s) => s >= 200 && s < 300).sort();
  return ok[0];
}

// ---------- examples that build on each other ----------

type Kept = Record<string, unknown>;
type Step = { r: RouteRecord; ex: Example; label: string };

/** Puts kept values into `{name}` placeholders. A placeholder alone keeps the value's type. */
export function substitute<T>(value: T, kept: Kept): T {
  if (typeof value === "string") {
    const whole = /^\{(\w+)\}$/.exec(value);
    if (whole && whole[1] in kept) return kept[whole[1]] as T;
    return value.replace(/\{(\w+)\}/g, (m, k: string) => (k in kept ? String(kept[k]) : m)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, kept)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, kept)])) as T;
  }
  return value;
}

// ---------- cookies ----------

type Cookie = { name: string; value: string; path: string };

/** The directory of a request path, the path a cookie without its own gets (RFC 6265, 5.1.4). */
const defaultPath = (path: string) => {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
};
const pathMatches = (cookiePath: string, path: string) =>
  path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"));

/** One Set-Cookie header: its name, value and path, and whether it tells the client to forget the cookie. */
function parseSetCookie(header: string, requestPath: string): Cookie & { gone: boolean } {
  const [pair, ...attrs] = header.split(";");
  const eq = pair.indexOf("=");
  const cookie = { name: eq < 0 ? "" : pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: defaultPath(requestPath), gone: false };
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const value = i < 0 ? "" : attr.slice(i + 1).trim();
    if (key === "path" && value.startsWith("/")) cookie.path = value;
    else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
    else if (key === "expires") expires = Date.parse(value);
  }
  // Max-Age wins over Expires, as in browsers
  cookie.gone = maxAge !== undefined ? maxAge <= 0 : expires !== undefined && expires <= Date.now();
  return cookie;
}

/**
 * The cookies of one chain of examples: what an answer sets, the requests after it in the
 * same chain send, as a browser would for one host. Every chain starts with an empty jar.
 */
class CookieJar {
  private cookies: Cookie[] = [];
  take(setCookies: string[], requestPath: string) {
    for (const header of setCookies) {
      const c = parseSetCookie(header, requestPath);
      if (!c.name) continue;
      this.cookies = this.cookies.filter((x) => x.name !== c.name || x.path !== c.path);
      if (!c.gone) this.cookies.push({ name: c.name, value: c.value, path: c.path });
    }
  }
  /** The Cookie header for a request to `path`, longer paths first; undefined when none matches. */
  header(path: string): string | undefined {
    const list = this.cookies.filter((c) => pathMatches(c.path, path)).sort((a, b) => b.path.length - a.path.length);
    return list.length ? list.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
  }
}

/** The cookies an answer sets, by name, their values decoded. */
function cookiesOf(res: InjectResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of res.cookies) {
    const c = parseSetCookie(header, "/");
    if (!c.name || c.gone) continue;
    try {
      out[c.name] = decodeURIComponent(c.value);
    } catch {
      out[c.name] = c.value;
    }
  }
  return out;
}

/** Reads `body.id`, `headers.location`, `cookies.sid` or `status` out of an answer. */
function pick(res: InjectResponse, path: string): unknown {
  const [root, ...rest] = path.split(".");
  let v: unknown =
    root === "body" ? res.body : root === "headers" ? res.headers : root === "cookies" ? cookiesOf(res) : root === "status" ? res.status : undefined;
  for (const k of rest) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[root === "headers" ? k.toLowerCase() : k] : undefined;
  return v;
}

function keepFrom(res: InjectResponse, keep: Record<string, string> = {}): { kept: Kept; missing: string[] } {
  const kept: Kept = {};
  const missing: string[] = [];
  for (const [name, path] of Object.entries(keep)) {
    const v = pick(res, path);
    if (v === undefined) missing.push(`keeps ${name} from ${path}, but the answer has no ${path}`);
    else kept[name] = v;
  }
  return { kept, missing };
}

const stepLabel = (r: RouteRecord, ex: Example, i: number) => `${r.method} ${r.path} > ${ex.name ?? `example ${i + 1}`}`;

function indexExamples(app: App): Map<string, Step> {
  const index = new Map<string, Step>();
  for (const r of app.routes()) (r.spec.examples ?? []).forEach((ex, i) => index.set(stepLabel(r, ex, i), { r, ex, label: stepLabel(r, ex, i) }));
  return index;
}

/** The examples an example needs first, the first one first. */
function chainOf(index: Map<string, Step>, start: Step): Step[] {
  const chain: Step[] = [];
  const seen = [start.label];
  for (let step = start; step.ex.after; ) {
    const m = /^\s*(\w+)\s+(\S+)\s*>\s*(.+?)\s*$/.exec(step.ex.after);
    const key = m ? `${m[1].toUpperCase()} ${m[2]} > ${m[3]}` : step.ex.after;
    const dep = index.get(key);
    if (!dep) throw new Error(`after: "${step.ex.after}" is not an example. Write it as "METHOD /path > example name".`);
    if (seen.includes(dep.label)) throw new Error(`after goes in a circle: ${[...seen, dep.label].join(" → ")}`);
    seen.push(dep.label);
    chain.unshift(dep);
    step = dep;
  }
  return chain;
}

async function runChain(app: App, chain: Step[], jar: CookieJar): Promise<Kept> {
  let kept: Kept = {};
  for (const step of chain) {
    const res = await send(app, step.r, substitute(step.ex, kept), jar);
    const want = expectedStatus(step.r, step.ex);
    if (want !== undefined ? res.status !== want : res.status >= 300) {
      throw new Error(`needs "${step.label}" first, which answered ${res.status}, expected ${want ?? "a 2xx"}`);
    }
    const got = keepFrom(res, step.ex.keep);
    if (got.missing.length) throw new Error(`needs "${step.label}" first, which ${got.missing[0]}`);
    kept = { ...kept, ...got.kept };
  }
  return kept;
}

// An event stream may never end, so an example reads as many events as it expects, or five.
const eventsFor = (r: RouteRecord, ex: Example) =>
  contractFor(r, expectedStatus(r, ex) ?? 200) instanceof EventsSchema ? (Array.isArray(ex.expect) ? ex.expect.length : 5) : undefined;

/** An example's request, with the chain's cookies; what the answer sets goes into the jar. */
async function send(app: App, r: RouteRecord, ex: Example, jar: CookieJar) {
  const path = fill(r.path, ex.params);
  const cookie = jar.header(path);
  let headers = ex.headers;
  if (cookie) {
    headers = { ...ex.headers };
    const own = Object.keys(headers).find((k) => k.toLowerCase() === "cookie");
    const mine = own === undefined ? undefined : headers[own];
    if (own !== undefined) delete headers[own];
    // the example's own cookies first: of a cookie named twice, the app reads the first
    headers.cookie = mine ? `${mine}; ${cookie}` : cookie;
  }
  const res = await app.inject({ method: r.method, url: path + queryString(ex.query), headers, body: ex.body, events: eventsFor(r, ex) });
  jar.take(res.cookies, path);
  return res;
}

async function runOne(app: App, r: RouteRecord, raw: Example, i: number, index: Map<string, Step>, beforeEach?: () => unknown): Promise<CheckResult> {
  const name = raw.name ?? `example ${i + 1}`;
  const started = performance.now();
  const problems: string[] = [];
  let status = 0;
  try {
    await beforeEach?.(); // once per chain, so the examples in it see each other's data
    const jar = new CookieJar(); // one per chain: cookies never cross from one to another
    const kept = await runChain(app, chainOf(index, { r, ex: raw, label: stepLabel(r, raw, i) }), jar);
    const ex = substitute(raw, kept);
    const res = await send(app, r, ex, jar);
    status = res.status;
    const want = expectedStatus(r, ex);
    if (want !== undefined ? status !== want : status >= 300) {
      problems.push(`answered ${status}, expected ${want ?? "a 2xx"}`);
      if (res.body?.detail) problems.push(`  ${res.body.type}: ${res.body.detail}`);
      for (const e of res.body?.errors ?? []) problems.push(`  ${e.in} ${e.path || ""} ${e.message}`.replace(/\s+/g, " "));
    } else {
      const declared = Object.keys(r.spec.response ?? {}).length > 0;
      const schema = contractFor(r, status);
      if (status === 204) {
        if (res.text) problems.push("answered 204 with a body");
      } else if (schema instanceof EventsSchema) {
        (res.body as unknown[]).forEach((event, n) => {
          const v = schema.safeParse(event);
          if (!v.ok) for (const issue of v.issues) problems.push(`event ${n + 1} ${issue.path || ""} ${issue.message}`.replace(/\s+/g, " "));
        });
      } else if (schema) {
        const v = schema.safeParse(res.body === "" ? undefined : res.body);
        if (!v.ok) for (const issue of v.issues) problems.push(`response ${issue.path || "(body)"} ${issue.message}`);
      } else if (declared) {
        problems.push(`status ${status} is not in the contract`);
      }
      if (ex.expect !== undefined) {
        const miss = partialMatch(ex.expect, res.body);
        if (miss) problems.push(miss);
      }
      problems.push(...keepFrom(res, ex.keep).missing); // whatever comes after this example relies on it
    }
  } catch (err) {
    problems.push((err as Error).message);
  }
  const ms = Math.round((performance.now() - started) * 10) / 10;
  return { method: r.method, path: r.path, example: name, ok: problems.length === 0, status, ms, problems };
}

export async function runChecks(app: App, opts: CheckOptions = {}): Promise<CheckReport> {
  const results: CheckResult[] = [];
  const unchecked: string[] = [];
  const uncovered: CheckReport["uncovered"] = [];
  const log = app.options.log;
  app.options.log = false;
  const index = indexExamples(app);
  try {
    for (const r of app.routes()) {
      if (r.method === "WS") continue; // a WebSocket has no examples to run
      const label = `${r.method} ${r.path}`;
      if (opts.only && !label.includes(opts.only)) continue;
      const examples = r.spec.examples ?? [];
      if (!examples.length) unchecked.push(label);
      else {
        const covered = new Set(examples.map((ex) => expectedStatus(r, ex)));
        for (const s of Object.keys(r.spec.response ?? {}).map(Number)) {
          if (!covered.has(s)) uncovered.push({ method: r.method, path: r.path, status: s });
        }
      }
      for (const [i, ex] of examples.entries()) results.push(await runOne(app, r, ex, i, index, opts.beforeEach));
    }
  } finally {
    app.options.log = log;
  }
  const failed = results.filter((r) => !r.ok).length;
  const ok = failed === 0 && !(opts.strict && uncovered.length);
  return { ok, passed: results.length - failed, failed, results, unchecked, uncovered };
}

export function formatReport(report: CheckReport, title = "", color = false): string {
  const c = paint(color);
  const lines: string[] = ["", `  ${c.seal("印")} ${c.bold("inkan check")}${title ? c.dim("  ·  " + title) : ""}`, ""];
  const gaps = (route: string) => {
    for (const u of report.uncovered) {
      if (`${u.method} ${u.path}` === route) lines.push(`    ${c.warn("·")} ${c.warn(String(u.status))} is in the contract, but no example answers with it`);
    }
  };
  let last = "";
  for (const r of report.results) {
    const route = `${r.method} ${r.path}`;
    if (route !== last) {
      if (last) gaps(last);
      lines.push(`  ${c.method(r.method, r.method.padEnd(6))} ${c.bold(r.path)}`);
      last = route;
    }
    const mark = r.ok ? c.ok("✓") : c.seal("✗");
    const status = r.status ? c.status(r.status) + " ".repeat(Math.max(0, 4 - String(r.status).length)) : "--- ";
    lines.push(`    ${mark} ${r.example.padEnd(34)} ${status} ${c.dim(r.ms + "ms")}`);
    for (const p of r.problems) lines.push(`        ${c.seal(p)}`);
  }
  if (last) gaps(last);
  if (report.unchecked.length) {
    lines.push("", `  ${c.warn("no examples, so nothing holds them to their contract:")}`);
    for (const u of report.unchecked) lines.push(`    ${c.dim("·")} ${u}`);
  }
  const total = report.results.length;
  const summary = [
    `${total} example${total === 1 ? "" : "s"}`,
    c.ok(`${report.passed} sealed`),
    report.failed ? c.seal(`${report.failed} broken`) : "",
    report.unchecked.length ? c.warn(`${report.unchecked.length} unchecked`) : "",
    report.uncovered.length
      ? (report.ok || report.failed ? c.warn : c.seal)(`${report.uncovered.length} status${report.uncovered.length === 1 ? "" : "es"} uncovered`)
      : "",
  ].filter(Boolean);
  lines.push("", "  " + summary.join(c.dim(" · ")), "");
  return lines.join("\n");
}
