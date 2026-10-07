import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { docsPage, inspectorPage } from "../src/pages.ts";

const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("the page scripts are valid JavaScript", () => {
  const pages = [
    docsPage({ title: "API", specUrl: "/openapi.json", inspector: "/_inkan" }),
    inspectorPage({ title: "API", base: "/_inkan", docs: "/docs" }),
  ];
  for (const html of pages) {
    const [js] = scripts(html);
    assert.ok(js, "a script is there");
    assert.doesNotThrow(() => new Script(js), "it parses");
  }
});

test("the docs page can edit, copy as curl and reset, and keeps the token per tab", () => {
  const html = docsPage({ title: "API", specUrl: "/openapi.json" });
  for (const hook of ["data-edit", "data-curl", "data-reset", 'id="auth"', 'id="authName"']) {
    assert.ok(html.includes(hook), hook);
  }
  assert.ok(html.includes("sessionStorage"));
  assert.ok(!html.includes("localStorage"), "a token must not outlive the tab");
});

test("titles cannot break out of the page", () => {
  const html = docsPage({ title: '</h1><script>alert(1)</script>', specUrl: "" });
  assert.ok(!html.includes("<script>alert(1)"));
});
