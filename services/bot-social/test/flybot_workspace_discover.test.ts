// FlyBot Discover on Bot Social: publish/unpublish, search and tabs, likes, collections, follows
// and follow notifications. Fixture homes only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

const TRIANGLE_GLB = [
  "Z2xURgIAAACUAQAAVAEAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAifSwic2NlbmUiOjAsInNjZW5lcyI6",
  "W3sibm9kZXMiOlswXX1dLCJub2RlcyI6W3sibWVzaCI6MH1dLCJtZXNoZXMiOlt7InByaW1pdGl2ZXMiOlt7ImF0",
  "dHJpYnV0ZXMiOnsiUE9TSVRJT04iOjB9fV19XSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6MzZ9XSwiYnVmZmVy",
  "Vmlld3MiOlt7ImJ1ZmZlciI6MCwiYnl0ZUxlbmd0aCI6MzYsInRhcmdldCI6MzQ5NjJ9XSwiYWNjZXNzb3JzIjpb",
  "eyJidWZmZXJWaWV3IjowLCJjb21wb25lbnRUeXBlIjo1MTI2LCJjb3VudCI6MywidHlwZSI6IlZFQzMiLCJtaW4i",
  "OlstMSwtMSwwXSwibWF4IjpbMSwxLDBdfV19ICAgJAAAAEJJTgAAAIC/AACAvwAAAAAAAIA/AACAvwAAAAAAAAAA",
  "AACAPwAAAAA=",
].join("");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=", "base64");
const WAV = Buffer.from("524946462800000057415645666d74201000000001000100401f0000401f000001000800646174610400000080818280", "hex");

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("published work source revision stays owner-only and rejects late older releases", async () => {
  const [author,reader] = await Promise.all([home(S.base,"revision-owner"),home(S.base,"revision-reader")]);
  const path = "/v1/ot/listings";
  const slug = "publish-version-fence";
  const work = {kind:"work",work_kind:"document",ref:"private-saved-work",slug,title:"Work revision fixture"};
  const draft = (revision: number) => ({...work,source_revision:revision,snapshot:"Public revision " + revision});
  const first = await author.ok("PUT",path,draft(3));
  const updated = await author.ok("PUT",path,draft(4));
  assert.equal(updated.id,first.id);
  assert.equal(updated.source_revision,4);
  const stale = await author.call("PUT",path,draft(3));
  assert.equal(stale.status,409);
  assert.equal(stale.data.error.code,"artifact_changed");
  assert.equal((await author.ok("GET",path+"/mine")).listings[0].source_revision,4);
  assert.deepEqual((await reader.ok("GET",path+"/mine")).listings,[]);
  const publicWork = await reader.ok("GET","/v1/ot/discover/"+slug+"/detail");
  assert.equal(publicWork.work.source_revision,undefined);
  const publicPage = await fetch(S.base + "/w/" + slug);
  assert.equal(publicPage.status,200);
  assert.match(await publicPage.text(),/Public revision 4/);
});

test("guest Discover pages only contain opted-in records and carry no viewer state", async () => {
  const publisher = await home(S.base, "guest-directory-publisher");
  const term = "anonymous-gallery-fixture";
  const works = "/v1/ot/public/discover/works";
  const agents = "/v1/ot/public/discover/agents";
  const read = async (path: string, expected = 200) => {
    const response = await fetch(S.base + path, {headers:{accept:"application/json"}});
    assert.equal(response.status, expected);
    if (expected === 200) assert.equal(response.headers.get("cache-control"),"no-store");
    return response.json();
  };
  const published = await Promise.all(["one", "two", "three"].map(value =>
    publisher.ok("PUT", "/v1/ot/listings", {kind:"work",work_kind:"document",ref:`private-${value}`,
      slug:`guest-gallery-${value}`,title:`${term} ${value}`,snapshot:"A public preview body."})));
  await publisher.ok("PUT","/v1/ot/listings",{kind:"agent",ref:"private-agent-ref",slug:"guest-gallery-agent",
    title:`${term} helper`,summary:"Public description",category:"content-creation"});
  await publisher.ok("DELETE", "/v1/ot/listings/" + published[2].id);
  const first = await read(works + `?kind=document&q=${term}&limit=1`);
  assert.equal(first.items.length,1);
  assert.ok(first.cursor);
  assert.deepEqual(Object.keys(first.items[0]).sort(),[
    "author","collections","comment_count","creator","kind","likes","match","path","slug","title","updated",
  ]);
  const next = await read(works + `?kind=document&q=${term}&limit=1&cursor=${first.cursor}`);
  assert.equal(next.items.length,1);
  assert.equal(next.cursor,null);
  assert.deepEqual([first.items[0].slug,next.items[0].slug].sort(),["guest-gallery-one","guest-gallery-two"]);
  await read(works + `?q=different&cursor=${first.cursor}`,400);
  assert.equal((await read(works + `?sort=popular&q=${term}`)).items.length,2);
  const hub = await read(agents + `?q=${term}`);
  assert.deepEqual(hub.items.map((item: any) => item.slug),["guest-gallery-agent"]);
  assert.deepEqual(Object.keys(hub.items[0].creator).sort(),["handle","name"]);
  assert.deepEqual(first.items[0].creator, hub.items[0].creator);
  const creator = encodeURIComponent(hub.items[0].creator.handle);
  assert.deepEqual((await read(agents + '?creator=' + creator)).items.map((item: any) => item.slug), ["guest-gallery-agent"]);
  assert.equal((await read(works + '?creator=' + creator)).items.length, 2);
  for (const extra of ["tab=following", "tab=collected", "cursor=a&cursor=b", "viewer=publisher"]) {
    await read(works + "?" + extra,400);
  }
  await read("/v1/ot/discover",401);
});

test("work topics scope both directories, pagination and neighbors", async () => {
  const [publisher, reader] = await Promise.all([home(S.base, "topic-publisher"), home(S.base, "topic-reader")]);
  const path = "/v1/ot/listings";
  const publish = (slug: string, category: string) => publisher.ok("PUT", path, {
    kind:"work", work_kind:"document", ref:slug, slug, title:"Topic fixture " + slug, category,
  });
  const first = await publish("topic-fixture-first", "travel");
  await publish("topic-fixture-other", "education");
  const last = await publish("topic-fixture-last", "travel");
  assert.equal(first.category, "travel");
  assert.equal((await publisher.call("PUT", path, {kind:"agent", ref:"topic-agent", slug:"topic-fixture-agent",
    title:"Agent with invalid work topic", category:"travel"})).status, 400);

  const guest = "/v1/ot/public/discover/works?kind=document&category=travel&q=Topic+fixture&limit=1";
  const read = async (id: string) => {
    const response = await fetch(S.base + id, {headers:{accept:"application/json"}});
    assert.equal(response.status, 200);
    return response.json();
  };
  const page = await read(guest);
  assert.equal(page.items.length, 1);
  assert.ok(page.cursor);
  const rest = await read(guest + "&cursor=" + encodeURIComponent(page.cursor));
  assert.deepEqual([page.items[0].slug, rest.items[0].slug].sort(), [first.slug, last.slug].sort());
  assert.equal(rest.cursor, null);
  const wrongTopic = guest.replace("category=travel", "category=education");
  assert.equal((await fetch(S.base + wrongTopic + "&cursor=" + encodeURIComponent(page.cursor))).status, 400);

  const signed = await reader.ok("GET", "/v1/ot/discover?kind=work&work_kind=document&category=travel&q=Topic+fixture");
  assert.deepEqual(signed.items.map((item: {slug: string}) => item.slug).sort(), [first.slug, last.slug].sort());
  const detail = await reader.ok("GET", `/v1/ot/discover/${first.slug}/detail?category=travel&q=Topic+fixture`);
  const preview = await read(`/w/${first.slug}?view=preview&nav=latest&topic=travel&q=Topic+fixture`);
  assert.deepEqual([detail.previous?.slug, detail.next?.slug].filter(Boolean), [last.slug]);
  assert.deepEqual([preview.previous?.slug, preview.next?.slug].filter(Boolean), [last.slug]);
});

test("work remix yields only exact listed document or website snapshots", async () => {
  const author = await home(S.base,"remix-author");
  const reader = await home(S.base,"remix-reader");
  const work = {kind:"work",work_kind:"document",ref:"remix-doc",slug:"remix-doc-fixture",title:"Launch notes",
    snapshot:"## Approved version\nMake a copy."};
  const listed = await author.ok("PUT","/v1/ot/listings",work);
  const detail = "/v1/ot/discover/"+work.slug;
  const remix = detail+"/remix";
  assert.equal((await fetch(S.base+remix)).status,401);
  const card = (await reader.ok("GET",detail+"/detail")).work;
  assert.equal(card.remix_available,true);
  assert.equal(card.snapshot,undefined);
  const first = await reader.ok("GET",remix);
  assert.deepEqual(Object.keys(first),["template"]);
  assert.deepEqual({kind:first.template.kind,title:first.template.title},{kind:"document",title:work.title});
  assert.match(first.template.revision,/^[0-9a-f]{64}$/);
  assert.deepEqual((await reader.ok("GET",remix+"?revision="+first.template.revision)).source,
    {kind:"document",body:work.snapshot});
  const latest = await author.ok("PUT","/v1/ot/listings",{...work,snapshot:"Another content revision"});
  assert.equal(latest.id,listed.id);
  const stale = await reader.call("GET",remix+"?revision="+first.template.revision);
  assert.equal(stale.status,409);
  assert.equal(stale.data.error.code,"listing_changed");
  assert.equal((await reader.call("GET",remix+"?include=private")).status,400);
  await author.ok("DELETE","/v1/ot/listings/"+listed.id);
  assert.equal((await author.call("GET",remix)).status,404);
  assert.equal((await reader.call("GET",remix)).status,404);

  const site = {kind:"work",work_kind:"website",ref:"remix-site",slug:"remix-site-fixture",title:"Public site",
    site_html:"<!doctype html><title>Site</title><h1>Released page</h1>"};
  await author.ok("PUT","/v1/ot/listings",site);
  const siteRemix = "/v1/ot/discover/"+site.slug+"/remix";
  const {template} = await reader.ok("GET",siteRemix);
  assert.deepEqual((await reader.ok("GET",siteRemix+"?revision="+template.revision)).source,{kind:"website",body:site.site_html});
  for (const [kind,snapshot] of [["slides","Visible outline"],["document",'{"legacy":"non-canonical content"}'],["document",""]]) {
    const slug = "remix-none-"+kind+(snapshot ? "-value" : "-empty");
    await author.ok("PUT","/v1/ot/listings",{kind:"work",work_kind:kind,ref:slug,slug,title:"Unsupported",snapshot});
    assert.equal((await reader.call("GET","/v1/ot/discover/"+slug+"/remix")).status,404);
  }
});

test("editable work releases require explicit canonical content and keep it out of previews and feeds", async () => {
  const author = await home(S.base,"editable-release-author");
  const reader = await home(S.base,"editable-release-reader");
  const listing = {kind:"work",work_kind:"slides",ref:"slides-release",slug:"slides-editable-release",title:"Release slides",
    snapshot:"A public outline"};
  const preview = await author.ok("PUT","/v1/ot/listings",listing);
  const path = "/v1/ot/discover/"+listing.slug;
  assert.equal((await reader.ok("GET",path+"/detail")).work.remix_available,undefined);
  assert.equal((await reader.call("GET",path+"/remix")).status,404);
  const slides = {schema:"flybot-workspace.slides.v1",slides:[{title:"First slide",bullets:Array(10).fill("b".repeat(200))}]};
  const injected = {...slides,slides:[{title:"First slide",bullets:["Approved"],private_notes:"Should not be public"}]};
  assert.equal((await author.call("PUT","/v1/ot/listings",{...listing,editable_snapshot:injected})).status,400);
  assert.equal((await reader.call("GET",path+"/remix")).status,404);
  const optedIn = await author.ok("PUT","/v1/ot/listings",{...listing,editable_snapshot:slides});
  assert.equal(optedIn.id,preview.id);
  assert.equal(optedIn.editable_remix,true);
  assert.equal((await author.ok("GET","/v1/ot/listings/mine")).listings.find((row: any) => row.id === preview.id).editable_remix,true);
  const feed = (await reader.ok("GET","/v1/ot/discover?kind=work&q=Release%20slides")).items[0];
  assert.equal(feed.editable_snapshot,undefined);
  assert.equal(feed.editable_remix,undefined);
  const guest = await fetch(S.base+"/w/"+listing.slug+"?view=preview",{headers:{accept:"application/json"}}).then(r=>r.json());
  assert.equal(guest.preview,listing.snapshot);
  assert.equal(guest.source,undefined);
  const detail = (await reader.ok("GET",path+"/detail")).work;
  assert.equal(detail.remix_available,true);
  assert.equal(detail.editable_snapshot,undefined);
  const template = await reader.ok("GET",path+"/remix");
  assert.deepEqual(Object.keys(template),["template"]);
  assert.equal(template.template.kind,"slides");
  const after = (revision: string) => reader.call("GET",path+"/remix?revision="+revision);
  assert.deepEqual((await after(template.template.revision)).data.source,{kind:"slides",slides});

  const next = {...slides,slides:[{title:"New content",bullets:["Another revision"]}]};
  await author.ok("PUT","/v1/ot/listings",{...listing,editable_snapshot:next});
  const stale = await after(template.template.revision);
  assert.equal(stale.status,409);
  assert.equal(stale.data.error.code,"listing_changed");
  await author.ok("PUT","/v1/ot/listings",listing);
  assert.equal((await reader.call("GET",path+"/remix")).status,404);
  assert.equal((await reader.ok("GET",path+"/detail")).work.remix_available,undefined);

  const board = {schema:"flybot-workspace.whiteboard.v1",width:800,height:600,strokes:[
    {id:"draw-path-1",type:"path",color:"#123456",width:3,points:[[10,15],[25,40]]},
    {id:"draw-text-1",type:"text",color:"#abcdef",x:40,y:85,size:18,text:"公开板书"},
  ]};
  const canvas = {kind:"work",work_kind:"whiteboard",ref:"board-release",slug:"board-editable-release",title:"Release board"};
  const published = await author.ok("PUT","/v1/ot/listings",{...canvas,editable_snapshot:board});
  assert.equal((await author.call("PUT","/v1/ot/listings",{...canvas,editable_snapshot:{...board,strokes:[{...board.strokes[0],private_url:"hidden"}]}})).status,400);
  assert.equal((await author.call("PUT","/v1/ot/listings",{...canvas,editable_snapshot:{...board,strokes:[board.strokes[0],board.strokes[0]]}})).status,400);
  const boardPath = "/v1/ot/discover/"+canvas.slug+"/remix";
  const {template: boardTemplate} = await reader.ok("GET",boardPath);
  const response = await reader.ok("GET",boardPath+"?revision="+boardTemplate.revision);
  assert.deepEqual(response.source,{kind:"whiteboard",board});
  await author.ok("DELETE","/v1/ot/listings/"+published.id);
  assert.equal((await reader.call("GET",boardPath+"?revision="+boardTemplate.revision)).status,404);
  assert.equal(S.platform.db.prepare("SELECT 1 FROM ot_listing_editable WHERE listing_id=?").get(published.id),undefined);
});

test("media remix exposes metadata until confirmation and rejects a same-timestamp file replacement", async (t) => {
  const sameTime = Date.now();
  const server = await startServer({...bulkAuth,now:() => sameTime});
  t.after(server.stop);
  const author = await home(server.base,"media-remix-author");
  const reader = await home(server.base,"media-remix-reader");
  const audio = {kind:"work",work_kind:"audio",ref:"audio-remix",slug:"audio-remix-fixture",title:"Sound clip",
    media_filename:"声音.wav",media_mime:"audio/wav",media_data:WAV.toString("base64")};
  const published = await author.ok("PUT","/v1/ot/listings",audio);
  const path = "/v1/ot/discover/"+audio.slug;
  assert.equal((await reader.ok("GET",path+"/detail")).work.remix_available,true);
  const first = await reader.ok("GET",path+"/remix");
  assert.deepEqual(Object.keys(first),["template"]);
  assert.deepEqual(first.template.media,{mime:audio.media_mime,filename:audio.media_filename,bytes:WAV.length});
  assert.equal(first.template.kind,"media");
  const read = (revision: string) => reader.call("GET",path+"/remix?revision="+revision);
  assert.deepEqual((await read(first.template.revision)).data.source,{
    kind:"media",mime:audio.media_mime,filename:audio.media_filename,bytes:WAV.length,data:audio.media_data,
  });
  const modified = Buffer.from(WAV);
  modified[modified.length-1] ^= 1;
  const update = await author.ok("PUT","/v1/ot/listings",{...audio,media_data:modified.toString("base64")});
  assert.equal(update.updated_at,published.updated_at);
  const stale = await read(first.template.revision);
  assert.equal(stale.status,409);
  assert.equal(stale.data.error.code,"listing_changed");
  const second = await reader.ok("GET",path+"/remix");
  assert.deepEqual(second.template.media,first.template.media);
  assert.notEqual(second.template.revision,first.template.revision);
  assert.equal((await read(second.template.revision)).data.source.data,modified.toString("base64"));
  await author.ok("DELETE","/v1/ot/listings/"+published.id);
  assert.equal((await read(second.template.revision)).status,404);

  const model = {kind:"work",work_kind:"model3d",ref:"model-remix",slug:"model-remix-fixture",title:"三角模型",model_data:TRIANGLE_GLB};
  await author.ok("PUT","/v1/ot/listings",model);
  const route = "/v1/ot/discover/"+model.slug;
  assert.equal((await reader.ok("GET",route+"/detail")).work.remix_available,true);
  const {template} = await reader.ok("GET",route+"/remix");
  assert.deepEqual(template.media,{mime:"model/gltf-binary",filename:"三角模型.glb",bytes:Buffer.from(TRIANGLE_GLB,"base64").length});
  assert.equal((await reader.ok("GET",route+"/remix?revision="+template.revision)).source.data,TRIANGLE_GLB);
});

test("publish, discover, like, collect, follow and notify followers", async () => {
  const A = await home(S.base, "creator");
  const B = await home(S.base, "fan");
  const tag = `${Date.now() % 100000}`;
  await B.ok("POST", "/v1/ot/follows", { handle: A.handle });
  assert.ok((await A.ok("GET", "/v1/ot/notifications")).notifications.some((n: any) => n.kind === "follow.new" && n.data.follower.handle === B.handle));
  assert.equal((await A.call("POST", "/v1/ot/follows", { handle: A.handle })).status, 400);

  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "bot_writer", slug: `writer-${tag}`, title: "Writer", summary: "drafts posts", category: "content-creation" });
  assert.equal(agent.path, `/a/writer-${tag}`);
  const work = await A.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "art_1", slug: `deck-${tag}`, title: "Quarterly deck", work_kind: "slides", snapshot: "# Q3\n- growth" });
  assert.equal(work.snapshot, "# Q3\n- growth");
  assert.equal((await B.call("PUT", "/v1/ot/listings", { kind: "work", ref: "x", slug: `deck-${tag}`, title: "steal" })).status, 409);
  assert.equal((await A.call("PUT", "/v1/ot/listings", { kind: "agent", ref: "y", slug: "settings", title: "bad" })).status, 400);
  assert.equal((await A.call("PUT", "/v1/ot/listings", { kind: "agent", ref: "y", slug: `ok-${tag}`, title: "bad", category: "nope" })).status, 400);
  const published = (await B.ok("GET", "/v1/ot/notifications")).notifications.filter((n: any) => n.kind === "discover.published");
  assert.equal(published.length, 2);

  const all = await B.ok("GET", `/v1/ot/discover?q=quarterly`);
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].following, true);
  assert.equal(all.items[0].snapshot, undefined, "list never carries snapshots");
  const publicAgents = (await B.ok("GET", `/v1/ot/discover?kind=agent&creator=${A.handle}&category=content-creation`)).items;
  assert.equal(publicAgents.length, 1);
  assert.equal(publicAgents[0].ref, undefined, "the public directory does not expose local identifiers");
  assert.equal((await B.ok("GET", `/v1/ot/discover?tab=following&creator=${A.handle}`)).items.length, 2);
  await B.ok("POST", `/v1/ot/listings/${work.id}/like`, {});
  await B.ok("POST", `/v1/ot/listings/${work.id}/collect`, {});
  const detail = await B.ok("GET", `/v1/ot/discover/deck-${tag}`);
  assert.deepEqual([detail.likes, detail.collections, detail.liked, detail.collected, detail.own], [1, 1, true, true, false]);
  assert.equal(detail.snapshot, "# Q3\n- growth");
  assert.equal((await B.ok("GET", "/v1/ot/discover?tab=collected")).items.length, 1);
  await B.ok("POST", `/v1/ot/listings/${work.id}/like`, { on: false });
  assert.equal((await B.ok("GET", `/v1/ot/discover/deck-${tag}`)).likes, 0);

  assert.equal((await B.call("DELETE", `/v1/ot/listings/${work.id}`)).status, 404, "only the creator unlists");
  await A.ok("DELETE", `/v1/ot/listings/${work.id}`);
  assert.equal((await B.call("GET", `/v1/ot/discover/deck-${tag}`)).status, 404);
  assert.equal((await A.ok("GET", `/v1/ot/discover/deck-${tag}`)).listed, false, "the creator still sees it");
  const mine = (await A.ok("GET", "/v1/ot/listings/mine")).listings;
  assert.equal(mine.length, 2);
  assert.equal(mine.find((entry: any) => entry.id === agent.id).ref, "bot_writer");
  assert.deepEqual((await B.ok("GET", "/v1/ot/listings/mine")).listings, []);
  const f = await A.ok("GET", "/v1/ot/follows");
  assert.deepEqual(f.followers.map((p: any) => p.handle), [B.handle]);
  await B.ok("POST", "/v1/ot/follows", { handle: A.handle, on: false });
  assert.equal((await A.ok("GET", "/v1/ot/follows")).followers.length, 0);
});

test("public listing pages need no token and hide unlisted works", async () => {
  const { publicPrefix } = await import("../src/flybot-workspace/discover.ts");
  assert.equal(publicPrefix("https://flybot-workspace.example/social"), "/social");
  assert.equal(publicPrefix("https://flybot-workspace.example/social/"), "/social");
  assert.equal(publicPrefix("https://flybot-workspace.example"), "");

  const A = await home(S.base, "public-creator");
  const tag = `${Date.now() % 100000}`;
  const work = await A.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "pub_1", slug: `essay-${tag}`, title: "Public essay", work_kind: "document", snapshot: "hello <script> world" });
  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "bot_pub", slug: `guide-${tag}`, title: "Guide bot", snapshot: JSON.stringify({ name: "Guide bot", quick_starts: ["介绍一下你"] }) });
  assert.equal(work.path, `/w/essay-${tag}`);
  assert.equal(agent.path, `/a/guide-${tag}`);

  const anon = await fetch(`${S.base}/v1/ot/public/listings/essay-${tag}`);
  assert.equal(anon.status, 200);
  const body = await anon.json() as any;
  assert.equal(body.title, "Public essay");
  assert.equal(body.liked, false);
  assert.equal(body.own, false);
  assert.equal(body.snapshot, "hello <script> world");

  const html = await fetch(`${S.base}/w/essay-${tag}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /text\/html/);
  assert.equal(html.headers.get("cache-control"), "no-store");
  const page = await html.text();
  assert.match(page, /Public essay/);
  assert.equal(page.includes("<script>"), false, "snapshot is escaped");
  assert.match(page, /hello &lt;script&gt; world/);
  assert.doesNotMatch(page, /public-agent-(composer|share)|script-src 'self'/);

  const preview = await fetch(`${S.base}/w/essay-${tag}/preview`);
  assert.equal((await preview.json() as any).preview, "hello <script> world");

  const agentPage = await fetch(`${S.base}/a/guide-${tag}`);
  assert.match(await agentPage.text(), /介绍一下你/);

  const asJson = await fetch(`${S.base}/a/guide-${tag}`, { headers: { accept: "application/json" } });
  assert.equal((await asJson.json() as any).kind, "agent");

  await A.ok("DELETE", `/v1/ot/listings/${work.id}`);
  assert.equal((await fetch(`${S.base}/w/essay-${tag}`)).status, 404);
  assert.equal((await fetch(`${S.base}/v1/ot/public/listings/essay-${tag}`)).status, 404);
});

test("the public work preview is bounded, listed-only, and independent of the viewer", async () => {
  const publisher = await home(S.base, "preview-publisher");
  const reader = await home(S.base, "preview-reader");
  const {owner_id, display_name, handle} = await publisher.ok("GET", "/v1/ot/me");
  const platformId = "a2".repeat(16);
  S.platform.db.prepare("UPDATE ot_profiles SET platform_user_id=? WHERE owner_id=?").run(platformId, owner_id);

  const slug = "public-preview-essay";
  const path = `/w/${slug}`;
  const snapshot = "Published excerpt <script>\n" + "x".repeat(198_000) + " full snapshot tail";
  const work = await publisher.ok("PUT", "/v1/ot/listings", {
    kind: "work", ref: "owner-local-artifact", slug, title: "Public preview", work_kind: "document", snapshot,
  });
  await publisher.ok("PUT", "/v1/ot/listings", {
    kind: "agent", ref: "owner-local-agent", slug: "work-preview-agent", title: "An agent",
  });
  await reader.ok("POST", "/v1/ot/listings/" + work.id + "/like", {});
  await reader.ok("POST", "/v1/ot/listings/" + work.id + "/collect", {});
  await reader.ok("POST", "/v1/ot/follows", {handle});

  const headers = {accept: "application/json"};
  const response = await fetch(S.base + path + "?view=preview", {headers});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Accept");
  const payload = await response.text();
  assert.ok(payload.length < 2_500, "the public response omits the rest of the snapshot");
  const preview = JSON.parse(payload);
  assert.deepEqual(preview, {
    slug, title: "Public preview", kind: "document", author: handle.replace(/^@/, "").replace(/\.home$/, ""),
    creator: {handle, name: display_name}, updated: Math.floor(work.updated_at / 1000),
    path, likes: 1, collections: 1, comment_count: 0, site_available: false,
    preview: snapshot.slice(0, 2000),
  });
  assert.deepEqual(await (await fetch(S.base + path + "/preview")).json(), {preview: preview.preview});
  const publicPage = await fetch(S.base + path + "?view=preview");
  assert.equal(publicPage.headers.get("content-type")?.startsWith("text/html"), true);
  assert.ok((await publicPage.text()).includes(`href="/discover?creator=${encodeURIComponent(handle)}"`));
  assert.equal((await fetch(S.base + "/w/work-preview-agent?view=preview", {headers})).status, 404);
  assert.equal((await fetch(S.base + "/w/unknown-preview?view=preview", {headers})).status, 404);

  for (const rawPath of [path, `/v1/ot/public/listings/${slug}`, "/a/work-preview-agent"]) {
    const raw = await (await fetch(S.base + rawPath, {headers})).json() as any;
    assert.deepEqual(raw.creator, {handle, display_name, bio: ""});
    assert.ok(!JSON.stringify(raw).includes(platformId));
    assert.ok(!JSON.stringify(raw).includes(owner_id));
    assert.equal(raw.liked, false);
    assert.equal(raw.own, false);
    if (raw.kind === "work") assert.equal(raw.snapshot, snapshot, "legacy public JSON keeps the published snapshot");
  }
  await publisher.ok("DELETE", "/v1/ot/listings/" + work.id);
  assert.equal((await fetch(S.base + path + "?view=preview", {headers})).status, 404);
});

test("a public preview gives chronological neighbors inside the requested public filters", async () => {
  const [creator, other] = await Promise.all([home(S.base, "preview-neighbor-owner"), home(S.base, "preview-neighbor-other")]);
  const term = "Scoped public neighbors";
  const publish = async (publishAs: typeof creator, suffix: string, time: number, workKind = "document", prefix = term) => {
    const slug = "direct-browse-" + suffix;
    const entry = await publishAs.ok("PUT", "/v1/ot/listings", {
      kind:"work", work_kind:workKind, ref:slug, slug, title:`${prefix} ${suffix}`, snapshot:"Public preview text",
    });
    S.platform.db.prepare("UPDATE ot_listings SET updated_at=? WHERE id=?").run(time, entry.id);
    return entry;
  };
  const newer = await publish(creator,"newer",500);
  const anchor = await publish(creator,"anchor",300);
  const older = await publish(creator,"older",100);
  await publish(other,"other-author",430);
  await publish(creator,"other-kind",440,"slides");
  await publish(creator,"other-topic",450,"document","Unrelated title");
  const withdrawn = await publish(creator,"withdrawn",460);
  await creator.ok("DELETE", "/v1/ot/listings/" + withdrawn.id);
  const read = (creatorFilter = creator.handle, query = term) => fetch(S.base + `/w/${anchor.slug}?` + new URLSearchParams({
    view:"preview", nav:"latest", kind:"document", creator:creatorFilter, q:query, tab:"following",
  }), {headers:{accept:"application/json"}});
  const response = await read();
  assert.equal(response.status,200);
  const view = await response.json() as any;
  assert.deepEqual(view.previous,{slug:newer.slug,title:newer.title});
  assert.deepEqual(view.next,{slug:older.slug,title:older.title});
  for (const [handle,q] of [[creator.handle,"Unrelated title"],["former-author.home",term]]) {
    const result = await read(handle,q);
    assert.equal(result.status,200);
    const work = await result.json() as any;
    assert.equal(work.slug,anchor.slug);
    assert.equal(work.previous,null);
    assert.equal(work.next,null);
  }
  await creator.ok("DELETE", "/v1/ot/listings/" + anchor.id);
  assert.equal((await read()).status,404);
});

test("publication notifications resolve the current listing by ID and disappear when it is unlisted", async () => {
  const [publisher, follower, other] = await Promise.all([
    home(S.base, "renamed-publisher"), home(S.base, "renamed-follower"), home(S.base, "reused-address"),
  ]);
  const inbox = "/v1/ot/notifications";
  await follower.ok("POST", "/v1/ot/follows", { handle: publisher.handle });
  const original = { kind: "agent", ref: "original_agent", slug: "original-published-slug", title: "Initial title" };
  const listing = await publisher.ok("PUT", "/v1/ot/listings", original);
  const [notice] = (await follower.ok("GET", inbox)).notifications;
  assert.equal(notice.data.listing_id, listing.id);
  assert.equal(notice.data.slug, original.slug);

  const renamed = { ...original, slug: "updated-published-slug", title: "Current title" };
  const updated = await publisher.ok("PUT", "/v1/ot/listings", renamed);
  assert.equal(updated.id, listing.id);
  const reused = await other.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "replacement_work",
    work_kind: "document", slug: original.slug, title: "Different listing" });
  assert.notEqual(reused.id, listing.id);
  const inboxPage = await follower.ok("GET", inbox + "?personal=1&latest=1&unread=1");
  assert.equal(inboxPage.unread, 1);
  assert.equal(inboxPage.notifications.length, 1);
  const [actual] = inboxPage.notifications;
  assert.deepEqual([actual.id, actual.seq], [notice.id, notice.seq]);
  assert.deepEqual([actual.data.listing_id, actual.data.slug, actual.data.title, actual.data.kind, actual.data.listing_kind],
    [listing.id, renamed.slug, renamed.title, "agent", "agent"]);

  await publisher.ok("DELETE", "/v1/ot/listings/" + listing.id);
  assert.deepEqual(await follower.ok("GET", inbox + "?latest=1"), { notifications: [], unread: 0 });
  assert.equal((await follower.call("POST", inbox + "/read", { notification_id: actual.id })).status, 404);
  assert.deepEqual(await follower.ok("POST", inbox + "/read", { all: true }), { marked: 0, unread: 0 });
  assert.equal((await follower.ok("GET", "/v1/ot/discover/" + original.slug)).id, reused.id);
});

test("published chats stay paired, use the publisher inbox, and stop receiving replies after revocation", async () => {
  const publisher = await home(S.base, "public-chat-publisher");
  const visitor = await home(S.base, "public-chat-visitor");
  const other = await home(S.base, "public-chat-other");
  const slug = "scoped-visitor-chat";
  const listing = {kind:"agent", ref:"writer_bot", slug, title:"Writer", summary:"Public summary"};
  const start = "/v1/ot/discover/" + slug + "/start";
  const row = await publisher.ok("PUT", "/v1/ot/listings", listing);
  assert.equal(row.chat_enabled, false);
  assert.equal((await visitor.call("POST", start)).status, 409);
  const snapshot = JSON.stringify({version:1,instructions:"Public prompt"});
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot, chat_enabled:true});
  const first = await visitor.ok("POST", start);
  assert.ok((await publisher.ok("GET", "/v1/ot/notifications")).notifications.some(
    (item: any) => item.kind === "discover.conversation_started" && item.data.conversation_id === first.conversation_id,
  ));
  assert.equal((await visitor.ok("POST", start)).conversation_id, first.conversation_id);
  assert.notEqual((await other.ok("POST", start)).conversation_id, first.conversation_id);
  const thread = "/v1/ot/conversations/" + first.conversation_id;
  assert.equal((await other.call("GET", thread)).status, 404);
  for (const participant of [publisher, visitor]) {
    assert.deepEqual(await participant.ok("GET", thread + "/attachments?kind=file"), {items: [], next_cursor: null});
  }
  assert.equal((await other.call("GET", thread + "/attachments?kind=file")).status, 404);
  assert.equal((await visitor.call("POST", thread + "/members", {handle:other.handle})).status, 409);
  assert.equal((await visitor.call("PUT", thread + "/agents/my_agent", {name:"Another agent"})).status, 409);
  const sent = await visitor.ok("POST", thread + "/messages", {body:"A visitor question"});
  assert.equal((await visitor.ok("GET", thread)).public_agent.pending, true);
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/agent-inbox")).items, []);
  const inbox = await publisher.ok("GET", "/v1/ot/agent-inbox");
  const item = inbox.items.find((i:any)=>i.message.id===sent.id);
  assert.deepEqual(item.published, {title:"Writer",summary:"Public summary",snapshot});
  assert.equal(item.mode, "public");
  const response = {agent_ref:"writer_bot", mode:"public", reply_to:sent.id, body:"A reply"};
  const answered = await publisher.ok("POST", thread + "/agent-messages", response);
  assert.equal((await publisher.ok("POST", thread + "/agent-messages", response)).id, answered.id);
  assert.equal((await visitor.ok("GET", thread)).public_agent.pending, false);
  const waiting = await visitor.ok("POST", thread + "/messages", {body:"A second question"});
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot, chat_enabled:false});
  assert.equal((await visitor.ok("GET", thread)).public_agent.open, false);
  assert.equal((await visitor.call("POST", thread + "/messages", {body:"Closed"})).status, 409);
  assert.equal((await publisher.call("POST", thread + "/agent-messages", {...response,reply_to:waiting.id})).status, 409);
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot, chat_enabled:true});
  assert.equal((await publisher.call("POST", thread + "/agent-messages", {...response,reply_to:waiting.id})).status, 409);
  assert.equal((await visitor.ok("GET", thread + "/messages")).messages.length, 3);
});

test("public quick-start opens one private thread and drafts the current published choice without sending", async () => {
  const publisher = await home(S.base, "quick-start-publisher");
  const visitor = await home(S.base, "quick-start-visitor");
  const stranger = await home(S.base, "quick-start-stranger");
  const slug = "published-quick-start";
  const listing = {kind:"agent", ref:"quick_bot", slug, title:"Quick agent", chat_enabled:true};
  const path = "/v1/ot/discover/" + slug + "/start";
  const page = async () => {
    const response = await fetch(S.base + "/a/" + slug);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.text();
  };
  const snapshot = JSON.stringify({quick_starts:["请介绍 <产品>", "列出计划"]});
  const release = await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot});
  const rendered = await page();
  assert.match(rendered, /请介绍 &lt;产品&gt;/);
  assert.match(rendered, /href="\/(?:chat|login)#public-agent=published-quick-start"/);
  assert.doesNotMatch(rendered, /请介绍 <产品>/);
  const version = /quick-start=0&amp;quick-start-version=([a-f0-9]{64})/.exec(rendered)?.[1];
  assert.ok(version);
  const viaJson = await fetch(S.base + "/a/" + slug, {headers:{accept:"application/json"}});
  assert.equal(viaJson.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(S.base + "/v1/ot/public/listings/" + slug)).headers.get("cache-control"), "no-store");
  const request = {quick_start:0, quick_start_version:version};
  assert.equal((await fetch(S.base + path, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(request)})).status, 401);
  assert.equal((await publisher.call("POST", path, request)).status, 400);
  assert.equal((await visitor.call("POST", path, {...request, body:"forged text"})).status, 400);
  assert.equal((await visitor.call("POST", path, {...request, quick_start:4})).status, 409);

  const first = await visitor.ok("POST", path, request);
  assert.equal(first.created, true);
  assert.equal(first.draft_text, "请介绍 <产品>");
  const again = await visitor.ok("POST", path, {...request, quick_start:1});
  assert.equal(again.created, false);
  assert.equal(again.conversation_id, first.conversation_id);
  assert.equal(again.draft_text, "列出计划");
  const thread = "/v1/ot/conversations/" + first.conversation_id;
  assert.equal((await visitor.ok("POST", path)).draft_text, undefined);
  assert.equal((await stranger.call("GET", thread + "/messages")).status, 404);
  assert.deepEqual((await visitor.ok("GET", thread + "/messages")).messages, []);
  assert.deepEqual((await publisher.ok("GET", "/v1/ot/agent-inbox")).items, []);
  assert.equal((await publisher.ok("GET", "/v1/ot/notifications")).notifications.some(
    (item: any) => item.kind === "discover.conversation_started" && item.data.conversation_id === first.conversation_id,
  ), false);
  const sent = await visitor.ok("POST", thread + "/messages", {body:first.draft_text});
  const original = (await publisher.ok("GET", "/v1/ot/agent-inbox")).items.find((item: any) => item.message.id === sent.id);
  assert.equal(original.mode, "public");
  assert.equal(original.agent_ref, listing.ref);
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/agent-inbox")).items, []);

  const nextSnapshot = JSON.stringify({quick_starts:["更新后的开场"]});
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot:nextSnapshot});
  const stale = await visitor.call("POST", path, request);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "quick_start_changed");
  const freshVersion = /quick-start=0&amp;quick-start-version=([a-f0-9]{64})/.exec(await page())?.[1];
  assert.ok(freshVersion && version !== freshVersion);
  assert.equal((await visitor.ok("POST", path, {...request, quick_start_version:freshVersion})).draft_text, "更新后的开场");
  assert.equal((await visitor.ok("GET", thread + "/messages")).messages.length, 1);

  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot:nextSnapshot, chat_enabled:false});
  assert.doesNotMatch(await page(), /quick-start-version/);
  assert.equal((await visitor.call("POST", path, {...request, quick_start_version:freshVersion})).status, 409);
  await publisher.ok("DELETE", "/v1/ot/listings/" + release.id);
  const unpublished = await fetch(S.base + "/a/" + slug);
  assert.equal(unpublished.status, 404);
  assert.equal(unpublished.headers.get("cache-control"), "no-store");
  assert.equal((await visitor.call("POST", path, request)).status, 404);
});

test("the public composer is gated by chat availability and a drafted start is bound to its listing ID", async () => {
  const [publisher, replacement, visitor] = await Promise.all([
    home(S.base, "composer-publisher"), home(S.base, "composer-replacement"), home(S.base, "composer-visitor"),
  ]);
  const listing = { kind: "agent", slug: "public-draft-agent", ref: "draft_agent", title: 'Draft <writer>',
    snapshot: JSON.stringify({ quick_starts: ["A safe quick-start"] }) };
  const start = "/v1/ot/discover/" + listing.slug + "/start";
  const original = await publisher.ok("PUT", "/v1/ot/listings", listing);
  const page = async () => {
    const response = await fetch(S.base + "/a/" + listing.slug);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.text();
  };
  assert.doesNotMatch(await page(), /<form id="public-agent-composer"|src="\/shell\/public-agent-composer/);
  assert.equal((await visitor.call("POST", start, { listing_id: original.id })).data.error.code, "public_chat_closed");

  await publisher.ok("PUT", "/v1/ot/listings", { ...listing, chat_enabled: true });
  const html = await page();
  assert.match(html, /Draft &lt;writer&gt;/);
  assert.match(html, /form-action 'none';[^"]*script-src 'self';/);
  assert.match(html, /<script type="module" src="\/shell\/public-agent-composer\.mjs"><\/script>/);
  assert.ok(html.includes(`<form id="public-agent-composer" method="post" data-slug="${listing.slug}" data-listing-id="${original.id}">`));
  assert.match(html, /<textarea[^>]+name="message"[^>]+maxlength="4000"[^>]+disabled/);
  assert.match(html, /<button[^>]+type="submit" disabled>/);
  assert.match(html, /href="\/login#public-agent=public-draft-agent"/);
  assert.match(html, /quick-start-version=[a-f0-9]{64}/);

  const selection = { listing_id: original.id };
  assert.equal((await fetch(S.base + start, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(selection) })).status, 401);
  assert.equal((await visitor.call("POST", start, { listing_id: "otl_fake" })).status, 400);
  assert.equal((await visitor.call("POST", start, { ...selection, message: "Private draft" })).status, 400);
  assert.equal((await visitor.call("POST", start, {
    ...selection, quick_start: 0, quick_start_version: "a".repeat(64),
  })).status, 400);
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/conversations?scope=public")).conversations, []);

  const opened = await visitor.ok("POST", start, selection);
  assert.equal(opened.created, true);
  assert.equal(opened.draft_text, undefined);
  assert.equal((await visitor.ok("POST", start, selection)).conversation_id, opened.conversation_id);
  const messages = "/v1/ot/conversations/" + opened.conversation_id + "/messages";
  assert.deepEqual((await visitor.ok("GET", messages)).messages, []);
  assert.deepEqual((await publisher.ok("GET", "/v1/ot/agent-inbox")).items, []);
  assert.equal((await publisher.ok("GET", "/v1/ot/notifications")).notifications
    .some((item: { kind: string }) => item.kind === "discover.conversation_started"), false);

  await publisher.ok("PUT", "/v1/ot/listings", { ...listing, slug: "draft-agent-moved", chat_enabled: true });
  const alternative = await replacement.ok("PUT", "/v1/ot/listings", { ...listing, chat_enabled: true });
  assert.notEqual(alternative.id, original.id);
  const conflict = await visitor.call("POST", start, selection);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, "public_agent_changed");
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/conversations?scope=public")).conversations
    .map((row: { id: string }) => row.id), [opened.conversation_id]);
  assert.deepEqual((await replacement.ok("GET", "/v1/ot/conversations?scope=public")).conversations, []);
  const sent = await visitor.ok("POST", messages, { body: "The confirmed message" });
  assert.ok((await publisher.ok("GET", "/v1/ot/agent-inbox")).items.some((item: { message: { id: string } }) =>
    item.message.id === sent.id));
  assert.deepEqual((await replacement.ok("GET", "/v1/ot/agent-inbox")).items, []);
});

test("listed agent profiles expose a canonical share path even when visitor chat is disabled", async () => {
  const publisher = await home(S.base, "profile-share-publisher");
  await publisher.ok("PUT", "/v1/ot/profile", { display_name: 'Name <img src=x onerror="alert(1)">' });
  const slug = "profile-share-agent";
  const malicious = '<script src="https://fixture.invalid/injected.js"></script>';
  const listing = { kind: "agent", ref: "shareable_agent", slug, title: malicious, summary: malicious,
    snapshot: JSON.stringify({ quick_starts: ["Open this example"] }) };
  const path = "/a/" + slug;
  for (const chat_enabled of [false, true]) {
    await publisher.ok("PUT", "/v1/ot/listings", { ...listing, chat_enabled });
    const response = await fetch(S.base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /form-action 'none';[^"]*script-src 'self';/);
    assert.equal(html.includes(malicious), false);
    assert.match(html, /Name &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;script src=&quot;https:\/\/fixture\.invalid\/injected\.js&quot;&gt;/);
    assert.match(html, /<script type="module" src="\/shell\/public-agent-share\.mjs"><\/script>/);
    assert.ok(html.includes(`id="public-agent-share" class="profile-share" data-profile-path="${path}"`));
    assert.ok(html.includes(`value="${path}" data-copy-profile-url readonly`));
    assert.ok(html.includes(`href="${path}">打开公开主页`));
    assert.match(html, /<button type="button" data-copy-profile disabled hidden>/);
    assert.match(html, /<details data-copy-profile-fallback>\s*<summary>主页链接<\/summary>/);
    assert.match(html, /data-copy-profile-status role="status" aria-live="polite"/);
    assert.equal(html.includes('<form id="public-agent-composer"'), chat_enabled);
    assert.doesNotMatch(html, /(?:data-profile-path|href)="\/social\/a\//);
  }
  const publicData = await (await fetch(S.base + path, { headers: { accept: "application/json" } })).json() as Record<string, unknown>;
  assert.equal(publicData.kind, "agent");
  assert.equal(Object.hasOwn(publicData, "profile_share_token"), false);
});

test("popular works use recent public engagement, with stable account-scoped cursors", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "popularity-author");
  const reader = await home(server.base, "popularity-reader");
  const other = await home(server.base, "popularity-other");
  const publish = async (slug: string, work_kind = "document", kind = "work") => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {
      kind, ref: slug, slug, title: `Workshop ${slug}`, work_kind, snapshot: `Public ${slug}`,
      ...(work_kind === "model3d" ? {model_data: TRIANGLE_GLB} : {}),
    });
  };
  const oldest = await publish("old-work");
  const model = await publish("model-work", "model3d");
  await publish("new-work");
  await publish("not-a-work", "document", "agent");
  const base = "/v1/ot/discover?kind=work&sort=popular&q=workshop";
  const slugs = (page: {items: {slug: string}[]}) => page.items.map(item => item.slug);

  assert.equal((await fetch(server.base + base)).status, 401);
  const sparse = await reader.ok("GET", base);
  assert.deepEqual(slugs(sparse), ["new-work", "model-work", "old-work"]);
  assert.equal(sparse.next_cursor, null);
  await author.ok("POST", `/v1/ot/listings/${oldest.id}/like`, {});
  assert.deepEqual(slugs(await reader.ok("GET", base)), slugs(sparse), "self-engagement does not boost a work");
  await reader.ok("POST", "/v1/ot/follows", {handle: author.handle});
  await reader.ok("POST", `/v1/ot/listings/${oldest.id}/like`, {});
  await reader.ok("POST", `/v1/ot/listings/${model.id}/collect`, {});
  const ranked = await reader.ok("GET", base);
  assert.deepEqual(slugs(ranked), ["model-work", "old-work", "new-work"]);
  assert.equal(ranked.items[0].collected, true);
  assert.equal(ranked.items[0].following, true);
  assert.ok(ranked.items.every((item: any) => item.snapshot === undefined && item.ref === undefined && item.position === undefined));
  const independent = await other.ok("GET", base);
  assert.deepEqual(slugs(independent), slugs(ranked), "shared order is independent of the viewer's flags");
  assert.equal(independent.items[0].collected, false);
  assert.equal(independent.items[0].following, false);
  assert.deepEqual(slugs(await other.ok("GET", base + "&work_kind=model3d")), ["model-work"]);
  assert.deepEqual(slugs(await other.ok("GET", "/v1/ot/discover?kind=work&q=workshop")), slugs(sparse));
  assert.deepEqual(slugs(await reader.ok("GET", "/v1/ot/discover?kind=work&tab=following&q=workshop")), slugs(sparse));

  const pageOne = await reader.ok("GET", base + "&limit=1");
  assert.deepEqual(slugs(pageOne), ["model-work"]);
  assert.match(pageOne.next_cursor, /^[A-Za-z0-9_-]{32}\.[1-9][0-9]{0,2}$/);
  const suffix = "&limit=1&cursor=" + encodeURIComponent(pageOne.next_cursor);
  assert.equal((await other.call("GET", base + suffix)).status, 400);
  assert.equal((await reader.call("GET", base + suffix + "&work_kind=model3d")).status, 400);
  assert.equal((await reader.call("GET", base + "&before=42")).status, 400);
  assert.equal((await reader.call("GET", base + "&tab=collected")).status, 400);
  assert.equal((await reader.call("GET", base + "&cursor=42")).status, 400);

  await reader.ok("POST", `/v1/ot/listings/${model.id}/collect`, {on:false});
  await author.ok("DELETE", `/v1/ot/listings/${oldest.id}`);
  const pageTwo = await reader.ok("GET", base + suffix);
  assert.deepEqual(slugs(pageTwo), ["new-work"], "revoked works are skipped without re-ranking page one");
  assert.equal(pageTwo.next_cursor, null);
  assert.deepEqual(slugs(await reader.ok("GET", base)), ["new-work", "model-work"]);
  assert.equal((await fetch(server.base + "/w/old-work")).status, 404);
  now += 11 * 60_000;
  const expired = await reader.call("GET", base + suffix);
  assert.equal(expired.status, 409);
  assert.equal(expired.data.error.code, "popularity_expired");
});


test("public GLB downloads appear only after an explicit publish and disappear on revoke", async () => {
  const owner = await home(S.base, "model-author");
  const visitor = await home(S.base, "model-visitor");
  const payload = {kind: "work", ref: "glb-fixture", slug: "clay-figure", title: "陶土模型 🏺", work_kind: "model3d"};
  const publicPage = S.base + "/w/clay-figure";
  const publicFile = publicPage + "/file";
  assert.equal((await fetch(publicFile)).status, 404);
  assert.equal((await owner.call("PUT", "/v1/ot/listings", {...payload, model_data: "aGVsbG8="})).status, 400);
  assert.equal((await fetch(publicPage)).status, 404, "invalid files never create a public page");
  const model = await owner.ok("PUT", "/v1/ot/listings", {...payload, model_data: TRIANGLE_GLB});
  assert.equal(model.model_data, undefined);
  const document = await fetch(publicPage);
  assert.equal(document.status, 200);
  assert.match(await document.text(), /href="\/w\/clay-figure\/file"/);
  const file = await fetch(publicFile);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "model/gltf-binary");
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.match(file.headers.get("content-disposition") ?? "", /filename="clay-figure\.glb"/);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), TRIANGLE_GLB);

  assert.equal((await visitor.call("DELETE", "/v1/ot/listings/" + model.id)).status, 404);
  await owner.ok("DELETE", "/v1/ot/listings/" + model.id);
  assert.equal((await fetch(publicPage)).status, 404);
  assert.equal((await fetch(publicFile)).status, 404);
});

test("public media uses explicit byte snapshots with typed metadata, seek ranges and revocation", async () => {
  const [owner, visitor] = await Promise.all([home(S.base, "media-author"), home(S.base, "media-visitor")]);
  const put = "/v1/ot/listings";
  const payload = {kind: "work", work_kind: "media", ref: "media-fixture", slug: "ceramic-image", title: "陶土 <实拍>",
    media_filename: "陶土照片.png", media_mime: "image/png", media_data: PNG.toString("base64")};
  const image = S.base + "/w/ceramic-image";
  const file = image + "/file";
  assert.equal((await fetch(file)).status, 404);
  for (const invalid of [
    {work_kind: "website"}, {kind: "agent"}, {work_kind: "audio"}, {media_mime: "image/svg+xml"},
    {media_filename: "../private.png"}, {media_filename: "bad\r\n.png"},
    {media_mime: "image/gif"}, {media_data: "<svg onload=alert(1) />"}, {media_data: "aGVs bG8="},
  ]) assert.equal((await owner.call("PUT", put, {...payload, ...invalid})).status, 400);
  assert.equal((await fetch(image)).status, 404);

  const published = await owner.ok("PUT", put, payload);
  assert.equal(published.work_kind, "image", "the media alias is persisted with the searchable kind");
  const feed = await visitor.ok("GET", "/v1/ot/discover?kind=work&work_kind=image&creator=" + encodeURIComponent(owner.handle));
  assert.equal(feed.items[0].slug, "ceramic-image");
  const detail = await visitor.ok("GET", "/v1/ot/discover/ceramic-image/detail");
  const publicData = await (await fetch(image, {headers: {accept: "application/json"}})).json() as any;
  const preview = await (await fetch(image + "?view=preview", {headers: {accept: "application/json"}})).json() as any;
  for (const entry of [published, feed.items[0], detail.work, publicData, preview]) {
    assert.deepEqual([entry.file_available, entry.file_mime, entry.file_bytes], [true, "image/png", PNG.length]);
    assert.equal(entry.media_data, undefined);
    assert.equal(entry.media_filename, undefined);
  }
  const guest = await (await fetch(image)).text();
  assert.match(guest, /<img class="work-media" src="\/w\/ceramic-image\/file" alt="陶土 &lt;实拍&gt;"/);
  assert.match(guest, /href="\/w\/ceramic-image\/file" download/);

  const fetchFile = (range?: string, method = "GET", headers: Record<string, string> = {}) =>
    fetch(file, {method, headers: {...headers, ...(range ? {range} : {})}});
  const whole = await fetchFile();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "image/png");
  assert.equal(whole.headers.get("cache-control"), "no-store");
  assert.equal(whole.headers.get("x-content-type-options"), "nosniff");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-length"), String(PNG.length));
  assert.match(whole.headers.get("content-disposition") ?? "", /^inline; filename="ceramic-image\.png"; filename\*=UTF-8''%E9/);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), PNG);
  const head = await fetchFile("bytes=0-1", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(PNG.length));
  assert.equal(head.headers.get("content-range"), null);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [
    ["bytes=3-8", 3, 8], ["bytes=8-", 8, PNG.length - 1], ["bytes=-4", PNG.length - 4, PNG.length - 1],
    ["bytes=0-999999", 0, PNG.length - 1],
  ] as const) {
    const result = await fetchFile(range);
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("content-length"), String(end - start + 1));
    assert.equal(result.headers.get("content-range"), `bytes ${start}-${end}/${PNG.length}`);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), PNG.subarray(start, end + 1));
  }
  for (const range of [`bytes=${PNG.length}-`, "bytes=8-2", "bytes=-0", "bytes=-"]) {
    const result = await fetchFile(range);
    assert.equal(result.status, 416);
    assert.equal(result.headers.get("content-range"), `bytes */${PNG.length}`);
  }
  const stale = await fetchFile("bytes=0-1", "GET", {"if-range": '"stale"'});
  assert.equal(stale.status, 200);
  assert.deepEqual(Buffer.from(await stale.arrayBuffer()), PNG);

  const audioPayload = {...payload, slug: "ceramic-audio", work_kind: "audio", media_filename: "recording", media_mime: "audio/wav",
    media_data: WAV.toString("base64")};
  assert.equal((await owner.call("PUT", put, {...audioPayload, media_data: PNG.toString("base64")})).status, 400);
  assert.equal((await fetch(file)).status, 200, "invalid replacement leaves the old publish intact");
  const audio = await owner.ok("PUT", put, audioPayload);
  assert.equal(audio.id, published.id);
  assert.equal((await fetch(file)).status, 404, "slug changes remove the old path");
  const audioPage = S.base + "/w/ceramic-audio";
  const audioGuest = await (await fetch(audioPage)).text();
  assert.match(audioGuest, /media-src 'self'/);
  assert.match(audioGuest, /<audio class="work-media" controls preload="none" src="\/w\/ceramic-audio\/file">/);
  const audioBytes = await fetch(audioPage + "/file", {headers: {range: "bytes=-4"}});
  assert.equal(audioBytes.status, 206);
  assert.equal(audioBytes.headers.get("content-type"), "audio/wav");
  assert.match(audioBytes.headers.get("content-disposition") ?? "", /filename\*=UTF-8''recording\.wav$/);
  assert.deepEqual(Buffer.from(await audioBytes.arrayBuffer()), WAV.subarray(-4));
  assert.equal((await visitor.call("DELETE", put + "/" + audio.id)).status, 404);
  await owner.ok("DELETE", put + "/" + audio.id);
  assert.equal((await fetch(audioPage)).status, 404);
  assert.equal((await fetch(audioPage + "/file", {method: "HEAD"})).status, 404);
  assert.equal((await fetch(audioPage + "/file", {headers: {range: "bytes=0-3"}})).status, 404);
  assert.equal(S.platform.db.prepare("SELECT 1 FROM ot_listing_media WHERE listing_id=?").get(audio.id), undefined);
});

test("published media shares the GLB owner quota and replacing a publication releases the old bytes", async (t) => {
  const server = await startServer({...bulkAuth, attachments: {ownerBudgetBytes: Buffer.from(TRIANGLE_GLB, "base64").length}});
  t.after(() => server.stop());
  const [owner, other] = await Promise.all([home(server.base, "media-quota-author"), home(server.base, "media-quota-other")]);
  const put = "/v1/ot/listings";
  const png = {kind: "work", ref: "public-image", slug: "quota-public-image", title: "A photo", work_kind: "image",
    media_filename: "photo.png", media_mime: "image/png", media_data: PNG.toString("base64")};
  const glb = {kind: "work", ref: "public-model", slug: "quota-public-model", title: "A model", work_kind: "model3d",
    model_data: TRIANGLE_GLB};
  const first = await owner.ok("PUT", put, png);
  const over = await owner.call("PUT", put, glb);
  assert.equal(over.status, 413);
  assert.equal(over.data.error.code, "attachment_storage_full");
  assert.equal((await fetch(server.base + "/w/quota-public-model")).status, 404);
  await other.ok("PUT", put, {...png, slug: "quota-other-image"});
  const replacement = await owner.ok("PUT", put, {...glb, ref: png.ref, slug: png.slug});
  assert.equal(replacement.id, first.id);
  const file = await fetch(server.base + "/w/quota-public-image/file");
  assert.equal(file.headers.get("content-type"), "model/gltf-binary");
  assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), TRIANGLE_GLB);
  assert.equal(server.platform.db.prepare("SELECT 1 FROM ot_listing_media WHERE listing_id=?").get(first.id), undefined);
  assert.equal((await owner.call("PUT", put, {...png, ref: "another-image", slug: "quota-second-image"})).status, 413);
  await owner.ok("PUT", put, {kind: "work", work_kind: "document", ref: png.ref, slug: png.slug, title: "Document instead"});
  assert.equal((await fetch(server.base + "/w/quota-public-image/file")).status, 404);
  await owner.ok("PUT", put, {...png, ref: "another-image", slug: "quota-second-image"});
});

test("work detail follows the filtered feed across page boundaries and timestamp ties", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "work-nav-author");
  const outsider = await home(server.base, "work-nav-outsider");
  const viewer = await home(server.base, "work-nav-viewer");
  const publish = (owner: typeof author, slug: string, title: string, workKind = "document") =>
    owner.ok("PUT", "/v1/ot/listings", {
      kind: "work", ref: slug, slug, title, work_kind: workKind, snapshot: "Public snapshot",
    });

  const oldest = await publish(author, "nav-oldest", "Trail sketch oldest");
  now += 1_000;
  const draft = await publish(author, "nav-hidden", "Trail sketch hidden");
  await publish(author, "nav-middle", "Trail sketch middle");
  await publish(author, "nav-same-time", "Trail sketch tied");
  await publish(outsider, "nav-unfollowed", "Trail sketch outside");
  await publish(author, "nav-other-kind", "Trail sketch website", "website");
  await publish(author, "nav-other-search", "Unrelated plans");
  await author.ok("PUT", "/v1/ot/listings", {
    kind: "agent", ref: "nav-agent", slug: "nav-agent", title: "Trail sketch helper",
  });
  await author.ok("DELETE", "/v1/ot/listings/" + draft.id);
  await viewer.ok("POST", "/v1/ot/follows", {handle: author.handle});

  const base = "/v1/ot/discover";
  const detailPath = (slug: string, q = "") => `${base}/${slug}/detail${q}`;
  const filters = "tab=following&work_kind=document&q=trail%20sketch";
  const page = await viewer.ok("GET", `${base}?kind=work&${filters}`);
  const slim = ({slug, title}: {slug: string; title: string}) => ({slug, title});
  const visible = page.items.map(slim);
  assert.deepEqual(new Set(visible.map((item: {slug: string}) => item.slug)),
    new Set(["nav-oldest", "nav-middle", "nav-same-time"]));
  assert.equal((await viewer.ok("GET", `${base}?kind=work&${filters}&limit=1`)).items.length, 1);
  for (const [index, item] of visible.entries()) {
    const data = await viewer.ok("GET", detailPath(item.slug, "?" + filters));
    assert.deepEqual(slim(data.work), item);
    assert.equal(data.work.following, true);
    assert.ok(!("snapshot" in data.work) && !("ref" in data.work));
    assert.deepEqual(data.previous, visible[index - 1] ?? null);
    assert.deepEqual(data.next, visible[index + 1] ?? null);
  }
  const unmatched = await viewer.ok("GET", detailPath("nav-unfollowed", "?" + filters));
  assert.equal(unmatched.work.slug, "nav-unfollowed");
  assert.equal(unmatched.previous, null);
  assert.equal(unmatched.next, null);
  const authorFilter = "creator=" + encodeURIComponent(author.handle) + "&work_kind=document&q=trail%20sketch";
  const scoped = await viewer.ok("GET", `${base}?kind=work&${authorFilter}`);
  assert.deepEqual(scoped.items.map(slim), visible);
  const fromAuthorProfile = await viewer.ok("GET", detailPath(visible[1].slug, "?" + authorFilter));
  assert.deepEqual(fromAuthorProfile.previous, visible[0]);
  assert.deepEqual(fromAuthorProfile.next, visible[2]);
  await viewer.ok("POST", `/v1/ot/listings/${oldest.id}/collect`, {});
  const collected = await viewer.ok("GET", detailPath(oldest.slug, "?tab=collected"));
  assert.equal(collected.work.collected, true);
  assert.equal(collected.previous, null);
  assert.equal(collected.next, null);

  // The previously older work takes the first rank after a visitor collects it.
  const hotFilter = "sort=popular&work_kind=document&q=trail%20sketch";
  const ranked = (await viewer.ok("GET", `${base}?kind=work&${hotFilter}`)).items.map(slim);
  assert.equal(ranked[0].slug, oldest.slug);
  const popular = await viewer.ok("GET", detailPath(oldest.slug, "?" + hotFilter));
  assert.equal(popular.previous, null);
  assert.deepEqual(popular.next, ranked[1]);
  assert.equal((await viewer.call("GET", detailPath("nav-hidden"))).status, 404);
  assert.equal((await author.call("GET", detailPath("nav-hidden"))).status, 404, "the public viewer hides revoked works from their author");
  assert.equal((await viewer.call("GET", detailPath("nav-agent"))).status, 404);
  assert.equal((await viewer.call("GET", detailPath(oldest.slug, "?sort=popular&tab=following"))).status, 400);
  assert.equal((await viewer.call("GET", detailPath(oldest.slug, "?work_kind=unknown"))).status, 400);
  assert.equal((await viewer.call("GET", detailPath(oldest.slug, "?q=trail&q=sketch"))).status, 400);
  assert.equal((await fetch(server.base + detailPath(oldest.slug))).status, 401);
});

test("public work search returns bounded excerpts and excludes hidden and revoked content", async () => {
  const [author, reader] = await Promise.all([home(S.base, "body-search-author"), home(S.base, "body-search-reader")]);
  await author.ok("PUT", "/v1/ot/profile", {display_name: "İnci ÇAĞLA"});
  const publish = (slug: string, changes: Record<string, unknown>) =>
    author.ok("PUT", "/v1/ot/listings", {kind: "work", ref: slug, slug, title: "Exhibition", ...changes});
  const needle = "火星 coöperate";
  const doc = await publish("body-search-document", {
    summary: "A public digest", category: "research",
    snapshot: "🚀 orbital notes ".repeat(310) + "火星\nCOÖPERATE " + "🚀 next ".repeat(140),
  });
  await publish("body-search-website", {
    work_kind: "website", summary: "Summary accidentally includes hidden-site-marker",
    site_html: `<head><title>tab-only-marker</title></head><main data-value="attribute-marker">
      <h1>火星 <strong>co&#xF6;perate</strong></h1><!-- comment-marker -->
      <script>script-marker</script><style>.obscured {display:none} main #collapsed {visibility:collapse}</style>
      <p hidden>hidden-site-marker</p><p aria-hidden="true">aria-marker</p>
      <div style="display: /*comment*/ none"><p>display-marker</p></div>
      <div style="display&#58none">entity-style-marker</div><div class="obscured">stylesheet-class-marker</div>
      <div id="collapsed">stylesheet-id-marker</div><dialog>closed-dialog-marker</dialog>
      <template><p>template-marker</p></template><textarea>textarea-marker</textarea>
    </main>`,
  });
  const spreadsheet = await publish("body-search-spreadsheet", {
    work_kind: "spreadsheet", snapshot: "Sheet 1\nMetric\t" + "拼".repeat(80),
  });
  await publish("body-search-old-board", {work_kind: "whiteboard", snapshot: '{"unpublished":"structured-marker"}'});
  await publish("body-search-old-array", {work_kind: "slides", snapshot: '["array-marker"]'});
  await publish("body-search-braces", {snapshot: '{Labels: "Pioneer"} in a document', title: "Symbols"});
  await author.ok("PUT", "/v1/ot/listings", {kind: "agent", ref: "body-search-agent", slug: "body-search-agent",
    title: "Agent", snapshot: JSON.stringify({instructions: "agent-instructions-marker", quick_starts: ["火星 coöperate"]})});

  const base = "/v1/ot/discover?kind=work&creator=" + encodeURIComponent(author.handle);
  const find = (value: string, filter = "") => reader.ok("GET", base + "&q=" + encodeURIComponent(value) + filter);
  const {items} = await find("火星   coöperate");
  assert.deepEqual(new Set(items.map((item: any) => item.slug)), new Set([doc.slug, "body-search-website"]));
  for (const item of items) {
    const match = item.match;
    assert.equal(match.kind, "body");
    assert.ok(match.text.length <= 160);
    assert.equal(match.text.slice(match.start, match.end).toLowerCase(), needle);
    assert.equal(item.snapshot, undefined);
    assert.equal(item.site_html, undefined);
  }
  assert.equal(items.find((item: any) => item.id === doc.id).match.text.startsWith("…"), true);
  for (const hidden of ["tab-only", "attribute", "comment", "script", "hidden-site", "aria", "display", "entity-style",
    "stylesheet-class", "stylesheet-id", "closed-dialog", "template", "textarea", "structured", "array", "agent-instructions"]) {
    const result = await find(hidden + "-marker");
    assert.deepEqual(result.items, [], hidden);
  }
  assert.equal((await find("exhibition")).items[0].match.kind, "title");
  assert.equal((await find("PUBLIC DIGEST")).items[0].match.kind, "summary");
  assert.equal((await find('"Pioneer"')).items[0].match.kind, "body");
  assert.equal((await find("火星")).items.length, 2);
  const {match} = (await find("çAĞLa")).items[0];
  assert.equal(match.kind, "creator");
  assert.equal(match.text.slice(match.start, match.end), "ÇAĞLA");
  const longQuery = (await find("拼".repeat(80), "&work_kind=spreadsheet")).items[0];
  assert.equal(longQuery.id, spreadsheet.id);
  assert.equal(longQuery.match.end - longQuery.match.start, 80);
  assert.deepEqual((await find(needle, "&tab=following")).items, []);
  await reader.ok("POST", "/v1/ot/follows", {handle: author.handle});
  assert.deepEqual((await find(needle, "&tab=following&category=research")).items.map((item: any) => item.id), [doc.id]);
  await reader.ok("POST", `/v1/ot/listings/${doc.id}/collect`, {});
  assert.deepEqual((await find(needle, "&tab=collected")).items.map((item: any) => item.id), [doc.id]);
  const ranked = (await find(needle, "&sort=popular")).items;
  assert.deepEqual(ranked.map((item: any) => item.match.kind), ["body", "body"]);
  const filter = "?q=" + encodeURIComponent(needle) + "&creator=" + encodeURIComponent(author.handle);
  const detail = await reader.ok("GET", `/v1/ot/discover/${items[0].slug}/detail${filter}`);
  assert.equal(detail.next.slug, items[1].slug);
  await author.ok("DELETE", `/v1/ot/listings/${doc.id}`);
  assert.deepEqual((await find(needle)).items.map((item: any) => item.slug), ["body-search-website"]);
  const updated = await publish("body-search-website", {
    work_kind: "website", site_html: "<main>Replacement publication<span hidden>hidden again</span></main>",
  });
  assert.equal(updated.summary, "Replacement publication");
  assert.deepEqual((await find(needle)).items, []);
  assert.equal((await find("replacement")).items[0].match.kind, "body");
});

test("latest works use a compound scope-bound cursor across timestamp ties", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const [author, reader, other] = await Promise.all([
    home(server.base, "keyset-author"), home(server.base, "keyset-reader"), home(server.base, "keyset-other"),
  ]);
  const publish = (slug: string) => author.ok("PUT", "/v1/ot/listings", {
    kind: "work", work_kind: "document", ref: slug, slug, title: "Keyset exhibition", snapshot: "Shared body keyword",
  });
  const oldest = await publish("keyset-oldest");
  now += 1_000;
  const ties = await Promise.all([publish("keyset-one"), publish("keyset-two"), publish("keyset-three")]);
  const expected = [...ties].sort((a, b) => b.id.localeCompare(a.id)).concat(oldest);
  const feed = "/v1/ot/discover?kind=work&q=keyword";
  const latest = feed + "&pagination=keyset&limit=1";
  let page = await reader.ok("GET", latest);
  assert.match(page.next_cursor, /^l\.[0-9]+\.otl_[0-9A-Z]{26}\.[a-f0-9]{24}$/);
  const cursor = "&cursor=" + encodeURIComponent(page.next_cursor);
  assert.equal((await other.call("GET", latest + cursor)).status, 400);
  assert.equal((await reader.call("GET", latest + cursor + "&work_kind=document")).status, 400);
  assert.equal((await reader.call("GET", latest + cursor + "&before=42")).status, 400);
  assert.equal((await reader.call("GET", latest + cursor + "&sort=popular")).status, 400);
  assert.equal((await reader.call("GET", latest + "&cursor=l.9007199254740992." + expected[0].id + "." + "a".repeat(24))).status, 400);
  for (const item of expected) {
    assert.deepEqual(page.items.map((entry: any) => entry.id), [item.id]);
    if (item.id !== oldest.id) {
      assert.ok(page.next_cursor);
      page = await reader.ok("GET", latest + "&cursor=" + encodeURIComponent(page.next_cursor));
    }
  }
  assert.equal(page.next_cursor, null);
  const legacy = await reader.ok("GET", feed + "&limit=1");
  assert.equal(legacy.next_before, now);
  const prior = await reader.ok("GET", feed + "&before=" + legacy.next_before);
  assert.deepEqual(prior.items.map((item: any) => item.id), [oldest.id]);
});

test("collected works order and navigate by the signed reader's collection times", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const [author, reader, other] = await Promise.all([
    home(server.base, "collect-sort-author"), home(server.base, "collect-sort-reader"), home(server.base, "collect-sort-other"),
  ]);
  const publish = (slug: string, category = "technology") => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {
      kind: "work", work_kind: "document", ref: slug, slug, title: "Collected example", category, snapshot: "Shared body keyword",
    });
  };
  const oldest = await publish("collect-sort-oldest");
  const middle = await publish("collect-sort-middle");
  const newest = await publish("collect-sort-newest");
  const outside = await publish("collect-sort-outside", "education");
  const collect = (account: typeof reader, item: {id: string}) => account.ok("POST", `/v1/ot/listings/${item.id}/collect`, {on: true});
  await collect(reader, middle);
  await collect(reader, newest);
  now += 1_000;
  await collect(reader, oldest);
  await collect(reader, outside);
  await collect(other, newest);

  const filters = "tab=collected&category=technology&q=keyword&work_kind=document";
  const latest = "/v1/ot/discover?kind=work&" + filters;
  const recent = latest + "&sort=collected&limit=1";
  assert.deepEqual((await reader.ok("GET", latest)).items.map((item: any) => item.id), [newest.id, middle.id, oldest.id]);
  const first = await reader.ok("GET", recent);
  assert.deepEqual(first.items.map((item: any) => item.id), [oldest.id]);
  assert.equal(first.items[0].feed_at, undefined);
  const cursor = "&cursor=" + encodeURIComponent(first.next_cursor);
  assert.equal((await other.call("GET", recent + cursor)).status, 400);
  assert.equal((await reader.call("GET", latest + "&pagination=keyset" + cursor)).status, 400);
  assert.equal((await reader.call("GET", recent + "&before=1")).status, 400);
  assert.equal((await reader.call("GET", "/v1/ot/public/discover/works?sort=collected")).status, 400);
  assert.equal((await reader.call("GET", "/v1/ot/discover?kind=work&tab=following&sort=collected")).status, 400);
  const peers = [middle, newest].sort((left, right) => right.id.localeCompare(left.id));
  const second = await reader.ok("GET", recent + cursor);
  assert.deepEqual(second.items.map((item: any) => item.id), [peers[0].id]);
  const third = await reader.ok("GET", recent + "&cursor=" + encodeURIComponent(second.next_cursor));
  assert.deepEqual(third.items.map((item: any) => item.id), [peers[1].id]);
  assert.equal(third.next_cursor, null);
  const detail = `/v1/ot/discover/${oldest.slug}/detail?${filters}&sort=collected`;
  assert.equal((await reader.ok("GET", detail)).next.slug, peers[0].slug);
  const unrelatedDetail = await other.ok("GET", detail);
  assert.deepEqual([unrelatedDetail.previous, unrelatedDetail.next], [null,null]);
});

test("work search backfills only existing public rows when opening a legacy database", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ot-discover-backfill-"));
  let upgraded: typeof S | undefined;
  t.after(async () => {
    await upgraded?.stop();
    rmSync(dir, {recursive: true, force: true});
  });
  const options = {...bulkAuth, dbPath: join(dir, "social.sqlite")};
  const old = await startServer(options);
  try {
    const author = await home(old.base, "legacy-search-author");
    const publish = (slug: string) => author.ok("PUT", "/v1/ot/listings", {
      kind: "work", work_kind: "website", ref: slug, slug, title: "A previous publication",
      site_html: "<article>backfill visible sample</article><p hidden>backfill hidden sample</p>",
    });
    await publish("legacy-search-public");
    const withdrawn = await publish("legacy-search-withdrawn");
    await author.ok("DELETE", `/v1/ot/listings/${withdrawn.id}`);
    old.platform.db.exec("DROP TABLE ot_discover_work_search; DROP TABLE ot_discover_work_terms");
  } finally {
    await old.stop();
  }
  upgraded = await startServer(options);
  const reader = await home(upgraded.base, "legacy-search-reader");
  const feed = "/v1/ot/discover?kind=work&q=";
  const {items} = await reader.ok("GET", feed + "visible%20sample");
  assert.deepEqual(items.map((item: any) => item.slug), ["legacy-search-public"]);
  assert.equal(items[0].match.kind, "body");
  assert.deepEqual((await reader.ok("GET", feed + "hidden%20sample")).items, []);
  assert.equal(upgraded.platform.db.prepare("SELECT COUNT(*) AS count FROM ot_discover_work_search").pluck().get(), 1);
});

test("guest work pages navigate directly between public works and keep the share entry", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "guest-work-nav");
  const publish = (slug: string, title: string, kind = "work") => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {kind, ref: slug, slug, title, snapshot: "Public preview"});
  };
  const older = await publish("guest-nav-older", "Older <work>");
  await publish("guest-nav-agent", "An agent", "agent");
  const withdrawn = await publish("guest-nav-withdrawn", "Withdrawn");
  const newer = await publish("guest-nav-newer", "Newer work");
  await author.ok("DELETE", "/v1/ot/listings/" + withdrawn.id);
  const opened = await fetch(server.base + newer.path);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("cache-control"), "no-store");
  const html = await opened.text();
  assert.match(html, /<span aria-disabled="true">上一件<\/span>/);
  assert.match(html, /<a rel="next" href="\/w\/guest-nav-older" title="Older &lt;work&gt;">下一件<\/a>/);
  assert.match(html, /href="\/login#work-detail=guest-nav-newer">分享作品/);
  assert.match(html, /href="\/login#work-comments=guest-nav-newer">查看评论/);
  assert.doesNotMatch(html, /guest-nav-withdrawn|guest-nav-agent/);
  const previous = await (await fetch(server.base + older.path)).text();
  assert.match(previous, /<a rel="prev" href="\/w\/guest-nav-newer"[^>]*>上一件<\/a>/);
  assert.match(previous, /<span aria-disabled="true">下一件<\/span>/);
});

test("public website HTML lives only in an isolated frame and is deleted on revocation", async () => {
  const publisher = await home(S.base, "website-publisher");
  const reader = await home(S.base, "website-reader");
  const slug = "interactive-counter";
  const page = S.base + "/w/" + slug;
  const put = "/v1/ot/listings";
  const summary = "一个可点击的计数器。";
  const site_html = '<!doctype html><button id="site-counter">0</button><script>site-counter-data</script>';
  const input = {kind: "work", work_kind: "website", ref: "website_artifact", slug, title: "计数器 <demo>", summary};

  assert.equal((await fetch(page + "/site")).status, 404);
  const anon = await fetch(S.base + put, {
    method: "PUT", headers: {"content-type":"application/json"}, body: JSON.stringify({...input, site_html}),
  });
  assert.equal(anon.status, 401);
  assert.equal((await publisher.call("PUT", put, {...input, work_kind: "document", site_html})).status, 400);
  assert.equal((await publisher.call("PUT", put, {...input, site_html: " "})).status, 400);
  assert.equal((await publisher.call("PUT", put, {...input, site_html: "网".repeat(12_000)})).status, 413);
  assert.equal((await fetch(page)).status, 404);

  const work = await publisher.ok("PUT", put, {...input, site_html, snapshot: site_html});
  assert.equal(work.site_available, true);
  assert.equal("site_html" in work, false);
  assert.equal(work.snapshot, null);
  assert.equal((await reader.call("PUT", put, {...input, site_html: "different"})).status, 409);

  const signed = await reader.ok("GET", "/v1/ot/discover/" + slug + "/detail");
  const anonymous = await (await fetch(page, {headers: {accept: "application/json"}})).json() as any;
  for (const projection of [signed.work, anonymous]) {
    assert.equal(projection.site_available, true);
    assert.equal(JSON.stringify(projection).includes("site-counter-data"), false);
    assert.equal("site_html" in projection, false);
  }
  const preview = await (await fetch(page + "?view=preview", {headers: {accept: "application/json"}})).json() as any;
  assert.equal(preview.kind, "website");
  assert.equal(preview.site_available, true);
  assert.equal(preview.preview, summary);
  assert.doesNotMatch(JSON.stringify(preview), /site-counter-data|site_html|snapshot/);
  const feed = await reader.ok("GET", "/v1/ot/discover?kind=work&work_kind=website&q=计数器");
  assert.equal(feed.items[0].site_available, true);
  assert.equal(JSON.stringify(feed).includes("site-counter-data"), false);

  const host = await (await fetch(page)).text();
  assert.match(host, /<iframe class="work-site-frame" src="\/w\/interactive-counter\/site"/);
  assert.match(host, /sandbox="allow-scripts" referrerpolicy="no-referrer"/);
  assert.match(host, /title="计数器 &lt;demo&gt; 的互动预览"/);
  assert.match(host, /frame-src 'self'/);
  assert.match(host, /评论/);
  assert.doesNotMatch(host, /site-counter-data|public-agent-share|script-src 'self'/);
  assert.deepEqual(await (await fetch(page + "/preview")).json(), {preview: summary});

  const frame = await fetch(page + "/site");
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
  assert.equal(frame.headers.get("cache-control"), "no-store");
  assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
  assert.equal(frame.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(new Set(frame.headers.get("content-security-policy")?.split("; ")), new Set([
    "sandbox allow-scripts", "frame-ancestors 'self'", "default-src 'none'",
    "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:", "font-src data:", "media-src data:",
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
  ]));
  assert.equal(await frame.text(), site_html);

  assert.equal((await reader.call("DELETE", put + "/" + work.id)).status, 404);
  await publisher.ok("DELETE", put + "/" + work.id);
  assert.equal((await fetch(page + "/site")).status, 404);
  assert.equal((await fetch(page)).status, 404);

  const legacy = await publisher.ok("PUT", put, {...input, snapshot: "既有静态网页"});
  assert.equal(legacy.site_available, false);
  assert.match(await (await fetch(page)).text(), /既有静态网页/);
  assert.equal((await fetch(page + "/site")).status, 404);
  await publisher.ok("PUT", put, {...input, site_html});
  await publisher.ok("PUT", put, {...input, work_kind: "document", snapshot: "普通文档"});
  assert.equal((await fetch(page + "/site")).status, 404);
  assert.doesNotMatch(await (await fetch(page)).text(), /work-site-frame" src=/);
});
