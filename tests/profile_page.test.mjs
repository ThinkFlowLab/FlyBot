import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeHandle, parseTags } from '../flybot_workspace/static/profile/app.mjs';

test('sanitizeHandle derives a lowercase dotted handle', () => {
  assert.equal(sanitizeHandle('Alice'), 'alice');
  assert.equal(sanitizeHandle('Alice Smith'), 'alice.smith');
  assert.equal(sanitizeHandle('a'), 'auser');
  assert.equal(sanitizeHandle('...'), 'user');
  assert.equal(sanitizeHandle('A..B'), 'a.b');
  assert.equal(sanitizeHandle('x'.repeat(40)).length, 30);
  assert.equal(sanitizeHandle(''), 'user');
});

test('parseTags splits, dedupes and bounds tags', () => {
  assert.deepEqual(parseTags('产品, 旅行，产品'), ['产品', '旅行']);
  assert.deepEqual(parseTags(''), []);
  assert.equal(parseTags('t1,t2,t3,t4,t5,t6,t7,t8,t9').length, 8);
  assert.equal(parseTags('x'.repeat(30))[0].length, 20);
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.hidden = true;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.href = '';
    this.submits = 0;
    this.children = [];
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  get childElementCount() { return this.children.length; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const handler of this.handlers.close || []) handler(); }
  requestSubmit() { this.submits += 1; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'object') node.parentElement = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  querySelector(selector) {
    const tags = selector.toUpperCase().split(',');
    for (const child of this.children) {
      if (tags.includes(child.tagName)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}

const PROFILE_FIELDS = ['name', 'handle', 'bio', 'tags', 'gender', 'location', 'website'];

function fakeDocument() {
  const elements = new Map();
  return {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement(id === 'profile-form' ? 'form' : 'div');
        if (id === 'profile-form') {
          element.elements = {};
          for (const name of PROFILE_FIELDS) element.elements[name] = new FakeElement('input');
        }
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
}

function homeDocument() {
  const doc = fakeDocument();
  const bySelector = new Map();
  doc.querySelector = selector => {
    if (String(selector).startsWith('#')) return doc.getElementById(String(selector).slice(1));
    if (!bySelector.has(selector)) bySelector.set(selector, new FakeElement('div'));
    return bySelector.get(selector);
  };
  doc.querySelectorAll = () => [];
  doc.addEventListener = () => {};
  doc.createElement = tag => new FakeElement(tag);
  return doc;
}

function installShareGlobals({pathname = '/profile', clipboard = 'stub'} = {}) {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedLocation = globalThis.location;
  const savedHistory = globalThis.history;
  const copied = [];
  const pushes = [];
  const loc = {pathname, origin: 'https://flybot.test', search: '', href: 'https://flybot.test' + pathname};
  globalThis.location = loc;
  globalThis.history = {
    pushState(state, title, url) {
      pushes.push(url);
      const [path, query] = String(url).split('?');
      loc.pathname = path;
      loc.search = query ? '?' + query : '';
    },
  };
  const nav = {};
  if (clipboard === 'stub') nav.clipboard = {writeText: async text => { copied.push(text); }};
  if (clipboard === 'reject') nav.clipboard = {writeText: async () => { throw new Error('clipboard denied'); }};
  Object.defineProperty(globalThis, 'navigator', {value: nav, configurable: true, writable: true});
  return {
    copied, pushes, loc,
    restore() {
      if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
      else delete globalThis.navigator;
      if (savedLocation === undefined) delete globalThis.location; else globalThis.location = savedLocation;
      if (savedHistory === undefined) delete globalThis.history; else globalThis.history = savedHistory;
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function installGlobals(doc, fetcher) {
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  return () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
  };
}

async function mountProfile(options = {}) {
  const doc = options.home ? homeDocument() : fakeDocument();
  const calls = [];
  let release = () => {};
  let releasePost = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const profileCalls = () => calls.filter(([path]) => path === '/v1/profile').length;
  const postCalls = () => calls.filter(([path, method]) => path === '/v1/profile' && method === 'POST').length;
  const fetcher = async (path, init) => {
    calls.push([path, init && init.method]);
    if (path.startsWith('/v1/profile/social') || path.startsWith('/v1/profile/follow-work')) {
      const result = await options.social?.(new URL(path, 'https://example.test'), init);
      return {
        status: result?.status ?? 200,
        json: async () => result?.body ?? {items: [], following: 0, followers: 0},
      };
    }
    if (path === '/v1/auth/session') {
      if (options.session401) return {status: 401, json: async () => ({error: {message: 'not signed in'}})};
      return {status: 200, json: async () => ({user: {username: 'alice'}})};
    }
    if (path !== '/v1/profile') throw new Error('unexpected ' + path);
    if (init && init.method === 'POST') {
      if (options.holdPost) await postGate;
      if (options.post409) {
        return {status: 409, json: async () => ({error: {
          message: 'Profile changed elsewhere; reload and retry',
          current: {name: 'Alicia', handle: 'alice', revision: 4},
        }})};
      }
      if (options.failPost) {
        return {status: 500, json: async () => ({error: {message: options.failPost}})};
      }
      return {status: 200, json: async () => ({profile: {name: 'Alice', handle: 'alice', revision: 4}})};
    }
    if (profileCalls() === 1 && options.holdInitial) await gate;
    if (profileCalls() > 1) {
      if (options.holdRepeat) await gate;
      if (options.failRepeat) return {status: 500, json: async () => ({error: {message: options.failRepeat}})};
    }
    const name = profileCalls() > 1 && options.repeatName ? options.repeatName : 'Alice';
    const profile = options.profile ? {...options.profile} : {name, handle: 'alice', revision: 3};
    if (profileCalls() > 1 && options.repeatName) profile.name = options.repeatName;
    return {status: 200, json: async () => ({profile})};
  };
  if (options.setup) options.setup(doc);
  const restore = installGlobals(doc, fetcher);
  await import('../flybot_workspace/static/profile/app.mjs?dom=' + (options.tag || 'profile'));
  await flush();
  return {doc, calls, profileCalls, postCalls, release, releasePost, restore};
}

function clickHandler(doc) {
  const button = doc.getElementById('profile-reload');
  assert.equal(Array.isArray(button.handlers.click) && button.handlers.click.length, 1,
    'the 重新加载 button has no click handler, so clicking it does nothing');
  return button;
}

test('重新加载 re-reads the profile and re-renders the form', async () => {
  const {doc, profileCalls, restore} = await mountProfile({tag: 'reload', repeatName: 'Alicia'});
  try {
    assert.equal(doc.getElementById('profile-form').elements.name.value, 'Alice');
    assert.equal(profileCalls(), 1);
    const button = clickHandler(doc);
    await button.handlers.click[0]({preventDefault() {}});
    assert.equal(profileCalls(), 2);
    assert.equal(doc.getElementById('profile-form').elements.name.value, 'Alicia');
    assert.equal(button.disabled, false);
  } finally { restore(); }
});

test('重新加载 disables itself while the request is in flight and does not stack', async () => {
  const {doc, profileCalls, release, restore} = await mountProfile({tag: 'inflight', holdRepeat: true});
  try {
    const button = clickHandler(doc);
    const pending = button.handlers.click[0]({preventDefault() {}});
    await flush();
    assert.equal(button.disabled, true);
    await button.handlers.click[0]({preventDefault() {}});
    await flush();
    assert.equal(profileCalls(), 2);
    release();
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(profileCalls(), 2);
  } finally { restore(); }
});

test('a failed 重新加载 keeps the page status and re-enables the button', async () => {
  const {doc, profileCalls, restore} = await mountProfile({tag: 'failure', failRepeat: '无法读取资料。'});
  try {
    const button = clickHandler(doc);
    await button.handlers.click[0]({preventDefault() {}});
    assert.equal(profileCalls(), 2);
    assert.equal(doc.getElementById('status').dataset.kind, 'error');
    assert.equal(doc.getElementById('status').textContent, '无法读取资料。');
    assert.equal(button.disabled, false);
  } finally { restore(); }
});

function submitHandler(doc) {
  const form = doc.getElementById('profile-form');
  assert.ok(Array.isArray(form.handlers.submit) && form.handlers.submit.length >= 1,
    'the profile form has no submit handler');
  return form.handlers.submit[0];
}

test('连点两次保存只发一次 POST /v1/profile 且按钮在飞时 disabled', async () => {
  const {doc, postCalls, releasePost, restore} = await mountProfile({tag: 'save-double', holdPost: true});
  try {
    const submit = submitHandler(doc);
    const save = doc.getElementById('profile-save');
    const first = submit({preventDefault() {}});
    await flush();
    const second = submit({preventDefault() {}});
    await flush();
    try {
      assert.equal(postCalls(), 1, 'a second click while the first POST is in flight must not send another request');
      assert.equal(save.disabled, true, 'the save button should be disabled while the POST is in flight');
    } finally { releasePost(); }
    await Promise.all([first, second]);
    assert.equal(save.disabled, false, 'the save button should be enabled again after the POST settles');
    assert.equal(postCalls(), 1);
  } finally { restore(); }
});

test('a 409 save shows a Chinese status line instead of the server English text', async () => {
  const {doc, restore} = await mountProfile({tag: 'save-409', post409: true});
  try {
    await submitHandler(doc)({preventDefault() {}});
    const status = doc.getElementById('status');
    assert.equal(status.dataset.kind, 'error');
    assert.equal(status.textContent, '资料已在别处更新，已重新加载。');
    assert.equal(doc.getElementById('profile-form').elements.name.value, 'Alicia',
      'the 409 payload should still refill the form with the current profile');
  } finally { restore(); }
});

test('昵称为空时保存被本地拦下，不发 POST 也不禁用保存按钮', async () => {
  const {doc, postCalls, restore} = await mountProfile({tag: 'blank-name'});
  try {
    const form = doc.getElementById('profile-form');
    form.elements.name.value = '   ';
    const save = doc.getElementById('profile-save');
    await submitHandler(doc)({preventDefault() {}});
    const status = doc.getElementById('status');
    assert.equal(postCalls(), 0, 'a blank name must be rejected before any POST /v1/profile is sent');
    assert.equal(status.dataset.kind, 'error');
    assert.equal(status.textContent, '请填写昵称。');
    assert.equal(save.disabled, false, 'a locally rejected save must leave the save button usable');
  } finally { restore(); }
});

test('保存返回 500 时状态行显示服务端错误，按钮恢复可用且输入不被清掉', async () => {
  const {doc, postCalls, restore} = await mountProfile({tag: 'save-500', failPost: '存储不可用'});
  try {
    const form = doc.getElementById('profile-form');
    form.elements.name.value = 'Alice 新';
    const save = doc.getElementById('profile-save');
    await submitHandler(doc)({preventDefault() {}});
    const status = doc.getElementById('status');
    assert.equal(postCalls(), 1);
    assert.equal(status.dataset.kind, 'error', 'a failed save must set the status line to an error');
    assert.equal(status.textContent, '存储不可用', 'a failed save must show the server message, not a success line');
    assert.equal(save.disabled, false, 'the save button must be usable again after a failed save');
    assert.equal(form.elements.name.value, 'Alice 新', 'a failed save must not wipe what the user typed');
  } finally { restore(); }
});

test('未登录的 401 会话只显示登录面板，不读资料并清掉旧状态行', async () => {
  const {doc, profileCalls, restore} = await mountProfile({
    tag: 'session-401',
    session401: true,
    setup(doc) {
      doc.getElementById('main-panel').hidden = false;
      doc.getElementById('status').dataset.kind = 'error';
      doc.getElementById('status').textContent = '旧错误';
    },
  });
  try {
    assert.equal(doc.getElementById('login-panel').hidden, false,
      'a 401 session must show the login panel');
    assert.equal(doc.getElementById('main-panel').hidden, true,
      'a 401 session must hide the profile form panel');
    const status = doc.getElementById('status');
    assert.equal(status.textContent, '',
      'a signed-out visit must clear the stale status line instead of reporting a session error');
    assert.equal(status.dataset.kind, '');
    assert.equal(profileCalls(), 0, 'a 401 session must not request GET /v1/profile');
  } finally { restore(); }
});

test('输入框里的 Enter 提交表单，textarea 里的 Enter 只换行', async () => {
  const {doc, restore} = await mountProfile({tag: 'enter-key'});
  try {
    const form = doc.getElementById('profile-form');
    assert.ok(Array.isArray(form.handlers.keydown) && form.handlers.keydown.length === 1,
      'the profile form has no keydown handler, so Enter does nothing');
    const keydown = form.handlers.keydown[0];
    let prevented = 0;
    keydown({key: 'Enter', target: {tagName: 'INPUT'}, preventDefault() { prevented += 1; }});
    assert.equal(form.submits, 1, 'Enter in a text input must submit the profile form');
    assert.equal(prevented, 1, 'the Enter key must be consumed so the form is submitted once');
    keydown({key: 'Enter', target: {tagName: 'TEXTAREA'}, preventDefault() { prevented += 1; }});
    assert.equal(form.submits, 1, 'Enter in the bio textarea must insert a newline, not submit');
    assert.equal(prevented, 1, 'the textarea Enter must not be consumed by the form');
  } finally { restore(); }
});

test('资料首次加载用用户名兜底显示名和 handle，并给出对应的公开地址', async () => {
  const blank = await mountProfile({
    tag: 'defaults-blank',
    profile: {name: '', handle: '', revision: 0},
  });
  try {
    const doc = blank.doc;
    const form = doc.getElementById('profile-form');
    assert.equal(form.elements.name.value, 'alice',
      'an unsaved profile must show the account username as the display name');
    assert.equal(form.elements.handle.value, 'alice',
      'an empty handle must fall back to the sanitized username');
    assert.equal(doc.getElementById('profile-meta').textContent,
      '还没有保存过资料。保存后会生成 FlyBot ID。',
      'an unsaved profile must say that no profile has been saved yet');
    assert.equal(doc.getElementById('profile-public').href, '/v1/profile',
      'before the first save the public link must point back at the API, not at /p/');
    assert.equal(doc.getElementById('whoami').textContent, 'alice');
    assert.equal(doc.getElementById('whoami').dataset.username, 'alice');
    assert.equal(doc.getElementById('profile-username').textContent, 'alice');
  } finally { blank.restore(); }

  const saved = await mountProfile({
    tag: 'defaults-saved',
    profile: {name: 'Alice', handle: 'alice.smith', revision: 7},
  });
  try {
    const doc = saved.doc;
    assert.equal(doc.getElementById('profile-meta').textContent,
      '修订 7 · FlyBot ID 可用于公开资料地址');
    assert.equal(doc.getElementById('profile-public').href, '/p/alice.smith',
      'a saved handle must link to the public profile page');
  } finally { saved.restore(); }
});

function shareHandler(doc) {
  const share = doc.getElementById('profile-share');
  assert.ok(Array.isArray(share.handlers.click) && share.handlers.click.length === 1,
    'the 分享 button has no click handler, so clicking it does nothing');
  return share.handlers.click[0];
}

test('有 FlyBot ID 时分享按钮把公开主页链接复制到剪贴板', async () => {
  const env = installShareGlobals({pathname: '/profile'});
  try {
    const {doc, restore} = await mountProfile({
      tag: 'share-handle',
      home: true,
      profile: {name: 'Alice', handle: 'alice.smith', revision: 3},
    });
    try {
      await shareHandler(doc)({preventDefault() {}});
      assert.deepEqual(env.copied, ['https://flybot.test/p/alice.smith'],
        'clicking 分享 must copy the public profile URL built from the saved handle');
      const status = doc.getElementById('status');
      assert.equal(status.dataset.kind, 'ok');
      assert.equal(status.textContent, '公开主页链接已复制。');
      assert.equal(doc.querySelector('#profile-share-fallback').hidden, true,
        'a successful copy must not open the manual-copy fallback');
    } finally { restore(); }
  } finally { env.restore(); }
});

test('没有 FlyBot ID 时分享按钮不写剪贴板，先提示再切到编辑页', async () => {
  const env = installShareGlobals({pathname: '/profile'});
  try {
    const {doc, restore} = await mountProfile({
      tag: 'share-no-handle',
      home: true,
      profile: {name: 'Alice', handle: '', revision: 0},
    });
    try {
      await shareHandler(doc)({preventDefault() {}});
      assert.equal(env.copied.length, 0,
        'a profile without a handle has no public URL, so nothing must be copied');
      assert.equal(doc.getElementById('status').textContent, '先设置 FlyBot ID 才能分享。');
      assert.deepEqual(env.pushes, ['/profile/edit'],
        'without a handle the share button must take the person to the edit page');
      assert.equal(env.loc.pathname, '/profile/edit');
      assert.equal(doc.querySelector('#profile-home').hidden, true,
        'the in-page edit view must replace the profile home after switching to /profile/edit');
      assert.equal(doc.querySelector('#profile-edit').hidden, false);
    } finally { restore(); }
  } finally { env.restore(); }
});

test('剪贴板不可用时把链接显示出来让人手动复制', async () => {
  const env = installShareGlobals({pathname: '/profile', clipboard: 'reject'});
  try {
    const {doc, restore} = await mountProfile({
      tag: 'share-clipboard-denied',
      home: true,
      profile: {name: 'Alice', handle: 'alice.smith', revision: 3},
    });
    try {
      await shareHandler(doc)({preventDefault() {}});
      assert.equal(doc.getElementById('status').dataset.kind, 'error');
      assert.match(doc.getElementById('status').textContent, /手动复制/);
      const fallback = doc.querySelector('#profile-share-fallback');
      assert.equal(fallback.hidden, false,
        'when the clipboard refuses the copy the URL must be shown for manual copying');
      assert.equal(doc.querySelector('#profile-share-link').textContent,
        'https://flybot.test/p/alice.smith');
    } finally { restore(); }
  } finally { env.restore(); }
});

test('编辑表单等资料加载完成才可输入，昵称更新同步显示在主页', async () => {
  const env = installShareGlobals({pathname: '/profile/edit'});
  try {
    const {doc, release, restore} = await mountProfile({tag: 'edit-first-load', home: true, holdInitial: true});
    try {
      const form = doc.getElementById('profile-form');
      assert.equal(form.hidden, true);
      assert.equal(doc.getElementById('profile-edit-initial').hidden, false);
      release();
      await flush();
      assert.equal(form.hidden, false);
      assert.equal(doc.getElementById('profile-edit-initial').hidden, true);
      assert.equal(doc.getElementById('profile-username').textContent, 'Alice');
      assert.equal(doc.getElementById('whoami').textContent, 'alice');
    } finally { restore(); }
  } finally { env.restore(); }
});

test('switching profile feeds aborts the stale view and replacing a failed next page preserves earlier results', async () => {
  const env = installShareGlobals();
  let releaseLiked;
  const liked = new Promise(resolve => { releaseLiked = resolve; });
  let likedSignal;
  let attempts = 0;
  const work = slug => ({slug, title: slug, kind: 'work'});
  const {doc, restore} = await mountProfile({
    tag: 'profile-feeds',
    home: true,
    social(url, init) {
      const view = url.searchParams.get('view');
      if (view === 'liked') {
        likedSignal = init.signal;
        return liked;
      }
      if (view !== 'collected') return;
      if (!url.searchParams.has('cursor')) return {body: {items: [work('work-first')], next_cursor: 'page2'}};
      if (++attempts === 1) return {status: 503, body: {}};
      return {body: {items: [work('work-second')], next_cursor: null}};
    },
  });
  try {
    const click = id => doc.getElementById(id).handlers.click[0]();
    const list = doc.getElementById('profile-feed-list');
    const delayed = click('tab-liked');
    assert.equal(doc.getElementById('profile-feed-empty').textContent, '正在加载…');
    await click('tab-saved');
    assert.equal(likedSignal.aborted, true);
    releaseLiked({body: {items: [work('stale-like')]}});
    await delayed;
    assert.equal(list.children[0].children[0].href, '/discover?work=work-first');
    await click('profile-feed-more');
    assert.equal(list.children.length, 1);
    assert.equal(doc.getElementById('profile-feed-retry').hidden, false);
    await click('profile-feed-retry');
    assert.equal(list.children[1].children[0].href, '/discover?work=work-second');
    assert.equal(doc.getElementById('profile-feed-more').hidden, true);
  } finally { restore(); env.restore(); }
});

test('作品通知 reads the current followed creator and saves by Bot Social handle', async () => {
  const env = installShareGlobals();
  const changes = [];
  const {doc, restore} = await mountProfile({
    tag: 'profile-work-notices', home: true,
    social(url, init) {
      if (url.pathname !== '/v1/profile/follow-work') return;
      if (init.method === 'POST') {
        changes.push(JSON.parse(init.body));
        return {body: {enabled: false}};
      }
      return {body: {items: [{handle: 'vera.home', display_name: 'Vera', enabled: true}]}};
    },
  });
  try {
    await doc.getElementById('profile-notify-open').handlers.click[0]();
    await flush();
    const toggle = doc.getElementById('follow-work-list').children[0].children[0].children[1];
    assert.equal(toggle.checked, true);
    assert.equal(toggle.getAttribute('aria-label'), 'Vera 的作品通知');
    toggle.checked = false;
    await toggle.handlers.change[0]();
    assert.deepEqual(changes, [{handle: 'vera.home', enabled: false}]);
    assert.equal(doc.getElementById('follow-work-status').textContent, '已关闭作品通知。');
  } finally { restore(); env.restore(); }
});

test('收藏和点赞条目只能从对应标签取消，失败保留原条目', async () => {
  const env = installShareGlobals();
  const mutations = [];
  const item = {id: 'otl_' + 'T'.repeat(26), title: '示例条目', slug: 'some-listing', kind: 'agent', collected: true, liked: true};
  const {doc, restore} = await mountProfile({
    tag: 'profile-reaction-removal', home: true,
    social(url, init) {
      if (init.method === 'POST') {
        const change = JSON.parse(init.body);
        mutations.push(change);
        if (mutations.length === 1) return {status: 503};
        return {body: change.action === 'like' ? {liked: false} : {collected: false}};
      }
      return url.searchParams.get('view') === 'counts' ? {body: {following: 0, followers: 0}} : {body: {items: [item]}};
    },
  });
  try {
    const click = id => doc.getElementById(id).handlers.click[0]();
    const list = doc.getElementById('profile-feed-list');
    assert.equal(list.children[0].querySelector('button'), null);
    await click('tab-saved');
    assert.equal(list.children[0].children[0].href, '/a/some-listing');
    const first = list.children[0].querySelector('button');
    assert.equal(first.textContent, '取消收藏');
    await first.handlers.click[0]();
    assert.equal(list.children.length, 1);
    assert.equal(first.disabled, false);
    assert.equal(doc.getElementById('profile-feed-action-status').textContent, '无法取消收藏，请重试。');
    await first.handlers.click[0]();
    assert.equal(list.children.length, 0);
    assert.equal(doc.getElementById('profile-feed-explore').hidden, false);
    await click('tab-liked');
    const second = list.children[0].querySelector('button');
    assert.equal(second.textContent, '取消点赞');
    await second.handlers.click[0]();
    assert.equal(list.children.length, 0);
    assert.deepEqual(mutations, [
      {listing_id: item.id, action: 'collect'},
      {listing_id: item.id, action: 'collect'},
      {listing_id: item.id, action: 'like'},
    ]);
  } finally { restore(); env.restore(); }
});
