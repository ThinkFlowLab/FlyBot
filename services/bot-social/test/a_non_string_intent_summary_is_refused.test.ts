// `openConversation` (the write half of `createConversation`, reached by a Bot's signed `conversation.create`) ran
// `String(pl.intent.summary ?? "")` before the peer-facing intent was stored and announced. Nothing checked the
// type: an object was coerced to the text "[object Object]" (an array to "1", a fraction to "1.5"), stored in
// `conversations.intent` and handed to the peer's console and event queue on GET /v1/conversations/:id — a summary
// nobody wrote, read by the other owner. The summary is a string or nothing: undefined and null still mean "no
// summary" (stored as ""), a string is stored as itself, and every other shape is a 400 `invalid_request`
// "summary must be a string" refused before the DLP scan, the row, the audit entry and the events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;

const nonString: [string, unknown][] = [
  ["an object", {}],
  ["a boolean", true],
  ["an array", [1]],
  ["a fraction", 1.5],
];

async function start(A: any, peerId: string, intent: Record<string, unknown>) {
  try {
    return { status: 201, json: (await A.bot.startConversation(peerId, intent)) as any };
  } catch (e: any) {
    return { status: e.status as number, json: e.body ?? { error: { code: e.code, message: e.message } } };
  }
}

/** Nothing of a refused conversation: no row, no card, no audit line and no event. */
function residue(p: any) {
  const one = (sql: string) => (p.db.prepare(sql).get() as any).n as number;
  return {
    conversations: one("SELECT COUNT(*) n FROM conversations"),
    approvals: one("SELECT COUNT(*) n FROM approvals"),
    audits: p.audit.list().length as number,
    events: one("SELECT COUNT(*) n FROM events"),
  };
}

for (const [label, value] of nonString) {
  test(`a Bot conversation naming the intent summary as ${label} is a 400 and writes nothing`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const { A, B } = await friends(s.base);
    const before = residue(p);

    const r = await start(A, B.bot.id, { type: "general_chat", summary: value });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json?.error?.code, "invalid_request", JSON.stringify(r.json));
    assert.equal(r.json?.error?.message, "summary must be a string", JSON.stringify(r.json));
    assert.deepEqual(residue(p), before, "no conversation, card, audit or event");
  });
}

const allowed: [string, unknown, string][] = [
  ["a string", "sync", "sync"],
  ["not given", undefined, ""],
  ["null (still not given)", null, ""],
];

for (const [label, value, stored] of allowed) {
  test(`a Bot conversation with the intent summary ${label} stores it as sent`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const { A, B } = await friends(s.base);

    const intent: Record<string, unknown> = { type: "general_chat" };
    if (value !== undefined) intent.summary = value;
    const r = await start(A, B.bot.id, intent);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const cid = r.json.conversation_id as string;
    const row = p.db.prepare("SELECT intent FROM conversations WHERE id = ?").get(cid) as any;
    assert.equal(JSON.parse(row.intent).summary, stored);

    const view = await B.bot.getConversation(cid);
    assert.equal(view.intent.summary, stored, "the peer reads the summary that was sent");
  });
}
