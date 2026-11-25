// A per-Bot share that ran out on its own clock is not a capability. Seating another owner's Bot is the moment
// that has to be read, not the next sweep: the row still says `active` until a reader flips it, and a room join
// gives away exactly what the lapsed share was for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

test("a lapsed share cannot seat its Bot, and a live one still can", async () => {
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    // Control: while the share is live, B may bring A's Bot into a room.
    const live = await B.owner.req("POST", "/v1/face-rooms/join", { code: "681234", bots: [B.bot.id, A.bot.id] });
    assert.ok(live.members.some((m: any) => m.bot_id === A.bot.id), "a live share seats the other owner's Bot");

    S.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE grantor_owner = ? AND grantee_bot = ? AND room_id IS NULL AND status = 'active'")
      .run(past(), A.owner_id, B.bot.id);
    const roomsBefore = count(S.platform.db, "SELECT COUNT(*) n FROM face_rooms");
    const usesBefore = count(S.platform.db, "SELECT COUNT(*) n FROM grant_rooms");
    const roomGrantsBefore = count(S.platform.db, "SELECT COUNT(*) n FROM grants WHERE room_id IS NOT NULL");

    // Refused whole, before the room is opened and before any seat or room grant is written.
    await expectApiError(B.owner.req("POST", "/v1/face-rooms/join", { code: "681235", bots: [B.bot.id, A.bot.id] }), 404, "bot_not_found");

    assert.equal(count(S.platform.db, "SELECT COUNT(*) n FROM face_rooms"), roomsBefore, "no room was opened for the refused join");
    assert.equal(count(S.platform.db, "SELECT COUNT(*) n FROM grant_rooms"), usesBefore, "the join recorded no room use");
    assert.equal(count(S.platform.db, "SELECT COUNT(*) n FROM grants WHERE room_id IS NOT NULL"), roomGrantsBefore, "the join wrote no room grant");
    assert.equal(count(S.platform.db, "SELECT COUNT(*) n FROM face_room_members WHERE bot_id = ? AND left_at IS NULL", A.bot.id), 1, "the other owner's Bot keeps only the seat the live share made");

    // The refusal is about the share, never about joining: B's own Bot still opens a room for itself.
    const own = await B.owner.req("POST", "/v1/face-rooms/join", { code: "681236", bots: [B.bot.id] });
    assert.deepEqual(own.members.map((m: any) => m.bot_id), [B.bot.id], "an owner's own Bot still seats itself");
  } finally {
    await S.stop();
  }
});
