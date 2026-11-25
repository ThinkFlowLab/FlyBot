// #128: both room-invite branches tell the person to copy the link, so both must offer the one-tap Copy
// /connect and /guide already have. The page is opened from a phone camera scan, where long-press and
// drag-select of a wrapped URL is the usual way to lose a character.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

const page = readFileSync(new URL("../public/room-invite.html", import.meta.url), "utf8");

/** Run the page's own script against a real server, keeping the context so the Copy handler can be clicked. */
async function render(base: string, path: string) {
  const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
  const el = { innerHTML: "Loading…" };
  let settled!: () => void;
  const done = new Promise<void>((r) => (settled = r));
  const ctx: any = {
    document: { getElementById: () => el },
    location: { pathname: path, href: base + path },
    fetch: (u: string) => fetch(base + u).finally(() => setTimeout(settled, 20)),
    Intl, Date, String, Object, URL, decodeURIComponent, encodeURIComponent, setTimeout,
    navigator: { clipboard: { writeText: (t: string) => { ctx.copied = t; return Promise.resolve(); } } },
  };
  vm.runInNewContext(script, ctx);
  await done;
  return { html: el.innerHTML, ctx: ctx as { copied?: string; copyInvite?: (b: { textContent: string }) => void } };
}

async function mintLocal(base: string, o: any) {
  const r = await fetch(base + "/v1/local-room-invites", {
    method: "POST",
    headers: { authorization: `Bearer ${o.owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ room_id: "session-copy", name: "Copy plan", bot_id: o.bot.id }),
  });
  assert.equal(r.status, 201);
  return (await r.json()) as { ticket: string; url: string };
}

async function mintFace(base: string, o: any) {
  const join = await fetch(base + "/v1/face-rooms/join", {
    method: "POST",
    headers: { authorization: `Bearer ${o.owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ code: "424242", bots: [o.bot.id] }),
  });
  assert.equal(join.status, 200);
  const room = (await join.json()) as { room_id: string };
  const inv = await fetch(`${base}/v1/face-rooms/${room.room_id}/invites`, { method: "POST", headers: { authorization: `Bearer ${o.owner.token}` } });
  assert.equal(inv.status, 201);
  return (await inv.json()) as { ticket: string };
}

const hasCopyControl = (html: string) => /<button[^>]*onclick="copyInvite\(this\)"[^>]*>Copy<\/button>/.test(html) && /<pre id="invite-link">/.test(html);

test("#128: a local room-invite page renders the link with a one-tap Copy", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mintLocal(s.base, A);
  const { html } = await render(s.base, new URL(m.url).pathname);
  assert.ok(hasCopyControl(html), `the link needs a Copy button next to it, got: ${html}`);
});

test("#128: a face room-invite page renders the link with a one-tap Copy too", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mintFace(s.base, A);
  const { html } = await render(s.base, `/r/${m.ticket}`);
  assert.ok(hasCopyControl(html), `the link needs a Copy button next to it, got: ${html}`);
});

test("#128: clicking Copy puts the exact address in the clipboard and says Copied ✓", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mintLocal(s.base, A);
  const path = new URL(m.url).pathname;
  const { ctx } = await render(s.base, path);
  assert.equal(typeof ctx.copyInvite, "function", "the page defines the Copy handler");
  const btn = { textContent: "Copy" };
  ctx.copyInvite!(btn);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.copied, s.base + path, "the clipboard gets the full link, verbatim");
  assert.equal(btn.textContent, "Copied ✓", "the button says it worked");
});
