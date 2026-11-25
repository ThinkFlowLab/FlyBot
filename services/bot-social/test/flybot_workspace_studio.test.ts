import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";
import { STUDIO_SCHEMA } from "../src/flybot-workspace/studio.js";

test("copying a named workspace snapshot requires active membership in both workspaces", async t => {
  const {base, stop} = await startServer(bulkAuth);
  t.after(stop);
  const owner = await home(base, "studio-copy-owner");
  const editor = await home(base, "studio-copy-editor");
  const team = (name: string, slug: string) => owner.ok("POST", "/v1/ot/workspaces", {
    name, slug, idempotency_key:"fixture-" + slug,
  });
  const [source, target] = await Promise.all([team("Source team", "copy-source-test"), team("Target team", "copy-target-test")]);
  const targetPath = `/v1/ot/teams/${target.workspace_id}/studio/documents`;
  const one = (id: string) => `/v1/ot/teams/${id}/members/${editor.handle}`;
  const add = (id: string) => owner.ok("POST", `/v1/ot/teams/${id}/members`, {handle:editor.handle,role:"member"});
  const draft = {title:"Reviewed text",body:"Saved snapshot",client_key:"scoped-source-copy-fixture",source_workspace_id:source.workspace_id};
  await add(target.id);
  assert.equal((await editor.call("POST",targetPath,draft)).status,404);
  assert.deepEqual((await editor.ok("GET",targetPath)).items,[]);
  await add(source.id);
  const first = await editor.ok("POST",targetPath,draft);
  assert.equal((await editor.ok("POST",targetPath,draft)).document.id,first.document.id);
  assert.equal((await editor.call("POST",targetPath,{...draft,source_workspace_id:target.workspace_id})).status,409);
  await owner.ok("PATCH",one(source.id),{suspended:true});
  assert.equal((await editor.call("POST",targetPath, {...draft,client_key:"scoped-source-new-fixture"})).status,404);
  assert.equal((await editor.call("POST",targetPath,draft)).status,404);
  assert.equal((await editor.ok("GET",targetPath)).items.length,1);
});

test("team Studio coordinates edits between actual account homes and enforces the current roster", async t => {
  const {base, stop, platform} = await startServer(bulkAuth);
  t.after(stop);
  const [owner, editor, peer, outsider] = await Promise.all([
    home(base, "studio-owner"), home(base, "studio-editor"), home(base, "studio-peer"), home(base, "studio-outsider"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Studio workspace", slug: "studio-workspace", idempotency_key: "team-studio-fixture",
  });
  const second = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Separate team", slug: "studio-separate", idempotency_key: "team-second-fixture",
  });
  const unconverted = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Private workspace", idempotency_key: "team-private-fixture",
  });
  const unbound = await owner.ok("POST", "/v1/ot/teams", {name: "Unbound team", slug: "studio-unbound"});
  const documents = (id: string) => `/v1/ot/teams/${id}/studio/documents`;
  const path = documents(team.workspace_id);
  const draft = {title: "共同编辑", body: "第一段\n留着换行 \t", client_key: "create-shared-doc-001"};
  for (const teamId of [unconverted.id, unconverted.workspace_id, unbound.id]) {
    assert.equal((await owner.call("POST", documents(teamId), draft)).status, 404);
  }
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await outsider.call("GET", path)).status, 404);
  const member = (handle: string) => `/v1/ot/teams/${team.id}/members/${handle}`;
  for (const memberHome of [editor, peer]) {
    await owner.ok("POST", `/v1/ot/teams/${team.id}/members`, {handle:memberHome.handle, role:"member"});
  }
  await owner.ok("PUT", "/v1/ot/profile", {display_name:"Document Owner"});
  await editor.ok("PUT", "/v1/ot/profile", {display_name:"Document Editor"});
  const creations = await Promise.all([
    editor.call("POST", path, draft), editor.call("POST", documents(team.id), draft),
  ]);
  assert.deepEqual(creations.map(row => row.status).sort(), [200,201]);
  const { document } = creations[0].data;
  assert.equal(creations[1].data.document.id, document.id);
  assert.match(document.id, /^[0-9a-f]{32}$/);
  assert.equal(document.revision, 1);
  assert.equal(document.body, draft.body);
  assert.equal(document.created_by, "Document Editor");
  assert.equal(document.updated_by, "Document Editor");
  const one = path + "/" + document.id;
  assert.deepEqual(await owner.ok("GET", one + "?revision=1"), {unchanged:true,revision:1});
  assert.equal((await owner.call("GET", one + "?revision=1&revision=1")).status, 400);
  assert.equal((await owner.call("GET", documents(second.id) + "/" + document.id)).status, 404);
  assert.equal((await outsider.call("GET", one + "?revision=1")).status, 404);
  const list = (await peer.ok("GET", path)).items;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, document.id);
  assert.equal(list[0].can_delete, false);
  assert.equal(list[0].body, undefined);
  assert.equal((await peer.call("DELETE", one, {revision:1})).status, 403);
  assert.equal((await editor.call("POST", path, {...draft,title:"Different title"})).data.error.code, "idempotency_conflict");

  const outcomes = await Promise.all([
    owner.call("PUT", one, {title:draft.title,body:"Owner edit",revision:1}),
    editor.call("PUT", one, {title:draft.title,body:"Editor edit",revision:1}),
  ]);
  assert.deepEqual(outcomes.map(row => row.status).sort(), [200,409]);
  assert.equal(outcomes.find(row => row.status===409)?.data.error.code, "revision_conflict");
  const current = (await peer.ok("GET", one + "?revision=1")).document;
  assert.equal(current.revision, 2);
  assert.equal(current.body, outcomes.find(row => row.status===200)?.data.document.body);
  assert.equal(current.updated_by, outcomes[0].status===200 ? "Document Owner" : "Document Editor");
  assert.equal((await editor.ok("POST", path, draft)).document.revision, 2);
  assert.equal((await editor.ok("PUT", one, {title:current.title, body:current.body, revision:2})).document.revision, 2);
  assert.equal((await editor.call("PUT", one, {title:draft.title,body:"x".repeat(60_001),revision:2})).status, 400);
  await owner.ok("PATCH", member(editor.handle), {suspended:true});
  assert.equal((await editor.call("GET", one + "?revision=2")).status, 404);
  assert.equal((await editor.call("PUT", one, {title:draft.title,body:"Lost access",revision:2})).status, 404);
  assert.equal((await editor.call("DELETE", one, {revision:2})).status, 404);
  assert.equal((await owner.call("DELETE", one, {revision:1})).data.error.code, "revision_conflict");
  assert.deepEqual(await owner.ok("DELETE", one, {revision:2}), {deleted:true});
  assert.equal((await owner.call("GET", one)).status, 404);
  assert.deepEqual((await owner.ok("GET", path)).items, []);
  await owner.ok("PATCH", member(editor.handle), {suspended:false});
  assert.equal((await editor.call("POST", path, draft)).data.error.code, "document_deleted");
  const tombstone = platform.db.prepare("SELECT title,body FROM ot_studio_documents WHERE id=?").get(document.id);
  assert.deepEqual(tombstone, {title:"",body:""});
});

test("team document versions restore atomically and stay scoped to the current roster", async t => {
  const {base, stop, platform} = await startServer(bulkAuth);
  t.after(stop);
  const [owner, editor, stranger] = await Promise.all([
    home(base, "versions-owner"), home(base, "versions-editor"), home(base, "versions-stranger"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {
    name:"History", slug:"workspace-versions", idempotency_key:"studio-versions-fixture",
  });
  await owner.ok("POST", `/v1/ot/teams/${team.id}/members`, {handle:editor.handle,role:"member"});
  const collection = `/v1/ot/teams/${team.workspace_id}/studio/documents`;
  const {document} = await owner.ok("POST", collection, {title:"Initial",body:"First",client_key:"studio-history-original"});
  const path = collection + "/" + document.id;
  await editor.ok("PUT", path, {title:"Edited",body:"Second",revision:1});
  assert.equal((await stranger.call("GET", path+"/versions/1")).status,404);
  const history = await editor.ok("GET", path+"/versions");
  assert.equal(history.current_revision,2);
  assert.deepEqual(history.items.map((item: Record<string, unknown>)=>[item.revision,item.title,item.body]),
    [[2,"Edited",undefined],[1,"Initial",undefined]]);
  assert.equal((await editor.ok("GET", path+"/versions/1")).version.body,"First");
  assert.equal((await owner.call("POST", path+"/restore", {revision:1,to:1})).data.error.code,"revision_conflict");
  const outcomes = await Promise.all([
    editor.call("POST", path+"/restore", {revision:2,to:1}),
    owner.call("POST", path+"/restore", {revision:2,to:1}),
  ]);
  assert.deepEqual(outcomes.map(item=>item.status).sort(),[200,409]);
  const restored = await owner.ok("GET", path+"/versions/3");
  assert.equal(restored.version.body,"First");
  assert.equal(restored.version.restored_from,1);
  assert.equal((await editor.ok("GET", path+"/versions/2")).version.body,"Second");
  for(let rev=3;rev<33;rev++) await editor.ok("PUT", path, {title:"Bounded",body:String(rev),revision:rev});
  const bounded = await editor.ok("GET", path+"/versions");
  assert.equal(bounded.items.length,30);
  assert.equal(bounded.items.at(-1).revision,4);
  assert.equal((await owner.call("GET",path+"/versions/3")).status,404);
  // Upgrading a store that only kept the current document should resume at its existing revision.
  platform.db.exec("DROP TABLE ot_studio_revisions");
  platform.db.exec(STUDIO_SCHEMA);
  platform.db.exec(STUDIO_SCHEMA);
  const migrated = await owner.ok("GET",path+"/versions");
  assert.deepEqual(migrated.items.map((version: {revision: number})=>version.revision),[33]);
  await owner.ok("DELETE",path,{revision:33});
  assert.equal((await editor.call("GET",path+"/versions/33")).status,404);
  const remaining = platform.db.prepare("SELECT count(*) AS n FROM ot_studio_revisions WHERE document_id=?")
    .get(document.id) as {n: number};
  assert.equal(remaining.n,0);
});

test("Studio watches wake on commits and scoped presence, then reauthorize before returning", async t => {
  let now = Date.now();
  const {base, stop} = await startServer({...bulkAuth, now:() => now});
  t.after(stop);
  const [owner, editor, outsider] = await Promise.all([
    home(base, "watch-owner"), home(base, "watch-editor"), home(base, "watch-outsider"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {
    name:"Studio live",slug:"studio-live-test",idempotency_key:"studio-live-team-fixture",
  });
  const anotherTeam = await owner.ok("POST", "/v1/ot/workspaces", {
    name:"Studio separated",slug:"studio-live-other",idempotency_key:"studio-live-other-fixture",
  });
  const memberships = `/v1/ot/teams/${team.id}/members`;
  await owner.ok("POST", memberships, {handle:editor.handle,role:"member"});
  await editor.ok("PUT", "/v1/ot/profile", {display_name:"Studio teammate"});
  const collection = `/v1/ot/teams/${team.workspace_id}/studio/documents`;
  const {document} = await owner.ok("POST", collection, {
    title:"Draft",body:"Draft text",client_key:"studio-live-document-key",
  });
  const {document:other} = await owner.ok("POST", collection, {
    title:"Other draft",body:"Separate document",client_key:"studio-live-second-document",
  });
  const path = collection + "/" + document.id;
  const live = path + "/live";
  const firstTab = {session_id:"first-studio-tab",active:true,editing:false};
  const secondTab = {session_id:"second-studio-tab",active:true,editing:true};

  async function wake(reader: typeof owner, revision: number, action: () => Promise<unknown>) {
    let settled = false;
    const pending = reader.call("GET", live + "?revision=" + revision).finally(() => { settled = true; });
    await delay(50);
    assert.equal(settled, false);
    await action();
    const controller = new AbortController();
    try {
      return await Promise.race([pending, delay(2000, undefined, {signal:controller.signal}).then(() => {
        throw new Error("Studio watch did not wake after the operation");
      })]);
    } finally { controller.abort(); }
  }

  assert.equal((await outsider.call("GET", live + "?revision=1")).status,404);
  assert.equal((await outsider.call("POST", live, firstTab)).status,404);
  assert.equal((await owner.call("GET", live + "?revision=1&revision=1")).status,400);
  assert.equal((await owner.call("GET", live + "?revision=0")).status,400);
  assert.equal((await owner.call("GET", live)).status,400);
  assert.equal((await owner.call("GET", `/v1/ot/teams/${anotherTeam.workspace_id}/studio/documents/${document.id}/live?revision=2`)).status,404);
  assert.equal((await editor.call("POST", live, {...firstTab, draft:"Private changes"})).status,400);
  assert.equal((await editor.call("POST", live, {...firstTab, editing:"yes"})).status,400);

  const opened = await wake(owner, 1, () => editor.ok("POST", live, firstTab));
  assert.deepEqual(opened.data, {unchanged:true, revision:1, editors:[{name:"Studio teammate",editing:false}]});
  const typing = await wake(owner, 1, () => editor.ok("POST", live, secondTab));
  assert.deepEqual(typing.data, {unchanged:true, revision:1, editors:[{name:"Studio teammate",editing:true}]});
  const closedFirst = await wake(owner, 1, () => editor.ok("POST", live, {...firstTab,active:false}));
  assert.deepEqual(closedFirst.data.editors,[{name:"Studio teammate",editing:true}]);
  assert.deepEqual((await editor.ok("GET", live + "?revision=2")).editors, []);
  assert.deepEqual((await owner.ok("GET", collection + "/" + other.id + "/live?revision=2")).editors, []);

  const saved = await wake(owner, 1, () => editor.ok("PUT", path, {
    title:"Saved",body:"Saved text",revision:1,
  }));
  assert.equal(saved.data.document.revision,2);
  assert.equal(saved.data.document.body,"Saved text");
  assert.deepEqual(saved.data.editors,[{name:"Studio teammate",editing:true}]);
  const unchanged = editor.call("GET", live + "?revision=2");
  const secondStarted = performance.now();
  await owner.ok("PUT", path, {title:"Saved",body:"Saved text",revision:2});
  await editor.ok("POST", live, secondTab);
  assert.deepEqual((await unchanged).data, {unchanged:true,revision:2,editors:[]});
  assert.ok(performance.now() - secondStarted >= 3500, "no-op save and heartbeat cannot force a poll loop");
  now += 16_001;
  assert.deepEqual((await owner.ok("GET", live + "?revision=1")).editors,[]);

  const restored = await wake(editor, 2, () => owner.ok("POST", path + "/restore", {revision:2,to:1}));
  assert.equal(restored.data.document.revision,3);
  assert.equal(restored.data.document.body,"Draft text");
  const watches = Array.from({length:8}, () => owner.call("GET", live + "?revision=3"));
  await delay(60);
  const crowded = await owner.call("GET", live + "?revision=3");
  assert.equal(crowded.status,429);
  assert.equal(crowded.data.error.code,"studio_live_busy");
  await editor.ok("POST", live, secondTab);
  assert.deepEqual((await Promise.all(watches)).map(reply => reply.status),Array(8).fill(200));
  await wake(owner, 3, () => editor.ok("POST", live, {...secondTab,editing:false}));
  const suspended = await wake(editor, 3, async () => {
    await owner.ok("PATCH", memberships + "/" + editor.handle, {suspended:true});
    await owner.ok("PUT", path, {title:"Authorized only",body:"Members only",revision:3});
  });
  assert.equal(suspended.status,404);
  assert.equal(suspended.data.error.code,"team_not_found");
  assert.doesNotMatch(JSON.stringify(suspended.data),/Members only/);
  assert.deepEqual((await owner.ok("GET", live + "?revision=3")).editors,[]);

  const deleted = await wake(owner, 4, () => owner.ok("DELETE", path, {revision:4}));
  assert.equal(deleted.status,404);
  assert.equal(deleted.data.error.code,"document_not_found");
  assert.equal((await owner.call("POST", live, firstTab)).status,404);
});
