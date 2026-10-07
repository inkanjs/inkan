// The two pages inkan serves itself: the docs and the request inspector.
// Plain HTML, CSS and JS in one string each. No CDN, nothing to fetch but the
// app's own JSON, so they work offline and behind any firewall.

//it's a complete mess but it works lol, gonna clean it up later or maybe never, but let's see, shall we? ~ vxnsin

const css = /* css */ `
:root{--paper:#f6f0e4;--paper-2:#ede3cf;--card:#fbf7ef;--ink:#2b2420;--ink-2:#74675b;--line:#d8c9b0;
--seal:#c4381f;--seal-soft:#f4d8cc;--ok:#3d7a4b;--warn:#a26d12;--get:#3d7a4b;--post:#2e5e9c;--put:#a26d12;
--patch:#76509b;--delete:#c4381f;--mono:ui-monospace,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--paper:#1a1614;--paper-2:#231e1b;--card:#201b18;
--ink:#ece1cf;--ink-2:#a3958a;--line:#3b332d;--seal:#e65d3e;--seal-soft:#3a2119;--ok:#79c08a;--warn:#e0a84a;
--get:#79c08a;--post:#7fa8e6;--put:#e0a84a;--patch:#b897e0;--delete:#e65d3e;color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);
background-image:radial-gradient(var(--line) .6px,transparent .6px);background-size:18px 18px}
a{color:inherit}code,pre,.mono{font-family:var(--mono);font-size:13px}
.top{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line);
background:var(--paper);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.stamp{display:inline-grid;place-items:center;width:30px;height:30px;border:2px solid var(--seal);color:var(--seal);
border-radius:6px;font-weight:700;transform:rotate(-4deg);font-size:15px;line-height:1}
.top h1{font:600 16px var(--mono);margin:0}.top .ver{color:var(--ink-2);font:13px var(--mono)}
.top nav{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.btn{font:12px var(--mono);border:1px solid var(--ink);background:var(--card);color:var(--ink);padding:5px 10px;
border-radius:3px;cursor:pointer;text-decoration:none;box-shadow:2px 2px 0 var(--line)}
.btn:hover{background:var(--paper-2)}.btn:active{transform:translate(1px,1px);box-shadow:1px 1px 0 var(--line)}
.btn.seal{border-color:var(--seal);color:var(--seal)}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);gap:26px;max-width:1180px;margin:0 auto;padding:24px 22px 80px}
aside{position:sticky;top:76px;align-self:start;max-height:calc(100vh - 96px);overflow:auto}
aside h4{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-2);margin:18px 0 6px}
aside a{display:flex;gap:8px;align-items:baseline;padding:3px 6px;border-radius:3px;text-decoration:none;font:12.5px var(--mono)}
aside a:hover{background:var(--paper-2)}aside a .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m{font:700 10.5px var(--mono);min-width:44px;display:inline-block}
.m-get{color:var(--get)}.m-post{color:var(--post)}.m-put{color:var(--put)}.m-patch{color:var(--patch)}.m-delete{color:var(--delete)}
.intro{margin:0 0 22px;color:var(--ink-2);max-width:68ch}
.win{background:var(--card);border:1px solid var(--ink);border-radius:4px;box-shadow:4px 4px 0 var(--line);margin:0 0 26px;scroll-margin-top:84px}
.bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--ink);background:var(--paper-2);border-radius:4px 4px 0 0}
.bar code{font-size:14px;font-weight:600;word-break:break-all}.bar .dep{color:var(--warn);font:11px var(--mono)}
.bar .sealmark{margin-left:auto;opacity:0;transition:opacity .3s,transform .3s;transform:scale(1.6) rotate(-12deg)}
.win.sealed .sealmark{opacity:1;transform:scale(1) rotate(-4deg)}
.win.broken .bar{background:var(--seal-soft)}
.pad{padding:14px 16px}.sum{margin:0 0 4px;font-weight:600}.desc{margin:0 0 8px;color:var(--ink-2)}
h5{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-2);margin:16px 0 6px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
td,th{text-align:left;padding:5px 8px;border-bottom:1px dashed var(--line);vertical-align:top}
th{font:600 11px var(--mono);color:var(--ink-2)}
pre.type{margin:0;padding:10px 12px;background:var(--paper);border:1px solid var(--line);border-radius:3px;overflow:auto;white-space:pre}
.k{color:var(--ink)}.ty{color:var(--post)}.lit{color:var(--ok)}.cm{color:var(--ink-2)}.ty-ref{color:var(--patch);font-weight:600}
.status{font:600 12px var(--mono);display:inline-block;min-width:34px}
.s2{color:var(--ok)}.s3{color:var(--post)}.s4{color:var(--warn)}.s5{color:var(--seal)}
.ex{border:1px dashed var(--line);border-radius:3px;margin:8px 0;padding:8px 10px}
.ex-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ex-head .name{font-weight:600}
.ex-head .req{color:var(--ink-2);font:12px var(--mono);word-break:break-all}.ex-head .acts{margin-left:auto;display:flex;gap:6px}
[hidden]{display:none!important}.btn.on{background:var(--paper-2);border-color:var(--seal);color:var(--seal)}
.edit{display:grid;gap:8px;margin-top:10px}
.edit label{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;align-items:start;font:12px var(--mono)}
.edit label span{color:var(--ink-2);padding-top:6px}
.edit input,.edit textarea,.auth input,.auth select{font:12.5px var(--mono);padding:5px 8px;border:1px solid var(--line);border-radius:3px;background:var(--paper);color:var(--ink);width:100%}
.edit textarea{resize:vertical}.edit-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px}
.auth{display:flex;gap:4px}.auth input{width:190px}.auth select{width:auto}
.ex pre{margin:8px 0 0;max-height:280px;overflow:auto;padding:8px 10px;background:var(--paper);border-radius:3px}
.verdict{font:600 12px var(--mono)}.verdict.ok{color:var(--ok)}.verdict.no{color:var(--seal)}
.muted{color:var(--ink-2)}.empty{padding:40px;text-align:center;color:var(--ink-2)}
input.filter{font:13px var(--mono);padding:6px 10px;border:1px solid var(--ink);border-radius:3px;background:var(--card);color:var(--ink);width:260px;max-width:100%}
.log td{font:12.5px var(--mono);white-space:nowrap}.log tr.row{cursor:pointer}.log tr.row:hover td{background:var(--paper-2)}
.log td.path{white-space:normal;word-break:break-all}.note{color:var(--seal)}
.log tr.detail td{white-space:normal;background:var(--paper)}.log tr.detail pre{white-space:pre-wrap;word-break:break-all;margin:4px 0 10px}
.acts-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}
.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
@media (max-width:820px){.pair{grid-template-columns:minmax(0,1fr)}}
@media (max-width:820px){.layout{grid-template-columns:minmax(0,1fr);padding:16px}aside{position:static;max-height:none}.top{padding:12px 16px}.top nav{margin-left:0}}
`;

const esc = /* js */ `
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
`;

const page = (title: string, cfg: unknown, body: string, script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<>&"]/g, "")}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="3" width="26" height="26" rx="6" fill="#c4381f"/><rect x="7" y="7" width="18" height="18" rx="3" fill="none" stroke="#fbf7ef" stroke-width="2"/><path d="M12 16.5l3 3 5.5-6.5" fill="none" stroke="#fbf7ef" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}">
<style>${css}</style></head><body>${body}
<script>var CFG=${JSON.stringify(cfg).replace(/</g, "\\u003c")};${esc}${script}</script></body></html>`;

// ---------- docs ----------

const docsScript = /* js */ `
var COMP = {};
var $ = function (s) { return document.querySelector(s); };
function lit(s) { return '<span class="lit">' + esc(s) + "</span>"; }
function ty(s) { return '<span class="ty">' + esc(s) + "</span>"; }
function note(s) {
  var n = [];
  if (s.format) n.push(s.format);
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
  if (s.anyOf) return s.anyOf.map(function (x) { return render(x, pad); }).join(" | ");
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
    var v = (ex.params || {})[n]; return v === undefined ? "{" + n + "}" : encodeURIComponent(String(v));
  });
  var q = new URLSearchParams();
  Object.keys(ex.query || {}).forEach(function (k) { [].concat(ex.query[k]).forEach(function (v) { q.append(k, String(v)); }); });
  var qs = q.toString();
  return u + (qs ? "?" + qs : "");
}
var ROUTES = [];
function card(path, method, op, idx) {
  var id = "op-" + (op.operationId || idx);
  var h = '<section class="win" id="' + esc(id) + '"><header class="bar"><span class="m m-' + method + '">' + method.toUpperCase() +
    "</span><code>" + esc(path) + "</code>" + (op.deprecated ? '<span class="dep">deprecated</span>' : "") +
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
    h += '<tr><td style="width:60px"><span class="status s' + s[0] + '">' + esc(s) + "</span></td><td>" + esc(r.description || "") + gap +
      (sc ? '<pre class="type" style="margin-top:6px">' + render(sc, "") + "</pre>" : "") + "</td></tr>";
  });
  h += "</table>";
  if (exs.length) {
    h += "<h5>examples · each one is also a test</h5>";
    exs.forEach(function (ex, i) {
      var want = expected(op, ex), n = ROUTES.length;
      ROUTES.push({ id: id, path: path, method: method, op: op, ex: ex, el: id + "-ex" + i });
      h += '<div class="ex" id="' + id + "-ex" + i + '"><div class="ex-head"><span class="name">' + esc(ex.name || "example " + (i + 1)) +
        '</span><span class="req">' + method.toUpperCase() + " " + esc(urlFor(path, ex)) + (want ? " → " + want : "") +
        '</span><span class="acts"><button class="btn" data-edit="' + n + '">edit</button><button class="btn" data-curl="' + n +
        '">curl</button><button class="btn" data-run="' + n + '">send</button></span></div>' +
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
function request(i) {
  var r = ROUTES[i], ex = r.ex, ed = document.getElementById(r.el).querySelector(".edit");
  var req = { method: r.method.toUpperCase(), url: urlFor(r.path, ex), headers: Object.assign({}, ex.headers || {}),
    body: ex.body === undefined ? undefined : JSON.stringify(ex.body), edited: false };
  if (ed && !ed.hidden) {
    var params = {};
    ed.querySelectorAll("[data-param]").forEach(function (inp) { params[inp.dataset.param] = inp.value; });
    var q = ed.querySelector("[data-query]").value.trim().replace(/^\\?/, "");
    req.url = urlFor(r.path, { params: params }) + (q ? "?" + q : "");
    req.headers = {};
    ed.querySelector("[data-headers]").value.split("\\n").forEach(function (line) {
      var k = line.indexOf(":");
      if (k > 0) req.headers[line.slice(0, k).trim()] = line.slice(k + 1).trim();
    });
    var b = ed.querySelector("[data-body]");
    req.body = b && b.value.trim() ? b.value : undefined;
    req.edited = true;
  }
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
function send(i) {
  var r = ROUTES[i], el = document.getElementById(r.el), out = el.querySelector(".out"), req = request(i);
  var init = { method: req.method, headers: req.headers };
  if (req.body !== undefined) init.body = req.body;
  var t0 = performance.now();
  out.innerHTML = '<p class="muted mono">sending…</p>';
  return fetch(req.url, init).then(function (res) {
    return res.text().then(function (text) {
      var ms = Math.round(performance.now() - t0), want = expected(r.op, r.ex);
      var ok = want === undefined ? res.status < 300 : res.status === want, pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      var verdict = req.edited ? '<span class="verdict muted">edited · not compared</span>'
        : '<span class="verdict ' + (ok ? "ok" : "no") + '">' + (ok ? "✓ as promised" : "✗ expected " + (want || "a 2xx")) + "</span>";
      out.innerHTML = '<p class="mono" style="margin:8px 0 0"><span class="status s' + String(res.status)[0] + '">' + res.status +
        '</span> <span class="muted">' + ms + "ms</span> " + verdict + "</p>" + (pretty ? "<pre>" + esc(pretty) + "</pre>" : "");
      if (!req.edited) { el.dataset.ok = ok ? "1" : "0"; stampCard(r.id); }
      return ok;
    });
  }).catch(function (e) {
    out.innerHTML = '<p class="verdict no">' + esc(e.message) + "</p>";
    if (!req.edited) { el.dataset.ok = "0"; stampCard(r.id); }
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
function boot(spec) {
  COMP = (spec.components || {}).schemas || {};
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
      nav += '<a href="#op-' + esc(r.op.operationId || r.idx) + '"><span class="m m-' + r.method + '">' + r.method.toUpperCase() +
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
${cfg.specUrl ? `<a class="btn" href="${cfg.specUrl}">openapi.json</a>` : ""}
${cfg.inspector ? `<a class="btn" href="${cfg.inspector}">inspector</a>` : ""}</nav></header>
<div class="layout"><aside id="nav"></aside><main><p class="intro" id="intro">Every route below carries its contract. The examples are the same ones <code>inkan check</code> runs, so what you read here is what the server was tested to do.</p><div id="main"><p class="empty">loading…</p></div></main></div>`;
  return page(cfg.title + " · docs", { spec: cfg.specUrl }, body, docsScript);
}

// ---------- inspector ----------

const inspectorScript = /* js */ `
var since = 0, paused = false, rows = [], open = {}, results = {};
var $ = function (s) { return document.querySelector(s); };
function line(e) {
  var t = e.at.slice(11, 19);
  return '<tr class="row" data-id="' + e.id + '"><td class="muted">' + t + '</td><td><span class="m m-' + e.method.toLowerCase() + '">' + esc(e.method) +
    '</span></td><td class="path">' + esc(e.path) + '</td><td><span class="status s' + String(e.status)[0] + '">' + e.status +
    '</span></td><td class="muted">' + e.ms + "ms</td><td class=muted>" + esc(e.route || "—") + '</td><td class="note">' + esc(e.notes.join("; ")) + "</td></tr>" +
    (open[e.id] ? '<tr class="detail"><td colspan="7">' + detail(e) + "</td></tr>" : "");
}
function pretty(s) { if (s === undefined || s === "") return "—"; try { return JSON.stringify(JSON.parse(s), null, 2); } catch (x) { return s; } }
// what may differ between two runs of the same request without the answer having changed
function comparable(s) { try { var v = JSON.parse(s); if (v && typeof v === "object") delete v.requestId; return JSON.stringify(v); } catch (x) { return s || ""; } }
function statusTag(s) { return '<span class="status s' + String(s)[0] + '">' + s + "</span>"; }
var FORBIDDEN = /^(host|connection|content-length|accept-encoding|accept-charset|cookie|date|dnt|expect|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|x-request-id|x-inkan-replay)$|^(sec-|proxy-)/;
function find(id) { return rows.filter(function (r) { return String(r.id) === String(id); })[0]; }
function replay(id) {
  var e = find(id), h = {}, dropped = false;
  Object.keys(e.request.headers).forEach(function (k) {
    var v = e.request.headers[k];
    if (v === "•••") dropped = true;
    else if (!FORBIDDEN.test(k)) h[k] = v;
  });
  h["x-inkan-replay"] = String(e.id);
  var init = { method: e.method, headers: h };
  if (e.request.body !== undefined && e.method !== "GET" && e.method !== "HEAD") init.body = e.request.body;
  var t0 = performance.now();
  results[id] = '<p class="muted mono">replaying…</p>';
  draw();
  fetch(e.path, init).then(function (res) {
    return res.text().then(function (text) {
      var ms = Math.round(performance.now() - t0);
      var same = res.status === e.status && comparable(text) === comparable(e.response.body);
      results[id] = '<div class="pair"><div><h5>then · ' + statusTag(e.status) + '</h5><pre>' + esc(pretty(e.response.body)) +
        '</pre></div><div><h5>now · ' + statusTag(res.status) + " · " + ms + 'ms</h5><pre>' + esc(pretty(text)) + "</pre></div></div>" +
        '<p class="verdict ' + (same ? "ok" : "no") + '">' + (same ? "✓ the same answer" : "✗ the answer changed") + "</p>" +
        (dropped ? '<p class="muted">Secret headers were not sent again, so a route behind auth may answer differently.</p>' : "");
      draw();
    });
  }).catch(function (err) { results[id] = '<p class="verdict no">' + esc(err.message) + "</p>"; draw(); });
}
function copyExample(id) {
  var e = find(id), say = function (msg) {
    results[id] = '<p class="muted mono">' + msg + " · paste it into <b>" + esc(e.method + " " + e.route) + "</b> → examples</p><pre>" + esc(e.example) + "</pre>";
    draw();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(e.example).then(function () { say("copied"); }, function () { say("copy it from here"); });
  else say("copy it from here");
}
function detail(e) {
  var acts = '<div class="acts-row">' +
    (e.request.clipped ? '<span class="muted">the body was too long to keep, so this one cannot be replayed</span>'
      : '<button class="btn" data-replay="' + e.id + '">replay</button>') +
    (e.example ? '<button class="btn" data-example="' + e.id + '">copy as example</button>' : '<span class="muted">no route answered, so there is no example to make</span>') +
    '</div><div class="replay">' + (results[e.id] || "") + "</div>";
  return acts + (e.requestId ? '<h5>request id</h5><pre>' + esc(e.requestId) + "</pre>" : "") + '<h5>request headers</h5><pre>' + esc(Object.keys(e.request.headers).map(function (k) { return k + ": " + e.request.headers[k]; }).join("\\n")) +
    '</pre><h5>request body</h5><pre>' + esc(pretty(e.request.body)) + '</pre><h5>response body</h5><pre>' + esc(pretty(e.response.body)) + "</pre>";
}
function draw() {
  var f = $("#filter").value.toLowerCase();
  var shown = rows.filter(function (e) { return !f || (e.method + " " + e.path + " " + e.status + " " + e.notes.join(" ")).toLowerCase().indexOf(f) >= 0; });
  $("#body").innerHTML = shown.length ? shown.map(line).join("") : '<tr><td colspan="7" class="empty">Nothing yet. Send a request and it shows up here.</td></tr>';
  $("#count").textContent = rows.length + " request" + (rows.length === 1 ? "" : "s");
}
function poll() {
  if (paused) return;
  fetch(CFG.base + "/log.json?since=" + since).then(function (r) { return r.json(); }).then(function (list) {
    if (!list.length) return;
    since = list[list.length - 1].id;
    rows = list.reverse().concat(rows).slice(0, 200);
    draw();
  }).catch(function () {});
}
$("#body").addEventListener("click", function (e) {
  var b = e.target.closest("[data-replay],[data-example]");
  if (b) { if (b.dataset.replay) replay(b.dataset.replay); else copyExample(b.dataset.example); return; }
  var tr = e.target.closest("tr.row"); if (!tr) return; var id = tr.dataset.id; open[id] = !open[id]; draw();
});
$("#filter").addEventListener("input", draw);
$("#pause").addEventListener("click", function () { paused = !paused; this.textContent = paused ? "▶ resume" : "❚❚ pause"; });
$("#clear").addEventListener("click", function () { rows = []; open = {}; draw(); });
draw(); poll(); setInterval(poll, 1000);
`;

export function inspectorPage(cfg: { title: string; base: string; docs: string }) {
  const body = `
<header class="top"><span class="stamp">印</span><h1>${cfg.title.replace(/[<>&]/g, "")}</h1><span class="ver">inspector · only on this machine</span>
<nav><input class="filter" id="filter" placeholder="filter: path, status, note…">
<button class="btn" id="pause">❚❚ pause</button><button class="btn" id="clear">clear</button>
${cfg.docs ? `<a class="btn" href="${cfg.docs}">docs</a>` : ""}</nav></header>
<div style="max-width:1180px;margin:0 auto;padding:22px">
<p class="intro">The last 200 requests, newest first. A red note means a request or an answer broke the contract. Secret headers show as •••. <span id="count" class="mono"></span></p>
<section class="win"><div class="pad" style="overflow:auto"><table class="log"><thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>took</th><th>route</th><th>notes</th></tr></thead><tbody id="body"></tbody></table></div></section></div>`;
  return page(cfg.title + " · inspector", { base: cfg.base }, body, inspectorScript);
}
