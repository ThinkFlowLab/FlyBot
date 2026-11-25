// `draftMessage` is the door a Bot's signed `message.draft` reaches, and it stores `payload.expects_reply` as the
// `messages.expects_reply` bit the peer's console reads on GET /v1/conversations/:id ("this line may need a reply").
// The field's contract is a boolean (`src/mcp.ts` declares `z.boolean().optional()`), and the owner's edit door
// (`editedPayloadOf`) already answers 400 "edited_payload.expects_reply must be a boolean" for anything else. This
// door asked only `pl.expects_reply !== false`, so `"false"`, 0, {}, [] and 1.5 all became true: a sender that
// explicitly said "no reply needed" handed the peer the opposite signal, a value the peer reads rather than the
// sender. The gate below passes undefined, null and a boolean (null still means "not given", so the default stays
// true) and refuses everything else as 400 `invalid_request` "expects_reply must be a boolean", after the signed
// envelope and before the DLP scan, the row, the card, the audit and the draft budget: a refused draft writes
// nothing and spends nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approveAll, friends, startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;

const nonBoolean: [string, unknown][] = [
  ["the string \"false\"", "false"],
  ["the number 0", 0],
  ["an object", {}],
  ["an array", []],
  ["a fraction", 1.5],
];

/** `signed` throws on a non-2xx; the error carries the status, code and body the door answered. */
async function draft(bot: any, cid: string, payload: Record<string, unknown>) {
  try {
    return { status: 202, json: (await bot.signed(`/v1/conversations/${cid}/messages`, "message.draft", payload, { conversation_id: cid })) as any };
  } catch (e: any) {
    return { status: e.status as number, json: e.body ?? { error: { code: e.code, message: e.message } } };
  }
}

/** Everything a refused draft must leave alone, including the hourly draft budget the door checks. */
function residue(p: any, cid: string, botId: string) {
  const one = (sql: string, ...a: any[]) => (p.db.prepare(sql).get(...a) as any).n as number;
  return {
    messages: one("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", cid),
    approvals: one("SELECT COUNT(*) n FROM approvals WHERE conversation_id = ?", cid),
    audits: p.audit.list().length as number,
    events: one("SELECT COUNT(*) n FROM events"),
    drafts: p.draftBudget(botId).used as number,
  };
}

async function pair(s: Server) {
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "sync" })).conversation_id as string;
  return { A, B, cid };
}

for (const [label, value] of nonBoolean) {
  test(`a Bot draft naming expects_reply as ${label} is a 400 and writes nothing`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const { A, B, cid } = await pair(s);
    const before = residue(p, cid, A.bot.id);

    const r = await draft(A.bot, cid, { text: "hello there", expects_reply: value });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json?.error?.code, "invalid_request", JSON.stringify(r.json));
    assert.equal(r.json?.error?.message, "expects_reply must be a boolean", JSON.stringify(r.json));
    assert.deepEqual(residue(p, cid, A.bot.id), before, "no message, card, audit or event, and no draft budget spent");
    assert.equal((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals.length, 0, "no card was queued");
  });
}

const allowed: [string, unknown, number][] = [
  ["an explicit false", false, 0],
  ["an explicit true", true, 1],
  ["not given", undefined, 1],
  ["null (still not given)", null, 1],
];

for (const [label, value, bit] of allowed) {
  test(`a Bot draft with expects_reply ${label} keeps its meaning for the peer`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const { A, B, cid } = await pair(s);

    const payload: Record<string, unknown> = { text: "hello there" };
    if (value !== undefined) payload.expects_reply = value;
    const r = await draft(A.bot, cid, payload);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal(r.json?.status, "pending_approval");

    const row = p.db.prepare("SELECT expects_reply, payload FROM messages WHERE conversation_id = ?").get(cid) as any;
    assert.equal(row.expects_reply, bit, "the stored bit follows the sent boolean, and defaults to 1");
    assert.equal(JSON.parse(row.payload).expects_reply, bit === 1, "the stored payload agrees with the bit");

    await approveAll(A.owner);
    const view = await B.bot.getConversation(cid);
    const inbound = view.messages.find((m: any) => m.direction === "inbound");
    assert.ok(inbound, "the approved line reached the peer");
    assert.equal(inbound.expects_reply, bit === 1, "the peer reads the value the sender meant");
  });
}
