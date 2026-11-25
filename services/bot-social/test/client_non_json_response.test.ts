/**
 * The Bot SDK is what a Bot author's code talks to, so an HTTP error has to reach them as one. Today `call()` parses
 * the body before it looks at the status: a gateway's 502/504 HTML page, or a portal page when `--url` points at the
 * wrong host, makes `JSON.parse` throw `SyntaxError` — the status, the code and the server's message are all lost and
 * the caller sees "Unexpected token '<'". A 2xx that is not JSON lands in the same `SyntaxError`: the caller cannot
 * tell a gateway that broke from a portal page that answered at all, and no status or code survives to tell them
 * apart. Both should surface as a decidable `ApiCallError` with its own client-side code.
 *
 * So: a non-2xx answer that is not JSON still becomes an `ApiCallError` carrying the real status and a trimmed
 * excerpt of the text; a 2xx answer that is not JSON becomes an explicit `ApiCallError` with its own code, so it
 * can never pass for a success; a JSON answer keeps exactly today's behaviour (`status`, `code`, `message`, `body`),
 * and an empty body is still `{}`.
 * The message must stay short: an error line cannot carry a whole page.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiCallError, OwnerClient } from "../src/client.js";

const BASE = "http://sdk.test";
const client = () => new OwnerClient(BASE, "owner-token");

/** Run `fn` against one stubbed `fetch` answer, then put the real `fetch` back. */
async function withResponse(answer: () => Response, fn: (c: OwnerClient) => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as typeof fetch;
  try {
    await fn(client());
  } finally {
    globalThis.fetch = original;
  }
}

const htmlPage = (title: string) =>
  `<!DOCTYPE html>\n<html>\n<head><title>${title}</title></head>\n<body><h1>${title}</h1><p>${"padding ".repeat(600)}</p></body>\n</html>`;

async function failure(answer: () => Response) {
  let caught: any;
  await withResponse(answer, async (c) => {
    caught = await c.req("GET", "/v1/friends").then(() => undefined, (e) => e);
  });
  return caught;
}

test("a gateway's 502 HTML page keeps its status instead of throwing a SyntaxError", async () => {
  const page = htmlPage("502 Bad Gateway");
  const err = await failure(() => new Response(page, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }));
  assert.ok(err instanceof ApiCallError, `a proxy answer is an ApiCallError, not ${err?.constructor?.name}: ${err?.message}`);
  assert.equal(err.status, 502, "the real status survives");
  assert.equal(err.code, "error", "a non-JSON error body has no server code, so it keeps the client's fallback");
  assert.match(err.message, /^<!DOCTYPE html>/, "the message is the page's own text; status and code are the fields beside it");
  assert.match(err.message, /502 Bad Gateway/, "the message carries the page's own text");
  assert.doesNotMatch(err.message, /\n/, "the page's line breaks are folded into one line");
  assert.ok(err.message.length < 320, `the whole page is not stuffed into the error (${err.message.length} chars)`);
  assert.ok(page.length > 4000, "the fixture really is longer than a trimmed message");
});

test("a 200 that is not JSON fails loudly instead of looking like success", async () => {
  const err = await failure(() => new Response(htmlPage("Sign in to the portal"), { status: 200, headers: { "content-type": "text/html" } }));
  assert.ok(err instanceof ApiCallError, `a non-JSON 200 is an ApiCallError, not ${err?.constructor?.name}: ${err?.message}`);
  assert.equal(err.status, 200, "the status is still reported");
  assert.equal(err.code, "sdk_non_json_body", "a client-side code, not one the server could have sent");
  assert.match(err.message, /text\/html/, "the message names what came back");
  assert.match(err.message, /Sign in to the portal/, "and shows a little of it");
});

test("a JSON error body keeps the status, code, message and body it has today", async () => {
  const body = { error: { code: "not_found", message: "no such conversation" } };
  const err = await failure(() => new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json" } }));
  assert.ok(err instanceof ApiCallError);
  assert.equal(err.status, 404);
  assert.equal(err.code, "not_found");
  assert.equal(err.message, "404 not_found: no such conversation");
  assert.deepEqual(err.body, body);
});

test("a JSON 2xx answer is returned as parsed JSON", async () => {
  const body = { events: [{ id: 1, type: "approval.requested" }], count: 1 };
  let got: unknown;
  await withResponse(() => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }), async (c) => {
    got = await c.req("GET", "/v1/events?since=0");
  });
  assert.deepEqual(got, body);
});

test("an empty 2xx body is still {}", async () => {
  let got: unknown;
  await withResponse(() => new Response(null, { status: 204 }), async (c) => {
    got = await c.req("DELETE", "/v1/notifications");
  });
  assert.deepEqual(got, {});
});
