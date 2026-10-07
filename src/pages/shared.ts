// The two pages inkan serves itself: the docs and the request inspector.
// Plain HTML, CSS and JS in one string each. No CDN, nothing to fetch but the
// app's own JSON, so they work offline and behind any firewall.

//it's a complete mess but it works lol, gonna clean it up later or maybe never, but let's see, shall we? ~ vxnsin

export const css = /* css */ `
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
.bar code{font-size:14px;font-weight:600;word-break:break-all}.bar .dep{color:var(--warn);font:11px var(--mono)}.bar .lock{color:var(--ink-2);font:11px var(--mono);white-space:nowrap}.heads{margin:4px 0 0;font-size:12px}
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
[hidden]{display:none!important}.chain{margin:4px 0 0;font-size:12px}.btn.on{background:var(--paper-2);border-color:var(--seal);color:var(--seal)}
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

export const esc = /* js */ `
// A request from these pages carries the token, so it may only go to this server: a path like
// //elsewhere/x would otherwise be read as another host.
function sameOrigin(u){try{return new URL(u,location.href).origin===location.origin}catch(e){return false}}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
`;

export const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);

export const page = (title: string, cfg: unknown, body: string, script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<>&"]/g, "")}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="3" width="26" height="26" rx="6" fill="#c4381f"/><rect x="7" y="7" width="18" height="18" rx="3" fill="none" stroke="#fbf7ef" stroke-width="2"/><path d="M12 16.5l3 3 5.5-6.5" fill="none" stroke="#fbf7ef" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}">
<style>${css}</style></head><body>${body}
<script>var CFG=${JSON.stringify(cfg).replace(/</g, "\\u003c")};${esc}${script}</script></body></html>`;
