// A caller that sends a body under a content-type the server has no parser for is making a mistake on
// its side: `curl -d '{}'` without -H sends application/x-www-form-urlencoded, and a typo such as
// application/jsonx sends nothing the server can read. Fastify refuses those before any route runs
// with statusCode 415, and that refusal has to arrive in the one error shape every client reads,
// { error: { code, message } }. Falling through to the catch-all answers 500 internal_error instead,
// which tells the caller the server broke and logs at error level for a client-side fault.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const post = async (contentType: string, body: string) => {
  const r = await fetch(S.base + "/v1/onboard", { method: "POST", headers: { "content-type": contentType }, body });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

const unsupported: Array<[string, string]> = [
  ["application/x-www-form-urlencoded", "a=1"],
  ["application/xml", "<a>1</a>"],
  ["multipart/form-data; boundary=x", '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n'],
  ["application/jsonx", "{}"],
];

for (const [contentType, body] of unsupported) {
  test(`a body sent as ${contentType} is refused with 415 and an error code, not 500`, async () => {
    const r = await post(contentType, body);
    assert.equal(r.status, 415, `expected 415 unsupported media type, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", "the refusal carries a code the console and the SDKs can read");
    assert.notEqual(r.body.error?.code, "internal_error", "a caller-side content-type mistake is not a server fault");
    assert.ok(typeof r.body.error?.message === "string" && r.body.error.message.length > 0, "the refusal explains what to send");
    assert.equal(r.body.error.message.includes(contentType.split(";")[0]), false, "the refusal does not echo the caller's content type back");
    assert.equal(r.body.statusCode, undefined, "Fastify's default statusCode field is gone");
  });
}

test("control: a JSON body still reaches the route and answers 201", async () => {
  const r = await post("application/json", "{}");
  assert.equal(r.status, 201, `expected the normal success, got ${r.status} ${JSON.stringify(r.body)}`);
});

test("control: a body over the limit is still refused with 413 payload_too_large", async () => {
  const r = await post("application/json", JSON.stringify({ pad: "x".repeat(300 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal(r.body.error?.code, "payload_too_large");
});
