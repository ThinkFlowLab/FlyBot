// `sendAsMemberOnce` decides whether to put `attachments` into the signed draft envelope with
// `body.attachments?.length`, so a JSON object has no `.length` and is dropped before any validator sees it: the 202
// carries a line with no file and the card has no file line, while the bot draft door refuses the same body. These
// tests pin one answer: a non-array `attachments` is a 400 before any conversation, message, approval or audit row,
// and every legal shape keeps the bytes it has today (absent and `[]` stay out of the signed payload; `[ref]` carries
// the ref exactly).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

async function post(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* an empty body is not an error here */ }
  return { status: r.status, json, text };
}

function counts(s: any) {
  const db = s.platform.db;
  const one = (sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    conversations: one("SELECT COUNT(*) n FROM conversations"),
    messages: one("SELECT COUNT(*) n FROM messages"),
    approvals: one("SELECT COUNT(*) n FROM approvals"),
    audit: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  };
}

const storedPayload = (s: any, messageId: string) => {
  const row: any = s.platform.db.prepare("SELECT payload FROM messages WHERE id = ?").get(messageId);
  return row ? JSON.parse(row.payload) : null;
};

const cardFor = (s: any, messageId: string) =>
  (s.platform.db.prepare("SELECT summary FROM approvals WHERE subject_id = ?").get(messageId) as any)?.summary ?? "";

let seq = 0;

/** A FlyBot home with an owner login token, plus one consenting peer bot it may write to. */
async function homeWithPeer(base: string) {
  const n = ++seq;
  const fly = await post(base, "/v1/onboard/flybot", { username: `home${n}`, password: "secret-pw", display_name: "Home", bot_handle: `home${n}.bot` });
  assert.equal(fly.status, 201, fly.text);
  const login = await post(base, "/v1/auth/login", { username: `home${n}`, password: "secret-pw" });
  assert.equal(login.status, 200, login.text);
  const token = login.json.owner_token as string;
  const homeId = fly.json.bot.bot_id as string;

  const peer = await ownerWithBot(base, `peer${n}`);
  const rel = await post(base, "/v1/relationships", { from_bot_id: homeId, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] }, token);
  assert.equal(rel.status, 201, rel.text);
  await peer.owner.req("POST", `/v1/relationships/${rel.json.relationship_id}/consent`, {
    decision: "accept", grant_capabilities: [{ capability: "chat.public", scope: {} }],
  });
  return { token, homeId, peerBotId: peer.bot.id as string };
}

/** Eight bytes, so the card's own size line is the fixed `[1 file: <name> (8 B)]`. */
async function upload(base: string, token: string, botId: string, name: string) {
  const r = await post(base, "/v1/attachments", { bot_id: botId, name, mime: "text/plain", content_base64: b64("01234567") }, token);
  assert.equal(r.status, 201, r.text);
  return r.json.attachment;
}

function send(base: string, token: string, homeId: string, peerBotId: string, text: string, attachments: unknown = undefined) {
  return post(base, `/v1/homes/${homeId}/send`, { from_bot_id: homeId, to: peerBotId, text, ...(attachments === undefined ? {} : { attachments }) }, token);
}

// A send whose attachments is an object map is a refusal, not a text-only line: no thread, no message, no card.
test("a home send naming attachments as an object is a 400 and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { token, homeId, peerBotId } = await homeWithPeer(s.base);
  const ref = await upload(s.base, token, homeId, "one.txt");

  const before = counts(s);
  const r = await send(s.base, token, homeId, peerBotId, "msg with object map", { "0": ref });

  assert.equal(r.status, 400, `object attachments answered ${r.status} ${r.text}`);
  assert.equal(r.json?.error?.code, "invalid_request");
  assert.match(String(r.json?.error?.message), /attachments must be an array/);
  assert.deepEqual(counts(s), before, "a refused send opens no conversation, writes no message, no approval, no audit row");
  const bound = (s.platform.db.prepare("SELECT COUNT(*) n FROM attachments WHERE message_id IS NOT NULL").get() as any).n as number;
  assert.equal(bound, 0, "a refused send binds no uploaded file to a message");
});

// A string ref id has never been a legal shape on this door; it must stay a 400 after the gate moves earlier.
test("a home send naming attachments as a string is still a 400", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { token, homeId, peerBotId } = await homeWithPeer(s.base);
  const ref = await upload(s.base, token, homeId, "two.txt");

  const before = counts(s);
  const r = await send(s.base, token, homeId, peerBotId, "msg with string ref", ref.id);
  assert.equal(r.status, 400, `string attachments answered ${r.status} ${r.text}`);
  assert.equal(r.json?.error?.code, "invalid_request");
  assert.match(String(r.json?.error?.message), /attachments must be an array/);
  assert.deepEqual(counts(s), before, "a refused send writes nothing");
});

// The legal shapes are a byte contract: absent and [] stay out of the signed payload, [ref] carries the ref and the
// card lists the file. A fix that passes everything through to `checkRefs` would put `attachments: []` into the
// payload and change the bytes of a legal call.
test("legal attachment shapes keep the signed payload and the card byte for byte", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { token, homeId, peerBotId } = await homeWithPeer(s.base);
  const ref = await upload(s.base, token, homeId, "one.txt");

  const none = await send(s.base, token, homeId, peerBotId, "no files");
  assert.equal(none.status, 202, none.text);
  const nonePayload = storedPayload(s, none.json.message.message_id);
  assert.equal("attachments" in nonePayload, false, "an absent attachments field stays absent");

  const empty = await send(s.base, token, homeId, peerBotId, "empty list", []);
  assert.equal(empty.status, 202, empty.text);
  const emptyPayload = storedPayload(s, empty.json.message.message_id);
  assert.equal("attachments" in emptyPayload, false, "an empty array stays dropped, as today");

  const one = await send(s.base, token, homeId, peerBotId, "one file", [ref]);
  assert.equal(one.status, 202, one.text);
  const onePayload = storedPayload(s, one.json.message.message_id);
  assert.deepEqual(onePayload.attachments, [ref], "the ref rides in the signed payload exactly");
  assert.match(cardFor(s, one.json.message.message_id), /\[1 file: one\.txt \(8 B\)\]/, "the card lists the file it carries");
});

// The bot draft door is the control: it already refuses the same shape, so a fix may not widen it to make the home
// door agree from the outside.
test("the bot draft door still refuses an object attachments", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "sender");
  const B = await ownerWithBot(s.base, "receiver");
  const rel = await post(s.base, "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] }, A.owner.token);
  await B.owner.req("POST", `/v1/relationships/${rel.json.relationship_id}/consent`, { decision: "accept", grant_capabilities: [{ capability: "chat.public", scope: {} }] });
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "chat" });
  const ref = await upload(s.base, A.owner.token, A.bot.id, "four.txt");

  const env = A.bot.envelope("message.draft", { text: "bot door", attachments: { "0": ref } }, { conversation_id: conv.conversation_id });
  const r = await post(s.base, `/v1/conversations/${conv.conversation_id}/messages`, env, A.bot.cred.token);
  assert.equal(r.status, 400, `bot door object map answered ${r.status} ${r.text}`);
  assert.equal(r.json?.error?.code, "invalid_request");
  assert.equal(r.json?.error?.message, "payload.attachments must be an array");
});
