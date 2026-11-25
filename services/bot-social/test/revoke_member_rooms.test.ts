import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

test("revoking a home member removes it from its face rooms", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  const B = await ownerWithBot(s.base, "revoked-room");
  const Bp = { kind: "owner" as const, ownerId: B.owner_id };
  const rel = p.requestRelationship(A, { from_bot_id: writer.bot_id, target_bot_id: B.bot.id });
  p.consent(Bp, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const joined = p.joinFaceRoom(A, { code: "246810", bots: [writer.bot_id] });
  const joinedB = p.joinFaceRoom(Bp, { code: "246810", bots: [B.bot.id] });
  assert.equal(joined.room_id, joinedB.room_id);

  p.removeHomeMember(A, a.home.bot_id, writer.bot_id);

  const view = p.getFaceRoom(Bp, joined.room_id);
  assert.ok(!view.members.some((m: any) => m.bot_id === writer.bot_id), "the revoked Bot is gone from the room");
  assert.notEqual(view.status, "closed", "the room stays for the remaining member");
});
