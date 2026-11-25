import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "./helpers.js";

async function post(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
async function mcpRaw(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const j: any = await r.json();
  return { isError: !!j.result?.isError, value: JSON.parse(j.result.content[0].text) };
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

/** Two FlyBot homes, friends with auto-accept, each with one member: enough for a delivered file. */
async function pair() {
  const s = await startServer({});
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const A = async (name: string, args: unknown = {}) => { const r = await mcpRaw(s.base, a.connector.token, name, args); if (r.isError) throw Object.assign(new Error(r.value.message ?? String(r.value)), r.value); return r.value; };
  const B = async (name: string, args: unknown = {}) => { const r = await mcpRaw(s.base, b.connector.token, name, args); if (r.isError) throw Object.assign(new Error(r.value.message ?? String(r.value)), r.value); return r.value; };
  const writer = await A("add_home_member", { home: a.home.bot_id, name: "Writer" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder" });
  const inv = await A("create_invite", { bot_id: writer.bot_id, auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] });
  await B("join_invite", { code: inv.code ?? inv.invite?.code, from_bot_id: coder.bot_id });
  const back = await B("create_invite", { bot_id: coder.bot_id, auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] });
  await A("join_invite", { code: back.code, from_bot_id: writer.bot_id });
  return { s, a, b, A, B, writer, coder };
}

/** One delivered message carrying one attachment, ready for the recipient to download. */
async function delivered(cx: Awaited<ReturnType<typeof pair>>) {
  const up = await cx.A("upload_attachment", { bot_id: cx.writer.bot_id, name: "note.txt", content_base64: b64("hello attachment") });
  const sent = await cx.A("send_as_member", { from_bot_id: cx.writer.bot_id, to: cx.coder.handle, text: "see attached", attachments: [up.attachment] });
  const approvals = await cx.A("list_approvals");
  const card = (approvals.approvals ?? approvals).find((x: any) => x.approval_id === sent.message.approval_id);
  cx.s.platform.decideApproval({ kind: "owner", ownerId: cx.a.owner_id ?? cx.a.owner?.owner_id } as any, card.approval_id, { decision: "approved" });
  const row: any = cx.s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(sent.message.message_id);
  assert.equal(row.status, "delivered", "the fixture must deliver the file first");
  return up;
}

test("get_attachment declares the audit line it writes: the read entry is not read-only", async (t) => {
  const cx = await pair();
  const s = cx.s;
  t.after(s.stop);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${cx.b.connector.token}` } } }));
  t.after(async () => { await c.close(); });

  const listed: any = await c.listTools();
  const tool = listed.tools.find((x: any) => x.name === "get_attachment");
  assert.ok(tool, "get_attachment is registered");
  // Every download appends an `attachment.downloaded` audit row, so the machine-readable hint clients act on must
  // stop claiming the call leaves nothing behind.
  assert.equal(tool.annotations?.readOnlyHint, false, "a download appends an audit row, so readOnlyHint must be false");
  // It appends an audit line only: nothing is deleted and nothing outside the server is reached.
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.annotations?.openWorldHint, false);
  // The fix is scoped to the tool: the shared read defaults other tools use must stay intact. `list_conversations` is
  // not in this set any more, because its read settles lapsed cards and it declares that write itself.
  for (const name of ["whoami", "custody_status"]) {
    const neighbour = listed.tools.find((x: any) => x.name === name);
    assert.ok(neighbour, `${name} is registered`);
    assert.equal(neighbour.annotations?.readOnlyHint, true, `${name} is a pure read and keeps the read default`);
  }
});

test("get_attachment's only write is its own audit line: no business row and no outbound traffic", async (t) => {
  const cx = await pair();
  const s = cx.s;
  t.after(s.stop);
  const up = await delivered(cx);
  const one = (sql: string) => (s.platform.db.prepare(sql).get() as any).n as number;
  const auditN = (action?: string) => (s.platform.audit.db.prepare(action ? "SELECT COUNT(*) n FROM audit_events WHERE action = ?" : "SELECT COUNT(*) n FROM audit_events").get(...(action ? [action] : [])) as any).n as number;
  const snap = () => ({
    audit: auditN(), downloaded: auditN("attachment.downloaded"),
    events: one("SELECT COUNT(*) n FROM events"), webhookDeliveries: one("SELECT COUNT(*) n FROM webhook_deliveries"),
    messages: one("SELECT COUNT(*) n FROM messages"), attachments: one("SELECT COUNT(*) n FROM attachments"),
    relationships: one("SELECT COUNT(*) n FROM relationships"), grants: one("SELECT COUNT(*) n FROM grants"),
  });
  const before = snap();
  const got = await cx.B("get_attachment", { attachment_id: up.attachment.id });
  assert.equal(Buffer.from(got.content_base64, "base64").toString(), "hello attachment");
  const after = snap();
  const delta = Object.fromEntries(Object.keys(before).map((k) => [k, (after as any)[k] - (before as any)[k]]));
  assert.deepEqual(delta, { audit: 1, downloaded: 1, events: 0, webhookDeliveries: 0, messages: 0, attachments: 0, relationships: 0, grants: 0 },
    "one audit row and nothing else: no domain write, no webhook");
  const row: any = s.platform.audit.db.prepare("SELECT actor, subject, data FROM audit_events WHERE action = 'attachment.downloaded'").get();
  assert.equal(row.actor, "platform");
  assert.equal(row.subject, up.attachment.id);
  assert.equal(JSON.parse(row.data).sha256, up.attachment.sha256);
  // A second download is idempotent apart from its own audit line.
  const second: any = await cx.B("get_attachment", { attachment_id: up.attachment.id });
  assert.equal(second.content_base64, got.content_base64);
  assert.deepEqual({ ...snap(), audit: 0, downloaded: 0 }, { ...after, audit: 0, downloaded: 0 });
  assert.equal(auditN() - after.audit, 1, "each download leaves exactly one row");
});
