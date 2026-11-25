// The /settings 聊天语言 choice has to reach the model, not stop at
// user_settings. These tests drive the real mount() with a stubbed fetch and
// read the message request body, so they assert what leaves the browser rather
// than what an exported helper can be talked into returning.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// Imported dynamically so a missing export fails only its own test and the two
// behaviour tests still report what the browser actually sends.
const chat = await import('../flybot_workspace/static/chat/app.mjs');
const { mount } = chat;

const AGENT = 'a'.repeat(32);
const CONV = 'c'.repeat(32);

test('messagePayload carries a chosen chat language and stays silent for auto', () => {
  assert.equal(typeof chat.messagePayload, 'function', 'the composer needs one place that decides the request body');
  const { messagePayload } = chat;
  assert.deepEqual(messagePayload('你好', 'en'), {body: '你好', chat_language: 'en'});
  assert.deepEqual(messagePayload('你好', 'zh-Hant'), {body: '你好', chat_language: 'zh-Hant'});
  assert.deepEqual(messagePayload('你好', 'auto'), {body: '你好'});
  assert.deepEqual(messagePayload('你好', ''), {body: '你好'});
  assert.deepEqual(messagePayload('你好', undefined), {body: '你好'});
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.name = '';
    this.href = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) {
        if (!names().includes(name)) element.className = [...names(), name].join(' ');
      },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter((item) => item !== handler);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  focus() { this.focused = true; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector) {
    if (selector === 'input:not(:disabled)') {
      return descendants(this).find((node) => node.tagName === 'INPUT' && !node.disabled) || null;
    }
    return null;
  }
}

function descendants(node) {
  const rows = [];
  for (const child of node.children) rows.push(child, ...descendants(child));
  return rows;
}

function matchesSelector(node, selector) {
  if (!node || !selector) return false;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = /^([a-z0-9]*)\[([a-z-]+)(?:="([^"]*)")?\]$/i.exec(selector);
  if (attr) {
    if (attr[1] && node.tagName !== attr[1].toUpperCase()) return false;
    const value = attr[3];
    const actual = attr[2].startsWith('data-')
      ? node.dataset[attr[2].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
      : node.attributes[attr[2]];
    if (value === undefined) return actual !== undefined && actual !== null && actual !== '';
    return actual === value;
  }
  return node.tagName === selector.toUpperCase();
}

// Ids and initial hidden state come from the served page, so the harness cannot
// invent a control the user would not have.
function fakeChatDocument(html) {
  const byId = new Map();
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)) {
    const [, tag, attrs] = match;
    const id = /\bid="([^"]+)"/.exec(attrs);
    if (id) {
      const element = new FakeElement(tag);
      element.id = id[1];
      element.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      element.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
      byId.set(id[1], element);
    }
  }
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>([^<]*)<\/\1>/gi)) {
    const id = /\bid="([^"]+)"/.exec(match[2]);
    const label = match[3].trim();
    if (id && label && byId.has(id[1])) byId.get(id[1]).textContent = label;
  }
  const body = new FakeElement('body');
  const doc = {
    cookie: '',
    body,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function chatHtml() {
  return readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
}

function json(status, body) { return {status, json: async () => body}; }

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(times = 16) {
  for (let index = 0; index < times; index += 1) await tick();
}

async function fire(node, type, event = {}) {
  for (const handler of (node.handlers && node.handlers[type]) || []) await handler(event);
}

function installChatGlobals() {
  const saved = {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.location = {hash: '', pathname: '/chat'};
  globalThis.history = {replaceState() {}};
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = () => ({matches: false});
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  };
}

const conversation = {
  id: CONV, workspace_id: 'ws-1', agent_id: AGENT, title: '晨会', unread_count: 0,
};

function languageFetcher(values) {
  const sent = [];
  const fetcher = async (path, options = {}) => {
    if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: [{id: AGENT, name: '文档助手'}]});
    if (path === `/v1/workspaces/ws-1/agents/${AGENT}/conversations?limit=100`) {
      return json(200, {items: [conversation]});
    }
    if (path === `/v1/workspaces/ws-1/agents/${AGENT}/conversations/${CONV}`) {
      return json(200, {conversation, items: [
        {id: 'm1', role: 'user', body: '你好', status: 'succeeded'},
        {id: 'm2', role: 'assistant', body: '你好，我是文档助手。', status: 'succeeded'},
      ]});
    }
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === `/v1/workspaces/ws-1/agents/${AGENT}/conversations/${CONV}/messages` && options.method === 'POST') {
      sent.push({path, body: JSON.parse(options.body), headers: options.headers});
      return json(201, {
        message: {id: 'm3', role: 'user', body: '今天有什么安排？', status: 'succeeded'},
        reply: {id: 'm4', role: 'assistant', body: '收到。', status: 'succeeded', error_code: null},
      });
    }
    throw new Error('unexpected ' + (options.method || 'GET') + ' ' + path);
  };
  return {fetcher, sent};
}

async function sendOnce(values) {
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  const {fetcher, sent} = languageFetcher(values);
  try {
    await mount(doc, {fetcher});
    await settle();
    el('chat-body').value = '今天有什么安排？';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    await settle();
  } finally {
    restore();
  }
  return sent;
}

test('a saved English chat language rides along with the next message', async () => {
  const sent = await sendOnce({send_shortcut: 'enter', chat_language: 'en'});
  assert.equal(sent.length, 1, 'the composer sends exactly one message');
  assert.equal(
    sent[0].body.chat_language, 'en',
    'the stored chat language never leaves the browser today, so the model cannot know it: ' + JSON.stringify(sent[0].body),
  );
  assert.equal(sent[0].body.body, '今天有什么安排？', 'the message text itself is unchanged');
  assert.match(sent[0].headers['Idempotency-Key'] || '', /^msg-/);
});

test('automatic reply language sends no forced language preference', async () => {
  const sent = await sendOnce({send_shortcut: 'enter', chat_language: 'auto'});
  assert.equal(sent.length, 1, 'the composer sends exactly one message');
  assert.deepEqual(Object.keys(sent[0].body), ['body'], 'auto must not invent a language field');
});

test('the English interface keeps the separately selected Japanese reply language', async () => {
  const sent = await sendOnce({send_shortcut:'enter', language:'en', chat_language:'ja'});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_language, 'ja');
});

// The stored value is a code; the sentence under the select is the only place a
// user is told that this preference now travels with every message.
test('the language note says what the choice does when a message is sent', async () => {
  const settings = await import('../flybot_workspace/static/settings/app.mjs');
  assert.equal(typeof settings.chatLanguageEffect, 'function',
    'the language page needs one sentence about what the choice does');
  assert.match(settings.chatLanguageEffect('en', 'English'), /使用「English」回复/);
  assert.match(settings.chatLanguageEffect('auto'), /界面语言单独设置/);
  const nodes = {'chat-language-effect': {textContent: ''}};
  settings.syncChatLanguageNote({getElementById: id => nodes[id] || null}, 'ja', '日本語');
  assert.match(nodes['chat-language-effect'].textContent, /日本語/);
  const html = readFileSync(new URL('../flybot_workspace/static/settings/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="chat-language-effect"/, 'the sentence has to have a place in the served page');
});
