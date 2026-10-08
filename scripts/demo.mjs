// Writes assets/demo.svg, the animation at the top of the README: three scenes of inkan,
// animated with CSS only, looping. The output in it is real: copied from `inkan check` and a
// request against the tea shop. Change the scenes here and run `node scripts/demo.mjs`.
import { writeFileSync } from "node:fs";

const W = 840, H = 470, T = 17; // seconds per loop
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// a line: [text spans], each span [text, class]
const scenes = [
  {
    title: "src/app.ts",
    from: 0.3, to: 6.2, step: 0.32,
    lines: [
      [["app.", ""], ["post", "k"], ["(", ""], ['"/teas"', "s"], [", {", ""]],
      [["  body: t.object({", ""]],
      [["    name:  t.string().min(", ""], ["1", "n"], ["),", ""]],
      [["    grams: t.int().min(", ""], ["1", "n"], ["),", ""]],
      [["  }),", ""]],
      [["  response: { ", ""], ["201", "n"], [": Tea },", ""]],
      [["  examples: [{ body: { name: ", ""], ['"Bancha"', "s"], [", grams: ", ""], ["40", "n"], [" } }],", ""]],
      [["}, ({ body }) => store.add(body));", ""]],
      [["", ""]],
      [["// one contract: it checks, types, documents and tests", "c"]],
    ],
  },
  {
    title: "a request that breaks it",
    from: 6.4, to: 11.4, step: 0.38,
    lines: [
      [["$ ", "p"], ["curl -X POST localhost:3000/teas -d ", ""], ["'{\"name\":\"Matcha\",\"grams\":-5}'", "s"]],
      [["", ""]],
      [["400 Bad Request", "r"], ["  application/problem+json", "c"]],
      [["{", ""]],
      [['  "type": ', ""], ['"validation"', "s"], [",", ""]],
      [['  "detail": ', ""], ['"The body does not match the contract"', "s"], [",", ""]],
      [['  "errors": [{ "in": ', ""], ['"body"', "s"], [', "path": ', ""], ['"grams"', "s"], [",", ""]],
      [['               "message": ', ""], ['"must be 1 or more"', "s"], [" }]", ""]],
      [["}", ""]],
    ],
  },
  {
    title: "examples are tests",
    from: 11.6, to: 16.6, step: 0.45,
    lines: [
      [["$ ", "p"], ["npx inkan check src/app.ts", ""]],
      [["", ""]],
      [["  ", ""], ["印", "r"], [" inkan check", "b"], ["  ·  Tea Shop", "c"]],
      [["", ""]],
      [["  GET    /teas", "b"]],
      [["    ", ""], ["✓", "g"], [" every tea                          200  ", ""], ["4ms", "c"]],
      [["  POST   /teas", "b"]],
      [["    ", ""], ["✓", "g"], [" a new tea                          201  ", ""], ["0.3ms", "c"]],
      [["", ""]],
      [["  2 examples · ", ""], ["2 sealed", "g"]],
    ],
  },
];

const pct = (s) => ((s / T) * 100).toFixed(2);
let css = "";
let body = "";
let n = 0;
scenes.forEach((sc, i) => {
  const id = `t${i}`;
  css += `@keyframes ${id}{0%,${pct(sc.from)}%{opacity:0}${pct(sc.from + 0.01)}%,${pct(sc.to)}%{opacity:1}${pct(sc.to + 0.2)}%,100%{opacity:0}}.${id}{animation:${id} ${T}s linear infinite}\n`;
  body += `<text class="title ${id}" x="${W / 2}" y="31" text-anchor="middle">${esc(sc.title)}</text>\n`;
  sc.lines.forEach((spans, j) => {
    const at = sc.from + 0.2 + j * sc.step;
    const k = `l${n++}`;
    css += `@keyframes ${k}{0%,${pct(at)}%{opacity:0}${pct(at + 0.05)}%,${pct(sc.to)}%{opacity:1}${pct(sc.to + 0.2)}%,100%{opacity:0}}.${k}{animation:${k} ${T}s linear infinite}\n`;
    const tspans = spans.map(([t, c]) => `<tspan${c ? ` class="${c}"` : ""}>${esc(t)}</tspan>`).join("");
    body += `<text class="line ${k}" x="34" y="${88 + j * 30}" xml:space="preserve">${tspans}</text>\n`;
  });
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="inkan: a contract, a request that breaks it, and inkan check">
<style>
text{font-family:ui-monospace,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;font-variant-ligatures:none;font-size:16px;fill:#ece1cf;opacity:0}
.title{font-size:13px;fill:#8a7d72}
.k{fill:#d9a05b}.s{fill:#79c08a}.n{fill:#e2583e}.c{fill:#8a7d72}.p{fill:#8a7d72}.r{fill:#e2583e;font-weight:700}.g{fill:#79c08a;font-weight:700}.b{font-weight:700}
${css}</style>
<rect width="${W}" height="${H}" rx="14" fill="#1a1614"/>
<rect width="${W}" height="48" rx="14" fill="#312a26"/><rect y="34" width="${W}" height="14" fill="#312a26"/>
<circle cx="26" cy="24" r="7" fill="#e5534b"/><circle cx="48" cy="24" r="7" fill="#e3b341"/><circle cx="70" cy="24" r="7" fill="#57c26a"/>
${body}</svg>
`;
writeFileSync(new URL("../assets/demo.svg", import.meta.url), svg);
console.log("wrote assets/demo.svg", svg.length, "bytes");
