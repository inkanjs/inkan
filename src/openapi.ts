// Writes an OpenAPI 3.1 document from the routes. Nothing is annotated twice:
// the schemas that validate a request are the ones that describe it.

import { STATUS_CODES } from "node:http";
import type { RouteRecord } from "./app.ts";
import { ObjectSchema, t, type JsonSchema, type RefContext, type Schema } from "./schema.ts";

export type OpenAPIInfo = {
  title?: string;
  version?: string;
  description?: string;
  servers?: { url: string; description?: string }[];
};

export const toOpenAPIPath = (path: string) =>
  path.replace(/:(\w+)/g, "{$1}").replace(/\*(\w*)$/, (_, n) => `{${n || "rest"}}`);

const operationId = (r: RouteRecord) =>
  r.method.toLowerCase() +
  r.path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      const by = s.startsWith(":") || s.startsWith("*");
      const word = s.replace(/^[:*]/, "").replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
      return (by ? "By" : "") + word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");

function parameters(where: "path" | "query" | "header", schema: Schema<any> | undefined, ctx: RefContext, r: RouteRecord) {
  const out: JsonSchema[] = [];
  const key = where === "path" ? "params" : where === "header" ? "headers" : "query";
  if (schema instanceof ObjectSchema) {
    for (const [name, s] of Object.entries(schema.shape as Record<string, Schema<any>>)) {
      const p: JsonSchema = {
        name,
        in: where,
        required: where === "path" || (!s.meta.optional && !s.meta.hasDefault),
        schema: s._schema(ctx),
      };
      if (s.meta.description) p.description = s.meta.description;
      const examples = (r.spec.examples ?? [])
        .map((e, i) => [e.name ?? `example${i + 1}`, (e as Record<string, any>)[key]?.[name]] as const)
        .filter(([, v]) => v !== undefined);
      if (examples.length) p.examples = Object.fromEntries(examples.map(([n, value]) => [n, { value }]));
      out.push(p);
    }
  } else if (where === "path") {
    for (const m of r.path.matchAll(/[:*](\w*)/g)) {
      out.push({ name: m[1] || "rest", in: "path", required: true, schema: { type: "string" } });
    }
  }
  return out;
}

export function buildOpenAPI(records: RouteRecord[], info: OpenAPIInfo = {}) {
  const ctx: RefContext = { components: new Map() };
  const paths: Record<string, Record<string, unknown>> = {};
  const problemRef = () => t.problem()._schema(ctx);

  for (const r of records) {
    const { spec } = r;
    if (spec.hidden) continue;
    const op: Record<string, unknown> = { operationId: spec.operationId ?? operationId(r) };
    if (spec.summary) op.summary = spec.summary;
    if (spec.description) op.description = spec.description;
    if (spec.tags) op.tags = spec.tags;
    if (spec.deprecated) op.deprecated = true;

    const params = [
      ...parameters("path", spec.params, ctx, r),
      ...parameters("query", spec.query, ctx, r),
      ...parameters("header", spec.headers, ctx, r),
    ];
    if (params.length) op.parameters = params;

    if (spec.body) {
      const examples = (spec.examples ?? []).filter((e) => e.body !== undefined);
      const media: Record<string, unknown> = { schema: spec.body._schema(ctx) };
      if (examples.length) {
        media.examples = Object.fromEntries(examples.map((e, i) => [e.name ?? `example${i + 1}`, { value: e.body }]));
      }
      op.requestBody = { required: !spec.body.meta.optional, content: { "application/json": media } };
    }

    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(spec.response ?? {})) {
      const code = Number(status);
      const res: Record<string, unknown> = { description: schema.meta.description ?? STATUS_CODES[code] ?? "" };
      if (code !== 204) {
        res.content = { [code >= 400 ? "application/problem+json" : "application/json"]: { schema: schema._schema(ctx) } };
      }
      responses[status] = res;
    }
    if ((spec.params || spec.query || spec.headers || spec.body) && !responses["400"]) {
      responses["400"] = {
        description: "The input does not match the contract",
        content: { "application/problem+json": { schema: problemRef() } },
        "x-inkan-implied": true,
      };
    }
    if (!Object.keys(responses).length) responses["200"] = { description: "OK" };
    op.responses = responses;
    if (spec.examples?.length) op["x-inkan-examples"] = spec.examples;

    (paths[toOpenAPIPath(r.path)] ??= {})[r.method.toLowerCase()] = op;
  }

  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: info.title ?? "API",
      version: info.version ?? "0.0.0",
      ...(info.description ? { description: info.description } : {}),
    },
  };
  if (info.servers) doc.servers = info.servers;
  doc.paths = paths;
  if (ctx.components.size) doc.components = { schemas: Object.fromEntries(ctx.components) };
  return doc;
}
