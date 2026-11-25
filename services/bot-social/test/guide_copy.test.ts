// #135: /guide's Copy button used to live inside the <pre> and copy p.innerText with the label trimmed
// off, so the label took part in the selection and the copied text depended on CSS. The console's pattern
// (public/ui.js:519-520, :106) is a button outside the block that copies its text, and a visible prompt when
// the clipboard is unavailable — which is exactly the case on plain http, where navigator.clipboard is null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../public/guide.html", import.meta.url), "utf8");
const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
const BLOCK = "botctl register alice --url http://localhost:8787\nhttp://localhost:8787/ui";

function run(clipboard: (text: string) => Promise<void>) {
  const pre: any = {
    textContent: BLOCK,
    innerText: `${BLOCK}\nCopy`,
    appendChild: (el: any) => { pre.appended = el; },
    insertAdjacentElement: (pos: string, el: any) => { pre.inserted = { pos, el }; },
  };
  const ctx: any = {
    document: { querySelectorAll: (s: string) => (s === "pre" ? [pre] : []), createElement: () => ({ className: "", textContent: "", onclick: null, appendChild: (el: any) => { (pre as any).rowChild = el; } }) },
    navigator: { clipboard: { writeText: clipboard } },
    prompt: (label: string, text: string) => { ctx.prompted = { label, text }; },
  };
  vm.runInNewContext(script, ctx);
  return { pre, ctx };
}

test("#135: Copy sits outside the block and copies the block's own text", async () => {
  let copied = "";
  const { pre } = run(async (t) => { copied = t; });
  assert.ok(pre.inserted, "the button is inserted next to the <pre>, not inside it");
  assert.equal(pre.inserted.pos, "afterend", "a sibling after the block");
  assert.equal(pre.appended, undefined, "nothing is appended into the block's text");
  const btn = pre.rowChild; // the button sits in the row after the block, not in the block
  await btn.onclick();
  assert.equal(copied, BLOCK, "the copied text is the block itself, with no button label in it");
  assert.equal(btn.textContent, "Copied", "the button says it worked");
});

test("#135: a refused clipboard (plain http) shows the text instead of failing silently", async () => {
  const { pre, ctx } = run(async () => { throw new Error("clipboard unavailable"); });
  await pre.rowChild.onclick();
  assert.ok(ctx.prompted, "the fallback is visible");
  assert.equal(ctx.prompted.text, BLOCK, "the prompt holds the block's own text, verbatim");
});
