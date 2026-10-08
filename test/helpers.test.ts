import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { html, inkan, raw, t } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;

test("text and html answer with their media type and the status status() set", async () => {
  const app = inkan(quiet)
    .get("/t", ({ text }) => text("hi"))
    .get("/h", ({ html: page }) => page(html`<h1>tea</h1>`, 201))
    .post("/s", ({ status, text }) => {
      status(202);
      return text("later");
    });
  const a = await app.inject({ url: "/t" });
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(a.text, "hi");
  const b = await app.inject({ url: "/h" });
  assert.equal(b.status, 201);
  assert.equal(b.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(b.text, "<h1>tea</h1>");
  assert.equal((await app.inject({ method: "POST", url: "/s" })).status, 202);
});

test("the html tag escapes every value, joins lists and writes nothing for null and false", () => {
  const name = `<script>alert("x")</script> & 'co'`;
  const items = ["a<b", "c"];
  const page = html`<p title="${name}">${name}</p><ul>${items.map((i) => html`<li>${i}</li>`)}</ul>${null}${false}${undefined}${0}`;
  assert.equal(
    String(page),
    `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;</p><ul><li>a&lt;b</li><li>c</li></ul>0`,
  );
  assert.equal(String(html`<div>${raw("<b>mine</b>")}</div>`), "<div><b>mine</b></div>");
});

test("html returned as it is goes out as HTML", async () => {
  const app = inkan(quiet).get("/", () => html`<p>${"<x>"}</p>`);
  const res = await app.inject({ url: "/" });
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.text, "<p>&lt;x&gt;</p>");
});

test("redirect answers 302 with a location, or the status it is given, and refuses others", async () => {
  const app = inkan(quiet)
    .get("/a", ({ redirect }) => redirect("/b"))
    .get("/c", ({ redirect }) => redirect("https://example.com/teas", 301))
    .get("/u", ({ redirect }) => redirect("/tee/grüner tee"));
  const a = await app.inject({ url: "/a" });
  assert.equal(a.status, 302);
  assert.equal(a.headers.location, "/b");
  assert.equal(a.text, "");
  assert.equal((await app.inject({ url: "/c" })).status, 301);
  assert.equal((await app.inject({ url: "/u" })).headers.location, "/tee/gr%C3%BCner%20tee");
  const ctx = (await import("../src/core/context.ts")).RequestContext.prototype;
  assert.throws(() => ctx.redirect("/x", 200 as never), /301, 302, 303, 307 or 308/);
});

test("notFound is a 404 problem, which onProblem sees like any other", async () => {
  const seen: number[] = [];
  const app = inkan(quiet)
    .onProblem((_ctx, p) => void seen.push(p.status))
    .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int() }), 404: t.problem() } }, ({ params, notFound }) =>
      params.id === 1 ? { id: 1 } : notFound(`No tea ${params.id}`),
    );
  const res = await app.inject({ url: "/teas/7" });
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], "application/problem+json");
  assert.equal(res.body.type, "not-found");
  assert.equal(res.body.detail, "No tea 7");
  assert.deepEqual(seen, [404]);
  assert.equal((await app.inject({ url: "/teas/1" })).body.id, 1);
});

test("render puts the page into the layout of its scope; inside a plugin its own wins", async () => {
  const app = inkan(quiet)
    .layout((content, { title }) => html`<!doctype html><title>${title}</title><main>${content}</main>`)
    .get("/", ({ render }) => render(html`<p>home</p>`, { title: "Tea & co" }))
    .register((admin) => {
      admin.layout(async (content) => html`<div class="admin">${content}</div>`); // a layout may wait for something
      admin.get("/admin", ({ render }) => render("<p>raw text is HTML here</p>"));
    });
  const home = await app.inject({ url: "/" });
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(home.text, "<!doctype html><title>Tea &amp; co</title><main><p>home</p></main>");
  assert.equal((await app.inject({ url: "/admin" })).text, `<div class="admin"><p>raw text is HTML here</p></div>`);

  const bare = inkan(quiet).get("/", ({ render }) => render(html`<p>no layout</p>`));
  assert.equal((await bare.inject({ url: "/" })).text, "<p>no layout</p>");
});

test("cookies are read by name, decoded, and a strange name is just a name", async () => {
  const app = inkan(quiet).get("/", ({ cookies }) => ({ ...cookies, proto: cookies.__proto__ ?? null }));
  const res = await app.inject({ url: "/", headers: { cookie: 'sid=a%20b; theme="dark"; sid=second; __proto__=x; broken=%E0%A4%A' } });
  // parsed, not written as a literal: in one, __proto__ would set the prototype instead of a key
  assert.deepEqual(res.body, JSON.parse('{"sid":"a b","theme":"dark","__proto__":"x","broken":"%E0%A4%A","proto":"x"}'));
});

test("setCookie writes one Set-Cookie per cookie, safe by default; clearCookie lets it expire", async () => {
  const app = inkan(quiet).post("/login", ({ setCookie, clearCookie }) => {
    setCookie("sid", "a b;c", { maxAge: 3600 });
    setCookie("theme", "dark", { httpOnly: false, sameSite: "Strict", secure: true, path: "/app" });
    clearCookie("old");
    return { ok: true };
  });
  const res = await app.inject({ method: "POST", url: "/login" });
  assert.deepEqual(res.cookies, [
    "sid=a%20b%3Bc; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax",
    "theme=dark; Path=/app; Secure; SameSite=Strict",
    "old=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax",
  ]);
  const loud = { ...quiet, onError: () => {} }; // the two 500s below are the point, not noise
  const bad = inkan(loud).get("/", ({ setCookie }) => setCookie("a b", "x"));
  assert.equal((await bad.inject({ url: "/" })).status, 500);
  const none = inkan(loud).get("/", ({ setCookie }) => setCookie("a", "x", { sameSite: "None" }));
  assert.equal((await none.inject({ url: "/" })).status, 500, "SameSite=None without secure is refused");
});

test("over a socket and through fetch every cookie arrives as a header of its own", async () => {
  const app = inkan(quiet).get("/", ({ setCookie, text }) => {
    setCookie("a", "1");
    setCookie("b", "2");
    return text("ok");
  });
  const server = await app.listen(0, "127.0.0.1");
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    assert.deepEqual(res.headers.getSetCookie().map((c) => c.split(";")[0]), ["a=1", "b=2"]);
  } finally {
    server.close();
  }
  const web = await app.fetch(new Request("http://x/"));
  assert.deepEqual(web.headers.getSetCookie().map((c) => c.split(";")[0]), ["a=1", "b=2"]);
});

test("the new names are the context's own: decorate refuses them", () => {
  for (const name of ["html", "text", "redirect", "notFound", "render", "cookies", "setCookie", "clearCookie"]) {
    assert.throws(() => inkan(quiet).decorate(name, 1), /already has/, name);
  }
});

// ---------- for answers made from a lot of data ----------

test("a list given row by row goes out as JSON, each row trimmed to the contract", async () => {
  const Tea = t.object({ id: t.int(), name: t.string() });
  async function* fromDb() {
    for (let i = 1; i <= 3; i++) yield { id: i, name: `tea ${i}`, secret: "kept back" };
  }
  const app = inkan(quiet).get("/teas", { response: { 200: t.array(Tea) } }, () => fromDb());
  const res = await app.inject({ url: "/teas" });
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(res.body, [
    { id: 1, name: "tea 1" },
    { id: 2, name: "tea 2" },
    { id: 3, name: "tea 3" },
  ]);
  const lines = await app.inject({ url: "/teas", headers: { accept: "application/x-ndjson" } });
  assert.equal(lines.headers["content-type"], "application/x-ndjson");
  assert.equal(lines.text, '{"id":1,"name":"tea 1"}\n{"id":2,"name":"tea 2"}\n{"id":3,"name":"tea 3"}\n');
});

test("many rows go out in chunks, and a row that breaks the contract cuts the answer off in development", async () => {
  const app = inkan({ ...quiet, onError: () => {} }).get("/many", { response: { 200: t.array(t.object({ n: t.int() })) } }, function* () {
    for (let n = 0; n < 5000; n++) yield { n };
    yield { n: "not a number" } as never;
  });
  const res = await app.inject({ url: "/many" });
  assert.equal(res.status, 200, "the status went out with the first rows");
  assert.ok(res.text.startsWith('[{"n":0},{"n":1}'));
  assert.ok(!res.text.endsWith("]"), "cut off, so a client cannot take it for the whole list");
});

test("csv writes rows as they come, quoted where needed, with formulas defused", async () => {
  async function* rows() {
    yield { id: 1, name: 'Tea, "green"', note: "=HYPERLINK(1)", at: new Date("2026-01-02T03:04:05Z") };
    yield { id: 2, name: "line\nbreak", note: null, at: undefined };
  }
  const app = inkan(quiet).get("/export", ({ csv }) => csv(rows(), { filename: "teas 2026.csv" }));
  const res = await app.inject({ url: "/export" });
  assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal(res.headers["content-disposition"], `attachment; filename="teas 2026.csv"; filename*=UTF-8''teas%202026.csv`);
  assert.equal(res.text, `id,name,note,at\r\n1,"Tea, ""green""",'=HYPERLINK(1),2026-01-02T03:04:05.000Z\r\n2,"line\nbreak",,\r\n`);

  const de = inkan(quiet).get("/de", ({ csv }) => csv([{ a: "1,5", b: -3 }], { separator: ";", bom: true, columns: { a: "Preis", b: "Bestand" } }));
  assert.equal((await de.inject({ url: "/de" })).text, "﻿Preis;Bestand\r\n1,5;-3\r\n");
});

test("a route past its timeout answers 504 and aborts ctx.signal", async () => {
  let aborted: unknown;
  const app = inkan(quiet).get("/slow", { timeout: 30 }, async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    aborted = signal.reason;
    return { late: true };
  });
  const res = await app.inject({ url: "/slow" });
  assert.equal(res.status, 504);
  assert.equal(res.body.type, "timeout");
  await new Promise((r) => setImmediate(r));
  assert.equal((aborted as DOMException).name, "TimeoutError");

  const quick = inkan({ ...quiet, timeout: 1000 }).get("/q", async () => ({ ok: true }));
  assert.equal((await quick.inject({ url: "/q" })).status, 200, "the app's timeout leaves quick routes alone");
});

test("ctx.signal aborts when the client goes away over a socket", async () => {
  let reason: unknown;
  let started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  const app = inkan(quiet).get("/wait", ({ signal }) => {
    started();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve((reason = signal.reason))));
  });
  const server = await app.listen(0, "127.0.0.1");
  try {
    const ac = new AbortController();
    const req = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/wait`, { signal: ac.signal }).catch(() => undefined);
    await begun;
    ac.abort();
    await req;
    for (let i = 0; i < 50 && !reason; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((reason as DOMException).name, "AbortError");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("cache keeps a handler's answer per input and per caller, and asks once for many at the same time", async () => {
  let asked = 0;
  const app = inkan(quiet).get("/stock/:id", { params: t.object({ id: t.int() }), cache: { seconds: 60 } }, async ({ params, header }) => {
    asked++;
    header("x-from", "db");
    await new Promise((r) => setTimeout(r, 20));
    return { id: params.id, n: asked };
  });
  const same = await Promise.all([1, 2, 3].map(() => app.inject({ url: "/stock/1" })));
  assert.equal(asked, 1, "three at once, one question");
  assert.deepEqual(same.map((r) => r.body.n), [1, 1, 1]);
  assert.ok(same.every((r) => r.headers["x-from"] === "db"), "headers the handler set come along");
  assert.notEqual(same[0].headers["x-request-id"], same[1].headers["x-request-id"], "every answer keeps its own id");
  await app.inject({ url: "/stock/2" });
  assert.equal(asked, 2, "another input asks again");
  await app.inject({ url: "/stock/1", headers: { cookie: "sid=other" } });
  assert.equal(asked, 3, "another caller asks again");

  let shared = 0;
  const open = inkan(quiet).get("/menu", { cache: { seconds: 60, shared: true } }, () => ({ n: ++shared }));
  await open.inject({ url: "/menu", headers: { cookie: "sid=a" } });
  assert.equal((await open.inject({ url: "/menu", headers: { cookie: "sid=b" } })).body.n, 1, "shared: the same for everybody");

  let failing = 0;
  const flaky = inkan({ ...quiet, onError: () => {} }).get("/f", { cache: { seconds: 60 } }, () => {
    if (++failing === 1) throw new Error("db down");
    return { ok: true };
  });
  assert.equal((await flaky.inject({ url: "/f" })).status, 500);
  assert.equal((await flaky.inject({ url: "/f" })).status, 200, "a failure is not kept");
});
