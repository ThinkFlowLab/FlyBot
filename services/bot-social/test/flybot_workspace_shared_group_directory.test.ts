import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bulkAuth,startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

const collection = "/v1/ot/conversations";
const directory = "/v1/ot/group-directory";
const ids = (page: {items: {conversation_id:string}[]}) => page.items.map(row => row.conversation_id);
let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

test("the signed native directory opens only current managed-group seats and keeps transcripts out of the directory", async () => {
  const [owner, peer, teammate, outsider] = await Promise.all(["directory-owner", "directory-peer", "directory-team-only", "directory-stranger"].map(
    name => home(service.base,name)));
  const account = await owner.ok("POST","/v1/ot/contacts",{handle:peer.handle});
  await peer.ok("POST", `/v1/ot/contacts/${account.id}`, {action:"accept"});
  const team = await owner.ok("POST","/v1/ot/workspaces",{name:"Directory release team",slug:"native-directory-team",
    idempotency_key:"directory-create-team"});
  const {code} = await owner.ok("POST",`/v1/ot/teams/${team.id}/invites`,{max_uses:3});
  await peer.ok("POST","/v1/ot/invites/accept",{code});
  await teammate.ok("POST","/v1/ot/invites/accept",{code});
  const personal = await owner.ok("POST",collection,{kind:"group",account_group:true,title:"Personal directory",members:[peer.handle]});
  const named = await owner.ok("POST",collection,{kind:"group",team_id:team.id,title:"Team directory",members:[peer.handle]});
  const direct = await owner.ok("POST",collection,{kind:"dm",peer:peer.handle});
  const legacy = await owner.ok("POST",collection,{kind:"group",title:"Unscoped legacy group",members:[peer.handle]});
  const slug = "native-directory-public-agent";
  await peer.ok("PUT","/v1/ot/listings",{kind:"agent",ref:"directory-agent",slug,title:"Public directory agent",
    snapshot:JSON.stringify({version:1,instructions:"Public listing text"}), chat_enabled:true});
  const published = await owner.ok("POST",`/v1/ot/discover/${slug}/start`);
  const archived = await owner.ok("POST",collection,{kind:"group",account_group:true,title:"Archived native directory",
    agents:[{agent_ref:"fixture-bot",name:"Fixture Bot"}]});
  await owner.ok("POST",`${collection}/${archived.id}/management`,{direct:true,action:"leave",revision:archived.group_management.revision});
  const message = await owner.ok("POST",`${collection}/${named.id}/messages`,{body:"Web-created history stays canonical"});

  assert.equal((await fetch(service.base + directory)).status,401);
  assert.deepEqual(await outsider.ok("GET",directory),{items:[],next_cursor:null});
  assert.deepEqual(await teammate.ok("GET",directory),{items:[],next_cursor:null});
  const visible = await peer.ok("GET",directory);
  assert.equal(visible.next_cursor,null);
  assert.deepEqual(new Set(ids(visible)),new Set([personal.id,named.id]));
  assert.deepEqual(visible.items.find((row: any) => row.kind === "personal"),{
    conversation_id:personal.id,title:personal.title,kind:"personal",workspace_id:null,workspace_name:null,
  });
  assert.deepEqual(visible.items.find((row: any) => row.kind === "team"),{
    conversation_id:named.id,title:named.title,kind:"team",workspace_id:team.workspace_id,workspace_name:team.name,
  });
  assert.doesNotMatch(JSON.stringify(visible),/Web-created history|last_message|agents|members/);
  const detail = directory + "/" + named.id;
  assert.equal((await peer.ok("GET",detail)).last_message.id,message.id);
  assert.equal((await teammate.call("GET",detail)).status,404);
  assert.equal((await outsider.call("GET",detail)).status,404);
  for (const id of [direct.id,legacy.id,archived.id,published.conversation_id]) {
    assert.equal((await owner.call("GET", directory + "/" + id)).data.error.code,"conversation_not_found");
  }

  const membership = `/v1/ot/teams/${team.id}/members/${peer.handle}`;
  await owner.ok("PATCH",membership,{suspended:true});
  assert.deepEqual(ids(await peer.ok("GET",directory)),[personal.id]);
  assert.equal((await peer.call("GET",detail)).status,404);
  await owner.ok("PATCH",membership,{suspended:false});
  assert.ok(ids(await peer.ok("GET",directory)).includes(named.id));
  await owner.ok("DELETE",`${collection}/${named.id}/members/${peer.handle}`);
  assert.deepEqual(ids(await peer.ok("GET",directory)),[personal.id]);
  assert.equal((await peer.call("GET",detail)).status,404);
  await peer.ok("DELETE",`${collection}/${personal.id}/members/${peer.handle}`);
  assert.deepEqual(await peer.ok("GET",directory),{items:[],next_cursor:null});
});

test("the native directory has a fixed bound and walks immutable shared group IDs once", async () => {
  const owner = await home(service.base,"group-directory-pages");
  const created = [];
  for (let i = 0; i < 32; i++) {
    const group = await owner.ok("POST",collection,{kind:"group",account_group:true,title:`Paged fixture ${i}`,
      agents:[{agent_ref:"fixture-bot",name:"Fixture Bot"}]});
    created.push(group.id);
  }
  const expected = created.sort().reverse();
  const first = await owner.ok("GET",directory);
  assert.deepEqual(ids(first),expected.slice(0,30));
  assert.equal(first.next_cursor,expected[29]);
  // Changes to a conversation's activity do not move it across a page boundary.
  await owner.ok("POST",`${collection}/${expected[30]}/messages`,{body:"New activity"});
  await owner.ok("DELETE",`${collection}/${expected[29]}/members/${owner.handle}`);
  const tail = await owner.ok("GET",`${directory}?cursor=${first.next_cursor}`);
  assert.deepEqual(ids(tail),expected.slice(30));
  assert.equal(tail.next_cursor,null);
  assert.equal((await owner.call("GET",directory+"?cursor=malformed")).status,400);
  assert.equal((await owner.call("GET",`${directory}?cursor=${expected[0]}&cursor=${expected[1]}`)).status,400);
  assert.equal((await owner.call("GET",directory+"?limit=10000")).status,400);
});
