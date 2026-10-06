// Every example in a route is also a test. `check` sends each one into the
// app and holds the answer against the contract: the status, the response
// schema and whatever the example says it `expect`s.

import { contractFor, type App, type Example, type RouteRecord } from "./app.ts";
import { paint } from "./color.ts";

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

async function runOne(app: App, r: RouteRecord, ex: Example, i: number): Promise<CheckResult> {
  const name = ex.name ?? `example ${i + 1}`;
  const started = performance.now();
  const problems: string[] = [];
  let status = 0;
  try {
    const res = await app.inject({
      method: r.method,
      url: fill(r.path, ex.params) + queryString(ex.query),
      headers: ex.headers,
      body: ex.body,
    });
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
  try {
    for (const r of app.routes()) {
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
      for (const [i, ex] of examples.entries()) {
        await opts.beforeEach?.();
        results.push(await runOne(app, r, ex, i));
      }
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
