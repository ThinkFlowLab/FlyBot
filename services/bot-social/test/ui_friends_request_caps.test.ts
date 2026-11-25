import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

// The friends page builds each incoming request from `/v1/friends-overview` (`PAGES.friends` -> `requestCard`).
// `requestCard` reads `requested_capabilities` / `offered_capabilities` to say what the requester wants and to
// pre-tick the boxes the owner grants when they press Accept (`readCaps(card,"g")` -> POST .../consent).
// `listRelationships` ships both lists, but `friendsOverview` never copied them, so the card read
// "They want:  . They grant you: " with every box dark and Accept only wrote the default caps.

const WANTED = ["chat.public", "calendar.book"];
const OFFERED = ["profile.read", "calendar.freebusy.read"];

/** Two owners and A's pending request to B, carrying both capability lists. */
async function request(base: string) {
  const A = await ownerWithBot(base, "alice");
  const B = await ownerWithBot(base, "bob");
  const req = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.bot.id, target_handle: B.handle, message: "hi",
    requested_capabilities: WANTED, offered_capabilities: OFFERED,
  });
  return { A, B, relId: req.relationship_id as string };
}

test("control: /v1/relationships already carries both capability lists on the same request", async () => {
  const { base, stop } = await startServer();
  try {
    const { B, relId } = await request(base);
    const rels = await B.owner.req("GET", "/v1/relationships");
    const rel = rels.relationships.find((r: any) => r.relationship_id === relId);
    assert.deepEqual([...rel.requested_capabilities].sort(), [...WANTED].sort());
    assert.deepEqual([...rel.offered_capabilities].sort(), [...OFFERED].sort());
  } finally { await stop(); }
});

test("the friend request card says what they want, what they grant, and pre-ticks the requested caps", async () => {
  const { base, stop } = await startServer();
  try {
    const { B, relId } = await request(base);
    const overview = await B.owner.req("GET", "/v1/friends-overview");
    const item = overview.pending_incoming.find((r: any) => r.relationship_id === relId);
    assert.ok(item, "the request is pending incoming for B");
    const { requestCard, relCaps } = loadConsole(["requestCard", "relCaps"]);
    // Exactly how PAGES.friends renders an incoming request.
    const html = requestCard({ ...item, created_at: item.requested_at, ...relCaps(item) });
    assert.match(html, /They want: .*Book meetings/, "the card names the caps they asked for");
    assert.match(html, /They grant you: .*Free\/busy/, "the card names the caps they offered");
    assert.match(html, /data-g="calendar.book" checked/, "calendar.book is pre-ticked, so Accept sends it");
  } finally { await stop(); }
});

test("Accept on that card grants calendar.book instead of writing only the default caps", async () => {
  const { base, stop } = await startServer();
  try {
    const { B, relId } = await request(base);
    const overview = await B.owner.req("GET", "/v1/friends-overview");
    const item = overview.pending_incoming.find((r: any) => r.relationship_id === relId);
    const { requestCard, relCaps } = loadConsole(["requestCard", "relCaps"]);
    const html = requestCard({ ...item, created_at: item.requested_at, ...relCaps(item) });
    // What `bindRequests` reads out of the rendered card, then posts as the owner's consent.
    const caps = [...html.matchAll(/data-g="([^"]+)"\s+checked/g)].map((m) => m[1])
      .filter((c) => !["chat.public", "profile.read"].includes(c))
      .map((c) => (c === "calendar.freebusy.read" ? { capability: c, scope: { window_days: 14, hours: "09:00-18:00" } } : { capability: c }));
    await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: caps });
    const rels = await B.owner.req("GET", "/v1/relationships");
    const rel = rels.relationships.find((r: any) => r.relationship_id === relId);
    const grantedToA = rel.capabilities.peer_on_me.map((g: any) => g.capability);
    assert.ok(grantedToA.includes("calendar.book"), `B grants A calendar.book; got ${JSON.stringify(grantedToA)}`);
  } finally { await stop(); }
});
