import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inkan } from "@vxnsin/inkan";
import { myPlugin } from "./index.js";

const quiet = { log: false as const };
const app = () =>
  inkan(quiet)
    .register(myPlugin())
    .get("/me", (ctx) => ({ tenant: ctx.tenant }));

test("puts the header on the context", async () => {
  const r = await app().inject({ url: "/me", headers: { "x-tenant": "acme" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { tenant: "acme" });
});

test("answers 400 without it", async () => {
  const r = await app().inject({ url: "/me" });
  assert.equal(r.status, 400);
});

test("reads another header when told to", async () => {
  const other = inkan(quiet)
    .register(myPlugin({ header: "X-Org" }))
    .get("/me", (ctx) => ({ tenant: ctx.tenant }));
  assert.deepEqual((await other.inject({ url: "/me", headers: { "x-org": "ink" } })).body, { tenant: "ink" });
});

test("says so in the OpenAPI document", async () => {
  const a = app();
  await a.ready();
  const op = (a.openapi() as any).paths["/me"].get;
  assert.ok(op.parameters.some((p: { name: string; in: string }) => p.name === "x-tenant" && p.in === "header"));
  assert.ok(op.responses["400"]);
});

test("names the inkan versions it works with, the same as peerDependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(myPlugin().inkan, pkg.peerDependencies["@vxnsin/inkan"]);
});
