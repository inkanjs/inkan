// Writes an OpenAPI 3.1 document from the routes. Nothing is annotated twice:
// the schemas that validate a request are the ones that describe it.

import { STATUS_CODES } from "node:http";
import type { OperationRoute, RouteRecord, Security } from "../core/route.ts";
import { ArraySchema, EventsSchema, FileSchema, ObjectSchema, RawBodySchema, t, type JsonSchema, type RefContext, type Schema } from "../schema/schema.ts";

const NO_META = Object.freeze({});
/** What a describe hook sees of a route: `ctx.route`'s fields and the spec, read-only. */
const routeView = (r: RouteRecord): OperationRoute =>
  Object.freeze({ ...(r.info ?? { method: r.method, path: r.path, security: Object.freeze([...(r.security ?? [])]), meta: r.spec.meta ?? NO_META }), spec: r.spec });

/** A body with a file anywhere at its top level goes as multipart/form-data. */
const carriesFiles = (s: Schema<any>) =>
  s instanceof ObjectSchema &&
  Object.values(s.shape as Record<string, Schema<any>>).some((f) => f instanceof FileSchema || (f instanceof ArraySchema && f.item instanceof FileSchema));

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

/** A scheme as OpenAPI names and describes it. Names may only hold letters, digits and . - _ */
function schemeOf(s: Security): [string, JsonSchema] {
  if (s === "bearer") return ["bearer", { type: "http", scheme: "bearer" }];
  if (s === "basic") return ["basic", { type: "http", scheme: "basic" }];
  const where = s.in ?? "header";
  const name = (where === "header" ? s.apiKey : `${s.apiKey}-${where}`).replace(/[^\w.-]/g, "_");
  return [name, { type: "apiKey", in: where, name: s.apiKey }];
}

export function buildOpenAPI(records: RouteRecord[], info: OpenAPIInfo = {}) {
  const ctx: RefContext = { components: new Map() };
  const paths: Record<string, Record<string, unknown>> = {};
  const problemRef = () => t.problem()._schema(ctx);
  // what describe() hooks see and may add to; schemas join it at the end
  const components: Record<string, Record<string, any>> = { securitySchemes: {} };
  const schemes = components.securitySchemes!;
  // for describe() hooks: a schema listed once under components.schemas, the way a route's named ones are
  const ref = (schema: Schema<any>, name?: string): JsonSchema => {
    const named = name ? schema.named(name) : schema;
    if (!named.meta.name) throw new TypeError(`Name the schema to refer to it: ref(schema, "Name") or schema.named("Name")`);
    return named._schema(ctx);
  };

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
      const types =
        spec.body instanceof RawBodySchema ? spec.body.mediaTypes() : [carriesFiles(spec.body) ? "multipart/form-data" : "application/json"];
      op.requestBody = { required: !spec.body.meta.optional, content: Object.fromEntries(types.map((type) => [type, media])) };
    }

    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(spec.response ?? {})) {
      const code = Number(status);
      const res: Record<string, unknown> = { description: schema.meta.description ?? STATUS_CODES[code] ?? "" };
      if (code !== 204) {
        const type = schema instanceof EventsSchema ? "text/event-stream" : code >= 400 ? "application/problem+json" : "application/json";
        res.content = { [type]: { schema: schema._schema(ctx) } };
      }
      const headers = spec.responseHeaders?.[code];
      if (headers) {
        res.headers = Object.fromEntries(
          Object.entries(headers).map(([name, h]) => [
            name,
            { schema: h._schema(ctx), required: !h.meta.optional && !h.meta.hasDefault, ...(h.meta.description ? { description: h.meta.description } : {}) },
          ]),
        );
      }
      responses[status] = res;
    }
    if (r.security?.length) {
      op.security = r.security.map((s) => {
        const [name, scheme] = schemeOf(s);
        schemes[name] ??= scheme;
        return { [name]: [] };
      });
      responses["401"] ??= {
        description: "The credentials this route asks for are missing",
        content: { "application/problem+json": { schema: problemRef() } },
        "x-inkan-implied": true,
      };
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
    // what the scopes around the route add: outermost first, as with hooks
    if (r.box) {
      let view: OperationRoute | undefined;
      for (const b of r.box.chain()) for (const d of b.describers) d(op, (view ??= routeView(r)), components, ref);
    }

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
  const all: Record<string, Record<string, any>> = { schemas: { ...Object.fromEntries(ctx.components), ...components.schemas } };
  for (const k in components) if (k !== "schemas") all[k] = components[k]!;
  for (const k of Object.keys(all)) if (!Object.keys(all[k]!).length) delete all[k];
  if (Object.keys(all).length) doc.components = all;
  return doc;
}
