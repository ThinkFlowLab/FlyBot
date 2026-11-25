import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

// Bot Social #61: a local room's link is /r/@handle/<ticket> (two segments, FlyBot
// core/src/shared/room-share.js). The landing route only had one segment, so a camera scan of the QR code
// was a 404 — not a missing page. These cases pin the route, the two shapes, and what the page says.
const page = readFileSync(new URL("../public/room-invite.html", import.meta.url), "utf8");
const LOCAL_TICKET = "abcdefghijklmnopqrstuv"; // 22 characters, inside FlyBot's 16-64 window
const FACE_TICKET = "A".repeat(43); // a face ticket is exactly 43 base64url characters

async function get(base: string, path: string) {
  const r = await fetch(base + path);
  return { status: r.status, type: r.headers.get("content-type") ?? "", body: await r.text() };
}

test("#61: a local link opens the page; before this route it was a 404", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const r = await get(s.base, `/r/@ann.bot/${LOCAL_TICKET}`);
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  // The page, not a JSON 404: Fastify's own not-found answers { statusCode: 404, error: "Not Found" }.
  assert.equal(r.body.includes("statusCode"), false);
  assert.match(r.body, /id="c"/);
});

test("#61: the page tells the two link shapes apart and asks the matching endpoint", async () => {
  // The local shape is two segments; the face shape stays one and keeps its own endpoint (negative control).
  assert.match(page, /seg\.length>=3/);
  assert.match(page, /\/v1\/local-room-invites\//);
  assert.match(page, /\/v1\/face-rooms\/invites\//);
  // The local copy is the "paste it back into FlyBot" step, never the face-room one-click join.
  assert.match(page, /paste it back into your own FlyBot/);
  const localBranch = page.slice(page.indexOf("if(local){"), page.indexOf("document.getElementById(\"c\").innerHTML=`<h2>Room invite</h2>"));
  assert.equal(localBranch.includes("join_room_invite"), false, "the local page must not promise join_room_invite");
  const faceBranch = page.slice(page.lastIndexOf("document.getElementById(\"c\").innerHTML=`<h2>Room invite</h2>"));
  // The face copy names the path a visitor can actually take: the FlyBot app, or `POST /v1/face-rooms/join-invite`.
  // `join_room_invite` was never a tool, so the page promised an action that did not exist (verified defect).
  assert.match(faceBranch, /\/v1\/face-rooms\/join-invite/, "the face page names the endpoint that exists");
  assert.equal(faceBranch.includes("join_room_invite"), false, "the face page must not promise join_room_invite");
});

test("#61: a local ticket has a sentence per refusal, and an uncheckable link is not a 404 in disguise", async () => {
  // Reason: this page's only request is a preview — GET /v1/face-rooms/invites/<ticket> or GET /v1/local-room-invites/<ticket>.
  for (const code of ["invite_not_found", "expired", "revoked", "ended", "rate_limited", "network", "unchecked", "server_error"]) {
    assert.match(page, new RegExp(`${code}:["\`]`), `every reachable refusal has its own sentence: ${code}`);
  }
  // `already_claimed` is only written by claimLocalRoomInvite and `locked_out` only by the claim/join
  // lockout check: neither preview can answer with them, so the page must not carry their sentences.
  for (const code of ["already_claimed", "locked_out"]) {
    assert.equal(new RegExp(`${code}:["\`]`).test(page), false, `${code} is unreachable from the preview request`);
  }
  // "Nothing can check this yet" is a different fact from "this link is not valid", and it is the one a
  // server without the local endpoint answers (Fastify's 404 has no invite code).
  assert.match(page, /status===404&&!known\?ERR\.unchecked/);
  // A rate limit that names a retry time is not shown as a raw code either.
  assert.equal(/Something went wrong \(\$\{/.test(page), false, "no raw code on screen");
});

test("#61: the handle in the path is display-only and escaped; the server never reflects it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const plain = await get(s.base, `/r/@ann.bot/${LOCAL_TICKET}`);
  const hostile = await get(s.base, `/r/${encodeURIComponent("<script>alert(1)</script>")}/${LOCAL_TICKET}`);
  assert.equal(hostile.status, 200, "an odd handle is still just a page");
  // Byte-identical: the path never reaches the HTML, so injection can only happen in the page's own
  // rendering, where the handle goes through esc() (asserted below).
  assert.equal(hostile.body, plain.body);
  assert.equal(hostile.body.includes("<script>alert(1)"), false);
  assert.match(page, /const host=esc\(lead\)/);
  assert.equal(/innerHTML=[^;]*\$\{handle\}/.test(page), false, "the raw handle is never interpolated");
});

test("#61: a face ticket on the one-segment route still serves the page, unchanged in shape", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const r = await get(s.base, `/r/${FACE_TICKET}`);
  assert.equal(r.status, 200);
  assert.equal(r.body, (await get(s.base, `/r/@ann.bot/${LOCAL_TICKET}`)).body, "one template for both shapes");
});

// Run the page's own script against a real server: a stub element for #c, the path a QR code encodes, and
// fetch pointed at the test server. What a person sees is the element's innerHTML once the preview answered.
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
  };
  vm.runInNewContext(script, ctx);
  await done;
  return el.innerHTML;
}
async function mintLocal(base: string, o: any, name = "Launch plan") {
  const r = await fetch(base + "/v1/local-room-invites", {
    method: "POST",
    headers: { authorization: `Bearer ${o.owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ room_id: "session-61", name, bot_id: o.bot.id }),
  });
  assert.equal(r.status, 201);
  return (await r.json()) as { ticket: string; url: string };
}

test("#61: a real local invite renders its name and the server's inviter, with no face-room count", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mintLocal(s.base, A, "Launch & plan");
  const html = await render(s.base, new URL(m.url).pathname);
  assert.match(html, /<h2>Launch &amp; plan<\/h2>/, "the room name, escaped");
  assert.ok(html.includes(A.handle), "the inviter's handle from the server");
  assert.match(html, /paste it back into your own FlyBot/);
  // The local preview has no member_count / max_members: nothing may render as an empty or "undefined" count.
  assert.equal(html.includes("undefined"), false, html);
  assert.equal(/in the room<\/span>/.test(html), false, "no face-room member count on a local invite");
  assert.equal(html.includes("Someone changed the link"), false, "the honest link is not flagged");
});

test("#61: a link edited to name another Bot still shows the real inviter and says so", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mintLocal(s.base, A);
  const html = await render(s.base, `/r/@trusted.bank.bot/${m.ticket}`);
  const host = /Host: <b>([^<]*)<\/b>/.exec(html)?.[1] ?? "";
  assert.ok(host.length > 0, html);
  assert.equal(host.includes("trusted"), false, "the edited handle is never shown as the host");
  assert.ok(html.includes(`(${A.handle})`), "the server's inviter handle sits beside the host");
  assert.match(html, /This link names @trusted\.bank\.bot, but the invite was made by/);
  const hostile = await render(s.base, `/r/${encodeURIComponent("<img src=x onerror=alert(1)>")}/${m.ticket}`);
  assert.equal(hostile.includes("<img"), false, "the edited handle is escaped where it is drawn");
});

test("#61: refusals from the real local endpoint each read as their own sentence", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const missing = await render(s.base, `/r/${A.handle}/abcdefghijklmnopqrstuv`);
  assert.match(missing, /This invite link is not valid\./);
  assert.match(missing, /Ask the room&#39;s owner for a new link\./);
  const m = await mintLocal(s.base, A);
  await fetch(s.base + `/v1/local-room-invites/${m.ticket}`, { method: "DELETE", headers: { authorization: `Bearer ${A.owner.token}` } });
  assert.match(await render(s.base, new URL(m.url).pathname), /This invite was revoked by the room&#39;s owner\./);
  // A face ticket keeps the face wording (negative control).
  assert.match(await render(s.base, `/r/${FACE_TICKET}`), /Ask the room lead for a new link\./);
});
