// /connect hands the owner four things to copy — the one-message setup, the MCP URL, the Authorization
// header and the JSON config — and only once, right after a connector token is minted. Each Copy button
// used to carry an inline `navigator.clipboard.writeText(...)` with no rejection handler and no fallback.
// On plain http (the usual self-hosted BOTSOCIAL_URL=http://<server>:8787) navigator.clipboard is absent,
// so the click threw "Cannot read properties of undefined (reading 'writeText')" and the button did
// nothing; a denied permission or an older browser was just as silent. The blocks are the only place the
// token is ever shown, so a dead button loses the token for good.
//
// These cases run the page's own script and evaluate the same inline handler the browser receives, with a
// fake <pre> whose innerText and textContent agree (as they do for a real block): the prompt must hold the
// block's own text when the clipboard is unavailable, and the clipboard mock must receive it verbatim and
// the button say "Copied ✓" when it works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../public/connect.html", import.meta.url), "utf8");
const script = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));

const BLOCKS: Record<string, string> = {
  msg: "Set me up with Bot Social following https://botsocial.example/setup",
  url: "https://botsocial.example/mcp",
  hdr: "Authorization: Bearer bsk_live_connector_token",
  json: '{\n  "mcpServers": {\n    "bot-social": {\n      "url": "https://botsocial.example/mcp"\n    }\n  }\n}',
};

/** A block/element whose textContent and innerText are the same, as a real <pre> or <button> is. */
function element(text: string) {
  const el: any = { textContent: text };
  Object.defineProperty(el, "innerText", {
    get: () => el.textContent,
    set: (value: string) => {
      el.textContent = value;
    },
  });
  return el;
}

function run(opts: { clipboard?: (text: string) => Promise<void> } = {}) {
  const blocks: Record<string, any> = {};
  for (const [id, text] of Object.entries(BLOCKS)) blocks[id] = element(text);
  const prompts: { label: string; text: string }[] = [];
  const ctx: any = {
    document: {
      querySelector: () => ({ innerHTML: "" }),
      getElementById: (id: string) => blocks[id],
    },
    location: { origin: "https://botsocial.example", href: "https://botsocial.example/connect", pathname: "/connect" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    prompt: (label: string, text: string) => {
      prompts.push({ label, text });
    },
  };
  if (opts.clipboard) {
    ctx.navigator = { clipboard: { writeText: opts.clipboard } };
  } else {
    // Plain http: navigator.clipboard is absent, and there is no writeText to call.
    ctx.navigator = {};
  }
  vm.runInNewContext(script, ctx);
  return { ctx, blocks, prompts };
}

/** Click a generated Copy button: evaluate the same inline handler the browser would, with `this` = button. */
async function click(ctx: any, id: string, btn: any) {
  const markup: string = ctx.copyBtn(id);
  const handler = /onclick="([^"]*)"/.exec(markup);
  assert.ok(handler, `the ${id} button carries an inline click handler`);
  const fn = new vm.Script(`(function(){${handler[1]}})`).runInContext(ctx);
  const result = fn.call(btn);
  // An inline handler's return value is discarded by the browser, so wait for the async work it started.
  await result;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return result;
}

test("an absent clipboard API (plain http) shows each block's text instead of throwing", async () => {
  const { ctx, prompts } = run();
  for (const id of Object.keys(BLOCKS)) {
    const btn = element("Copy");
    await assert.doesNotReject(
      async () => {
        await click(ctx, id, btn);
      },
      `clicking ${id} must not throw when the clipboard is unavailable`,
    );
    assert.equal(prompts.length, 1, `clicking ${id} shows the fallback exactly once`);
    assert.equal(prompts[0].text, BLOCKS[id], `the prompt holds the ${id} block verbatim`);
    prompts.length = 0;
  }
});

test("a working clipboard copies each block verbatim, says Copied ✓, and never prompts", async () => {
  const copied: string[] = [];
  const { ctx, prompts } = run({ clipboard: async (text) => { copied.push(text); } });
  for (const id of Object.keys(BLOCKS)) {
    const btn = element("Copy");
    await click(ctx, id, btn);
    assert.equal(btn.textContent, "Copied ✓", `the ${id} button says it worked`);
  }
  assert.deepEqual(copied, Object.values(BLOCKS), "each button copies its own block, verbatim");
  assert.equal(prompts.length, 0, "nothing falls back when the clipboard works");
});
