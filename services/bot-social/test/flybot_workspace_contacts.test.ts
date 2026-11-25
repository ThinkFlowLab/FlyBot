import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("contacts require both owners and give a stable, private account-level DM", async () => {
  const a = await home(S.base, "contact-a");
  const b = await home(S.base, "contact-b");
  const stranger = await home(S.base, "contact-stranger");
  const contacts = "/v1/ot/contacts";
  const conversations = "/v1/ot/conversations";
  const start = {kind:"dm", peer:b.handle};
  const found = await a.ok("GET", contacts + "/lookup?handle=" + encodeURIComponent("@" + b.handle));
  assert.equal(found.peer.handle, b.handle);
  assert.deepEqual(Object.keys(found.peer).sort(), ["display_name","handle"]);
  assert.equal(found.relationship, null);
  assert.equal((await a.call("POST", conversations, start)).status, 403);

  const request = await a.ok("POST", contacts, {handle:b.handle});
  assert.equal(request.status, "pending");
  assert.equal(request.incoming, false);
  assert.equal((await b.ok("POST", contacts, {handle:a.handle})).id, request.id, "crossed requests retain the original consent");
  assert.equal((await b.ok("GET", contacts)).items[0].incoming, true);
  assert.deepEqual((await a.ok("GET", contacts + "/lookup?handle=" + b.handle)).relationship,
    {id:request.id, status:"pending", incoming:false});
  assert.deepEqual((await b.ok("GET", contacts + "/lookup?handle=" + a.handle)).relationship,
    {id:request.id, status:"pending", incoming:true});
  assert.equal((await stranger.ok("GET", contacts + "/lookup?handle=" + b.handle)).relationship, null);
  assert.deepEqual((await stranger.ok("GET", contacts)).items, []);
  assert.equal((await a.call("POST", contacts + "/" + request.id, {action:"accept"})).status, 409);
  assert.equal((await stranger.call("POST", contacts + "/" + request.id, {action:"accept"})).status, 404);
  assert.equal((await a.call("POST", conversations, start)).status, 403);
  await b.ok("POST", contacts + "/" + request.id, {action:"accept"});
  assert.deepEqual((await a.ok("GET", contacts + "/lookup?handle=" + b.handle)).relationship,
    {id:request.id, status:"accepted", incoming:false});

  const dm = await a.ok("POST", conversations, start);
  assert.deepEqual(dm.direct, {open:true});
  assert.equal((await b.ok("POST", conversations, {kind:"dm",peer:a.handle})).id, dm.id);
  assert.equal((await b.ok("GET", conversations + "?scope=personal")).conversations[0].id, dm.id);
  const team = await a.ok("POST", "/v1/ot/teams", {name:"Separate team"});
  assert.deepEqual((await a.ok("GET", conversations + "?scope=member&team_id=" + team.id)).conversations, []);
  assert.equal((await b.call("GET", conversations + "?scope=member&team_id=" + team.id)).status, 404);
  const path = conversations + "/" + dm.id;
  const data = Buffer.from("private attachment").toString("base64");
  const message = await a.ok("POST", path + "/messages", {direct:true, attachment:{title:"contact.txt", mime:"text/plain", data}});
  const filePath = path + "/messages/" + message.id + "/file";
  assert.equal((await b.ok("GET", filePath)).data, data);
  assert.equal((await stranger.call("GET", filePath)).status, 404);
  assert.equal((await stranger.call("GET", path)).status, 404);

  await b.ok("POST", contacts + "/" + request.id, {action:"remove"});
  assert.equal((await a.ok("GET", contacts + "/lookup?handle=" + b.handle)).relationship, null);
  assert.deepEqual((await a.ok("GET", contacts)).items, []);
  assert.equal((await a.ok("GET", path)).direct.open, false);
  assert.equal((await b.ok("GET", filePath)).data, data, "history remains readable");
  assert.equal((await a.call("POST", path + "/messages", {body:"blocked"})).status, 403);
  assert.equal((await a.call("POST", conversations, start)).status, 403);
  assert.equal((await a.call("POST", contacts, {handle:b.handle})).status, 429);
});
