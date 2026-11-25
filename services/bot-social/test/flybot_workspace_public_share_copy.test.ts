import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

test("a known text share can be copied while active, with no source identity in the response", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth,now:()=>now});
  t.after(() => server.stop());
  const [owner, reader] = await Promise.all([home(server.base,"Share author"),home(server.base,"Share reader")]);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update("share:" + token).digest("hex");
  const published = {token_hash:hash,ref:"private-artifact-id",title:"Shared text",kind:"document",
    body:"<script>literally shared text</script>",expires_at:now + 5000};
  const path = "/v1/ot/public-shares";
  const statusPath = path + "/" + hash;
  await owner.ok("PUT",path,published);
  assert.deepEqual(await owner.ok("GET",statusPath),{active:true});
  assert.equal((await reader.call("GET",statusPath)).status,404);
  assert.equal((await fetch(server.base + statusPath)).status,401);
  const read = () => fetch(server.base + "/share/" + token);
  const resolve = () => reader.call("POST",path + "/resolve",{token});
  const initial = await read();
  assert.equal(initial.headers.get("cache-control"),"no-store");
  assert.equal(initial.headers.get("referrer-policy"),"no-referrer");
  const html = await initial.text();
  assert.ok(html.includes('/space#shared-work=' + token));
  assert.ok(html.includes("&lt;script&gt;literally shared text&lt;/script&gt;"));
  assert.ok(!html.includes(published.ref));
  assert.deepEqual(await reader.ok("POST",path + "/resolve",{token}),{title:published.title,body:published.body});
  assert.equal((await reader.call("POST",path + "/resolve",{token:"a".repeat(43)})).status,404);
  assert.equal((await fetch(server.base + path + "/resolve",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({token})})).status,401);

  await owner.ok("PUT",path,{...published,kind:"spreadsheet"});
  assert.ok(!(await (await read()).text()).includes("/space#shared-work="));
  assert.equal((await resolve()).status,404);
  await owner.ok("PUT",path,published);
  now = published.expires_at;
  assert.equal((await read()).status,404);
  assert.equal((await resolve()).status,404);
  assert.equal((await owner.call("GET",statusPath)).status,404);
  now -= 1000;
  await owner.ok("DELETE",path + "/" + hash);
  assert.equal((await read()).status,404);
  assert.equal((await resolve()).status,404);
  assert.equal((await owner.call("GET",statusPath)).status,404);
});
