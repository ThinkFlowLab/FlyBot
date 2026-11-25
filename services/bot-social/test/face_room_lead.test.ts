// FlyBot #476 / bot-social #32: a face room's lead (picked only by the room creator) and member role labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leadSystemText } from "../src/face-rooms.js";
import { openDb } from "../src/db.js";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join_ } from "node:path";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
type Who = Awaited<ReturnType<typeof ownerWithBot>>;
const join = (base: string, o: Who, code: string, bots: string[] = [o.bot.id]) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
const view = (base: string, o: Who, roomId: string) => req(base, "GET", `/v1/face-rooms/${roomId}`, o.owner.token);
const setLead = (base: string, o: Who, roomId: string, bot: string | null, token = o.owner.token) => req(base, "POST", `/v1/face-rooms/${roomId}/lead`, token, { bot });
const second = async (o: Who, name: string) => {
  const local = o.handle.replace(/^@/, "").replace(/\.bot$/, "");
  const r = await o.owner.req("POST", "/v1/bots", { handle: `${local}-${name}.bot`, display_name: name });
  return { id: r.bot_id as string, handle: `@${local}-${name}.bot` };
};

/** Two homes, one Bot each: Ann created the room, so the default lead is Ann's Bot. */
async function twoHomeRoom(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, "616161");
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, "616161")).status, 200);
  return { s, A, B, roomId: a.body.room_id as string };
}

async function room(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a2 = await second(A, "two");
  // Ben's Bot is in first by time only if he joins first; here Ann creates the room.
  const a = await join(s.base, A, "515151");
  assert.equal(a.status, 200);
  const b = await join(s.base, B, "515151");
  assert.equal(b.status, 200);
  const more = await join(s.base, A, "515151", [a2.id]);
  assert.equal(more.status, 200);
  return { s, A, B, a2, roomId: a.body.room_id as string };
}

test("leadSystemText names the lead or the default", () => {
  assert.equal(leadSystemText({ display_name: "Writer", owner_name: "Ann" }, "set"), "Room lead: Ann's Writer");
  assert.match(leadSystemText(null, "cleared"), /default/);
  assert.match(leadSystemText(null, "lead_left"), /left/);
});

test("default lead is the creator's first Bot that joined; every member sees the same lead and the creator", async (t) => {
  const { s, A, B, roomId } = await room(t);
  const va = await view(s.base, A, roomId);
  const vb = await view(s.base, B, roomId);
  for (const v of [va, vb]) {
    assert.equal(v.body.lead_bot_handle, null);
    assert.equal(v.body.effective_lead_bot_handle, A.handle);
    assert.equal(v.body.created_by.owner_name, "ann");
  }
  assert.equal(va.body.created_by_me, true);
  assert.equal(vb.body.created_by_me, false);
  assert.ok(va.body.members.every((m: any) => m.role === null));
});

test("only the creator sets or clears the lead, with an owner token, to a Bot in the room", async (t) => {
  const { s, A, B, a2, roomId } = await room(t);
  const no = await setLead(s.base, B, roomId, B.handle);
  assert.equal(no.status, 403);
  assert.equal(no.body.error.code, "not_room_creator");
  const botToken = await setLead(s.base, A, roomId, B.handle, A.reg.bot_token);
  assert.equal(botToken.status, 403);
  const stranger = await ownerWithBot(s.base, "cy");
  assert.equal((await setLead(s.base, stranger, roomId, B.handle)).status, 404);
  const outside = await second(A, "out");
  const bad = await setLead(s.base, A, roomId, outside.handle);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "bot_not_in_room");

  // Any Bot of any home can lead.
  const ok = await setLead(s.base, A, roomId, B.handle);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.lead_bot_handle, B.handle);
  assert.equal(ok.body.effective_lead_bot_handle, B.handle);
  const vb = await view(s.base, B, roomId);
  assert.equal(vb.body.effective_lead_bot_handle, B.handle);
  const ev = vb.body.events.find((e: any) => e.type === "room.lead_changed");
  assert.ok(ev);
  assert.equal(ev.reason, "set");
  assert.equal(ev.lead.handle, B.handle);
  assert.equal(ev.trust, "platform");
  assert.equal(ev.text, `Room lead: ben's ${vb.body.members.find((m: any) => m.handle === B.handle).display_name}`);
  // The event reached every member Bot's inbox.
  const inbox = await B.bot.req("GET", "/v1/events?since=0");
  assert.ok(inbox.events.some((e: any) => e.event_type === "face_room.lead_changed" && e.room_id === roomId && e.effective_lead_bot_handle === B.handle));

  // By bot id too; the same lead again writes no event.
  await setLead(s.base, A, roomId, a2.id);
  const before = (await view(s.base, A, roomId)).body.events.filter((e: any) => e.type === "room.lead_changed").length;
  await setLead(s.base, A, roomId, a2.handle);
  assert.equal((await view(s.base, A, roomId)).body.events.filter((e: any) => e.type === "room.lead_changed").length, before);

  const cleared = await setLead(s.base, A, roomId, null);
  assert.equal(cleared.body.lead_bot_handle, null);
  assert.equal(cleared.body.effective_lead_bot_handle, A.handle);
  assert.equal(cleared.body.events.at(-1).reason, "cleared");
});

test("a lead who leaves resets to the default; the default follows who is still in the room", async (t) => {
  const { s, A, B, a2, roomId } = await room(t);
  await setLead(s.base, A, roomId, B.handle);
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, {});
  assert.equal(left.status, 200);
  const va = await view(s.base, A, roomId);
  assert.equal(va.body.lead_bot_handle, null);
  assert.equal(va.body.effective_lead_bot_handle, A.handle);
  const reset = va.body.events.filter((e: any) => e.type === "room.lead_changed").at(-1);
  assert.equal(reset.reason, "lead_left");
  // The creator's first Bot leaves: the creator's next Bot by join order is the default.
  await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, { bots: [A.handle] });
  assert.equal((await view(s.base, A, roomId)).body.effective_lead_bot_handle, a2.handle);
});

test("when the creator's Bots are all gone, the first Bot that joined leads", async (t) => {
  const { s, A, B, roomId } = await room(t);
  await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  const vb = await view(s.base, B, roomId);
  assert.equal(vb.body.effective_lead_bot_handle, B.handle);
  assert.equal(vb.body.created_by_me, false);
});

test("a membership change that moves the default lead announces one handover, and the new lead hears it", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {})).status, 200);
  const vb = await view(s.base, B, roomId);
  assert.equal(vb.body.effective_lead_bot_handle, B.handle);
  const changes = vb.body.events.filter((e: any) => e.type === "room.lead_changed");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, "handover");
  assert.equal(changes[0].lead_bot_handle, null);
  assert.equal(changes[0].effective_lead_bot_handle, B.handle);
  assert.equal(changes[0].text, `Room lead: ben's ${vb.body.members.find((m: any) => m.handle === B.handle).display_name}`);
  const inbox = await B.bot.req("GET", "/v1/events?since=0");
  assert.ok(inbox.events.some((e: any) => e.event_type === "face_room.lead_changed" && e.room_id === roomId && e.reason === "handover" && e.effective_lead_bot_handle === B.handle));
});

test("the creator coming back takes the default lead back with one more handover", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t);
  await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal((await join(s.base, A, "616161")).status, 200);
  const vb = await view(s.base, B, roomId);
  assert.equal(vb.body.effective_lead_bot_handle, A.handle);
  const changes = vb.body.events.filter((e: any) => e.type === "room.lead_changed");
  assert.deepEqual(changes.map((e: any) => e.reason), ["handover", "handover"]);
  assert.equal(changes[1].effective_lead_bot_handle, A.handle);
});

test("the picked lead leaving stays a lead_left, with no extra handover", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t);
  assert.equal((await setLead(s.base, A, roomId, B.handle)).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, {})).status, 200);
  const va = await view(s.base, A, roomId);
  assert.deepEqual(va.body.events.filter((e: any) => e.type === "room.lead_changed").map((e: any) => e.reason), ["set", "lead_left"]);
});

test("a leave that keeps the same default lead announces nothing", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, {})).status, 200);
  assert.equal((await join(s.base, B, "616161")).status, 200);
  const va = await view(s.base, A, roomId);
  assert.equal(va.body.effective_lead_bot_handle, A.handle);
  assert.deepEqual(va.body.events.filter((e: any) => e.type === "room.lead_changed"), []);
});

test("removing one Bot of the creator's home hands the room to the creator's next Bot, once", async (t) => {
  const { s, A, B, a2, roomId } = await room(t);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, { bots: [A.handle] })).status, 200);
  const vb = await view(s.base, B, roomId);
  assert.equal(vb.body.effective_lead_bot_handle, a2.handle);
  const changes = vb.body.events.filter((e: any) => e.type === "room.lead_changed");
  assert.deepEqual(changes.map((e: any) => e.reason), ["handover"]);
  assert.equal(changes[0].effective_lead_bot_handle, a2.handle);
});

test("each owner sets role labels of their own Bots only; roles are sanitized and shown to every member", async (t) => {
  const { s, A, B, roomId } = await room(t);
  const r = await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: { [A.handle]: "  Writer\n@all " + "x".repeat(100) } });
  assert.equal(r.status, 200);
  const mine = r.body.members.find((m: any) => m.handle === A.handle);
  assert.ok(mine.role.startsWith("Writer") && !/[@\n]/.test(mine.role));
  assert.equal(mine.role.length, 80);
  const theirs = await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: { [B.handle]: "Boss" } });
  assert.equal(theirs.status, 404);
  assert.equal((await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: [] })).status, 400);
  assert.equal((await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: { [A.handle]: 5 } })).status, 400);
  const vb = await view(s.base, B, roomId);
  assert.ok(vb.body.members.find((m: any) => m.handle === A.handle).role.startsWith("Writer"));
  const clear = await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: { [A.handle]: null } });
  assert.equal(clear.body.members.find((m: any) => m.handle === A.handle).role, null);
});

test("platform lists room_lead and member_roles; an old database gains the columns", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const info = await req(s.base, "GET", "/v1/platform");
  assert.ok(info.body.features.includes("room_lead"));
  assert.ok(info.body.features.includes("member_roles"));
  // A database from before #32: face_rooms / face_room_members without the new columns.
  const path = join_(mkdtempSync(join_(tmpdir(), "bs32-")), "old.db");
  const old = new Database(path);
  old.exec("CREATE TABLE face_rooms (id TEXT PRIMARY KEY, code TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, started_at TEXT, closed_at TEXT)");
  old.exec("CREATE TABLE face_room_members (room_id TEXT NOT NULL, bot_id TEXT NOT NULL, owner_id TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT NOT NULL, owner_name TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, added_by_owner_id TEXT, joined_at TEXT NOT NULL, join_seq INTEGER NOT NULL DEFAULT 0, left_at TEXT, PRIMARY KEY (room_id, bot_id))");
  old.close();
  const db = openDb(path);
  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols("face_rooms").includes("lead_bot_id"));
  assert.ok(cols("face_rooms").includes("created_by_owner_id"));
  assert.ok(cols("face_room_members").includes("role"));
  db.close();
});
