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
