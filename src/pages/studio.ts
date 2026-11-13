// The studio: the app while it runs. Requests live, with replay and copy as example; every route
// with its numbers; a map of the paths; the MCP tools, to call by hand; the jobs, to cancel.

import { attr, page } from "./shared.ts";

const studioCss = /* css */ `
.tabs{display:flex;gap:2px;padding:0 22px;border-bottom:1px solid var(--line);background:var(--paper);position:sticky;top:59px;z-index:4;overflow-x:auto}
.tab{font:600 12px var(--mono);padding:10px 14px;border:0;background:none;color:var(--ink-2);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tab:hover{color:var(--ink)}.tab.on{color:var(--seal);border-bottom-color:var(--seal)}
.tab .n{font-weight:400;opacity:.7;margin-left:4px}
.wrap{max-width:1180px;margin:0 auto;padding:22px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:0 0 22px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px 10px;min-width:0}
.kpi b{display:block;font:700 22px var(--mono);line-height:1.25;font-variant-numeric:tabular-nums}.kpi span{font:10px var(--mono);color:var(--ink-2);text-transform:uppercase;letter-spacing:.08em}
.kpi svg{display:block;width:100%;height:30px;margin-top:6px;overflow:visible}
.pane{animation:rise .35s cubic-bezier(.22,1,.36,1)}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes flash{from{background:var(--seal-soft)}to{background:transparent}}
.log tr.fresh td{animation:flash 1.2s ease-out}
.pill{font:600 11px var(--mono);padding:1px 7px;border-radius:99px;border:1px solid currentColor;display:inline-block;white-space:nowrap}
.st-running{color:var(--post)}.st-queued{color:var(--warn)}.st-done{color:var(--ok)}.st-failed,.st-canceled{color:var(--seal)}
.sortable th{cursor:pointer}.sortable th:hover{color:var(--ink)}
.bar-meter{height:6px;background:var(--paper-2);border-radius:3px;overflow:hidden;margin-top:4px}
.bar-meter i{display:block;height:100%;background:var(--seal);transition:width .4s}
.tree{font:13px var(--mono);margin:0;padding:0;list-style:none}
.tree ul{list-style:none;margin:0 0 0 18px;padding:0 0 0 12px;border-left:1px dashed var(--line)}
.tree li{margin:2px 0;opacity:0;animation:rise .4s cubic-bezier(.22,1,.36,1) forwards}
.seg{display:inline-flex;gap:8px;align-items:center;padding:2px 8px;border-radius:3px}
.seg:hover{background:var(--paper-2)}.seg .name{font-weight:600}
.badge{font:10.5px var(--mono);color:var(--ink-2);border:1px solid var(--line);border-radius:3px;padding:0 5px}
.badge.tool{color:var(--patch);border-color:var(--patch)}.badge.auth{color:var(--warn);border-color:var(--warn)}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--ink);border-radius:4px;box-shadow:4px 4px 0 var(--line);padding:14px 16px;min-width:0}
.card h3{font:600 14px var(--mono);margin:0 0 4px;word-break:break-all}.card pre{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin:6px 0;padding:8px;background:var(--paper);border-radius:3px}
.card textarea{width:100%;font:12.5px var(--mono);padding:6px 8px;border:1px solid var(--line);border-radius:3px;background:var(--paper);color:var(--ink);resize:vertical}
.off{border:1px dashed var(--seal);color:var(--seal);border-radius:4px;padding:10px 12px;margin:0 0 16px;font:12.5px var(--mono)}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);margin-right:6px;animation:pulse 1.6s infinite}
.paused .live-dot{background:var(--ink-2);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 60%,transparent)}100%{box-shadow:0 0 0 8px transparent}}
@media (max-width:820px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2{grid-template-columns:minmax(0,1fr)}.tabs{top:0;position:static}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.tree li{opacity:1}}
`;

const studioScript = /* js */ `(function () {
var $ = function (s) { return document.querySelector(s); };
var since = 0, paused = false, rows = [], fresh = {}, open = {}, results = {}, S = null, tab = "live", sortBy = "p95", sortDir = -1, trend = [];
try { tab = sessionStorage.getItem("inkan:studio-tab") || "live"; } catch (e) {}
var TABS = ["live", "routes", "map", "mcp", "jobs"];
function mtag(m) { return '<span class="m m-' + esc(m.toLowerCase()) + '">' + esc(m) + "</span>"; }
function statusTag(s) { return '<span class="status s' + esc(String(s)[0]) + '">' + esc(s) + "</span>"; }
function pretty(s) { if (s === undefined || s === "") return "—"; try { return JSON.stringify(JSON.parse(s), null, 2); } catch (x) { return s; } }
function comparable(s) { try { var v = JSON.parse(s); if (v && typeof v === "object") delete v.requestId; return JSON.stringify(v); } catch (x) { return s || ""; } }
function ago(ms) { var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; }
function bytes(n) { return n > 1048576 ? (n / 1048576).toFixed(n < 104857600 ? 1 : 0) + " MB" : (n / 1024).toFixed(0) + " kB"; }
function spark(values, color) {
  values = values.filter(function (v) { return v != null; });
  if (values.length < 2) return '<svg viewBox="0 0 100 28"></svg>';
  var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values), step = 100 / (values.length - 1);
  var p = values.map(function (v, i) { return [i * step, hi === lo ? (hi ? 14 : 25) : 25 - ((v - lo) / (hi - lo)) * 21]; });
  var f = function (n) { return n.toFixed(1); }, d = "M0," + f(p[0][1]);
  for (var i = 1; i < p.length; i++) { // Catmull-Rom through the points, as cubic Béziers
    var a = p[i - 2] || p[i - 1], b = p[i - 1], c = p[i], n = p[i + 1] || c;
    d += " C" + f(b[0] + (c[0] - a[0]) / 6) + "," + f(b[1] + (c[1] - a[1]) / 6) + " " + f(c[0] - (n[0] - b[0]) / 6) + "," + f(c[1] - (n[1] - b[1]) / 6) + " " + f(c[0]) + "," + f(c[1]);
  }
  return '<svg viewBox="0 0 100 28" preserveAspectRatio="none"><path d="' + d + ' L100,28 L0,28Z" fill="' + color + '" opacity=".12"/><path d="' + d +
    '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
}
function sample(at) {
  var minute = rows.filter(function (e) { var t = Date.parse(e.at); return t <= at && at - t < 60000; }), t = minute.map(function (e) { return e.ms; }).sort(function (a, b) { return a - b; });
  return { n: minute.length, e: minute.filter(function (e) { return e.status >= 500 || e.notes.length; }).length, p: t.length ? t[Math.floor(t.length * 0.95)] || t[t.length - 1] : 0 };
}
// ----- live -----
var FORBIDDEN = /^(host|connection|content-length|accept-encoding|accept-charset|cookie|date|dnt|expect|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|x-request-id|x-inkan-replay)$|^(sec-|proxy-)/;
function find(id) { return rows.filter(function (r) { return String(r.id) === String(id); })[0]; }
function replay(id) {
  var e = find(id), h = {}, dropped = false;
  if (!sameOrigin(e.path)) { results[id] = '<p class="verdict no">not replayed: this path would leave the server</p>'; draw(); return; }
  Object.keys(e.request.headers).forEach(function (k) { var v = e.request.headers[k]; if (v === "•••") dropped = true; else if (!FORBIDDEN.test(k)) h[k] = v; });
  h["x-inkan-replay"] = String(e.id);
  var init = { method: e.method, headers: h };
  if (e.request.body !== undefined && e.method !== "GET" && e.method !== "HEAD") init.body = e.request.body;
  var t0 = performance.now();
  results[id] = '<p class="muted mono">replaying…</p>'; draw();
  fetch(e.path, init).then(function (res) {
    return res.text().then(function (text) {
      var ms = Math.round(performance.now() - t0), same = res.status === e.status && comparable(text) === comparable(e.response.body);
      results[id] = '<div class="pair"><div><h5>then · ' + statusTag(e.status) + "</h5><pre>" + esc(pretty(e.response.body)) + '</pre></div><div><h5>now · ' + statusTag(res.status) + " · " + esc(ms) +
        "ms</h5><pre>" + esc(pretty(text)) + '</pre></div></div><p class="verdict ' + (same ? "ok" : "no") + '">' + (same ? "✓ the same answer" : "✗ the answer changed") + "</p>" +
        (dropped ? '<p class="muted">Secret headers were not sent again, so a route behind auth may answer differently.</p>' : "");
      draw();
    });
  }).catch(function (err) { results[id] = '<p class="verdict no">' + esc(err.message) + "</p>"; draw(); });
}
function copyExample(id) {
  var e = find(id), say = function (msg) { results[id] = '<p class="muted mono">' + msg + " · paste it into <b>" + esc(e.method + " " + e.route) + "</b> → examples</p><pre>" + esc(e.example) + "</pre>"; draw(); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(e.example).then(function () { say("copied"); }, function () { say("copy it from here"); });
  else say("copy it from here");
}
function detail(e) {
  return '<div class="acts-row">' + (e.request.clipped ? '<span class="muted">the body was too long to keep, so this one cannot be replayed</span>' : '<button class="btn" data-replay="' + esc(e.id) + '">replay</button>') +
    (e.example ? '<button class="btn" data-example="' + esc(e.id) + '">copy as example</button>' : '<span class="muted">no route answered, so there is no example to make</span>') +
    '</div><div class="replay">' + (results[e.id] || "") + "</div>" + (e.requestId ? "<h5>request id</h5><pre>" + esc(e.requestId) + "</pre>" : "") +
    "<h5>request headers</h5><pre>" + esc(Object.keys(e.request.headers).map(function (k) { return k + ": " + e.request.headers[k]; }).join("\\n")) +
    "</pre><h5>request body</h5><pre>" + esc(pretty(e.request.body)) + "</pre><h5>response body</h5><pre>" + esc(pretty(e.response.body)) + "</pre>";
}
function line(e) {
  return '<tr class="row' + (fresh[e.id] ? " fresh" : "") + '" data-id="' + esc(e.id) + '"><td class="muted">' + esc(e.at.slice(11, 19)) + "</td><td>" + mtag(e.method) + '</td><td class="path">' + esc(e.path) +
    "</td><td>" + statusTag(e.status) + '</td><td class="muted">' + esc(e.ms) + 'ms</td><td class="muted">' + esc(e.route || "—") + '</td><td class="note">' + esc(e.notes.join("; ")) + "</td></tr>" +
    (open[e.id] ? '<tr class="detail"><td colspan="7">' + detail(e) + "</td></tr>" : "");
}
function livePane() {
  var f = ($("#filter") || { value: "" }).value.toLowerCase();
  var shown = rows.filter(function (e) { return !f || (e.method + " " + e.path + " " + e.status + " " + e.notes.join(" ")).toLowerCase().indexOf(f) >= 0; });
  return '<div class="acts-row"><input class="filter" id="filter" placeholder="filter: path, status, note…" value="' + esc(f) + '"><button class="btn" id="pause">' + (paused ? "▶ resume" : "❚❚ pause") +
    '</button><button class="btn" id="clear">clear</button><span class="muted mono">' + rows.length + " of the last 200 · a red note means a contract was broken · secret headers show as •••</span></div>" +
    '<section class="win"><div class="pad" style="overflow:auto"><table class="log"><thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>took</th><th>route</th><th>notes</th></tr></thead><tbody>' +
    (shown.length ? shown.map(line).join("") : '<tr><td colspan="7" class="empty">Nothing yet. Send a request and it shows up here.</td></tr>') + "</tbody></table></div></section>";
}
// ----- routes -----
function routesPane() {
  var list = S.routes.slice(), key = function (r) { var s = r.stats || {}; return sortBy === "path" ? r.path : sortBy === "n" ? s.n || 0 : sortBy === "errors" ? s.errors || 0 : s[sortBy] === undefined ? -1 : s[sortBy]; };
  list.sort(function (a, b) { var x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
  var th = function (k, label) { return '<th data-sort="' + k + '">' + label + (sortBy === k ? (sortDir < 0 ? " ↓" : " ↑") : "") + "</th>"; };
  return '<p class="intro">Every route, with what the studio has seen of it since it opened: calls, answers that broke the contract or failed, and the median and 95th percentile time. Sort by a column.</p>' +
    '<section class="win"><div class="pad" style="overflow:auto"><table class="log sortable"><thead><tr><th>method</th>' + th("path", "path") + "<th>what</th>" + th("n", "calls") + th("errors", "broken") + th("p50", "p50") + th("p95", "p95") + "<th>last</th></tr></thead><tbody>" +
    list.map(function (r) {
      var s = r.stats;
      return "<tr><td>" + mtag(r.method) + '</td><td class="path">' + esc(r.path) + "</td><td>" + esc(r.summary || "") + " " + (r.tool ? '<span class="badge tool">tool ' + esc(r.tool) + "</span> " : "") + (r.secured ? '<span class="badge auth">auth</span> ' : "") +
        (r.examples ? '<span class="badge">' + r.examples + " ex</span>" : '<span class="badge" style="color:var(--warn)">no examples</span>') + (r.deprecated ? ' <span class="badge">deprecated</span>' : "") +
        "</td><td>" + (s ? s.n : "—") + '</td><td class="' + (s && s.errors ? "note" : "muted") + '">' + (s ? s.errors : "—") + "</td><td>" + (s ? s.p50 + "ms" : "—") + "</td><td>" + (s ? s.p95 + "ms" : "—") + "</td><td>" + (s ? statusTag(s.last) : "—") + "</td></tr>";
    }).join("") + "</tbody></table></div></section>";
}
// ----- map -----
function mapPane() {
  var root = { kids: {}, routes: [] };
  S.routes.forEach(function (r) {
    var node = root;
    r.path.split("/").filter(Boolean).forEach(function (seg) { node = node.kids[seg] = node.kids[seg] || { kids: {}, routes: [] }; });
    node.routes.push(r);
  });
  var n = 0;
  function render(name, node) {
    var delay = (n++ * 0.03).toFixed(2);
    var badges = node.routes.map(function (r) { return mtag(r.method) + (r.tool ? '<span class="badge tool">tool</span>' : "") + (r.secured ? '<span class="badge auth">auth</span>' : ""); }).join(" ");
    var kids = Object.keys(node.kids).sort().map(function (k) { return render(k, node.kids[k]); }).join("");
    return '<li style="animation-delay:' + delay + 's"><span class="seg"><span class="name' + (name.charAt(0) === ":" || name.charAt(0) === "*" ? " m-patch" : "") + '">' + esc(name) + "</span>" + badges + "</span>" + (kids ? "<ul>" + kids + "</ul>" : "") + "</li>";
  }
  return '<p class="intro">The app as a tree of its paths. A segment that starts with : or * is a parameter; the badges say which methods answer there, which are MCP tools and which ask for credentials.</p>' +
    '<section class="win"><div class="pad"><ul class="tree">' + render("/", root) + "</ul></div></section>";
}
// ----- mcp -----
function mcpPane() {
  var m = S.mcp, calls = rows.filter(function (e) { return e.notes.join(" ").indexOf("MCP tool") >= 0; });
  var head = m.error ? '<div class="off">The tools cannot be made: ' + esc(m.error) + "</div>" : m.path ? '<p class="intro">Served on <code>' + esc(m.path) + "</code>. Call a tool here as a client would: the call is a request to its route, with this page's cookies.</p>"
    : '<div class="off">MCP is off. This is what <code>inkan({ mcp: true })</code> would serve.</div>';
  return head + '<div class="grid2">' + m.tools.map(function (t, i) {
    return '<div class="card"><h3>' + esc(t.name) + '</h3><div class="muted mono">' + esc(t.route) + "</div><pre>" + esc(t.description) + "</pre>" +
      (m.path ? '<textarea rows="3" id="args' + i + '">{}</textarea><div class="acts-row"><button class="btn seal" data-call="' + i + '">call</button><details><summary class="muted mono">input schema</summary><pre>' +
        esc(JSON.stringify(t.inputSchema, null, 2)) + '</pre></details></div><div id="res' + i + '">' + (results["tool" + i] || "") + "</div>" : "") + "</div>";
  }).join("") + "</div>" +
    (m.skipped.length ? "<h5>not tools</h5><table class=log>" + m.skipped.map(function (s) { return "<tr><td>" + mtag(s.method) + "</td><td class=path>" + esc(s.path) + "</td><td class=muted>" + esc(s.reason) + "</td></tr>"; }).join("") + "</table>" : "") +
    "<h5>recent tool calls</h5>" + (calls.length ? "<table class=log>" + calls.slice(0, 20).map(function (e) { return "<tr><td class=muted>" + esc(e.at.slice(11, 19)) + "</td><td>" + mtag(e.method) + "</td><td class=path>" + esc(e.path) + "</td><td>" + statusTag(e.status) + "</td><td class=muted>" + esc(e.ms) + "ms</td></tr>"; }).join("") + "</table>" : '<p class="muted">None yet.</p>');
}
function callTool(i) {
  var t = S.mcp.tools[i], args;
  try { args = JSON.parse($("#args" + i).value || "{}"); } catch (e) { results["tool" + i] = '<p class="verdict no">the arguments are not JSON</p>'; draw(); return; }
  results["tool" + i] = '<p class="muted mono">calling…</p>'; draw();
  fetch(S.mcp.path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: t.name, arguments: args } }) })
    .then(function (r) { return r.json(); }).then(function (msg) {
      var r = msg.result, err = msg.error;
      results["tool" + i] = err ? '<p class="verdict no">' + esc(err.message) + "</p>" : '<p class="verdict ' + (r.isError ? "no" : "ok") + '">' + (r.isError ? "✗ tool error" : "✓ result") + " · " + statusTag(r._meta && r._meta["dev.inkan/status"]) +
        "</p><pre>" + esc(r.structuredContent ? JSON.stringify(r.structuredContent, null, 2) : pretty(r.content && r.content[0] && r.content[0].text)) + "</pre>";
      draw();
    }).catch(function (e) { results["tool" + i] = '<p class="verdict no">' + esc(e.message) + "</p>"; draw(); });
}
// ----- jobs -----
function jobRow(k, j, live) {
  return "<tr><td class=mono>" + esc(j.id.slice(0, 10)) + '</td><td><span class="pill st-' + esc(j.state) + '">' + esc(j.state) + (j.position ? " #" + esc(j.position) : "") + "</span></td><td class=path>" +
    esc((live ? j.progress : j.error || j.result || j.progress) || "") + "</td><td class=muted>" + ago(j.finishedAt || j.startedAt || j.createdAt) + "</td><td>" +
    (live ? '<button class="btn" data-cancel="' + esc(j.id) + '" data-kind="' + esc(k.path) + '">cancel</button>' : "") + "</td></tr>";
}
function jobsPane() {
  if (!S.jobs.length) return '<p class="empty">No jobs. <code>app.job(path, options, run)</code> defines one, and its queue shows up here.</p>';
  return '<div class="grid2">' + S.jobs.map(function (k) {
    var next = k.schedule && k.schedule.next ? Math.max(0, Math.round((k.schedule.next - Date.now()) / 1000)) : null;
    return '<div class="card"><h3>' + esc(k.path) + '</h3><div class="muted mono">' + k.running + " of " + k.concurrency + " slots · " + k.queued + " of " + k.queueLimit + " waiting" +
      (k.schedule ? " · <b>" + esc(k.schedule.cron) + "</b> " + esc(k.schedule.zone) + (next !== null ? ", next in " + next + "s" : "") : "") + '</div><div class="bar-meter"><i style="width:' +
      Math.round((k.running / k.concurrency) * 100) + '%"></i></div><h5>now</h5>' + (k.live.length ? "<table class=log>" + k.live.map(function (j) { return jobRow(k, j, true); }).join("") + "</table>" : '<p class="muted">Nothing running or waiting.</p>') +
      "<h5>ended</h5>" + (k.recent.length ? "<table class=log>" + k.recent.map(function (j) { return jobRow(k, j, false); }).join("") + "</table>" : '<p class="muted">None since the studio opened.</p>') + "</div>";
  }).join("") + "</div>";
}
// ----- the frame -----
function kpis() {
  var now = Date.now(), minute = rows.filter(function (e) { return now - Date.parse(e.at) < 60000; });
  var broken = minute.filter(function (e) { return e.status >= 500 || e.notes.length; }).length;
  var times = minute.map(function (e) { return e.ms; }).sort(function (a, b) { return a - b; });
  var p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
  var a = S ? S.app : { uptime: 0, heap: 0 };
  return '<div class="kpi"><span>requests / min</span><b>' + minute.length + "</b>" + spark(trend.map(function (h) { return h.n; }), "var(--seal)") + '</div><div class="kpi"><span>broken / min</span><b class="' + (broken ? "note" : "") + '">' + broken +
    "</b>" + spark(trend.map(function (h) { return h.e; }), "var(--warn)") + '</div><div class="kpi"><span>p95 · last minute</span><b>' + p95 + "ms</b>" + spark(trend.map(function (h) { return h.p; }), "var(--post)") +
    '</div><div class="kpi"><span>heap</span><b>' + bytes(a.heap) + "</b>" + spark(trend.map(function (h) { return h.h; }), "var(--ok)") + '</div><div class="kpi"><span>up</span><b>' + ago(Date.now() - a.uptime * 1000) + "</b><span>" + esc(a.node || "") + "</span></div>";
}
function draw() {
  var counts = { live: rows.length, routes: S ? S.routes.length : 0, map: "", mcp: S ? S.mcp.tools.length : 0, jobs: S ? S.jobs.length : 0 };
  $("#tabs").innerHTML = TABS.map(function (t) { return '<button class="tab' + (t === tab ? " on" : "") + '" data-tab="' + t + '">' + t + (counts[t] !== "" ? '<span class="n">' + counts[t] + "</span>" : "") + "</button>"; }).join("");
  $("#kpis").innerHTML = kpis();
  var focus = document.activeElement && document.activeElement.id, pos = focus === "filter" ? $("#filter").selectionStart : 0, typed = {};
  document.querySelectorAll("textarea[id^=args]").forEach(function (t) { typed[t.id] = t.value; });
  var html = tab === "live" || !S ? livePane() : tab === "routes" ? routesPane() : tab === "map" ? mapPane() : tab === "mcp" ? mcpPane() : jobsPane();
  var pane = $("#pane");
  if (pane.dataset.shown !== tab) { pane.className = ""; void pane.offsetWidth; pane.className = "pane"; pane.dataset.shown = tab; }
  if (tab === "map" && S && pane.dataset.drawn === "map") return; // the tree animates once, not on every poll
  pane.dataset.drawn = S ? tab : "";
  pane.innerHTML = html;
  Object.keys(typed).forEach(function (id) { var t = document.getElementById(id); if (t) t.value = typed[id]; });
  if (focus === "filter") { var f = $("#filter"); f.focus(); f.setSelectionRange(pos, pos); }
  document.body.classList.toggle("paused", paused);
  fresh = {};
}
function poll() {
  if (paused) return;
  fetch(CFG.base + "/log.json?since=" + since).then(function (r) { return r.json(); }).then(function (list) {
    if (!list.length) return;
    since = list[list.length - 1].id;
    list.forEach(function (e) { fresh[e.id] = true; });
    rows = list.reverse().concat(rows).slice(0, 200);
    if (tab === "live") draw();
  }).catch(function () {});
}
function pollStudio() {
  fetch(CFG.base + "/studio.json").then(function (r) { return r.json(); }).then(function (s) {
    S = s;
    var now = Date.now(), point = sample(now);
    // the first time, the log so far draws the lines back, so they do not start empty
    if (!trend.length && rows.length) for (var k = 59; k > 0; k--) trend.push(sample(now - k * 2000));
    point.h = s.app.heap;
    trend.push(point);
    if (trend.length > 60) trend.shift();
    if (tab === "live" || tab === "map") $("#kpis").innerHTML = kpis();
    if (tab !== "live") draw();
  }).catch(function () {});
}
document.addEventListener("click", function (e) {
  var t = e.target.closest("[data-tab]");
  if (t) { tab = t.dataset.tab; try { sessionStorage.setItem("inkan:studio-tab", tab); } catch (x) {} $("#pane").dataset.drawn = ""; draw(); return; }
  var b = e.target.closest("[data-replay],[data-example],[data-call],[data-cancel],[data-sort],#pause,#clear");
  if (b) {
    if (b.id === "pause") { paused = !paused; draw(); }
    else if (b.id === "clear") { rows = []; open = {}; draw(); }
    else if (b.dataset.replay) replay(b.dataset.replay);
    else if (b.dataset.example) copyExample(b.dataset.example);
    else if (b.dataset.call) callTool(Number(b.dataset.call));
    else if (b.dataset.sort) { if (sortBy === b.dataset.sort) sortDir = -sortDir; else { sortBy = b.dataset.sort; sortDir = -1; } draw(); }
    else if (b.dataset.cancel) { b.disabled = true; fetch(CFG.base + "/jobs/cancel?kind=" + encodeURIComponent(b.dataset.kind) + "&id=" + encodeURIComponent(b.dataset.cancel), { method: "POST", headers: { "x-inkan-studio": "1" } }).then(pollStudio); }
    return;
  }
  var tr = tab === "live" && e.target.closest("tr.row");
  if (tr) { open[tr.dataset.id] = !open[tr.dataset.id]; draw(); }
});
document.addEventListener("input", function (e) { if (e.target.id === "filter") draw(); });
draw(); poll(); pollStudio(); setInterval(poll, 1000); setInterval(pollStudio, 2000);
})();
`;

export function studioPage(cfg: { title: string; base: string; docs: string; mcp: string }) {
  const body = `<style>${studioCss}</style>
<header class="top"><span class="stamp">印</span><h1>${cfg.title.replace(/[<>&]/g, "")}</h1><span class="ver"><span class="live-dot"></span>studio</span>
<nav>${cfg.docs ? `<a class="btn" href="${attr(cfg.docs)}">docs</a>` : ""}</nav></header>
<div class="tabs" id="tabs"></div>
<div class="wrap"><div class="kpis" id="kpis"></div><div id="pane"></div></div>`;
  return page(cfg.title + " · studio", { base: cfg.base, mcp: cfg.mcp }, body, studioScript);
}
