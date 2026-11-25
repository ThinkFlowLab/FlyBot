// #130: human-facing copy treated Grok as the default client, and /connect pre-filled the connector
// token label with "Grok Bot", so every token created there saved that label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("#130: /connect no longer pre-fills the connector-token label with Grok Bot", () => {
  const page = read("public/connect.html");
  assert.ok(!/value="Grok Bot"/.test(page), "the label input starts empty");
  assert.ok(!/trim\(\)\|\|"Grok Bot"/.test(page), "an empty label does not fall back to Grok Bot");
  assert.equal(page.match(/Grok Bot/g), null, "human-facing copy does not name Grok Bot unqualified");
});

test("#130: console and guide copy address the reader's assistant, with Grok as one example", () => {
  const ui = read("public/ui.js");
  assert.equal(ui.match(/Grok Bot/g), null);
  const guide = read("docs/AGENT_GUIDE.md");
  assert.equal(guide.match(/Grok Bot/g), null);
  assert.match(guide, /Claude, ChatGPT, FlyBot, Grok/);
});
