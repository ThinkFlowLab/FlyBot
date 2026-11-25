import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A friend-invite link is a bearer credential aimed at one Bot. A link handed out before an emergency stop therefore
// has to stop advertising that Bot while it is stopped: a stranger who opens it is told the link is live and is
// invited to have their assistant join, and then `joinInvite` answers `403 bot_frozen` (`assertInvitable` has run
// there since #142). The preview is the first thing a leaked link shows, so it is the same state gate, not a
// withdrawal: the invite row stays as it is and resuming the Bot reopens the very same link.
//
// The owner's own `GET /v1/invites` list is the owner's view of the row, not the public preview, and stays `active`
// while the Bot is stopped. A preview spends no use either way.

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;
const mint = (base: string, o: any) => req(base, "POST", "/v1/invites", tok(o), { bot_id: o.bot.id });
const preview = (base: string, code: string) => req(base, "GET", `/v1/invites/${code}`);
const stop = (base: string, o: any) => req(base, "POST", "/v1/emergency-stop", tok(o), { bot_id: o.bot.id });
const resume = (base: string, o: any) => req(base, "POST", `/v1/bots/${o.bot.id}/resume`, tok(o));
const inviteRow = (s: { platform: any }, code: string) =>
  s.platform.db.prepare("SELECT status, uses FROM invites WHERE code = ?").get(code) as any;
const relationships = (s: { platform: any }, botId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM relationships WHERE (requester_bot = ? OR target_bot = ?) AND status != 'room'").get(botId, botId) as any).n as number;

test("a link from a Bot that was stopped after it was handed out stops previewing", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const a = await ownerWithBot(s.base, "invfrz");
  const inv = await mint(s.base, a);
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  // The control: while the Bot is active the public link reads live and names it.
  const live = await preview(s.base, inv.body.code);
  assert.equal(live.status, 200);
  assert.equal(live.body.status, "active");
  assert.equal(live.body.inviter.handle, a.handle);

  assert.equal((await stop(s.base, a)).status, 200);

  // The public preview must say what the join says: a state gate, not "come on in".
  const refused = await preview(s.base, inv.body.code);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "bot_frozen");
  assert.equal(refused.body.error.message, "this bot is frozen (emergency stop)");
  assert.equal(refused.body.inviter, undefined, "a refused preview leaks no inviter card");

  // The stop is a state, not a withdrawal: the row is untouched, which is what lets Resume reopen it below.
  assert.deepEqual({ ...inviteRow(s, inv.body.code) }, { status: "active", uses: 0 });
});

test("a link from a removed Bot answers bot_revoked", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const a = await ownerWithBot(s.base, "invrev");
  const inv = await mint(s.base, a);
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(a.bot.id);

  const refused = await preview(s.base, inv.body.code);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "bot_revoked");
  assert.equal(refused.body.error.message, "this bot identity was revoked");
  assert.equal(inviteRow(s, inv.body.code).uses, 0);
});

test("resuming the Bot reopens the same link, and no preview spends a use", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const a = await ownerWithBot(s.base, "invfrzresume");
  const inv = await mint(s.base, a);
  assert.equal((await stop(s.base, a)).status, 200);
  const back = await resume(s.base, a);
  assert.equal(back.status, 200);
  const reopened = await preview(s.base, inv.body.code);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.status, "active");
  assert.equal(reopened.body.inviter.handle, a.handle);
  assert.equal(inviteRow(s, inv.body.code).uses, 0, "a preview never spends the link's uses");
});

test("the owner's own invite list stays the owner's view while the Bot is stopped", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const a = await ownerWithBot(s.base, "invfrzlist");
  const inv = await mint(s.base, a);
  assert.equal((await stop(s.base, a)).status, 200);

  const list = await req(s.base, "GET", "/v1/invites", tok(a));
  assert.equal(list.status, 200);
  const row = list.body.invites.find((i: any) => i.invite_id === inv.body.invite_id);
  assert.equal(row.status, "active", "the owner's list is the row, unchanged by the stop");
  assert.equal(row.uses, 0);
  assert.equal(row.bot.handle, a.handle);
});

test("a stop, a live preview and a join never line up: the illegal state is unreachable at every step", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const a = await ownerWithBot(s.base, "invfrzwalk");
  const b = await ownerWithBot(s.base, "invfrzwalkjoin");
  const inv = await mint(s.base, a);
  const usage = () => inviteRow(s, inv.body.code).uses;
  const isLive = (p: { status: number; body: any }) => p.status === 200 && p.body.status === "active";

  // Walk stop -> preview -> join -> resume -> preview -> join -> preview. The point is the pairing at every step,
  // not only the final answer: a preview that reads live while the Bot is not active is the illegal state, and so
  // is a join that writes anything behind a refused preview.
  assert.equal(isLive(await preview(s.base, inv.body.code)), true, "the link reads live while the Bot runs");

  assert.equal((await stop(s.base, a)).status, 200);
  const whileFrozen = await preview(s.base, inv.body.code);
  assert.equal(isLive(whileFrozen), false, "a stopped Bot's link never previews live");
  assert.equal(whileFrozen.status, 403);
  assert.equal(whileFrozen.body.error.code, "bot_frozen", "the preview answers what the join would answer");

  const usedBefore = usage();
  const refusedJoin = await req(s.base, "POST", `/v1/invites/${inv.body.code}/join`, tok(b), { from_bot_id: b.bot.id });
  assert.equal(refusedJoin.status, 403);
  assert.equal(refusedJoin.body.error.code, "bot_frozen");
  assert.equal(usage(), usedBefore, "a refused join spends no use");
  assert.equal(relationships(s, a.bot.id), 0, "a refused join writes no relationship");
  assert.equal(relationships(s, b.bot.id), 0);

  assert.equal((await resume(s.base, a)).status, 200);
  const reopened = await preview(s.base, inv.body.code);
  assert.equal(isLive(reopened), true, "Resume reopens the same link, with nothing restored");
  assert.equal(reopened.body.inviter.handle, a.handle);

  const joined = await req(s.base, "POST", `/v1/invites/${inv.body.code}/join`, tok(b), { from_bot_id: b.bot.id });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(usage(), 1, "the join is the only thing that spends the use");
  assert.equal(relationships(s, a.bot.id), 1);

  // With max_uses 1 the link is spent after that join, and a spent link is the invite's own answer (410), never a
  // live preview.
  assert.equal(isLive(await preview(s.base, inv.body.code)), false);
  assert.equal((await preview(s.base, inv.body.code)).body.status, "used");
});

test("a withdrawn link keeps its own answer even when the Bot is stopped", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const a = await ownerWithBot(s.base, "invfrzrevoked");
  const inv = await mint(s.base, a);
  assert.equal((await req(s.base, "DELETE", `/v1/invites/${encodeURIComponent(inv.body.invite_id)}`, tok(a))).status, 200);
  assert.equal((await stop(s.base, a)).status, 200);

  // The two facts are read in the join's order: the link's own terminal state first, the inviter's state only for a
  // live link. "This invite was revoked" is the answer a holder needs; the stop does not overwrite it.
  const gone = await preview(s.base, inv.body.code);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.status, "revoked");
});
