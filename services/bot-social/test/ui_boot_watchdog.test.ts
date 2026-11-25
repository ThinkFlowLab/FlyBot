// Owner console boot (#136): a /ui.js that never loads must fail visibly with a Retry, not spin forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { pub } from "./ui_helpers.js";

type El = {
  tagName: string;
  className: string;
  textContent: string;
  src: string;
  type: string;
  attrs: Record<string, string>;
  children: El[];
  onclick: null | (() => void);
  onerror: null | (() => void);
  appendChild(c: El): El;
  setAttribute(k: string, v: string): void;
};

/** Run the inline watchdog in public/index.html against a fake DOM with hand-cranked timers. */
function watchdog() {
  const html = pub("index.html");
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>", open);
  assert.ok(open > 0 && close > open, "index.html should carry the inline boot watchdog");
  const source = html.slice(open + "<script>".length, close);
  assert.match(source, /__bsConsoleLoaded/, "the watchdog script is the one that reads the loaded handshake");

  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const body = { children: [] as El[], appendChild(c: El) { this.children.push(c); return c; } };
  const root: El = {
    tagName: "root", className: "", textContent: "", src: "", type: "", attrs: {}, children: [],
    onclick: null, onerror: null,
    appendChild(c: El) { this.children.push(c); return c; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
  };
  const document = {
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: (tag: string): El => ({
      tagName: tag, className: "", textContent: "", src: "", type: "", attrs: {}, children: [],
      onclick: null, onerror: null,
      appendChild(c: El) { this.children.push(c); return c; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
    }),
    body,
  };
  const window: any = {};
  vm.runInNewContext(source, {
    window,
    document,
    Date,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });

  const fire = () => {
    const [id, t] = timers.entries().next().value as [number, { fn: () => void; ms: number }];
    assert.ok(t, "a boot timer should be armed");
    timers.delete(id);
    t.fn();
    return t.ms;
  };
  const byTag = (parent: El, tag: string) => parent.children.find((c) => c.tagName === tag);
  const texts = (el: El): string => (el.children || []).map((c) => c.textContent).join("|");
  return { html, root, body, window, timers, fire, byTag, texts };
}

test("a /ui.js that never arrives turns into an error with Retry within 8 seconds (#136)", () => {
  const w = watchdog();
  assert.equal(w.root.children.length, 0, "the boot spinner is left alone while the script may still load");
  const ms = w.fire();
  assert.ok(ms >= 6000 && ms <= 8000, `the watchdog waits 6–8 seconds, got ${ms}`);
  const box = w.root.children[0];
  assert.equal(box.attrs.role, "alert", "the failure is announced");
  assert.equal(w.texts(box), "🤝 Bot Social|The console did not load.|Retry|Check your connection, then retry.");
  const retry = w.byTag(box, "button");
  assert.ok(retry, "the error carries a Retry button");
  assert.equal(typeof retry!.onclick, "function", "Retry must be clickable");
});

test("Retry loads /ui.js again with a cache-busting query and re-arms the watchdog", () => {
  const w = watchdog();
  w.fire();
  const retry = w.byTag(w.root.children[0], "button");
  retry!.onclick!();
  const script = w.body.children.at(-1);
  assert.ok(script, "Retry appends a fresh script element");
  assert.match(script.src, /^\/ui\.js\?retry=\d+$/, "a retry must not be served from a failed response");
  assert.equal(w.timers.size, 1, "the retry is watched too");
  assert.equal(w.timers.values().next().value!.ms, 7000);
});

test("a script the parser reports as failed shows the error without waiting for the timer", () => {
  const w = watchdog();
  w.window.__bsBootWatchdog.failed();
  assert.equal(w.timers.size, 0, "the pending timer is cleared");
  assert.equal(w.root.children[0].attrs.role, "alert");
  assert.match(w.html, /onerror="window\.__bsBootWatchdog\.failed\(\)"/, "the static script tag reports its own load error");
});

test("ui.js stands the watchdog down, so a slow but healthy boot shows no error", () => {
  const w = watchdog();
  w.window.__bsConsoleLoaded();
  assert.equal(w.timers.size, 0, "loaded() clears the timer");
  assert.equal(w.root.children.length, 0, "the spinner keeps spinning while boot() works");
  assert.doesNotThrow(() => w.window.__bsBootWatchdog.failed(), "a late failure cannot replace a loaded console");
  assert.equal(w.root.children.length, 0);

  const ui = pub("ui.js");
  const head = ui.split("\n").slice(0, 6).join("\n");
  assert.match(head, /if \(window\.__bsConsoleLoaded\) window\.__bsConsoleLoaded\(\);/, "ui.js announces itself at the top of the file");
});

test("with JavaScript disabled the noscript line explains what is missing", () => {
  const { html } = watchdog();
  assert.match(html, /<noscript><div class="boot" role="alert"><b>🤝 Bot Social<\/b><p>This console needs JavaScript\. Turn it on and reload the page\.<\/p><\/div><\/noscript>/);
});
