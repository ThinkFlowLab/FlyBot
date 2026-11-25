import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { friends, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Two friends whose owners also put both Bots in one face room; that join is the owner's click (#45). */
async function roomWithBoth(base: string, A: any, B: any) {
  const a = await req(base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "515151", bots: [A.bot.id] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await req(base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "515151", bots: [B.bot.id] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.room_id, a.body.room_id);
  return a.body.room_id as string;
}

test("#45: a room-context line leaves without a card, a finding keeps its card", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await roomWithBoth(s.base, A, B);
  assert.match(roomId, /^frm_/);
  // the room pairing wrote room-scoped grants; a send may now name that room
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  const owner = { kind: "owner" as const, ownerId: A.owner_id };

  // 1. clean room-context line: no approval card, delivered, and the other home has it
  const sent = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: 'FLYBOT-ROOM-SHARE {"v":1,"op":"ask"}', room_id: roomId });
  assert.equal(sent.message.status, "delivered");
  assert.equal((sent.message as any).auto_approved, true);
  assert.equal((sent.message as any).room_id, roomId);
  assert.deepEqual((sent.message as any).policy.reasons, ["room.context", "dlp.clean"]);
  const peer = await B.bot.events(0);
  assert.ok(peer.events.some((e: any) => e.event_type === "message.received"), "the line arrived at the other home");
  // and no pending approval was left behind for it
  assert.equal(s.platform.listApprovals(owner, "pending").some((a: any) => a.approval_id === (sent.message as any).approval_id), false);

  // 2. the same line without a room context is still held: the control
  const held = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "no room context here" });
  assert.equal(held.message.status, "pending_approval");
  assert.ok((held.message as any).policy.reasons.includes("mvp.all_outbound_requires_approval"));

  // 3. a room-context line that carries a finding keeps its card, with the reason visible
  await req(s.base, "PATCH", "/v1/me", A.owner.token, { sensitive_terms: ["swordfish"] });
  const flagged = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "the swordfish code", room_id: roomId });
  assert.equal(flagged.message.status, "pending_approval");
  assert.ok((flagged.message as any).policy.risk_flags.length > 0);
  assert.ok((flagged.message as any).policy.reasons.some((r: string) => r === "dlp.owner.sensitive_term"), "the finding is in reasons");
  const card = s.platform.listApprovals(owner, "pending").find((a: any) => a.approval_id === (flagged.message as any).approval_id);
  assert.ok(card, "the card is in the queue");
  assert.ok(card.reasons.some((r: string) => r.startsWith("dlp.")));

  // 4. a room-context line with an attachment keeps its card too: the platform found a file of its own
  const up = s.platform.uploadAttachment(owner, { bot_id: A.bot.id, name: "notes.txt", mime: "text/plain", content_base64: Buffer.from("hello").toString("base64") });
  const withFile = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "see the file", attachments: [up.attachment], room_id: roomId });
  assert.equal(withFile.message.status, "pending_approval");
  assert.ok((withFile.message as any).policy.reasons.includes("mvp.all_outbound_requires_approval"));

  // 5. a room both Bots were never in: refused whole, no message and no card
  const before = s.platform.listApprovals(owner, "pending").length;
  assert.throws(
    () => s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "let me in", room_id: "frm_madeup" }),
    (e: any) => e.code === "room_not_shared" && e.status === 403,
  );
  assert.equal(s.platform.listApprovals(owner, "pending").length, before, "nothing was queued");

  // 6. taking B out of the room ends that consent
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, { bots: [B.bot.id] });
  assert.equal(left.status, 200, JSON.stringify(left.body));
  const stillThere = s.platform.listApprovals(owner, "pending").length;
  assert.throws(
    () => s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "after you left", room_id: roomId }),
    (e: any) => e.code === "room_not_shared",
  );
  assert.equal(s.platform.listApprovals(owner, "pending").length, stillThere);
});

test("#45: the MCP send_as_member takes room_id and the tool says what it means", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await roomWithBoth(s.base, A, B);
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${(A.owner as any).token}` } } }));
  t.after(() => c.close());
  const tool = (await c.listTools()).tools.find((x) => x.name === "send_as_member")!;
  assert.ok((tool.inputSchema as any).properties.room_id, "room_id is in the schema");
  assert.match(tool.description ?? "", /room-scoped grant|room both Bots were put in/i);
  const r = JSON.parse((await c.callTool({ name: "send_as_member", arguments: { from_bot_id: A.bot.id, to: B.handle, text: "hello from the room", room_id: roomId } }) as any).content[0].text);
  assert.equal(r.message.status, "delivered");
  assert.equal(r.message.room_id, roomId);
  const bad = await c.callTool({ name: "send_as_member", arguments: { from_bot_id: A.bot.id, to: B.handle, text: "nope", room_id: "frm_madeup" } });
  assert.equal((bad as any).isError, true);
  assert.match((bad as any).content[0].text, /room_not_shared/);
});
