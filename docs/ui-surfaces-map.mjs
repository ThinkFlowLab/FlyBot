// Related #3393. Prints the page → plugin-feature map referenced by docs/UI_SURFACES.md §2.
// Usage, from the repository root: node docs/ui-surfaces-map.mjs
import {readdirSync as rd, readFileSync as rf, statSync as st} from "node:fs";
import {join as j} from "node:path";

const F = j(process.cwd(), "runtime/flybot-workspace-web/features");
const S = j(process.cwd(), "flybot_workspace/static");
const by = new Map();
for (const n of rd(F)) {
  let t = "";
  try { t = rf(j(F, n, "index.js"), "utf8"); } catch { continue; }
  const m = t.match(/pages:\s*\[([^\]]*)\]/);
  if (m) by.set(n, [...m[1].matchAll(/\x27([^\x27]+)\x27/g)].map((i) => i[1]));
}
const dirs = rd(S).filter((n) => st(j(S, n)).isDirectory()), served = new Map();
for (const [f, ps] of by) for (const p of ps) served.set(p, [...(served.get(p) ?? []), f]);
console.log(`${by.size} features; ${dirs.length} dirs`);
for (const p of dirs) console.log(`  ${p.padEnd(12)} ${(served.get(p) ?? []).join(",") || "(python only)"}`);
