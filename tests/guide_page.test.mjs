import assert from 'node:assert/strict';
import test from 'node:test';
import * as guideModule from '../flybot_workspace/static/guide/app.mjs';
import {CATALOG, CATEGORIES, CATEGORY_ICON_PATHS, ITEM_ICON_PATHS, countByCategory, filterCatalog, formatPath, groupCatalog, guideHref, guideIconPath, guideInitialQuery} from '../flybot_workspace/static/guide/app.mjs';

test('catalog only contains known categories and no Teamily guide prose', () => {
  const ids = new Set(CATEGORIES.map((item) => item.id));
  assert.ok(ids.has('calls'));
  assert.equal(CATALOG.some((item) => item.title.includes('折叠会话列表') || (item.body || '').includes('再次点击')), false);
  for (const item of CATALOG) {
    assert.ok(ids.has(item.category), item.category);
    assert.ok(item.title);
    assert.ok(item.body);
    assert.ok(Array.isArray(item.path) && item.path.length > 0);
    assert.ok(/^\/(?!\/)/.test(item.href), item.id);
  }
});

test('countByCategory totals every item and keeps an empty calls category', () => {
  const counts = countByCategory(CATALOG);
  assert.equal(counts.all, CATALOG.length);
  assert.equal(counts.calls, 0);
  assert.ok(counts.chat >= 1);
  const named = CATEGORIES.filter((item) => item.id !== 'all').reduce((sum, item) => sum + (counts[item.id] || 0), 0);
  assert.equal(named, counts.all);
});

test('filterCatalog matches title, body, path and category', () => {
  assert.deepEqual(filterCatalog(CATALOG, {category: 'calls'}).map((item) => item.id), []);
  const chat = filterCatalog(CATALOG, {category: 'chat'});
  assert.ok(chat.every((item) => item.category === 'chat'));
  const found = filterCatalog(CATALOG, {query: '浏览器网页入口'});
  assert.deepEqual(found.map((item) => item.id), ['download-runtime']);
  const pathHit = filterCatalog(CATALOG, {query: '收起侧边栏'});
  assert.ok(pathHit.some((item) => item.id === 'memory-dir-collapse'));
  assert.ok(filterCatalog(CATALOG, {category: 'memory', query: 'xyz-not-a-feature'}).length === 0);
});

test('groupCatalog preserves category order and formatPath joins crumbs', () => {
  const grouped = groupCatalog(filterCatalog(CATALOG, {category: 'all'}));
  assert.equal(grouped[0].id, CATALOG[0].category);
  assert.ok(grouped.every((group) => group.items.length > 0));
  assert.equal(formatPath(['设置', '外观']), '设置 › 外观');
  assert.equal(formatPath([]), '');
});

test('the guide deep link round-trips the keyword through the query string', () => {
  assert.equal(guideHref('外观'), '/guide?q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('  '), '/guide');
  assert.equal(guideHref(''), '/guide');
  assert.equal(guideInitialQuery('?q=%E5%A4%96%E8%A7%82'), '外观');
  assert.equal(guideInitialQuery('?x=1'), '');
  assert.equal(guideInitialQuery(''), '');
  assert.deepEqual(filterCatalog(CATALOG, {category: 'settings', query: '外观'}).map((item) => item.id), ['settings-hub', 'settings-appearance']);
  assert.deepEqual(filterCatalog(CATALOG, {query: '日出日落'}).map((item) => item.id), ['settings-appearance']);
});

test('the empty state names an empty category instead of blaming a search', () => {
  const {emptyGuideMessage} = guideModule;
  assert.equal(typeof emptyGuideMessage, 'function', 'the guide page cannot tell an empty category from a fruitless search');
  const emptyCategory = filterCatalog(CATALOG, {category: 'calls'});
  assert.deepEqual(emptyCategory, []);
  assert.equal(emptyGuideMessage(emptyCategory, ''), '这一类还没有指引。');
  assert.equal(emptyGuideMessage(emptyCategory, '   '), '这一类还没有指引。');
  const noHits = filterCatalog(CATALOG, {category: 'memory', query: 'xyz-not-a-feature'});
  assert.deepEqual(noHits, []);
  assert.equal(emptyGuideMessage(noHits, 'xyz-not-a-feature'), '没有匹配的条目。换个词，或按 Esc 清空搜索。');
  assert.equal(emptyGuideMessage(filterCatalog(CATALOG, {category: 'chat'}), ''), '');
});

test('the guide deep link carries the category as well as the keyword', () => {
  assert.equal(typeof guideModule.guideInitialCategory, 'function',
    'the guide page never reads ?category= back from the URL');
  const initial = guideModule.guideInitialCategory;
  assert.equal(initial('?category=calls'), 'calls');
  assert.equal(initial('?category=settings&q=%E5%A4%96%E8%A7%82'), 'settings');
  assert.equal(initial('?category=not-a-category'), 'all');
  assert.equal(initial('?category='), 'all');
  assert.equal(initial('?q=%E5%A4%96%E8%A7%82'), 'all');
  assert.equal(initial(''), 'all');
  assert.equal(guideHref('', 'calls'), '/guide?category=calls');
  assert.equal(guideHref('', 'all'), '/guide');
  assert.equal(guideHref('外观', 'settings'), '/guide?category=settings&q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('外观', 'all'), '/guide?q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('', 'not-a-category'), '/guide');
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.elements = undefined;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  removeAttribute(key) {
    delete this.attributes[key];
  }

  addEventListener(key, handler) {
    this.handlers[key] = handler;
  }

  querySelectorAll() {
    return [];
  }

  focus() {}

  reset() {}
}

function fakeGuideDocument() {
  const elements = new Map();
  const doc = {
    cookie: '',
    readyState: 'complete',
    body: new FakeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) {
        const el = new FakeElement(id.endsWith('-form') ? 'form' : 'div');
        if (id.endsWith('-form')) {
          el.elements = {username: new FakeElement('input'), password: new FakeElement('input')};
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createElementNS(_namespace, tag) { return new FakeElement(tag); },
    createTextNode(text) { return {textContent: String(text), tagName: '#TEXT', children: []}; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

test('a category deep link selects its chip and narrows the list', async () => {
  const {doc, el} = fakeGuideDocument();
  const replaced = [];
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    fetch: globalThis.fetch,
  };
  globalThis.document = doc;
  globalThis.location = {pathname: '/guide', search: '?category=calls'};
  globalThis.history = {replaceState: (...args) => replaced.push(args)};
  globalThis.fetch = async (path) => (path === '/v1/auth/session'
    ? {status: 200, json: async () => ({user: {id: 'user-1', username: 'alice'}})}
    : {status: 404, json: async () => ({error: {message: 'missing'}})});
  try {
    await import('../flybot_workspace/static/guide/app.mjs?category=calls');
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const chips = el('guide-categories').children;
    const selected = chips.filter((chip) => chip.attributes['aria-current'] === 'true')
      .map((chip) => chip.dataset.category);
    assert.deepEqual(selected, ['calls'], 'the calls chip is not the current category');
    assert.equal(el('guide-list').children.length, 0, 'the list still shows other categories');
    assert.equal(el('guide-count').textContent, '当前显示 0 条');
    assert.equal(el('guide-empty').hidden, false);
    assert.equal(el('guide-empty').textContent, '这一类还没有指引。');
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
    globalThis.history = previous.history;
    globalThis.fetch = previous.fetch;
  }
});

async function mountGuide(search) {
  const {doc, el} = fakeGuideDocument();
  const replaced = [];
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    fetch: globalThis.fetch,
  };
  globalThis.document = doc;
  globalThis.location = {pathname: '/guide', search};
  globalThis.history = {replaceState: (...args) => replaced.push(args)};
  globalThis.fetch = async (path) => (path === '/v1/auth/session'
    ? {status: 200, json: async () => ({user: {id: 'user-1', username: 'alice'}})}
    : {status: 404, json: async () => ({error: {message: 'missing'}})});
  await import(`../flybot_workspace/static/guide/app.mjs?mount=${encodeURIComponent(search)}`);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const chip = (id) => el('guide-categories').children.find((item) => item.dataset.category === id);
  return {
    el,
    replaced,
    chip,
    currentCategory: () => el('guide-categories').children
      .filter((item) => item.attributes['aria-current'] === 'true')
      .map((item) => item.dataset.category),
    restore() {
      globalThis.document = previous.document;
      globalThis.location = previous.location;
      globalThis.history = previous.history;
      globalThis.fetch = previous.fetch;
    },
  };
}

test('clicking a category chip writes the category into the URL', async () => {
  const page = await mountGuide('');
  try {
    page.chip('calls').handlers.click();
    assert.equal(page.replaced.length, 1, 'clicking a category chip never updated the URL');
    assert.equal(page.replaced[0][2], '/guide?category=calls',
      'the category chip did not put ?category= into the URL');
    assert.deepEqual(page.currentCategory(), ['calls']);
  } finally {
    page.restore();
  }
});

test('clicking a category chip keeps the keyword in the URL too', async () => {
  const page = await mountGuide('?q=%E5%A4%96%E8%A7%82');
  try {
    assert.equal(page.el('guide-search').value, '外观');
    page.chip('settings').handlers.click();
    assert.equal(page.replaced.length, 1, 'clicking a category chip never updated the URL');
    assert.equal(page.replaced[0][2], '/guide?category=settings&q=%E5%A4%96%E8%A7%82',
      'the chip click dropped the keyword or the category from the URL');
    assert.deepEqual(page.currentCategory(), ['settings']);
  } finally {
    page.restore();
  }
});

function textOf(node) {
  if (!node.children || node.children.length === 0) return node.textContent || '';
  return node.children.map(textOf).join('');
}

function marksIn(node, found = []) {
  for (const child of node.children || []) {
    if (child.tagName === 'MARK') found.push(child.textContent);
    marksIn(child, found);
  }
  return found;
}

test('highlightSegments marks only the matched run and keeps the text intact', () => {
  const {highlightSegments} = guideModule;
  assert.equal(typeof highlightSegments, 'function',
    'typing a keyword never marks which part of a guide row matched it');
  assert.deepEqual(highlightSegments('打开聊天', '聊天'), [
    {text: '打开', match: false},
    {text: '聊天', match: true},
  ]);
  assert.deepEqual(highlightSegments('FlyBot 下载', 'fly'), [
    {text: 'Fly', match: true},
    {text: 'Bot 下载', match: false},
  ]);
  assert.deepEqual(highlightSegments('收起目录也可以收起', '收起'), [
    {text: '收起', match: true},
    {text: '目录也可以', match: false},
    {text: '收起', match: true},
  ]);
  const noHit = highlightSegments('打开聊天', 'xyz-not-a-feature');
  assert.deepEqual(noHit, [{text: '打开聊天', match: false}]);
  assert.deepEqual(highlightSegments('打开聊天', '   '), [{text: '打开聊天', match: false}]);
  assert.deepEqual(highlightSegments('', '聊天'), []);
  for (const query of ['聊天', 'xyz', '   ']) {
    assert.equal(highlightSegments('打开聊天', query).map((part) => part.text).join(''), '打开聊天',
      `highlighting "${query}" changed the text the reader sees`);
  }
});

test('a searched guide row marks the keyword inside its title', async () => {
  const page = await mountGuide('?q=%E6%99%BA%E8%83%BD%E4%BD%93');
  try {
    const rows = [];
    for (const section of page.el('guide-list').children) {
      for (const child of section.children) {
        if (child.className === 'guide-item') rows.push(child);
      }
    }
    assert.ok(rows.length, 'the search returned no rows to mark');
    const row = rows.find((entry) => CATALOG
      .find((item) => item.id === entry.dataset.itemId).title.includes('智能体'));
    assert.ok(row, 'the search returned no row whose title contains the keyword');
    const title = row.children[1];
    assert.ok(marksIn(title).length,
      'the matched keyword is not marked in the guide row title');
    assert.ok(marksIn(title).every((text) => text === '智能体'));
    assert.ok(textOf(title).includes('智能体'), 'the title still has to read as the full title');
    assert.equal(textOf(title), CATALOG.find((item) => item.id === row.dataset.itemId).title,
      'marking the keyword must not change the title text');
    for (const row of rows) {
      const rowTitle = row.children[1];
      assert.equal(textOf(rowTitle), CATALOG.find((item) => item.id === row.dataset.itemId).title,
        'marking the keyword must not change the title text');
    }
  } finally {
    page.restore();
  }
});

test('the opened guide dialog marks the keyword in its title and body', async () => {
  const page = await mountGuide('?q=%E6%97%A5%E5%87%BA%E6%97%A5%E8%90%BD');
  try {
    let target = null;
    for (const section of page.el('guide-list').children) {
      for (const child of section.children) {
        if (child.className === 'guide-item' && child.dataset.itemId === 'settings-appearance') target = child;
      }
    }
    assert.ok(target, 'the body match was not listed');
    target.handlers.click();
    const body = page.el('guide-dialog-body');
    assert.ok(marksIn(body).includes('日出日落'),
      'the opened guide body does not mark the keyword that matched it');
    const item = CATALOG.find((entry) => entry.id === 'settings-appearance');
    assert.equal(textOf(body), item.body, 'marking must keep the dialog body text intact');
    const title = page.el('guide-dialog-title');
    assert.equal(textOf(title), item.title);
    assert.deepEqual(marksIn(title), [], 'a keyword that is not in the title must not mark anything');
  } finally {
    page.restore();
  }
});

test('each guide detail links to the destination for the current item', async () => {
  const page = await mountGuide('?test=links');
  try {
    for (const item of CATALOG) {
      const row = page.el('guide-list').children
        .flatMap((section) => section.children)
        .find((child) => child.dataset.itemId === item.id);
      assert.ok(row, item.id);
      row.handlers.click();
      const action = page.el('guide-dialog-action');
      assert.equal(action.attributes.href, item.href, item.id);
      assert.equal(action.textContent, `去这里 · ${item.title}`);
    }
  } finally {
    page.restore();
  }
});

test('a fruitless search says there is no match and how to clear it', async () => {
  const page = await mountGuide('?q=xyz-not-a-feature');
  try {
    const empty = page.el('guide-empty');
    assert.equal(empty.hidden, false);
    assert.equal(empty.textContent, '没有匹配的条目。换个词，或按 Esc 清空搜索。');
  } finally {
    page.restore();
  }
});

test('each category and catalog row has its own dedicated icon path', () => {
  const generic = 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm-1 3h2v5h-2V8zm0 6h2v2h-2v-2z';
  const categoryPaths = CATEGORIES.map((category) => guideIconPath('category', category.id));
  assert.equal(categoryPaths.length, CATEGORIES.length);
  assert.equal(new Set(categoryPaths).size, CATEGORIES.length, 'category icons must not reuse a single glyph');
  assert.ok(categoryPaths.every((path) => path && path !== generic));
  assert.deepEqual(Object.keys(CATEGORY_ICON_PATHS).sort(), CATEGORIES.map((item) => item.id).sort());
  const itemPaths = CATALOG.map((item) => guideIconPath('item', item.id));
  assert.equal(itemPaths.length, CATALOG.length);
  assert.equal(new Set(itemPaths).size, CATALOG.length, 'catalog row icons must be dedicated, not a shared info mark');
  assert.ok(itemPaths.every((path) => path && path !== generic));
  assert.deepEqual(Object.keys(ITEM_ICON_PATHS).sort(), CATALOG.map((item) => item.id).sort());
});

test('the mounted guide paints those dedicated icons in chips, titles and rows', async () => {
  const page = await mountGuide('?category=all');
  try {
    const pathOf = (node) => {
      const svg = node && node.children && node.children[0];
      const path = svg && svg.children && svg.children[0];
      return path && path.attributes ? path.attributes.d : '';
    };
    const chips = page.el('guide-categories').children;
    assert.equal(chips.length, CATEGORIES.length);
    const chipPaths = chips.map((chip) => pathOf(chip.children[0]));
    assert.deepEqual(chipPaths, CATEGORIES.map((category) => guideIconPath('category', category.id)));
    const seenItems = [];
    for (const section of page.el('guide-list').children) {
      const heading = section.children[0];
      assert.equal(heading.className, 'guide-group-title');
      const firstRow = section.children.find((child) => child.className === 'guide-item');
      const groupId = CATALOG.find((item) => item.id === firstRow.dataset.itemId).category;
      const summary = section.children.find((child) => child.className === 'guide-group-summary');
      assert.ok(summary?.textContent);
      assert.equal(pathOf(heading.children[0]), guideIconPath('category', groupId));
      assert.equal(heading.children[1].textContent, CATEGORIES.find((item) => item.id === groupId).label);
      for (const child of section.children) {
        if (child.className !== 'guide-item') continue;
        seenItems.push(child.dataset.itemId);
        assert.equal(pathOf(child.children[0]), guideIconPath('item', child.dataset.itemId));
      }
    }
    assert.deepEqual(seenItems, CATALOG.map((item) => item.id));
  } finally {
    page.restore();
  }
});
