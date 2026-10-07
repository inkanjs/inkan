// The inspector: the requests the app saw, live, with replay and copy as example.

import { attr, css, esc, page } from "./shared.ts";

const inspectorScript = /* js */ `
var since = 0, paused = false, rows = [], open = {}, results = {};
var $ = function (s) { return document.querySelector(s); };
function line(e) {
  var t = e.at.slice(11, 19);
  return '<tr class="row" data-id="' + esc(e.id) + '"><td class="muted">' + esc(t) + '</td><td><span class="m m-' + esc(e.method.toLowerCase()) + '">' + esc(e.method) +
    '</span></td><td class="path">' + esc(e.path) + '</td><td><span class="status s' + esc(String(e.status)[0]) + '">' + esc(e.status) +
    '</span></td><td class="muted">' + esc(e.ms) + "ms</td><td class=muted>" + esc(e.route || "—") + '</td><td class="note">' + esc(e.notes.join("; ")) + "</td></tr>" +
    (open[e.id] ? '<tr class="detail"><td colspan="7">' + detail(e) + "</td></tr>" : "");
}
function pretty(s) { if (s === undefined || s === "") return "—"; try { return JSON.stringify(JSON.parse(s), null, 2); } catch (x) { return s; } }
// what may differ between two runs of the same request without the answer having changed
function comparable(s) { try { var v = JSON.parse(s); if (v && typeof v === "object") delete v.requestId; return JSON.stringify(v); } catch (x) { return s || ""; } }
function statusTag(s) { return '<span class="status s' + esc(String(s)[0]) + '">' + esc(s) + "</span>"; }
var FORBIDDEN = /^(host|connection|content-length|accept-encoding|accept-charset|cookie|date|dnt|expect|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|x-request-id|x-inkan-replay)$|^(sec-|proxy-)/;
function find(id) { return rows.filter(function (r) { return String(r.id) === String(id); })[0]; }
function replay(id) {
  var e = find(id), h = {}, dropped = false;
  if (!sameOrigin(e.path)) { results[id] = '<p class="verdict no">not replayed: this path would leave the server</p>'; draw(); return; }
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
        '</pre></div><div><h5>now · ' + statusTag(res.status) + " · " + esc(ms) + 'ms</h5><pre>' + esc(pretty(text)) + "</pre></div></div>" +
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
      : '<button class="btn" data-replay="' + esc(e.id) + '">replay</button>') +
    (e.example ? '<button class="btn" data-example="' + esc(e.id) + '">copy as example</button>' : '<span class="muted">no route answered, so there is no example to make</span>') +
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
${cfg.docs ? `<a class="btn" href="${attr(cfg.docs)}">docs</a>` : ""}</nav></header>
<div style="max-width:1180px;margin:0 auto;padding:22px">
<p class="intro">The last 200 requests, newest first. A red note means a request or an answer broke the contract. Secret headers show as •••. <span id="count" class="mono"></span></p>
<section class="win"><div class="pad" style="overflow:auto"><table class="log"><thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>took</th><th>route</th><th>notes</th></tr></thead><tbody id="body"></tbody></table></div></section></div>`;
  return page(cfg.title + " · inspector", { base: cfg.base }, body, inspectorScript);
}
