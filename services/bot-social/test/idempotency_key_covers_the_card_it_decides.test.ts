/**
 * The idempotency key is a fingerprint of the call, and the card being decided is part of the call: two different
 * approvals are two different requests even when a client sends the same key and the same body. The fingerprint
 * spreads the path's card id first and the body's own fields after it, so a client that echoes an `approval_id` in
 * the body (a whole object passed straight through) replaces the path's id inside the fingerprint. The second call
 * then finds the first call's row under the same fingerprint and answers with the first card's cached result: the
 * caller is told its decision succeeded, the card it named is still pending, and nothing says otherwise. The rule
 * this build already applies to a key reused with a different body is a refusal, and the same refusal is what the
 * second card has to get.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

/** send_as_member signs with the Bot's custodial key. */
function custody(s: any, who: any) {
  s.platform.enableCustody({ kind: "owner", ownerId: who.owner_id }, who.bot.id, { private_key_pem: who.kp.privateKeyPem });
}

const KEY = "flybot-decide-two-cards-1";

test("a key reused on a second card is a conflict, not the first card's answer replayed", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };

  const one = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "first line", idempotency_key: "flybot-two-cards-send-1" });
  const two = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "second line", idempotency_key: "flybot-two-cards-send-2" });
  const firstCard = (one.message as any).approval_id as string;
  const secondCard = (two.message as any).approval_id as string;
  assert.notEqual(firstCard, secondCard, "two lines, two cards");

  // The client passes its object straight through, so the body carries an `approval_id` of its own.
  const body = { decision: "approved" as const, idempotency_key: KEY, approval_id: "apr_client_generated_placeholder" } as any;
  const first = s.platform.decideApproval(owner, firstCard, body);
  assert.equal(first.decision, "approved");
  // The same key reused for a different card is a different request, and this build's rule for that is a conflict —
  // never the first card's answer replayed as if the second decision had been made.
  assert.throws(
    () => s.platform.decideApproval(owner, secondCard, body),
    (e: any) => e.code === "idempotency_conflict" && e.status === 409,
    "a key reused on another card is a conflict, not a silent replay",
  );

  const row = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(secondCard) as any;
  assert.equal(row.status, "pending", "and the card it named is untouched, exactly as the refusal says");
  const other = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(firstCard) as any;
  assert.equal(other.status, "approved");
});
