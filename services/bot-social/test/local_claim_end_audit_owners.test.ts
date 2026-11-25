// Withdrawing the claim on a local-room invite ends the pair's grant. That ending is audited, but it
// named no owner (`owners: []`), and the read side filters with `owners LIKE '%"id"%'` -- so the record
// existed and neither owner of the pair could find it. Both sides of the share must read it, nobody
// else must.
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { ownerWithBot } from "./helpers.js";

const ROOM = "session-claim-end-audit-0001";

let base = "";
let platform: Platform;
let stop: () => Promise<void>;

before(async () => {
  platform = new Platform({});
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  stop = async () => { await app.close(); platform.close(); };
});
after(async () => { await stop(); });

const endedFor = async (o: any) =>
  ((await o.owner.req("GET", "/v1/audit-events")).events as any[])
    .filter((e) => e.action === "grant.revoked" && e.data?.reason === "local_invite_ended" && e.data?.room_id === ROOM);

describe("a claim withdrawn from a local-room invite", () => {
  test("both owners of the pair read the grant.revoked record, an unrelated owner reads none", async () => {
    const A = await ownerWithBot(base, "ann");
    const B = await ownerWithBot(base, "ben");
    const C = await ownerWithBot(base, "cat");
    const minted = await A.owner.req("POST", "/v1/local-room-invites", { room_id: ROOM, name: "Launch plan", bot_id: A.bot.id });
    await B.owner.req("POST", `/v1/local-room-invites/${minted.ticket}/claim`, { bots: [B.bot.id] });
    await A.owner.req("DELETE", `/v1/local-room-invites/${minted.ticket}/claims/${encodeURIComponent(B.handle)}`);

    const mineA = await endedFor(A);
    const mineB = await endedFor(B);
    assert.ok(mineA.length > 0, "the owner who minted the link reads the ending of the share it made");
    assert.ok(mineB.length > 0, "the owner whose Bot lost the share reads it too");
    assert.deepEqual(mineA.map((e) => e.subject).sort(), mineB.map((e) => e.subject).sort(), "both read the same records");
    assert.deepEqual(await endedFor(C), [], "an unrelated owner reads none of them");
  });
});
