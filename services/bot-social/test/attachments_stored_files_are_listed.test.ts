// `POST /v1/attachments` puts a file into a home's storage and answers `limits.used_bytes`; an upload over the
// budget is refused with `413 attachment_storage_full` and `used_bytes` / `limit_bytes`. Those were the only places
// the numbers appeared: `GET /v1/me` carries no storage fields, `GET /v1/attachments/{id}` answers the uploading home
// `404 attachment_not_found` (only the recipient of a delivered message may download), and `GET /v1/attachments` had
// no route at all. So a home could not see which files, which Bots and which deadlines its budget stands for.
//
// The read below lists the home's stored files - name, mime, size, hash, the uploading Bot, the message it was sent
// on, created and expiry - with the same totals an upload judges, after sweeping files past their deadline. It never
// returns bytes. The same read is the MCP tool `list_attachments`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

type S = Awaited<ReturnType<typeof startServer>>;
const tokenOf = (c: any) => String(c.token);

async function readList(base: string, token: string) {
  const r = await fetch(`${base}/v1/attachments`, { headers: { authorization: `Bearer ${token}` } });
  let body: any = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

async function upload(base: string, token: string, name: string, text: string, botId?: string) {
  const r = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...(botId ? { bot_id: botId } : {}), name, content_base64: b64(text) }),
  });
  return { status: r.status, body: await r.json() as any };
}

async function mcpRaw(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  return { isError: !!j.result?.isError, value: j.result ? JSON.parse(j.result.content[0].text) : null, raw: j };
}

async function secondBot(s: S, owner: any, handle: string) {
  const kp = generateEd25519();
  return owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
}

test("a home reads back what it stores: both files, newest first, with the Bot and the totals", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const other = await secondBot(s, A.owner, "ann-other.bot");
  const notes = "# notes\n";
  const table = "a,b\n1,2\n";

  const first = await upload(s.base, tokenOf(A.owner), "notes.md", notes, A.bot.id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await upload(s.base, tokenOf(A.owner), "chart.csv", table, other.bot_id);
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const got = await readList(s.base, tokenOf(A.owner));
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const files: any[] = got.body.attachments;
  assert.equal(files.length, 2, "both stored files are listed");
  assert.deepEqual(files.map((f) => f.name), ["chart.csv", "notes.md"], "the newest upload comes first");

  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.equal(byName["notes.md"].bot.id, A.bot.id, "the file names the Bot that uploaded it");
  assert.equal(byName["notes.md"].bot.handle, A.handle, "and its handle");
  assert.equal(byName["notes.md"].size, Buffer.byteLength(notes));
  assert.equal(byName["notes.md"].mime, "text/markdown");
  assert.equal(byName["notes.md"].sha256, first.body.attachment.sha256);
  assert.equal(byName["notes.md"].message_id, null, "unsent files name no message");
  assert.ok(byName["notes.md"].created_at, "the upload time is there");
  assert.ok(byName["notes.md"].expires_at, "and the deadline");
  assert.equal(byName["chart.csv"].bot.id, other.bot_id, "the second file names the second Bot");

  assert.equal(got.body.used_bytes, Buffer.byteLength(notes) + Buffer.byteLength(table), "used_bytes is the sum of what is listed");
  assert.equal(got.body.limit_bytes, first.body.limits.ownerBudgetBytes, "limit_bytes is the budget an upload judges");
  assert.ok(!JSON.stringify(got.body).includes("content_base64"), "no file bytes come back");
});

test("another home's list is empty even when it holds the first home's attachment id", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const mine = await upload(s.base, tokenOf(A.owner), "secret.txt", "only ann's", A.bot.id);
  assert.equal(mine.status, 201, JSON.stringify(mine.body));

  const got = await readList(s.base, tokenOf(B.owner));
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(got.body.attachments, [], "another home's files are not listed");
  assert.equal(got.body.used_bytes, 0, "and do not count against it");
  assert.ok(!JSON.stringify(got.body).includes(mine.body.attachment.id), "the id alone reveals no row");
});

test("a file past its deadline is swept, leaves the list and stops counting", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const up = await upload(s.base, tokenOf(A.owner), "old.txt", "gone soon", A.bot.id);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  s.platform.db.prepare("UPDATE attachments SET expires_at = ? WHERE id = ?").run(PAST, up.body.attachment.id);

  const got = await readList(s.base, tokenOf(A.owner));
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(got.body.attachments, [], "a file past its deadline is gone from the list");
  assert.equal(got.body.used_bytes, 0, "and stops counting");
  const lines = (s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'attachment.expired' AND subject = ?").get(up.body.attachment.id).n as number;
  assert.equal(lines, 1, "the sweep names the file it removed, as every removal does");
});

test("a connector token reads the same rows; a Bot token is refused as a home read", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const up = await upload(s.base, tokenOf(A.owner), "notes.md", "# hi", A.bot.id);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const connector = await A.owner.req("POST", "/v1/connector-tokens", { label: "list" });

  const viaConnector = await readList(s.base, String(connector.token));
  assert.equal(viaConnector.status, 200, JSON.stringify(viaConnector.body));
  assert.equal(viaConnector.body.attachments.length, 1, "the connector sees the home's file");
  assert.equal(viaConnector.body.attachments[0].name, "notes.md");

  const viaBot = await readList(s.base, A.bot.cred.token);
  assert.equal(viaBot.status, 403, "the list is the home's budget, not one Bot's");
  assert.equal(viaBot.body.error.code, "owner_only");
});

test("the owner MCP tool list_attachments answers the same object", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const up = await upload(s.base, tokenOf(A.owner), "notes.md", "# hi", A.bot.id);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const connector = await A.owner.req("POST", "/v1/connector-tokens", { label: "mcp" });

  const r = await mcpRaw(s.base, String(connector.token), "list_attachments");
  assert.equal(r.isError, false, JSON.stringify(r.raw));
  assert.equal(r.value.attachments.length, 1, "the tool lists the stored file");
  assert.equal(r.value.attachments[0].name, "notes.md");
  assert.equal(r.value.used_bytes, Buffer.byteLength("# hi"));
  assert.ok(!JSON.stringify(r.value).includes("content_base64"), "the tool returns no bytes");
});
