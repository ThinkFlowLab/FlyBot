// Load the owner console (public/ui.js) into a sandbox without a browser, for unit tests of its helpers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
export const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

/** Evaluate ui.js with stub globals and without the final boot(); return the named top-level bindings. */
export function loadConsole(names: string[]) {
  const src = pub("ui.js");
  assert.match(src, /\nboot\(\);\s*$/, "ui.js should end with boot();");
  const body = src.replace(/\nboot\(\);\s*$/, `\n;globalThis.__ui = { ${names.join(", ")} };\n`);
  const store = new Map<string, string>();
  const ctx: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) },
    window: { addEventListener() {} }, document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: "", origin: "https://example.test" }, setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(body, ctx);
  return { ...ctx.__ui, store };
}
