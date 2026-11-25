import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startServer, ownerWithBot, friends, bulkAuth } from "./helpers.js";

/** The three text fields this PR guards, and the four non-string shapes a JSON body can carry for them. */
const SHAPES: [string, unknown][] = [
  ["object", {}],
  ["boolean", true],
  ["array", [1]],
  ["number", 1.5],
];

type Server = Awaited<ReturnType<typeof startServer>>;

const rows = (s: Server, table: string) => (s.platform.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n as number;
const audits = (s: Server) => s.platform.audit.list().length;
const events = (s: Server, type: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = ?").get(type) as any).n as number;
const lastStored = (s: Server, table: string, column: string) =>
  (s.platform.db.prepare(`SELECT ${column} v FROM ${table} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as any)?.v;

/** A refused text field answers 400 invalid_request with the field's own message, and never any other status. */
async function refused(run: () => Promise<unknown>, field: string, shape: string, text: string) {
  try {
    await run();
  } catch (e: any) {
    assert.equal(e.status, 400, `${field} [${shape}] status: ${e.status} ${e.code}`);
    assert.equal(e.code, "invalid_request", `${field} [${shape}] code`);
    assert.ok(String(e.message).endsWith(`${text} must be a string`), `${field} [${shape}] message: ${e.message}`);
    return;
  }
  assert.fail(`${field} [${shape}] was accepted instead of refused`);
}

async function freshPair(s: Server, tag: string) {
  const A = await ownerWithBot(s.base, `alice-${tag}`);
  const B = await ownerWithBot(s.base, `bob-${tag}`);
  return { A, B };
}

async function freshChat(s: Server) {
  const { A, B } = await friends(s.base);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "sync" });
  return { A, B, cid: conv.conversation_id as string };
}

describe("a text field that is not a string is refused before anything is written", () => {
  test("invites.message: owner door refuses every non-string shape and stores nothing", async () => {
    const s = await startServer(bulkAuth);
    try {
      const A = await ownerWithBot(s.base, "alice-invite");
      for (const [shape, value] of SHAPES) {
        const before = rows(s, "invites");
        const auditBefore = audits(s);
        await refused(() => A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id, message: value }), "invites.message", shape, "message");
        assert.equal(rows(s, "invites"), before, `invites.message [${shape}] wrote an invite row`);
        assert.equal(audits(s), auditBefore, `invites.message [${shape}] wrote an audit line`);
      }
    } finally { await s.stop(); }
  });

  test("invites.message: signed invite.create takes the same gate", async () => {
    const s = await startServer(bulkAuth);
    try {
      const A = await ownerWithBot(s.base, "alice-invite-bot");
      for (const [shape, value] of SHAPES) {
        const before = rows(s, "invites");
        const auditBefore = audits(s);
        await refused(() => A.bot.signed("/v1/invites", "invite.create", { message: value }), "bot invite.create message", shape, "message");
        assert.equal(rows(s, "invites"), before, `bot invite.create message [${shape}] wrote an invite row`);
        assert.equal(audits(s), auditBefore, `bot invite.create message [${shape}] wrote an audit line`);
      }
    } finally { await s.stop(); }
  });

  test("relationships.message: owner door refuses before DLP and before the row", async () => {
    const s = await startServer(bulkAuth);
    try {
      for (const [shape, value] of SHAPES) {
        const { A, B } = await freshPair(s, `rel-${shape}`);
        const before = rows(s, "relationships");
        const auditBefore = audits(s);
        const eventBefore = events(s, "relationship.requested");
        await refused(() => A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: value }), "relationships.message", shape, "message");
        assert.equal(rows(s, "relationships"), before, `relationships.message [${shape}] wrote a relationship row`);
        assert.equal(audits(s), auditBefore, `relationships.message [${shape}] wrote an audit line`);
        assert.equal(events(s, "relationship.requested"), eventBefore, `relationships.message [${shape}] emitted an event`);
      }
    } finally { await s.stop(); }
  });

  test("relationships.message: signed relationship.request takes the same gate", async () => {
    const s = await startServer(bulkAuth);
    try {
      for (const [shape, value] of SHAPES) {
        const { A, B } = await freshPair(s, `relbot-${shape}`);
        const before = rows(s, "relationships");
        const auditBefore = audits(s);
        await refused(() => A.bot.signed("/v1/relationships", "relationship.request", { target_handle: B.handle, message: value }), "bot relationship.request message", shape, "message");
        assert.equal(rows(s, "relationships"), before, `bot relationship.request message [${shape}] wrote a relationship row`);
        assert.equal(audits(s), auditBefore, `bot relationship.request message [${shape}] wrote an audit line`);
      }
    } finally { await s.stop(); }
  });

  test("conversations.summary: owner close refuses and the chat stays open", async () => {
    const s = await startServer(bulkAuth);
    try {
      for (const [shape, value] of SHAPES) {
        const { A, cid } = await freshChat(s);
        const auditBefore = audits(s);
        const eventBefore = events(s, "conversation.closed");
        await refused(() => A.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "agreed", summary: value }), "conversations.summary", shape, "summary");
        const row = s.platform.db.prepare("SELECT status, summary FROM conversations WHERE id = ?").get(cid) as any;
        assert.equal(row.status, "open", `conversations.summary [${shape}] closed the chat anyway`);
        assert.equal(row.summary, null, `conversations.summary [${shape}] stored a summary anyway`);
        assert.equal(audits(s), auditBefore, `conversations.summary [${shape}] wrote an audit line`);
        assert.equal(events(s, "conversation.closed"), eventBefore, `conversations.summary [${shape}] emitted an event`);
      }
    } finally { await s.stop(); }
  });

  test("conversations.summary: signed conversation.close takes the same gate", async () => {
    const s = await startServer(bulkAuth);
    try {
      for (const [shape, value] of SHAPES) {
        const { A, cid } = await freshChat(s);
        const auditBefore = audits(s);
        await refused(() => (A.bot.close as any)(cid, "agreed", value), "bot conversation.close summary", shape, "summary");
        const row = s.platform.db.prepare("SELECT status, summary FROM conversations WHERE id = ?").get(cid) as any;
        assert.equal(row.status, "open", `bot conversation.close summary [${shape}] closed the chat anyway`);
        assert.equal(row.summary, null, `bot conversation.close summary [${shape}] stored a summary anyway`);
        assert.equal(audits(s), auditBefore, `bot conversation.close summary [${shape}] wrote an audit line`);
      }
    } finally { await s.stop(); }
  });

  test("controls: absent, null and the empty string keep their old meaning", async () => {
    const s = await startServer(bulkAuth);
    try {
      const A = await ownerWithBot(s.base, "alice-control");
      for (const [shape, message] of [["absent", undefined], ["null", null], ["empty", ""]] as [string, any][]) {
        const body: any = { bot_id: A.bot.id };
        if (shape !== "absent") body.message = message;
        await A.owner.req("POST", "/v1/invites", body);
        assert.equal(lastStored(s, "invites", "message"), shape === "empty" ? "" : null, `invites.message [${shape}]`);

        const { A: C, B } = await freshPair(s, `ctl-${shape}`);
        const relBody: any = { from_bot_id: C.bot.id, target_handle: B.handle };
        if (shape !== "absent") relBody.message = message;
        await C.owner.req("POST", "/v1/relationships", relBody);
        assert.equal(lastStored(s, "relationships", "message"), shape === "empty" ? "" : null, `relationships.message [${shape}]`);

        const chat = await freshChat(s);
        const closeBody: any = { outcome: "agreed" };
        if (shape !== "absent") closeBody.summary = message;
        await chat.A.owner.req("POST", `/v1/conversations/${chat.cid}/close`, closeBody);
        const row = s.platform.db.prepare("SELECT summary FROM conversations WHERE id = ?").get(chat.cid) as any;
        assert.equal(row.summary, shape === "empty" ? "" : null, `conversations.summary [${shape}]`);
      }
    } finally { await s.stop(); }
  });
});
