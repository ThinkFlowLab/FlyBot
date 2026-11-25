import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

/**
 * An own-invite refusal must be recorded but must not spend the join budget.
 * `POST /v1/local-room-invites/{ticket}/claim` answers `409 own_invite` before it writes an attempt row, so a home
 * testing its own link leaves no trace in `face_room_attempts`. The ticket door already treats a repeat for a home
 * that holds the seat this way (`already_member`, `docs/FACE_ROOMS.md:132`): recorded under its own label, not
 * counted. Same here — the refusal stays visible, and five retries of your own ticket cannot lock this home out of
 * every other room.
 */
const ROOM = "session-3f2a9c1e-6b7d-4e1a-9f0c-2d4b6a8c0e12";
const WRONG = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 base64url chars, the ticket shape the door parses

async function claim(o: any, ticket: string, statuses: number[], bots: string[]) {
  try {
    await o.owner.req("POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, { bots });
    statuses.push(200);
  } catch (e: any) { statuses.push(e.status); }
}

test("an own_invite refusal is recorded under its own label and does not spend the join budget", async (t) => {
  // attemptsPerAccount 3: any recorded refusal would rate-limit the fourth call on this door.
  const s = await startServer({ faceRooms: { attemptsPerAccount: 3, attemptsPerIp: 100 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await A.owner.req("POST", "/v1/local-room-invites", { room_id: ROOM, name: "Launch plan", bot_id: A.bot.id });
  const ticket = m.ticket as string;

  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) await claim(A, ticket, statuses, [A.bot.id]);
  const rows = (s.platform.db.prepare("SELECT outcome FROM face_room_attempts WHERE owner_id = ?").all(A.owner_id) as any[])
    .map((r) => r.outcome);
  console.log("OWN_INVITE_STATUSES " + JSON.stringify(statuses));
  console.log("OWN_INVITE_ATTEMPT_OUTCOMES " + JSON.stringify(rows));

  // Control: three wrong tickets on the same door spend the budget, so the fourth is refused for it.
  const B = await ownerWithBot(s.base, "ben");
  const control: number[] = [];
  for (let i = 0; i < 4; i++) await claim(B, WRONG, control, [B.bot.id]);
  console.log("CONTROL_WRONG_STATUSES " + JSON.stringify(control));
  assert.deepEqual(control, [404, 404, 404, 429], "control: a wrong ticket counts, the fourth call is rate-limited");

  // The reading under test: five own-ticket claims, five rows under `own_invite`, none counted, no 429.
  assert.deepEqual(rows, ["minted", "own_invite", "own_invite", "own_invite", "own_invite", "own_invite"],
    `an own_invite refusal must be recorded under its own label (recorded, not counted); attempt outcomes were ${JSON.stringify(rows)}`);
  assert.deepEqual(statuses, [409, 409, 409, 409, 409],
    `own_invite must not count toward the budget, so no refusal may turn into 429; got ${JSON.stringify(statuses)}`);
});
