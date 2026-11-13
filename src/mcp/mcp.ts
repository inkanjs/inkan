// The app as an MCP server: every route with a contract is a tool, and a tool call is a
// request like any other, through the route's security, hooks, checks and log.
// Speaks MCP 2026-07-28 (stateless, per-request _meta) and, for older clients, the
// initialize-based revisions back to 2025-03-26, without sessions either way.

import { STATUS_CODES } from "node:http";
import type { RouteRecord } from "../core/route.ts";
import type { Origins } from "../core/ws.ts";
import { ArraySchema, EventsSchema, FileSchema, ObjectSchema, RawBodySchema, type JsonSchema, type RefContext, type Schema } from "../schema/schema.ts";
import { operationIdOf } from "../openapi/openapi.ts";

/**
 * The app's MCP endpoint. `true` serves it on `/mcp`.
 * @experimental
 */
export type McpOptions = {
  /** Where the endpoint lives. Default `/mcp`. */
  path?: string;
  /**
   * The pages that may call it from a browser: by default only the app's own origin, and
   * clients without an Origin header (not browsers). A call from another origin is a 403.
   */
  origins?: Origins;
  /** What a model is told about the server as a whole. Default: the app's `description`. */
  instructions?: string;
};

/**
 * What a client is told about a tool's behaviour. Hints only: clients treat them as untrusted.
 * @experimental
 */
export type McpAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * A route's `mcp`: `false` keeps it out, an object renames or rewords its tool.
 * @experimental
 */
export type McpRoute =
  | false
  | {
      /** The tool's name. Default: the route's `operationId`, as in the OpenAPI document. */
      name?: string;
      /** What the model reads. Default: the route's summary, description and examples. */
      description?: string;
      /** Merged over the hints inkan reads from the method. */
      annotations?: McpAnnotations;
    };

/** @experimental */
export type McpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpAnnotations;
};

/**
 * What `app.mcp()` hands back: the tools, and the routes that are not one, with the reason.
 * @experimental
 */
export type McpServer = {
  path: string;
  tools: McpTool[];
  skipped: { method: string; path: string; reason: string }[];
};

/** How a tool's arguments map onto the route's request. */
type Layout = { nested: boolean; params: string[]; query: string[]; body: boolean; headers: boolean };
/** @internal */
export type ToolEntry = { tool: McpTool; route: RouteRecord; layout: Layout };

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** @internal Every route as a tool, or the reason it is none. */
export function buildTools(records: readonly RouteRecord[]): { entries: Map<string, ToolEntry>; server: Omit<McpServer, "path"> } {
  const entries = new Map<string, ToolEntry>();
  const tools: McpTool[] = [];
  const skipped: McpServer["skipped"] = [];
  for (const r of records) {
    const reason = skipReason(r);
    if (reason) {
      if (!r.spec.hidden) skipped.push({ method: r.method, path: r.path, reason });
      continue;
    }
    const opts = r.spec.mcp || {};
    const name = opts.name ?? r.spec.operationId ?? operationIdOf(r.method, r.path);
    if (!NAME.test(name)) {
      throw new TypeError(`${r.method} ${r.path}: "${name}" cannot be an MCP tool name (1-128 letters, digits, _ . -). Give it mcp: { name }.`);
    }
    const twin = entries.get(name);
    if (twin) throw new TypeError(`${r.method} ${r.path} and ${twin.route.method} ${twin.route.path} are both the MCP tool "${name}". Give one mcp: { name }.`);
    const entry = toolOf(r, name, opts);
    entries.set(name, entry);
    tools.push(entry.tool);
  }
  return { entries, server: { tools, skipped } };
}

function skipReason(r: RouteRecord): string | undefined {
  const { spec } = r;
  if (spec.hidden) return "hidden";
  if (spec.mcp === false) return "mcp: false";
  if (r.method === "WS") return "a WebSocket";
  if (!METHODS.has(r.method)) return `${r.method} is no tool`;
  if (spec.body instanceof RawBodySchema) return "takes a raw or streamed body";
  if (spec.body && carriesFiles(spec.body)) return "takes files";
  for (const [status, s] of Object.entries(spec.response ?? {})) {
    if (Number(status) < 300 && s instanceof EventsSchema) return "answers with server-sent events";
  }
}

const carriesFiles = (s: Schema<any>) =>
  s instanceof FileSchema ||
  (s instanceof ObjectSchema &&
    Object.values(s.shape as Record<string, Schema<any>>).some((f) => f instanceof FileSchema || (f instanceof ArraySchema && f.item instanceof FileSchema)));

const fieldsOf = (s: Schema<any> | undefined): [string, Schema<any>][] =>
  s instanceof ObjectSchema ? Object.entries(s.shape as Record<string, Schema<any>>) : [];

const required = (s: Schema<any>) => !s.meta.optional && !s.meta.hasDefault;

function toolOf(r: RouteRecord, name: string, opts: Exclude<McpRoute, false>): ToolEntry {
  const { spec } = r;
  const ctx: RefContext = { components: new Map(), refPrefix: "#/$defs/" };
  const pathNames = [...r.path.matchAll(/[:*](\w*)/g)].map((m) => m[1] || "rest");
  const declared = new Map(fieldsOf(spec.params));
  const params: [string, JsonSchema, boolean][] = pathNames.map((n) => {
    const s = declared.get(n);
    return [n, s ? s._schema(ctx) : { type: "string" }, true];
  });
  const query: [string, JsonSchema, boolean][] = fieldsOf(spec.query).map(([n, s]) => [n, s._schema(ctx), required(s)]);
  const names = [...params, ...query].map(([n]) => n);
  // flat reads best; nested only where a name would be taken twice
  const nested = new Set(names).size < names.length || names.includes("body") || names.includes("headers");

  const properties: Record<string, JsonSchema> = {};
  const need: string[] = [];
  const group = (key: string, fields: [string, JsonSchema, boolean][]) => {
    if (!fields.length) return;
    if (!nested) {
      for (const [n, s, req] of fields) {
        properties[n] = s;
        if (req) need.push(n);
      }
      return;
    }
    properties[key] = { type: "object", properties: Object.fromEntries(fields.map(([n, s]) => [n, s])), required: fields.filter(([, , q]) => q).map(([n]) => n) };
    if (fields.some(([, , q]) => q)) need.push(key);
  };
  group("params", params);
  group("query", query);
  const headerFields = fieldsOf(spec.headers);
  if (headerFields.length) {
    properties.headers = {
      type: "object",
      properties: Object.fromEntries(headerFields.map(([n, s]) => [n, s._schema(ctx)])),
      required: headerFields.filter(([, s]) => required(s)).map(([n]) => n),
    };
    if (headerFields.some(([, s]) => required(s))) need.push("headers");
  }
  if (spec.body) {
    properties.body = spec.body._schema(ctx);
    if (!spec.body.meta.optional) need.push("body");
  }
  const inputSchema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (need.length) inputSchema.required = need;
  const layout: Layout = { nested, params: pathNames, query: query.map(([n]) => n), body: Boolean(spec.body), headers: headerFields.length > 0 };

  const tool: McpTool = { name, description: opts.description ?? describe(r, layout), inputSchema: withDefs(inputSchema, ctx) };
  const title = spec.summary;
  if (title) tool.title = title;
  const out = outputOf(r);
  if (out) tool.outputSchema = out;
  const hints: McpAnnotations = { ...(title ? { title } : {}), ...hintsOf(r.method), ...opts.annotations };
  tool.annotations = hints;
  return { tool, route: r, layout };
}

/** The `$defs` named schemas went to, at the root; a root that is only a `$ref` is unfolded. */
function withDefs(schema: JsonSchema, ctx: RefContext): JsonSchema {
  if (!ctx.components.size) return schema;
  const defs = Object.fromEntries(ctx.components);
  const ref = typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice(8) : undefined;
  const root = ref && Object.keys(schema).length === 1 ? { ...defs[ref] } : schema;
  return { ...root, $defs: defs };
}

/** The 2xx answer as an `outputSchema`, when the one 2xx answers with a JSON object. */
function outputOf(r: RouteRecord): JsonSchema | undefined {
  const ok = Object.entries(r.spec.response ?? {}).filter(([s]) => Number(s) >= 200 && Number(s) < 300);
  if (ok.length !== 1) return; // several shapes, or none promised: the text says what came
  const [status, schema] = ok[0]!;
  if (status === "204") return;
  const ctx: RefContext = { components: new Map(), refPrefix: "#/$defs/" };
  const out = withDefs(schema._schema(ctx), ctx);
  return out.type === "object" ? out : undefined;
}

function hintsOf(method: string): McpAnnotations {
  if (method === "GET") return { readOnlyHint: true };
  if (method === "DELETE") return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  if (method === "PUT") return { readOnlyHint: false, idempotentHint: true };
  return { readOnlyHint: false };
}

/** Summary, description and up to three examples as calls: what the docs page shows. */
function describe(r: RouteRecord, layout: Layout): string {
  const { spec } = r;
  const parts: string[] = [];
  if (spec.summary) parts.push(spec.summary);
  if (spec.description) parts.push(spec.description);
  if (!parts.length) parts.push(`${r.method} ${r.path}`);
  if (spec.deprecated) parts.push("Deprecated.");
  const shown = (spec.examples ?? []).filter((e) => !e.after).slice(0, 3);
  if (shown.length) {
    const lines = shown.map((e, i) => {
      const status = e.status ?? firstOk(r);
      return `- ${e.name ?? `example ${i + 1}`}: ${JSON.stringify(argumentsOf(e, layout))}${status ? ` → ${status}` : ""}`;
    });
    parts.push(`Examples:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

const firstOk = (r: RouteRecord) => Object.keys(r.spec.response ?? {}).map(Number).find((s) => s >= 200 && s < 300);

/** @internal An example's request as the tool's arguments. */
export function argumentsOf(e: { params?: object; query?: object; headers?: object; body?: unknown }, layout: Layout): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (layout.nested) {
    if (e.params && Object.keys(e.params).length) args.params = e.params;
    if (e.query && Object.keys(e.query).length) args.query = e.query;
  } else Object.assign(args, e.params, e.query);
  if (layout.headers && e.headers) {
    const declared = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (Object.keys(declared).length) args.headers = declared;
  }
  if (e.body !== undefined) args.body = e.body;
  return args;
}

// ---------- calls ----------

/** @internal What the app hands the tool call to: the request it would get over HTTP. */
export type InnerRequest = { method: string; url: string; headers: Record<string, string>; body?: Buffer };
/** @internal What came back, read whole. */
export type InnerAnswer = { status: number; headers: Record<string, string>; bytes: Buffer };

// what an outer request carries that has no business in the inner one; Origin stays, for the route's own checks
const DROP = new Set(["content-type", "content-length", "transfer-encoding", "accept", "accept-encoding", "connection", "expect", "te", "upgrade", "keep-alive"]);

/** @internal The route's request for these arguments, or the reason there is none. */
export function requestFor(entry: ToolEntry, args: Record<string, unknown>, outer: { headers: Record<string, string | string[] | undefined>; query: URLSearchParams }): InnerRequest | string {
  const { route, layout } = entry;
  const pick = (key: "params" | "query", n: string) => (layout.nested ? (args[key] as Record<string, unknown> | undefined)?.[n] : args[n]);
  let missing: string | undefined;
  const path = route.path.replace(/([:*])(\w*)/g, (_, kind: string, n: string) => {
    const v = pick("params", n || "rest");
    if (v === undefined || v === null || v === "") missing ??= n || "rest";
    const s = String(v ?? "");
    return kind === "*" ? s.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(s);
  });
  if (missing) return `"${missing}" is missing: it is part of the path ${route.path}`;
  const qs = new URLSearchParams();
  for (const n of layout.query) {
    const v = pick("query", n);
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) qs.append(n, typeof item === "object" ? JSON.stringify(item) : String(item));
  }
  // an API key the route reads from the query comes from the endpoint's own URL
  for (const s of route.security ?? []) {
    if (typeof s === "object" && s.in === "query" && !qs.has(s.apiKey)) {
      const key = outer.query.get(s.apiKey);
      if (key !== null) qs.set(s.apiKey, key);
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(outer.headers)) {
    if (v === undefined || DROP.has(k) || k.startsWith("mcp-") || k === "last-event-id") continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  const given = args.headers as Record<string, unknown> | undefined;
  if (layout.headers && given) for (const [k, v] of Object.entries(given)) if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
  let body: Buffer | undefined;
  if (layout.body && args.body !== undefined) {
    body = Buffer.from(JSON.stringify(args.body));
    headers["content-type"] = "application/json";
  }
  const search = qs.toString();
  return { method: route.method, url: path + (search ? `?${search}` : ""), headers, body };
}

/** @internal The answer as a tool result: the body as the model reads it, the status in `_meta`. */
export function resultOf(entry: ToolEntry, answer: InnerAnswer): Record<string, unknown> {
  const { status, headers, bytes } = answer;
  const type = headers["content-type"] ?? "";
  const meta = { "dev.inkan/status": status };
  const statusLine = `${status} ${STATUS_CODES[status] ?? ""}`.trim();
  if (status >= 400) return { content: [{ type: "text", text: bytes.length ? bytes.toString() : statusLine }], isError: true, _meta: meta };
  if (!bytes.length) return { content: [{ type: "text", text: statusLine + (headers.location ? ` (${headers.location})` : "") }], _meta: meta };
  if (/(^|\/|\+)json\b/.test(type)) {
    const text = bytes.toString();
    const result: Record<string, unknown> = { content: [{ type: "text", text }], _meta: meta };
    if (entry.tool.outputSchema) {
      try {
        result.structuredContent = JSON.parse(text);
      } catch {} // the contract says JSON; a route that broke it answers as text
    }
    return result;
  }
  if (type.startsWith("image/")) return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: type.split(";")[0] }], _meta: meta };
  if (type.startsWith("text/") || type.includes("xml") || type.includes("csv")) return { content: [{ type: "text", text: bytes.toString() }], _meta: meta };
  return { content: [{ type: "text", text: `${bytes.length} bytes of ${type || "unknown type"}` }], _meta: meta };
}

// ---------- the protocol ----------

/** @internal Revisions spoken: the modern one, then the initialize-based ones, newest first. */
export const MODERN = ["2026-07-28"];
/** @internal */
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];

/** @internal An answer before HTTP: a status and a JSON-RPC message, or 202 without one. */
export type RpcAnswer = { status: number; message?: Record<string, unknown> };

/** @internal What the endpoint needs from the app. */
export type RpcHost = {
  tools: () => Map<string, ToolEntry>;
  /** `ttlMs`: how long a client may keep the tool list; the routes only change with a deploy. */
  info: { name: string; version: string; instructions?: string; ttlMs: number };
  call: (entry: ToolEntry, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const error = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

/** @internal `=?base64?…?=` as the value it stands for. */
export function headerValue(v: string | undefined): string | undefined {
  if (v === undefined) return;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, "base64").toString() : v;
}

/**
 * One JSON-RPC message, as POSTed (`http` set: its headers are checked against the body) or as
 * a line on stdio. No state outlives it.
 * @internal
 */
export async function answer(host: RpcHost, msg: unknown, http?: Record<string, string | string[] | undefined>): Promise<RpcAnswer> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return { status: 400, message: error(null, -32600, "One JSON-RPC message per request; batches are not supported") };
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return { status: 400, message: error(m.id, -32600, "Not a JSON-RPC 2.0 request") };
  if (!("id" in m)) return { status: 202 }; // a notification: nothing to answer
  const { id } = m;
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, any>;
  const header = (n: string) => {
    const v = http?.[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const meta = params._meta as Record<string, any> | undefined;
  const version = meta?.["io.modelcontextprotocol/protocolVersion"];
  const modern = typeof version === "string" && m.method !== "initialize";
  const serverInfo = { name: host.info.name, version: host.info.version };
  const ok = (result: Record<string, unknown>): RpcAnswer => ({
    status: 200,
    message: { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { ...(result._meta as object), "io.modelcontextprotocol/serverInfo": serverInfo } } : result },
  });

  if (modern) {
    if (!MODERN.includes(version)) return { status: 400, message: error(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested: version }) };
    if (http) {
      const mismatch = (what: string): RpcAnswer => ({ status: 400, message: error(id, -32020, `Header mismatch: ${what}`) });
      if (header("mcp-protocol-version") !== version) return mismatch(`MCP-Protocol-Version does not say ${version}`);
      if (header("mcp-method") !== m.method) return mismatch(`Mcp-Method does not say ${m.method}`);
      if (m.method === "tools/call" && headerValue(header("mcp-name")) !== params.name) return mismatch(`Mcp-Name does not say ${String(params.name)}`);
    }
    if (typeof meta?.["io.modelcontextprotocol/clientCapabilities"] !== "object") {
      return { status: 400, message: error(id, -32602, "_meta needs io.modelcontextprotocol/clientCapabilities") };
    }
  } else if (http) {
    const said = header("mcp-protocol-version");
    if (said !== undefined && !LEGACY.includes(said)) return { status: 400, message: error(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested: said }) };
  }

  const instructions = host.info.instructions ? { instructions: host.info.instructions } : {};
  // the same list for every caller: what a tool call may do is the route's to decide
  const cache = modern ? { ttlMs: host.info.ttlMs, cacheScope: "public" } : {};
  switch (m.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok({ protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: false } }, serverInfo, ...instructions });
    }
    case "server/discover":
      return ok({ supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: {} }, ...instructions, ...cache });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [...host.tools().values()].map((e) => e.tool), ...cache });
    case "tools/call": {
      const entry = typeof params.name === "string" ? host.tools().get(params.name) : undefined;
      if (!entry) return { status: 200, message: error(id, -32602, `Unknown tool: ${String(params.name)}`) };
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) return { status: 200, message: error(id, -32602, "arguments has to be an object") };
      return ok(await host.call(entry, args));
    }
    default:
      return { status: modern && http ? 404 : 200, message: error(id, -32601, `Method not found: ${m.method}`) };
  }
}
