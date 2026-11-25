// A mistyped base URL or a wrong method must answer in the one error shape the console, botctl and
// the SDKs read: { error: { code, message } }. Fastify's default body ({"message",:error","statusCode"})
// makes public/ui.js print "Something went wrong (undefined)", because it only reads error.code.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const get = async (path: string, init?: RequestInit) => {
  const r = await fetch(S.base + path, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

test("an unknown route answers { error: { code, message } }, not Fastify's default body", async () => {
  const r = await get("/v1/nope");
  assert.equal(r.status, 404);
  assert.equal(r.body.error?.code, "not_found", "the error carries a code the console can read");
  assert.equal(r.body.error?.message, "no such route: GET /v1/nope", "the message names the method and path");
  assert.equal(r.body.message, undefined, "Fastify's default message field is gone");
  assert.equal(r.body.statusCode, undefined, "Fastify's default statusCode field is gone");
});

test("a wrong method on a real route is the same not_found shape", async () => {
  const r = await get("/v1/invites", { method: "PUT" });
  assert.equal(r.status, 404);
  assert.equal(r.body.error?.code, "not_found");
  assert.equal(r.body.error?.message, "no such route: PUT /v1/invites");
  assert.equal(r.body.statusCode, undefined);
});

test("control: an unknown invite code keeps its own 404 shape", async () => {
  const r = await get("/v1/invites/definitely-not-a-code");
  assert.equal(r.status, 404);
  assert.equal(r.body.error?.code, "invite_not_found", "the route's own 404 still wins over the fallback");
  assert.equal(r.body.statusCode, undefined);
});
