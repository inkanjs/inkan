// The docs page: every route with its contract, examples to send, edit and chain.

import { attr, css, esc, page } from "./shared.ts";

const docsScript = /* js */ `
var COMP = {};
var $ = function (s) { return document.querySelector(s); };
function lit(s) { return '<span class="lit">' + esc(s) + "</span>"; }
function ty(s) { return '<span class="ty">' + esc(s) + "</span>"; }
function note(s) {
  var n = [];
  if (s.format && s.format !== "binary") n.push(s.format);
  if (s.minimum !== undefined || s.maximum !== undefined) n.push((s.minimum !== undefined ? s.minimum : "") + ".." + (s.maximum !== undefined ? s.maximum : ""));
  if (s.minLength !== undefined || s.maxLength !== undefined) n.push("length " + (s.minLength || 0) + ".." + (s.maxLength !== undefined ? s.maxLength : ""));
  if (s.pattern) n.push("/" + s.pattern + "/");
  if (s.default !== undefined) n.push("default " + JSON.stringify(s.default));
  if (s.description) n.push(s.description);
  return n;
}
function render(s, pad) {
  pad = pad || "";
  if (!s || !Object.keys(s).length) return ty("any");
  if (s.$ref) { var name = s.$ref.split("/").pop(); return '<a class="ty-ref" href="#schema-' + esc(name) + '">' + esc(name) + "</a>"; }
  if (s.anyOf || s.oneOf) return (s.anyOf || s.oneOf).map(function (x) { return render(x, pad); }).join(" | ");
  if (s.format === "binary") return ty("file") + (s.contentMediaType ? '  <span class="cm">// ' + esc(s.contentMediaType) + "</span>" : "");
  if (s.const !== undefined) return lit(JSON.stringify(s.const));
  if (s.enum) return s.enum.map(function (v) { return lit(JSON.stringify(v)); }).join(" | ");
  if (s.type === "null") return ty("null");
  if (s.type === "array") { var inner = render(s.items, pad); return (/ \\| /.test(inner) ? "(" + inner + ")" : inner) + ty("[]"); }
  if (s.type === "object") {
    if (!s.properties) return s.additionalProperties ? ty("Record<string, ") + render(s.additionalProperties, pad) + ty(">") : ty("object");
    var req = s.required || [], keys = Object.keys(s.properties);
    if (!keys.length) return ty("{}");
    var lines = keys.map(function (k) {
      var p = s.properties[k], n = note(p);
      return pad + "  " + '<span class="k">' + esc(k) + (req.indexOf(k) < 0 ? "?" : "") + "</span>: " + render(p, pad + "  ") +
        (n.length ? '  <span class="cm">// ' + esc(n.join(", ")) + "</span>" : "");
    });
    return "{\\n" + lines.join("\\n") + "\\n" + pad + "}";
  }
  return ty(s.type === "integer" ? "int" : s.type || "any");
}
function block(schema) { return '<pre class="type">' + render(schema, "") + "</pre>"; }
function firstContent(c) { if (!c) return null; var k = Object.keys(c)[0]; return k ? c[k].schema : null; }
function expected(op, ex) {
  if (ex.status !== undefined) return ex.status;
  var ok = Object.keys(op.responses || {}).map(Number).filter(function (s) { return s >= 200 && s < 300; }).sort();
  return ok[0];
}
function urlFor(path, ex) {
  var u = path.replace(/\\{(\\w+)\\}/g, function (_, n) {
    var v = (ex.params || {})[n];
    if (v === undefined) return "{" + n + "}";
    return /^\\{\\w+\\}$/.test(String(v)) ? String(v) : encodeURIComponent(String(v)); // a placeholder stays readable
  });
  var q = new URLSearchParams();
  Object.keys(ex.query || {}).forEach(function (k) { [].concat(ex.query[k]).forEach(function (v) { q.append(k, String(v)); }); });
  var qs = q.toString();
  return u + (qs ? "?" + qs : "");
}
var ROUTES = [];
function card(path, method, op, idx) {
  var id = "op-" + (op.operationId || idx);
  var h = '<section class="win" id="' + esc(id) + '"><header class="bar"><span class="m m-' + esc(method) + '">' + esc(method.toUpperCase()) +
    "</span><code>" + esc(path) + "</code>" + (op.deprecated ? '<span class="dep">deprecated</span>' : "") +
    (op.security && op.security.length ? '<span class="lock" title="asks for these credentials">&#128274; ' + esc(op.security.map(function (s) { return Object.keys(s)[0]; }).join(" or ")) + "</span>" : "") +
    '<span class="stamp sealmark" title="every example answered as promised">印</span></header><div class="pad">';
  if (op.summary) h += '<p class="sum">' + esc(op.summary) + "</p>";
  if (op.description) h += '<p class="desc">' + esc(op.description) + "</p>";
  if (op.parameters && op.parameters.length) {
    h += "<h5>parameters</h5><table><tr><th>name</th><th>in</th><th>type</th><th></th></tr>";
    op.parameters.forEach(function (p) {
      h += "<tr><td><code>" + esc(p.name) + (p.required ? "" : "?") + "</code></td><td class=muted>" + esc(p.in) +
        "</td><td><code>" + render(p.schema, "") + "</code></td><td class=muted>" + esc(note(p.schema || {}).concat(p.description || []).join(", ")) + "</td></tr>";
    });
    h += "</table>";
  }
  if (op.requestBody) h += "<h5>body</h5>" + block(firstContent(op.requestBody.content));
  var exs = op["x-inkan-examples"] || [];
  var covered = exs.map(function (ex) { return expected(op, ex); });
  h += "<h5>responses</h5><table>";
  Object.keys(op.responses || {}).forEach(function (s) {
    var r = op.responses[s], sc = firstContent(r.content);
    var gap = exs.length && !r["x-inkan-implied"] && covered.indexOf(Number(s)) < 0 ? ' <span class="muted" title="inkan check --strict fails on this">· no example answers with it</span>' : "";
    var heads = r.headers ? '<p class="mono muted heads">headers: ' + esc(Object.keys(r.headers).map(function (n) { return n + (r.headers[n].required ? "" : "?"); }).join(", ")) + "</p>" : "";
    h += '<tr><td style="width:60px"><span class="status s' + esc(s[0]) + '">' + esc(s) + "</span></td><td>" + esc(r.description || "") + gap + heads +
      (sc ? '<pre class="type" style="margin-top:6px">' + render(sc, "") + "</pre>" : "") + "</td></tr>";
  });
  h += "</table>";
  if (exs.length) {
    h += "<h5>examples · each one is also a test</h5>";
    exs.forEach(function (ex, i) {
      var want = expected(op, ex), n = ROUTES.length;
      ROUTES.push({ id: id, path: path, method: method, op: op, ex: ex, el: id + "-ex" + i, name: ex.name || "example " + (i + 1) });
      h += '<div class="ex" id="' + esc(id + "-ex" + i) + '"><div class="ex-head"><span class="name">' + esc(ex.name || "example " + (i + 1)) +
        '</span><span class="req">' + esc(method.toUpperCase() + " " + urlFor(path, ex) + (want ? " → " + want : "")) +
        '</span><span class="acts"><button class="btn" data-edit="' + n + '">edit</button><button class="btn" data-curl="' + n +
        '">curl</button><button class="btn" data-run="' + n + '">send</button></span></div>' +
        (ex.after ? '<p class="mono muted chain">after ' + esc(ex.after) + "</p>" : "") +
        (ex.keep ? '<p class="mono muted chain">keeps ' + esc(Object.keys(ex.keep).map(function (k) { return k + " = " + ex.keep[k]; }).join(", ")) + "</p>" : "") +
        (ex.body !== undefined ? '<pre class="exbody">' + esc(JSON.stringify(ex.body, null, 2)) + "</pre>" : "") +
        editor(path, op, ex) + '<div class="out"></div></div>';
    });
  }
  return h + "</div></section>";
}
// ----- editing a request before it goes out -----
function paramNames(path) { return (path.match(/\\{(\\w+)\\}/g) || []).map(function (s) { return s.slice(1, -1); }); }
function headerText(h) { return Object.keys(h || {}).map(function (k) { return k + ": " + h[k]; }).join("\\n"); }
function editor(path, op, ex) {
  var h = '<div class="edit" hidden>';
  paramNames(path).forEach(function (p) {
    var v = (ex.params || {})[p];
    h += '<label><span>:' + esc(p) + '</span><input data-param="' + esc(p) + '" value="' + esc(v === undefined ? "" : v) + '"></label>';
  });
  h += '<label><span>query</span><input data-query placeholder="a=1&amp;b=2" value="' + esc(urlFor("", { query: ex.query }).replace(/^\\?/, "")) + '"></label>';
  h += '<label><span>headers</span><textarea data-headers rows="2" placeholder="name: value">' + esc(headerText(ex.headers)) + "</textarea></label>";
  if (op.requestBody || ex.body !== undefined) {
    h += '<label><span>body</span><textarea data-body rows="7">' + esc(ex.body === undefined ? "" : JSON.stringify(ex.body, null, 2)) + "</textarea></label>";
  }
  return h + '<div class="edit-foot"><button class="btn" data-reset>reset to the example</button>' +
    '<span class="muted">an edited request is sent as it is and not held to the example</span></div></div>';
}
function hasHeader(h, name) { return Object.keys(h).some(function (k) { return k.toLowerCase() === name.toLowerCase(); }); }
// ----- examples that build on each other: run what comes first, keep what it answers -----
function substitute(v, kept) {
  if (typeof v === "string") {
    var whole = /^\\{(\\w+)\\}$/.exec(v);
    if (whole && whole[1] in kept) return kept[whole[1]];
    return v.replace(/\\{(\\w+)\\}/g, function (m, k) { return k in kept ? String(kept[k]) : m; });
  }
  if (Array.isArray(v)) return v.map(function (x) { return substitute(x, kept); });
  if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = substitute(v[k], kept); }); return o; }
  return v;
}
function stepFor(after) {
  var m = /^\\s*(\\w+)\\s+(\\S+)\\s*>\\s*(.+?)\\s*$/.exec(after || "");
  if (!m) return -1;
  var path = m[2].replace(/[:*](\\w+)/g, "{$1}");
  return ROUTES.findIndex(function (r) { return r.method.toUpperCase() === m[1].toUpperCase() && r.path === path && r.name === m[3]; });
}
function chainFor(i) {
  var chain = [], seen = [i];
  for (var step = i; ROUTES[step].ex.after; ) {
    var dep = stepFor(ROUTES[step].ex.after);
    if (dep < 0) throw new Error('after: "' + ROUTES[step].ex.after + '" is not an example on this page');
    if (seen.indexOf(dep) >= 0) throw new Error("after goes in a circle");
    seen.push(dep); chain.unshift(dep); step = dep;
  }
  return chain;
}
function pick(answer, path) {
  var parts = path.split("."), root = parts.shift();
  var v = root === "body" ? answer.body : root === "headers" ? answer.headers : root === "status" ? answer.status : undefined;
  parts.forEach(function (k) { v = v !== null && typeof v === "object" ? v[root === "headers" ? k.toLowerCase() : k] : undefined; });
  return v;
}
function answerOf(res, text) {
  var headers = {}, body = text;
  res.headers.forEach(function (v, k) { headers[k] = v; });
  try { body = JSON.parse(text); } catch (e) {}
  return { status: res.status, headers: headers, body: body };
}
function runChain(i) {
  var chain = chainFor(i), kept = {}, done = Promise.resolve();
  chain.forEach(function (s) {
    done = done.then(function () {
      var req = request(s, kept, true), init = { method: req.method, headers: req.headers };
      if (req.form) init.body = req.form;
      else if (req.body !== undefined) init.body = req.body;
      if (!sameOrigin(req.url)) throw new Error("not sent: " + req.url + " is not on this server");
      return fetch(req.url, init).then(function (res) {
        return res.text().then(function (text) {
          var a = answerOf(res, text), want = expected(ROUTES[s].op, ROUTES[s].ex), label = ROUTES[s].method.toUpperCase() + " " + ROUTES[s].path + " > " + ROUTES[s].name;
          if (want !== undefined ? a.status !== want : a.status >= 300) throw new Error('needs "' + label + '" first, which answered ' + a.status);
          Object.keys(ROUTES[s].ex.keep || {}).forEach(function (k) { kept[k] = pick(a, ROUTES[s].ex.keep[k]); });
        });
      });
    });
  });
  return done.then(function () { return kept; });
}
function request(i, kept, plain) {
  kept = kept || {};
  var r = ROUTES[i], ex = substitute(r.ex, kept), ed = plain ? null : document.getElementById(r.el).querySelector(".edit");
  var req = { method: r.method.toUpperCase(), url: urlFor(r.path, ex), headers: Object.assign({}, ex.headers || {}),
    body: ex.body === undefined ? undefined : JSON.stringify(ex.body), edited: false };
  if (ed && !ed.hidden) {
    var params = {};
    ed.querySelectorAll("[data-param]").forEach(function (inp) { params[inp.dataset.param] = substitute(inp.value, kept); });
    var q = substitute(ed.querySelector("[data-query]").value.trim().replace(/^\\?/, ""), kept);
    req.url = urlFor(r.path, { params: params }) + (q ? "?" + q : "");
    req.headers = {};
    ed.querySelector("[data-headers]").value.split("\\n").forEach(function (line) {
      var k = line.indexOf(":");
      if (k > 0) req.headers[line.slice(0, k).trim()] = substitute(line.slice(k + 1).trim(), kept);
    });
    var b = ed.querySelector("[data-body]");
    req.body = b && b.value.trim() ? b.value : undefined;
    if (req.body !== undefined) { try { req.body = JSON.stringify(substitute(JSON.parse(req.body), kept)); } catch (e) { req.body = substitute(req.body, kept); } }
    req.edited = true;
  }
  if (!req.edited && hasFiles(ex.body)) { req.form = toForm(ex.body); req.body = undefined; } // the browser writes the multipart boundary
  if (req.body !== undefined && !hasHeader(req.headers, "content-type")) req.headers["content-type"] = "application/json";
  var auth = authValue();
  if (auth && !hasHeader(req.headers, auth.name)) req.headers[auth.name] = auth.value;
  return req;
}
function toggleEdit(i, btn) {
  var el = document.getElementById(ROUTES[i].el), ed = el.querySelector(".edit"), pre = el.querySelector(".exbody");
  ed.hidden = !ed.hidden;
  if (pre) pre.hidden = !ed.hidden;
  btn.classList.toggle("on", !ed.hidden);
}
function resetEdit(i) {
  var r = ROUTES[i], ed = document.getElementById(r.el).querySelector(".edit"), tmp = document.createElement("div");
  tmp.innerHTML = editor(r.path, r.op, r.ex);
  tmp.firstChild.hidden = false;
  ed.replaceWith(tmp.firstChild);
}
// ----- auth: one header for every request, kept for this tab only, never in a URL -----
var store = {
  get: function (k) { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } },
  set: function (k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (e) {} }
};
function authValue() { var v = $("#auth").value.trim(); return v ? { name: $("#authName").value, value: v } : null; }
$("#auth").value = store.get("inkan:auth");
$("#authName").value = store.get("inkan:auth-header") || "authorization";
$("#auth").addEventListener("input", function () { store.set("inkan:auth", this.value.trim()); });
$("#authName").addEventListener("change", function () { store.set("inkan:auth-header", this.value); });
// ----- curl -----
function sq(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }
function curl(i) {
  var req = request(i), auth = authValue(), parts = ["curl"];
  if (req.method !== "GET") parts.push("-X " + req.method);
  parts.push(sq(location.origin + req.url));
  Object.keys(req.headers).forEach(function (k) { parts.push("-H " + sq(k + ": " + req.headers[k])); });
  if (req.body !== undefined) parts.push("--data-raw " + sq(req.body));
  var text = parts.join(" \\\\\\n  ");
  var shown = auth ? text.split(auth.value).join("•••") : text; // the token goes to the clipboard, not onto the screen
  var out = document.getElementById(ROUTES[i].el).querySelector(".out");
  var done = function (msg) { out.innerHTML = '<p class="mono muted" style="margin:8px 0 0">' + msg + "</p><pre>" + esc(shown) + "</pre>"; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { done("copied to the clipboard"); }, function () { done("copy it from here"); });
  } else done("copy it from here");
}
// ----- files in examples, and event streams that may never end -----
function isFile(v) { return v && typeof v === "object" && typeof v.$file === "string"; }
function hasFiles(body) {
  return !!body && typeof body === "object" && Object.keys(body).some(function (k) { var v = body[k]; return isFile(v) || (Array.isArray(v) && v.some(isFile)); });
}
function toForm(body) {
  var form = new FormData();
  Object.keys(body).forEach(function (k) {
    [].concat(body[k]).forEach(function (v) {
      if (isFile(v)) form.append(k, new Blob([v.content], { type: v.type }), v.$file);
      else if (v !== undefined) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    });
  });
  return form;
}
// An event stream is read until it has as many events as the example expects, then let go.
function readAll(res, events) {
  if (!/text\\/event-stream/.test(res.headers.get("content-type") || "")) return res.text();
  var reader = res.body.getReader(), dec = new TextDecoder(), text = "";
  var count = function () { return text.split("\\n\\n").filter(function (b) { return b.trim() && b.trim()[0] !== ":"; }).length; };
  return (function pump() {
    return reader.read().then(function (r) {
      if (!r.done) text += dec.decode(r.value, { stream: true });
      if (r.done || count() >= events) { reader.cancel(); return text; }
      return pump();
    });
  })();
}
function send(i) {
  var r = ROUTES[i], el = document.getElementById(r.el), out = el.querySelector(".out"), req, t0;
  out.innerHTML = '<p class="muted mono">' + (r.ex.after ? "running what comes first…" : "sending…") + "</p>";
  return Promise.resolve().then(function () { return r.ex.after ? runChain(i) : {}; }).then(function (kept) {
    req = request(i, kept);
    var init = { method: req.method, headers: req.headers };
    if (req.form) init.body = req.form;
    else if (req.body !== undefined) init.body = req.body;
    if (!sameOrigin(req.url)) throw new Error("not sent: " + req.url + " is not on this server");
    t0 = performance.now();
    return fetch(req.url, init);
  }).then(function (res) {
    var limit = Array.isArray(r.ex.expect) ? r.ex.expect.length : 5;
    return readAll(res, limit).then(function (text) {
      var ms = Math.round(performance.now() - t0), want = expected(r.op, r.ex);
      var ok = want === undefined ? res.status < 300 : res.status === want, pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      var verdict = req.edited ? '<span class="verdict muted">edited · not compared</span>'
        : '<span class="verdict ' + (ok ? "ok" : "no") + '">' + esc(ok ? "✓ as promised" : "✗ expected " + (want || "a 2xx")) + "</span>";
      out.innerHTML = '<p class="mono" style="margin:8px 0 0"><span class="status s' + esc(String(res.status)[0]) + '">' + esc(res.status) +
        '</span> <span class="muted">' + esc(ms) + "ms</span> " + verdict + "</p>" + (pretty ? "<pre>" + esc(pretty) + "</pre>" : "");
      if (!req.edited) { el.dataset.ok = ok ? "1" : "0"; stampCard(r.id); }
      return ok;
    });
  }).catch(function (e) {
    out.innerHTML = '<p class="verdict no">' + esc(e.message) + "</p>";
    if (!req || !req.edited) { el.dataset.ok = "0"; stampCard(r.id); }
  });
}
function stampCard(id) {
  var win = document.getElementById(id), all = win.querySelectorAll(".ex"), done = 0, good = 0;
  all.forEach(function (e) { if (e.dataset.ok) { done++; if (e.dataset.ok === "1") good++; } });
  win.classList.toggle("sealed", done === all.length && good === all.length);
  win.classList.toggle("broken", done > good);
}
function sendAll() {
  var chain = Promise.resolve();
  ROUTES.forEach(function (_, i) { chain = chain.then(function () { return send(i); }); });
}
// the token field offers the headers the document's security schemes name, and starts on the first one
function schemes(spec) {
  var all = (spec.components || {}).securitySchemes || {}, sel = $("#authName"), first = null;
  var have = Array.prototype.map.call(sel.options, function (o) { return o.value; });
  Object.keys(all).forEach(function (k) {
    var s = all[k], h = s.type === "http" ? "authorization" : s.type === "apiKey" && s.in === "header" ? String(s.name).toLowerCase() : null;
    if (!h) return;
    if (have.indexOf(h) < 0) { var o = document.createElement("option"); o.value = o.textContent = h; sel.appendChild(o); have.push(h); }
    if (!first) { first = h; if (s.scheme === "bearer") $("#auth").placeholder = "Bearer <token>, kept for this tab"; }
  });
  if (first && !store.get("inkan:auth-header")) sel.value = first;
}
function boot(spec) {
  COMP = (spec.components || {}).schemas || {};
  schemes(spec);
  document.title = (spec.info.title || "API") + " · docs";
  $("#title").textContent = spec.info.title || "API";
  $("#ver").textContent = spec.info.version || "";
  if (spec.info.description) $("#intro").textContent = spec.info.description;
  var groups = {}, cards = [], idx = 0;
  Object.keys(spec.paths).forEach(function (path) {
    Object.keys(spec.paths[path]).forEach(function (method) {
      var op = spec.paths[path][method], tag = (op.tags && op.tags[0]) || "routes";
      (groups[tag] = groups[tag] || []).push({ path: path, method: method, op: op, idx: idx });
      cards.push(card(path, method, op, idx++));
    });
  });
  var nav = "";
  Object.keys(groups).forEach(function (g) {
    nav += "<h4>" + esc(g) + "</h4>";
    groups[g].forEach(function (r) {
      nav += '<a href="#op-' + esc(r.op.operationId || r.idx) + '"><span class="m m-' + esc(r.method) + '">' + esc(r.method.toUpperCase()) +
        '</span><span class="p">' + esc(r.path) + "</span></a>";
    });
  });
  var names = Object.keys(COMP);
  if (names.length) {
    nav += "<h4>schemas</h4>" + names.map(function (n) { return '<a href="#schema-' + esc(n) + '"><span class="p">' + esc(n) + "</span></a>"; }).join("");
    cards.push(names.map(function (n) {
      return '<section class="win" id="schema-' + esc(n) + '"><header class="bar"><code>' + esc(n) + '</code></header><div class="pad">' + block(COMP[n]) + "</div></section>";
    }).join(""));
  }
  $("#nav").innerHTML = nav;
  $("#main").innerHTML = cards.join("") || '<p class="empty">No routes yet.</p>';
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-run],[data-edit],[data-curl],[data-reset]");
    if (!b) return;
    if (b.dataset.run !== undefined) send(Number(b.dataset.run));
    else if (b.dataset.edit !== undefined) toggleEdit(Number(b.dataset.edit), b);
    else if (b.dataset.curl !== undefined) curl(Number(b.dataset.curl));
    else { var exEl = b.closest(".ex"); resetEdit(ROUTES.findIndex(function (r) { return r.el === exEl.id; })); }
  });
  if (!ROUTES.length) $("#all").remove();
}
$("#all").addEventListener("click", sendAll);
if (CFG.spec) fetch(CFG.spec).then(function (r) { return r.json(); }).then(boot);
else $("#main").innerHTML = '<p class="empty">The OpenAPI document is switched off.</p>';
`;

export function docsPage(cfg: { title: string; specUrl: string; inspector?: string }) {
  const body = `
<header class="top"><span class="stamp">印</span><h1 id="title">${cfg.title.replace(/[<>&]/g, "")}</h1><span class="ver" id="ver"></span>
<nav><span class="auth"><select id="authName" title="The header the token goes into"><option value="authorization">authorization</option><option value="x-api-key">x-api-key</option></select><input id="auth" type="password" autocomplete="off" spellcheck="false" placeholder="token, kept for this tab" title="Sent with every request from this page. Kept in sessionStorage, never in a URL."></span>
<button class="btn seal" id="all" title="Sends every example. Examples that change data change it for real.">▶ send every example</button>
${cfg.specUrl ? `<a class="btn" href="${attr(cfg.specUrl)}">openapi.json</a>` : ""}
${cfg.inspector ? `<a class="btn" href="${attr(cfg.inspector)}">inspector</a>` : ""}</nav></header>
<div class="layout"><aside id="nav"></aside><main><p class="intro" id="intro">Every route below carries its contract. The examples are the same ones <code>inkan check</code> runs, so what you read here is what the server was tested to do.</p><div id="main"><p class="empty">loading…</p></div></main></div>`;
  return page(cfg.title + " · docs", { spec: cfg.specUrl }, body, docsScript);
}

