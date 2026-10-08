// What a handler answers with besides JSON: HTML that is safe by default, and cookies.

/** HTML that is known to be safe: written by the `html` tag, or let through on purpose with `raw()`. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML: every character that could open a tag or leave an attribute is escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** One value put into HTML: escaped, unless it is HTML already; a list joined; nothing for null, undefined and false. */
function part(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(part).join("");
  return escapeHtml(String(v));
}

/**
 * HTML from a template, with every `${…}` escaped: `` html`<h1>${name}</h1>` `` is safe
 * whatever `name` holds. Lists are joined, so `${items.map((i) => html`<li>${i}</li>`)}`
 * works, and null, undefined and false write nothing, for `${admin && html`…`}`.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Lets HTML through unescaped. Only for markup you made yourself, never for what a user sent. */
export const raw = (markup: string): SafeHtml => new SafeHtml(markup);

export type CookieOptions = {
  /** Seconds until it expires; 0 deletes it. Without this or `expires` it lasts until the browser closes. */
  maxAge?: number;
  expires?: Date;
  /** Default `/`. */
  path?: string;
  domain?: string;
  /** Only sent over HTTPS. Default false, so it works on plain HTTP too; turn it on behind TLS. */
  secure?: boolean;
  /** Out of reach of the page's scripts. Default true. */
  httpOnly?: boolean;
  /** Default `Lax`: sent on links into the site, not on requests other sites make. */
  sameSite?: "Strict" | "Lax" | "None";
  partitioned?: boolean;
};

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/; // a cookie name, as RFC 6265 allows it

/** A Set-Cookie header value. The value is percent-encoded, so it can hold anything. */
export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  if (!TOKEN.test(name)) throw new TypeError(`Not a valid cookie name: ${JSON.stringify(name)}`);
  if (o.sameSite === "None" && !o.secure) throw new TypeError(`The cookie ${name} has sameSite "None", which browsers only take with secure: true`);
  let s = `${name}=${encodeURIComponent(value)}; Path=${o.path ?? "/"}`;
  if (o.maxAge !== undefined) s += `; Max-Age=${Math.floor(o.maxAge)}`;
  if (o.expires) s += `; Expires=${o.expires.toUTCString()}`;
  if (o.domain) s += `; Domain=${o.domain}`;
  if (o.secure) s += "; Secure";
  if (o.httpOnly ?? true) s += "; HttpOnly";
  s += `; SameSite=${o.sameSite ?? "Lax"}`;
  if (o.partitioned) s += "; Partitioned";
  return s;
}

/** The cookies of a request, by name; the first one wins when a name comes twice, as browsers send the most specific first. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null); // a cookie named __proto__ is just a cookie
  if (!header) return out;
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    let value = piece.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // a broken escape: kept as it came
    }
  }
  return out;
}

/** The statuses a redirect can have. */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const isRedirect = (status: number): status is RedirectStatus => REDIRECTS.has(status);

// ---------- rows: as CSV, and as JSON written row by row ----------

export type CsvOptions = {
  /** The columns, in order: keys, or key → heading. Default: the keys of the first row. */
  columns?: string[] | Record<string, string>;
  /** Default `,`; `;` is what a German Excel expects. */
  separator?: string;
  /** Starts the file with a byte order mark, so Excel reads it as UTF-8. Default false. */
  bom?: boolean;
  /** Offered for download under this name. */
  filename?: string;
  /**
   * Cells that begin with `=`, `+`, `-`, `@`, a tab or a return get a `'` in front, so a
   * spreadsheet shows them instead of running them as a formula. Default true; false writes
   * them as they are, for numbers like -3 to stay numbers.
   */
  guardFormulas?: boolean;
};

const FORMULA = /^[=+\-@\t\r]/;

/** One cell: quoted when it holds the separator, a quote or a line break; dates as ISO strings. */
function cell(v: unknown, sep: string, guard: boolean): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (guard && typeof v === "string" && FORMULA.test(s)) s = "'" + s;
  return s.includes(sep) || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV, as they come: a heading, then a line per row, in chunks of about 16 KB. */
export async function* csvChunks(rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>, o: CsvOptions = {}): AsyncIterable<string> {
  const sep = o.separator ?? ",";
  const guard = o.guardFormulas ?? true;
  let keys: string[] | undefined;
  let heads: string[] | undefined;
  if (o.columns) {
    keys = Array.isArray(o.columns) ? o.columns : Object.keys(o.columns);
    heads = Array.isArray(o.columns) ? o.columns : Object.values(o.columns);
  }
  let buf = o.bom ? "﻿" : "";
  if (heads) buf += heads.map((h) => cell(h, sep, guard)).join(sep) + "\r\n";
  for await (const row of rows) {
    if (!keys) {
      keys = Object.keys(row);
      buf += keys.map((h) => cell(h, sep, guard)).join(sep) + "\r\n";
    }
    buf += keys.map((k) => cell(row[k], sep, guard)).join(sep) + "\r\n";
    if (buf.length >= 16384) {
      yield buf;
      buf = "";
    }
  }
  if (buf) yield buf;
}

/**
 * Rows as one JSON array, or as one JSON line each (NDJSON), as they come: each row written
 * by its schema's writer, so it holds only what the contract lists, and checked first when
 * `check` is given. In chunks of about 16 KB, so the socket is not asked once per row.
 */
export async function* jsonRows(rows: Iterable<unknown> | AsyncIterable<unknown>, write: (v: unknown) => string, ndjson: boolean, check?: (row: unknown, index: number) => void): AsyncIterable<string> {
  let buf = ndjson ? "" : "[";
  let i = 0;
  for await (const row of rows) {
    check?.(row, i);
    const s = row === undefined ? "null" : write(row);
    buf += ndjson ? s + "\n" : (i ? "," : "") + s;
    i++;
    if (buf.length >= 16384) {
      yield buf;
      buf = "";
    }
  }
  if (!ndjson) buf += "]";
  if (buf) yield buf;
}
