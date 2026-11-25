// The invite page's Copy button used to live inside the <pre> and copy p.innerText with the label trimmed
// off. That worked once: after the first click the button said "Copied", the label became part of the
// block's text, and the second click copied the command plus "\nCopied". Appending the button also put the
// label into any text selection. /guide had the same defect and was fixed (#135); this pins the same shape
// here: one button per block, as a sibling AFTER the block, copying the block's own textContent, with a
// visible prompt when navigator.clipboard is unavailable (plain http, revoked permission) instead of a
// TypeError from the click handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../public/invite.html", import.meta.url), "utf8");
const script = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
const INVITE_URL = "https://botsocial.example/invite/AbC123";
const JOIN_BLOCK = `Use join_invite with ${INVITE_URL}`;
const BOTCTL_BLOCK = `botctl join ${INVITE_URL}`;

const invite = {
  status: "active",
  inviter: { display_name: "Coder", handle: "coder.bot", owner_display_name: "Bob" },
  message: "hello there",
  offered_capabilities: ["chat.public"],
  requested_capabilities: [],
  expires_at: "2026-11-30T00:00:00Z",
};

/** A <pre> whose innerText really reflects a button appended into it, as the browser's does. */
function block(text: string) {
  const pre: any = {
    textContent: text,
    appended: [] as any[],
    inserted: null as { pos: string; el: any } | null,
    appendChild(el: any) {
      pre.appended.push(el);
    },
    insertAdjacentElement(pos: string, el: any) {
      pre.inserted = { pos, el };
    },
  };
  Object.defineProperty(pre, "innerText", {
    get: () => [pre.textContent, ...pre.appended.map((el: any) => el.textContent)].join("\n"),
  });
  return pre;
}

function element() {
  const el: any = { className: "", textContent: "", type: "", onclick: null, children: [] as any[] };
  el.appendChild = (child: any) => {
    el.children.push(child);
  };
  return el;
}

async function run(opts: { refuseClipboard?: boolean; noClipboard?: boolean } = {}) {
  const blocks = [block(JOIN_BLOCK), block(BOTCTL_BLOCK)];
  const container = { innerHTML: "" };
  const copies: string[] = [];
  const ctx: any = {
    document: {
      getElementById: () => container,
      querySelectorAll: (sel: string) => (sel === "#c pre" ? blocks : []),
      createElement: () => element(),
    },
    location: { pathname: "/invite/AbC123", href: INVITE_URL, origin: "https://botsocial.example" },
    fetch: async () => ({ json: async () => invite }),
    prompt: (label: string, text: string) => {
      ctx.prompted = { label, text };
    },
  };
  if (!opts.noClipboard) {
    ctx.navigator = {
      clipboard: {
        writeText: async (text: string) => {
          if (opts.refuseClipboard) throw new Error("clipboard unavailable");
          copies.push(text);
        },
      },
    };
  } else {
    // Plain http: navigator.clipboard is absent. Real browsers also expose no writeText here.
    ctx.navigator = {};
  }
  vm.runInNewContext(script, ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { blocks, copies, ctx, container };
}

/** The button as the page places it after the fix, or where the old page put it, so both shapes can be clicked. */
function button(pre: any) {
  const row = pre.inserted?.el;
  return { row, btn: row ? row.children[0] : pre.appended[0] };
}

test("Copy is a sibling after each command block, and the first click copies the block's own text", async () => {
  const { blocks, copies } = await run();
  for (const [i, expected] of [JOIN_BLOCK, BOTCTL_BLOCK].entries()) {
    const pre = blocks[i];
    assert.ok(pre.inserted, `block ${i + 1} gets a Copy button next to it, not inside its text`);
    assert.equal(pre.inserted.pos, "afterend", "the button sits as a sibling after the block");
    assert.equal(pre.appended.length, 0, "nothing is appended into the block, so the label cannot enter a selection");
    assert.equal(pre.inserted.el.className, "cprow", "the button lives in its own row");
  }
  const { btn } = button(blocks[0]);
  assert.equal(btn.textContent, "Copy");
  await btn.onclick();
  assert.deepEqual(copies, [JOIN_BLOCK], "the copied text is the block itself, with no button label in it");
  assert.equal(btn.textContent, "Copied", "the button says it worked");
});

test("a second click copies the command again, without the button's label in it", async () => {
  const { blocks, copies } = await run();
  const { btn } = button(blocks[0]);
  await btn.onclick();
  assert.equal(btn.textContent, "Copied");
  await btn.onclick();
  assert.deepEqual(copies, [JOIN_BLOCK, JOIN_BLOCK], "both clicks copy the command verbatim");
  assert.equal(copies[1].includes("Copied"), false, "the button's own label never becomes part of the command");
});

test("an absent clipboard API (plain http) shows the text in a prompt instead of throwing", async () => {
  const { blocks, ctx } = await run({ noClipboard: true });
  const { btn } = button(blocks[0]);
  await btn.onclick(); // the old handler threw "Cannot read properties of undefined (reading 'writeText')" here
  assert.ok(ctx.prompted, "the fallback is visible, so the text can still be copied by hand");
  assert.equal(ctx.prompted.text, JOIN_BLOCK, "the prompt holds the block's own text, verbatim");
});
