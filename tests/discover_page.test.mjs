import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validSlug, catalogInitial, catalogItems, agentDiscoverPairs, isAgentsCatalog, isTeamsCatalog, renderTeamCard, FEED_CATEGORIES, CATALOG_CATEGORIES, FEED_ACTIVITY_EMPTY_NOTE, FEED_ACTIVITY_LISTED_NOTE, FEED_FOLLOWING_EMPTY_TITLE, FEED_FOLLOWING_EMPTY_BODY, FEED_FOLLOWING_NOTE, FEED_SEARCH_EMPTY_NOTE, feedQuery, formatFeedTime, renderFeedCard, coverPattern } from '../flybot_workspace/static/discover/app.mjs';


test('catalogInitial skips leading punctuation like the public homepage initial', () => {
  assert.equal(catalogInitial('[CI FIXTURE] Directory assistant'), 'C');
  assert.equal(catalogInitial('Directory assistant'), 'D');
  assert.equal(catalogInitial('  智能体'), '智');
  assert.equal(catalogInitial('42-helper'), '4');
  assert.equal(catalogInitial('---'), '?');
  assert.equal(catalogInitial(''), '?');
  assert.equal(catalogInitial(undefined), '?');
});

test('validSlug mirrors the server slug rule', () => {
  assert.equal(validSlug('on-call'), true);
  assert.equal(validSlug('abc'), true);
  assert.equal(validSlug('a'), false);
  assert.equal(validSlug('On-call'), false);
  assert.equal(validSlug('-abc'), false);
  assert.equal(validSlug('abc-'), false);
  assert.equal(validSlug('a'.repeat(31)), false);
  assert.equal(validSlug(null), false);
});

test('isAgentsCatalog only matches the recorded tab=agents query', () => {
  assert.equal(isAgentsCatalog({search: ''}), false);
  assert.equal(isAgentsCatalog({search: '?tab=agents'}), true);
  assert.equal(isAgentsCatalog({search: '?tab=teams'}), false);
  assert.equal(isAgentsCatalog({search: '?tab=agents&section=groups'}), false);
  assert.equal(isAgentsCatalog(undefined), false);
});

test('isTeamsCatalog only matches the recorded tab=agents&section=groups query', () => {
  assert.equal(isTeamsCatalog({search: ''}), false);
  assert.equal(isTeamsCatalog({search: '?tab=agents'}), false);
  assert.equal(isTeamsCatalog({search: '?tab=agents&section=groups'}), true);
  assert.equal(isTeamsCatalog({search: '?section=groups'}), false);
  assert.equal(isTeamsCatalog(undefined), false);
});

test('available feed categories have a consistent order', () => {
  assert.deepEqual(FEED_CATEGORIES, ['网页', '文档', '图片', '音乐', '幻灯片', '视频', '3D 作品', '白板', '看板', '电子表格']);
});

test('feed all-filter shows the recorded 全部 label and keeps an empty canvas', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('class="feed-filters"')[1].split('id="feed-following-empty"')[0];
  assert.match(block, /class="feed-filter-all"[^>]*aria-current="true"[^>]*>全部</);
  assert.equal(/class="feed-filter-all"[^>]*><\/button>/.test(block), false);
  assert.equal(/aria-label="全部"/.test(block), false);
  assert.equal(/没有单独标出文字|圆形按钮/.test(block), false);
  const order = ['全部', '热门', ...FEED_CATEGORIES];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(html, /id="feed-activity-empty"/);
  assert.match(html, /id="feed-grid"[^>]*data-empty="true"/);
  const activity = html.split('id="feed-activity-empty"')[1].split('id="feed-note"')[0];
  assert.equal(/\bhidden\b/.test(activity.split('>')[0]), false);
  assert.equal(activity.includes('id="feed-note"'), false);
  assert.equal(/最多领取|CREDITS|积分中心/.test(html.split('id="feed-panel"')[1].split('id="catalog-view"')[0]), false);
});

test('recorded catalog categories stay in the captured order', () => {
  assert.deepEqual(CATALOG_CATEGORIES, [
    'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
    'Education', 'Engineering', 'Finance', 'IT & Security', 'Investment',
    'Legal', 'Life', 'Marketing', 'Operations', 'Product', 'Recruiting', 'Research', 'Sales',
  ]);
});

test('catalog categories are selectable and the search opens a real dialog', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('id="catalog-filters"')[1].split('id="catalog-creator-filter"')[0];
  assert.match(block, /data-catalog-category="all" aria-pressed="true">全部</);
  for (const label of CATALOG_CATEGORIES) assert.ok(block.includes('>' + label.replaceAll('&', '&amp;') + '<'));
  assert.doesNotMatch(block, /disabled/);
  assert.match(block, /id="catalog-filter-search"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /<dialog id="catalog-category-dialog"/);
});


test('the teams catalog links to separate workspace and AI team creation flows', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="catalog-tab-teams" href="\/discover\?tab=agents&amp;section=groups">AI 团队</);
  assert.match(html, /id="catalog-create-team" href="\/team" hidden>\+ 创建团队</);
  assert.match(html, /id="catalog-create-agent-team" href="\/agents\?tab=teams&amp;new=1" hidden>\+ 创建 AI 智能体团队</);
  assert.doesNotMatch(html, /没有公共 AI 团队目录接口/);
});

test('team cards render real membership and keep a join action for nonmembers', () => {
  const doc = fakeDocument();
  const team = {workspace_id: 'd'.repeat(32), name: '策划团队', summary: '<b>Brief</b>', member_count: 2};
  const card = renderTeamCard(doc, team, {onJoin() {}});
  assert.equal(card.children[0].children[1].textContent, team.name);
  assert.equal(card.children[1].textContent, team.summary);
  assert.equal(card.children[2].children[0].textContent, '2 位成员');
  assert.equal(card.children[2].children[1].textContent, '申请加入');
  for (const [membership, label] of [['member','已加入'],['pending','等待审批'],['suspended','已暂停']]) {
    const footer = renderTeamCard(doc, {...team, membership}, {onJoin() {}}).children[2];
    const state = footer.children[1];
    assert.equal(state.tagName, 'span');
    assert.equal(state.textContent, label);
    assert.equal(footer.children[2]?.href, membership === 'member' ? '/members#workspace=' + team.workspace_id : undefined);
  }
});

test('catalog filter rows do not wrap chips onto a second line', () => {
  const css = readFileSync(new URL('../flybot_workspace/static/discover/app.css', import.meta.url), 'utf8');
  const block = css.split('.catalog-filters {')[1].split('.catalog-creator-row')[0];
  assert.match(block, /flex-wrap:\s*nowrap/);
  assert.match(block, /\.catalog-filter-scroll[^}]*overflow-x:\s*auto/s);
  assert.match(block, /\.catalog-filter-search[^}]*flex:\s*0 0 auto/s);
  assert.equal(/\.catalog-filters \{[^}]*flex-wrap:\s*wrap/.test(css.split('/* Design refresh */')[0]), false);
});


test('catalogItems tolerates missing bodies', () => {
  assert.deepEqual(catalogItems({items: [{slug: 'a'}]}), [{slug: 'a'}]);
  assert.deepEqual(catalogItems(null), []);
  assert.deepEqual(catalogItems({}), []);
});

test('agentDiscoverPairs aligns statuses by index and defaults to unlisted', () => {
  const agents = [{id: 'a'}, {id: 'b'}];
  const pairs = agentDiscoverPairs(agents, [{listed: true, slug: 'a'}]);
  assert.deepEqual(pairs[0].discover, {listed: true, slug: 'a'});
  assert.deepEqual(pairs[1].discover, {listed: false});
});

test('publish management keeps archived listings available for withdrawal', () => {
  const agents = [{id:'active'}, {id:'archived-public', archived:1}, {id:'archived-private', archived:1}];
  const statuses = [{listed:false}, {listed:true}, {listed:false}];
  assert.deepEqual(agentDiscoverPairs(agents,statuses).map(({agent}) => agent.id), ['active','archived-public']);
});


test('catalogQuery encodes search and cursor on the existing public allowlist', async () => {
  const {catalogQuery} = await import('../flybot_workspace/static/discover/app.mjs');
  assert.equal(catalogQuery(), '/v1/discover/agents?limit=12');
  assert.equal(catalogQuery('  a & 中文  ', 'ci-helper-01'),
    '/v1/discover/agents?limit=12&q=a+%26+%E4%B8%AD%E6%96%87&cursor=ci-helper-01');
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.dataset = {};
    this.hidden = true; this.disabled = false; this.value = ''; this.textContent = '';
  }
  get childElementCount() { return this.children.length; }
  get options() { return this.children; }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof Element) Object.defineProperty(node, 'parent', {value:this, writable:true, configurable:true});
    }
    this.children.push(...nodes);
  }
  prepend(...nodes) {
    for (const node of nodes) {
      if (node instanceof Element) Object.defineProperty(node, 'parent', {value:this, writable:true, configurable:true});
    }
    this.children.unshift(...nodes);
  }
  contains(node) { return this === node || this.children.some(child => child.contains?.(node)); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  focus() {}
  select() {}
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
}
function fakeDocument() {
  const elements = new Map();
  return {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelectorAll() { return []; },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('DS-Bot paints the public catalog before session, then enables the already loaded viewer flags', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const requests = [];
  const work = detailFixture({liked: true, collected: true, own_work: true});
  const loaded = mount(doc, {location: {search: '?sort=popular'}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12&sort=popular') {
      return Promise.resolve(commentResponse({items: [work], viewer_username: 'alice'}));
    }
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await flush();
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('whoami').textContent, '');
  const [card] = el('feed-grid').children;
  const [comments, details] = card.children[1].children;
  assert.equal(card.children[1].className, 'feed-card-actions');
  assert.equal(card.children[1].children.length, 2);
  assert.equal(comments.className, 'feed-comments-toggle');
  assert.equal(details.className, 'feed-detail-toggle');
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  assert.equal(el('feed-grid').children[0], card, 'session did not remove or rebuild the visible card');
  assert.equal(el('whoami').textContent, 'alice');
  const [like, collect, stillComments, stillDetails] = card.children[1].children;
  assert.equal(like.attributes['aria-pressed'], 'true');
  assert.equal(collect.attributes['aria-pressed'], 'true');
  assert.equal(stillComments, comments, 'the owner has no follow control');
  assert.equal(stillDetails, details, 'the detail control remains last');
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12&sort=popular']);
});

test('a guest sees the public works before sign-in resolves and never requests a private tab', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const session = Promise.withResolvers();
  const requests = [];
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12') return Promise.resolve(commentResponse({items: [detailFixture()]}));
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await flush();
  assert.equal(el('feed-grid').children.length, 1);
  await el('feed-tab-collected').handlers.click();
  assert.equal(el('feed-grid').children.length, 0);
  assert.equal(el('feed-note').textContent, '');
  session.resolve(commentResponse({}, 401));
  await loaded;
  assert.equal(el('login-panel').hidden, false);
  assert.match(el('feed-note').textContent, /请先登录/);
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12']);
});

test('a signed-in private tab supersedes a delayed public response and clears after logout', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const publicFeed = Promise.withResolvers();
  const session = Promise.withResolvers();
  const requests = [];
  let authCount = 0;
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return ++authCount === 1 ? session.promise : Promise.resolve(commentResponse({}, 401));
    if (path === '/v1/discover/works?limit=12') return publicFeed.promise;
    if (path === '/v1/discover/me/works?limit=12&tab=following') {
      return Promise.resolve(commentResponse({items: [detailFixture({slug: 'followed-work', title: 'Followed'})], viewer_username: 'alice'}));
    }
    if (path === '/v1/auth/logout') return Promise.resolve(commentResponse({}));
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await el('feed-tab-following').handlers.click();
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12']);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  const [row] = el('feed-grid').children;
  const [oldLike] = row.children[1].children;
  publicFeed.resolve(commentResponse({items: [detailFixture()]}));
  await flush();
  assert.equal(el('feed-grid').children[0], row);
  await el('logout-form').handlers.submit({preventDefault() {}});
  await oldLike.handlers.click();
  assert.equal(el('feed-grid').children.length, 0);
  assert.match(el('feed-note').textContent, /请先登录/);
  assert.deepEqual(requests, [
    '/v1/auth/session', '/v1/discover/works?limit=12', '/v1/discover/me/works?limit=12&tab=following',
    '/v1/auth/logout', '/v1/auth/session',
  ]);
});

test('the platform page keeps public cards visible while signed-in viewer flags are read', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const session = Promise.withResolvers();
  const viewerFeed = Promise.withResolvers();
  const work = detailFixture();
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12') return Promise.resolve(commentResponse({items: [work]}));
    if (path === '/v1/discover/me/works?limit=12&tab=all') return viewerFeed.promise;
    throw new Error(path);
  }});
  const grid = doc.getElementById('feed-grid');
  await flush();
  const [publicCard] = grid.children;
  assert.equal(publicCard.children[1].children.length, 2);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await flush();
  assert.equal(grid.children[0], publicCard);
  assert.equal(publicCard.children[1].children.length, 2);
  viewerFeed.resolve(commentResponse({items: [{...work, liked: true}]}));
  await loaded;
  const [like] = grid.children[0].children[1].children;
  assert.equal(like.attributes['aria-pressed'], 'true');
});

test('the signed-in native feed refreshes once when a different account provided the public cards', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const refresh = Promise.withResolvers();
  const requests = [];
  const work = detailFixture({liked: true, own_work: true});
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path !== '/v1/discover/works?limit=12') throw new Error(path);
    return requests.length === 2 ? Promise.resolve(commentResponse({items: [work], viewer_username: 'alice', cursor: 'old-cursor'})) : refresh.promise;
  }});
  const grid = doc.getElementById('feed-grid');
  const more = doc.getElementById('feed-more');
  await flush();
  const [publicCard] = grid.children;
  assert.equal(publicCard.children[1].children.length, 2);
  assert.equal(more.disabled, true);
  session.resolve(commentResponse({user: {username: 'bobby'}}));
  await flush();
  assert.equal(grid.children[0], publicCard);
  assert.equal(publicCard.children[1].children.length, 2);
  assert.equal(more.hidden, true);
  refresh.resolve(commentResponse({items: [{...work, liked: false, own_work: false}], viewer_username: 'bobby', cursor: 'new-cursor'}));
  await loaded;
  const [like, , follow] = grid.children[0].children[1].children;
  assert.equal(like.attributes['aria-pressed'], 'false');
  assert.equal(follow.textContent, '关注');
  assert.equal(follow.attributes['aria-label'], '关注作者');
  assert.equal(more.disabled, false);
  assert.equal(more.hidden, false);
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12', '/v1/discover/works?limit=12']);
});

test('native following and collected links start one scoped feed read and confirm the viewer before rendering', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  for (const tab of ['following', 'collected']) {
    const doc = fakeDocument();
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    const session = Promise.withResolvers();
    const paths = [];
    const workPath = '/v1/discover/me/works?limit=12&q=release&kind=document&tab=' + tab;
    const mounted = mount(doc, {location:{search:'?feed=' + tab + '&kind=document&q=release'}, fetcher:async path => {
      paths.push(path);
      if (path === '/v1/auth/session') return session.promise;
      if (path === workPath) return commentResponse({viewer_username:'alice', items:[detailFixture({collected:true})]});
      throw new Error(path);
    }});
    const grid = doc.getElementById('feed-grid');
    await flush();
    assert.deepEqual(paths, ['/v1/auth/session', workPath]);
    assert.equal(grid.children.length, 0);
    assert.match(doc.getElementById('feed-count').textContent, /正在加载作品/);
    session.resolve(commentResponse({user:{id:'owner', username:'alice'}}));
    await mounted;
    assert.deepEqual(paths, ['/v1/auth/session', workPath]);
    assert.equal(grid.children.length, 1);
    assert.equal(grid.children[0].children[1].children[1].attributes['aria-pressed'], 'true');
  }
});

test('an unverified native visitor never sees the scoped feed and need not wait for it', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const pending = Promise.withResolvers();
  let signal;
  const mounted = mount(doc, {location:{search:'?feed=collected'}, fetcher:async (path, options) => {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/me/works?limit=12&tab=collected') {
      signal = options.signal;
      return pending.promise;
    }
    throw new Error(path);
  }});
  await flush();
  assert.equal(signal.aborted, false);
  session.resolve(commentResponse({}, 401));
  await mounted;
  assert.equal(signal.aborted, true);
  assert.match(doc.getElementById('feed-note').textContent, /请先登录/);
  pending.resolve(commentResponse({viewer_username:'alice', items:[detailFixture()]}));
  await flush();
  assert.equal(doc.getElementById('feed-grid').children.length, 0);
  assert.equal(doc.getElementById('login-panel').hidden, false);
});

test('a native signed-in feed retries an early unauthorized response once after verifying the account', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  let reads = 0;
  const mounted = mount(doc, {location:{search:'?feed=collected'}, fetcher:async path => {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/me/works?limit=12&tab=collected') {
      if (++reads === 1) return commentResponse({}, 401);
      return commentResponse({viewer_username:'alice', items:[detailFixture()]});
    }
    throw new Error(path);
  }});
  await flush();
  assert.equal(reads, 1);
  assert.equal(doc.getElementById('feed-error').hidden, true);
  session.resolve(commentResponse({user:{id:'owner', username:'alice'}}));
  await mounted;
  assert.equal(reads, 2);
  assert.equal(doc.getElementById('feed-grid').children.length, 1);
});

test('the native feed discards private rows with an unproven viewer after a single retry', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const requests = [];
  await mount(doc, {location: {search: '?feed=collected'}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user: {username: 'bobby'}});
    assert.equal(path, '/v1/discover/me/works?limit=12&tab=collected');
    const viewer_username = requests.length === 2 ? 'alice' : ['bobby'];
    return commentResponse({items: [detailFixture({title: 'Other account collection'})], viewer_username});
  }});
  assert.equal(doc.getElementById('feed-grid').children.length, 0);
  assert.match(doc.getElementById('feed-error').textContent, /登录状态已变化/);
  assert.equal(requests.length, 3);
});

test('public agent cards and profile links render while account actions are waiting for the session', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const requests = [];
  const loaded = mount(doc, {location: {search: '?tab=agents'}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/agents?limit=12') return commentResponse({
      viewer_username: 'alice', items: [{slug: 'writing-demo', name: 'Writing', chat_enabled: true}],
    });
    if (path === '/v1/workspaces?limit=100') return commentResponse({items: []});
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await flush();
  assert.equal(el('main-panel').hidden, false);
  const [row] = el('discover-list').children;
  assert.equal(classHits(row, 'catalog-profile')[0].href, '/a/writing-demo');
  assert.equal(classHits(row, 'catalog-use').length, 0);
  assert.equal(classHits(row, 'catalog-chat').length, 0);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('catalog-create-agent').hidden, true);

  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  assert.equal(el('discover-list').children[0], row);
  assert.equal(classHits(row, 'catalog-use').length, 1);
  assert.equal(classHits(row, 'catalog-chat')[0].href, '/chat#public-agent=writing-demo');
  assert.equal(el('catalog-manage').hidden, false);
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/agents?limit=12', '/v1/workspaces?limit=100']);
});

test('a late wrong-viewer catalog recheck leaves the selected search and actions intact', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const verification = Promise.withResolvers();
  const requests = [];
  const initial = '/v1/discover/agents?limit=12';
  const loaded = mount(doc, {location: {search: '?tab=agents'}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/workspaces?limit=100') return commentResponse({items: []});
    if (path === initial) {
      if (requests.filter(url => url === initial).length === 2) return verification.promise;
      return commentResponse({viewer_username: 'other', items: [{slug: 'writing-demo', name: 'Writing', chat_enabled: true}]});
    }
    if (path === initial + '&q=math') {
      return commentResponse({viewer_username: 'alice', items: [{slug: 'math-demo', name: 'Math', chat_enabled: true, own_agent: true}]});
    }
    throw new Error(path);
  }});
  await flush();
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  assert.equal(classHits(doc.getElementById('discover-list'), 'catalog-chat').length, 0);
  const query = doc.getElementById('catalog-query');
  query.value = 'math';
  await doc.getElementById('catalog-search').handlers.submit({preventDefault() {}});
  verification.resolve(commentResponse({viewer_username: 'alice', items: [{slug: 'writing-demo', name: 'Writing', chat_enabled: true}]}));
  await flush();

  const list = doc.getElementById('discover-list');
  assert.equal(classHits(list, 'catalog-profile')[0].href, '/a/math-demo');
  assert.equal(classHits(list, 'catalog-chat').length, 0);
  assert.equal(classHits(list, 'catalog-use').length, 1);
  assert.equal(query.value, 'math');
  assert.equal(requests.filter(url => url === initial).length, 2);
});

test('anonymous catalog search/clear/paging use public GETs and never publish on browse', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    const url = new URL(path, 'https://management.test');
    const query = url.searchParams.get('q');
    const cursor = url.searchParams.get('cursor');
    return {status: 200, json: async () => query
      ? {items: []}
      : {items: [{
        name: 'Fixture', slug: cursor ? 'fixture-two' : 'fixture-one',
        summary: '<script>not HTML</script>', chat_enabled: Boolean(cursor),
      }],
        cursor: cursor ? null : 123}};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('catalog-more').hidden, false);
  const card = el('discover-list').children[0].children[0];
  const profile = card.children[1].children[0].children[0];
  assert.equal(profile.tagName, 'a');
  assert.equal(profile.href, '/a/fixture-one');
  assert.equal(profile.textContent, 'Fixture');
  assert.equal(card.children[1].children[1].textContent, '<script>not HTML</script>');
  assert.equal(classHits(card, 'catalog-use').length, 0);
  assert.equal(classHits(card, 'catalog-chat')[0].href, '/a/fixture-one');
  assert.equal(classHits(card, 'catalog-chat')[0].textContent, '查看主页');
  await el('catalog-more').handlers.click();
  assert.equal(el('discover-list').children.length, 2);
  const chat = classHits(el('discover-list').children[1], 'catalog-chat')[0];
  assert.equal(chat.href, '/a/fixture-two#conversation-title');
  assert.equal(chat.textContent, '聊天');
  assert.equal(el('catalog-more').hidden, true);
  el('catalog-query').value = 'nothing & 中文';
  el('catalog-search').handlers.submit({preventDefault() {}});
  await flush();
  assert.equal(el('discover-list').children.length, 0);
  assert.match(el('discover-empty').textContent, /没有匹配/);
  el('catalog-clear').handlers.click();
  await flush();
  assert.equal(el('catalog-query').value, '');
  assert.equal(el('discover-list').children.length, 1);
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
  assert.equal(requests.some(([path]) => path.includes('cursor=123')), true);
  assert.equal(requests.some(([path]) => path.includes('q=nothing+%26+%E4%B8%AD%E6%96%87')), true);
});

test('catalog retries, aborts replaced searches, and clears an empty search', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const stale = Promise.withResolvers();
  let staleSignal;
  let attempts = 0;
  await mount(doc, {location: {search: '?tab=agents'}, fetcher: async (path, options) => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (++attempts === 1) throw new Error('fixture unavailable');
    const query = new URL(path, 'https://management.test').searchParams.get('q');
    if (query === 'stale') {
      staleSignal = options.signal;
      return stale.promise;
    }
    return {status: 200, json: async () => ({items: query ? [] : [{slug: 'example-agent', name: 'Example'}]})};
  }});
  const el = id => doc.getElementById(id);
  assert.equal(el('catalog-error').hidden, false);
  assert.match(el('catalog-error').textContent, /fixture unavailable/);
  assert.equal(el('catalog-panel').getAttribute('aria-busy'), 'false');
  assert.equal(el('discover-empty').hidden, true);
  assert.equal(el('teams-retry').hidden, false);
  await el('teams-retry').handlers.click();
  assert.equal(el('discover-list').children.length, 1);
  assert.equal(el('teams-retry').hidden, true);
  el('catalog-query').value = 'stale';
  const replaced = el('catalog-search').handlers.submit({preventDefault() {}});
  el('catalog-query').value = 'empty';
  await el('catalog-search').handlers.submit({preventDefault() {}});
  assert.equal(staleSignal.aborted, true);
  stale.resolve({status: 200, json: async () => ({items: [{slug: 'old-agent'}]})});
  await replaced;
  assert.equal(el('discover-list').children.length, 0);
  assert.equal(el('catalog-empty-reset').hidden, false);
  await el('catalog-empty-reset').handlers.click();
  assert.equal(el('catalog-query').value, '');
  assert.equal(el('discover-list').children.length, 1);
});

test('catalog history only reloads bounded pages for the same viewer and filters', async () => {
  const {catalogQuery, mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const query = '验收';
  const category = 'content-creation';
  const initial = catalogQuery(query, '', category);
  const next = catalogQuery(query, 'page-one', category);
  const key = (owner, path = initial) => JSON.stringify(['signed-in', owner, path]);
  for (const [scope, pages, expected] of [
    [key('reader'), 2, [initial, next]],
    [key('someone-else'), 2, [initial]],
    [key('reader', catalogQuery('另一条件', '', category)), 2, [initial]],
    [key('reader'), 500, [initial]],
  ]) {
    const doc = fakeDocument();
    const requests = [];
    await mount(doc, {
      location:{search:'?tab=agents&category=' + category + '&q=' + encodeURIComponent(query)},
      history:{state:{discoverAgentDirectory:{key:scope, pages, scroll:320}}},
      fetcher:async (path, {method}) => {
        assert.equal(method, 'GET');
        if (path === '/v1/auth/session') return commentResponse({user:{id:'reader', username:'alice'}});
        if (path === '/v1/workspaces?limit=100') return commentResponse({items:[]});
        requests.push(path);
        return commentResponse(path === initial
          ? {items:[{slug:'first-result',name:'First'}],cursor:'page-one'}
          : {items:[{slug:'next-result',name:'Next'}]});
      },
    });
    assert.deepEqual(requests, expected);
    assert.equal(doc.getElementById('discover-list').children.length, expected.length);
  }
});

test('catalog cards only link to profiles with a valid public slug', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    return {status: 200, json: async () => ({items: [{name: 'Fixture', slug: '../fixture-one'}], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents'}});
  const card = doc.getElementById('discover-list').children[0].children[0];
  const title = card.children[1].children[0];
  assert.equal(title.textContent, 'Fixture');
  assert.equal(title.childElementCount, 0);
});

test('default discover view loads works; private tabs require sign-in and does not load the catalog API', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/me/works?')) return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works?')) return {status: 200, json: async () => ({items: [], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('feed-panel').hidden, false);
  assert.equal(el('catalog-view').hidden, true);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'true');
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false);
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/works?')), true);
  await el('feed-tab-following').handlers.click();
  assert.match(el('feed-note').textContent, /请先登录/);
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(FEED_FOLLOWING_EMPTY_TITLE, '关注列表暂无动态');
  assert.equal(FEED_FOLLOWING_EMPTY_BODY, '你关注的人发布动态后会显示在这里。');
  assert.equal(FEED_FOLLOWING_NOTE.includes('没有对照截图'), false);
  assert.match(FEED_FOLLOWING_NOTE, /你关注的作者已公开/);
  await el('feed-tab-activity').handlers.click();
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
});

test('anonymous viewers see login guidance and never query the teams directory', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async path => {
    requests.push(path);
    return {status: 401, json: async () => ({})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents&section=groups'}});
  assert.equal(doc.getElementById('catalog-tab-teams').attributes['aria-current'], 'page');
  assert.equal(doc.getElementById('catalog-create-team').hidden, false);
  assert.equal(doc.getElementById('catalog-create-agent-team').hidden, true);
  assert.match(doc.getElementById('discover-empty').textContent, /登录后/);
  await doc.getElementById('catalog-search').handlers.submit({preventDefault() {}});
  assert.deepEqual(requests, ['/v1/auth/session']);
});

test('search and join use the team directory and show the approval status', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const team = {workspace_id: 'ott_1', name: '产品团队', member_count: 2};
  const pending = Promise.withResolvers();
  const respond = (status, body) => ({status, json: async () => body});
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return respond(200, {user: {id: 'one', username: 'alice'}});
    if (path === '/v1/team-directory/ott_1/join') return pending.promise;
    assert.match(path, /^\/v1\/team-directory\?limit=24/);
    return respond(200, {items: path.includes('&q=') ? [] : [team]});
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents&section=groups'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('catalog-create-team').hidden, false);
  assert.equal(el('catalog-create-agent-team').hidden, false);
  const teamAction = () => el('discover-list').children[0].children[0].children[1].children[1];
  const original = teamAction();
  const clicked = original.handlers.click();
  await original.handlers.click();
  assert.equal(teamAction().disabled, true);
  pending.resolve(respond(202, {join_request: {status: 'pending'}}));
  await clicked;
  assert.equal(teamAction().textContent, '等待审批');
  el('catalog-query').value = '  研发 & 内容 ';
  await el('catalog-search').handlers.submit({preventDefault() {}});
  assert.equal(el('discover-empty').textContent, '没有匹配的团队。');
  await el('catalog-clear').handlers.click();
  assert.equal(el('discover-list').children.length, 1);
  assert.deepEqual(requests, [
    ['/v1/auth/session', 'GET'],
    ['/v1/team-directory?limit=24', 'GET'],
    ['/v1/team-directory/ott_1/join', 'POST'],
    ['/v1/team-directory?limit=24&q=%E7%A0%94%E5%8F%91+%26+%E5%86%85%E5%AE%B9', 'GET'],
    ['/v1/team-directory?limit=24', 'GET'],
  ]);
});

test('an empty team directory explains publication and keeps errors separate', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  let status = 200;
  await mount(doc, {
    location: {search: '?tab=agents&section=groups'},
    async fetcher(path) {
      if (path === '/v1/auth/session') return commentResponse({user: {id: 'owner', username: 'alice'}});
      if (path.startsWith('/v1/team-directory?')) return commentResponse({items: [], cursor: null}, status);
      throw new Error('unexpected ' + path);
    },
  });
  const empty = doc.getElementById('discover-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /创建团队后.*成员页.*团队目录/);
  status = 503;
  await doc.getElementById('catalog-search').handlers.submit({preventDefault() {}});
  assert.equal(empty.hidden, true);
  assert.equal(doc.getElementById('catalog-error').hidden, false);
  assert.equal(doc.getElementById('teams-retry').hidden, false);
});

test('feedQuery encodes a keyword and a recency cursor', () => {
  assert.equal(feedQuery('', ''), 'limit=12');
  assert.equal(feedQuery('外观', '100.ci-doc'), 'limit=12&q=%E5%A4%96%E8%A7%82&cursor=100.ci-doc');
  assert.equal(feedQuery('设计', 'hot-key', '', 'popular'), 'limit=12&q=%E8%AE%BE%E8%AE%A1&cursor=hot-key&sort=popular');
  assert.equal(feedQuery('', '', '', 'latest', 'vera.home'), 'limit=12&creator=vera.home');
  assert.equal(feedQuery('notes', '', 'document', 'latest', '', 'travel'), 'limit=12&q=notes&kind=document&category=travel');
});

test('work topic composes with existing filters and survives a shared detail URL', async () => {
  const {feedSearchText, feedStateFromSearch, workDetailSearchText} = await import('../flybot_workspace/static/discover/app.mjs');
  const search = '?feed=collected&kind=document&q=notes&topic=education';
  const state = feedStateFromSearch(search);
  assert.equal(state.topic, 'education');
  assert.equal(feedSearchText(state), search);
  assert.equal(workDetailSearchText(state, {slug:'trip-notes', comments:true}), search + '&work=trip-notes&comments=1');
  assert.equal(feedStateFromSearch('?topic=education&topic=travel').topic, undefined);
  assert.equal(feedStateFromSearch('?topic=unknown').topic, undefined);
});

test('an empty author feed uses the canonical handle and can be cleared', async () => {
  const {mount, feedStateFromSearch, feedSearchText} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const mixedCase = '?creator=Writer.Home';
  assert.equal(feedSearchText(feedStateFromSearch(mixedCase)), '?creator=writer.home');
  assert.equal(feedSearchText(feedStateFromSearch('?kind=image&q=sample&creator=Writer.Home')),
    '?kind=image&q=sample&creator=writer.home');
  assert.equal(feedStateFromSearch('?creator=writer%2Fhome').creator, undefined);
  await mount(doc, {
    location: {search: mixedCase},
    async fetcher(path) {
      requests.push(path);
      if (path === '/v1/auth/session') return commentResponse({}, 401);
      if (path.startsWith('/v1/discover/works?')) return commentResponse({items: [], cursor: null});
      throw new Error('unexpected ' + path);
    },
  });
  const clear = doc.getElementById('feed-creator-filter');
  assert.match(clear.textContent, /writer\.home/);
  assert.equal(doc.getElementById('feed-note').textContent, '该作者还没有公开作品。');
  assert.ok(requests.includes('/v1/discover/works?limit=12&creator=writer.home'));
  await clear.handlers.click();
  assert.equal(clear.hidden, true);
  assert.equal(doc.getElementById('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
  assert.ok(requests.includes('/v1/discover/works?limit=12'));
});

test('the activity feed renders opted-in work cards from the public API', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path === '/v1/discover/works?limit=12') {
      return {status: 200, json: async () => ({items: [{
        slug: 'ci-fixture-doc',
        title: '[CI FIXTURE] Document',
        kind: 'document',
        kind_label: '文档',
        author: 'alice',
        updated: 1800000000,
        path: '/w/ci-fixture-doc',
      }], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-grid').dataset.empty, 'false');
  assert.equal(el('feed-grid').children.length, 1);
  const cell = el('feed-grid').children[0];
  // The grid cell wraps the work link so the detail can sit beside it.
  assert.equal(String(cell.tagName).toLowerCase(), 'article');
  assert.equal(cell.className, 'feed-entry');
  const card = cell.children[0];
  assert.equal(String(card.tagName).toLowerCase(), 'a');
  assert.equal(card.href, '/discover?work=ci-fixture-doc');
  assert.equal(card.children[0].className, 'work-cover');
  assert.equal(card.children[0].dataset.kind, 'document');
  assert.equal(card.children[1].textContent, '文档');
  assert.equal(card.children[2].textContent, '[CI FIXTURE] Document');
  assert.equal(card.children[3].children[1].textContent.includes('alice'), true);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_LISTED_NOTE);
  assert.equal(el('feed-count').textContent, '已显示 1 件公开作品');
  assert.equal(el('feed-more').hidden, true);
});

test('formatFeedTime renders the listing timestamp in Asia/Shanghai', () => {
  assert.equal(formatFeedTime(1800000000), '2027/1/15');
});


test('work type selection uses the real API and resets pagination, all restores full feed', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    return {status: 200, json: async () => ({items: [], cursor: path.includes('kind=website') ? '1.site-one' : null})};
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  await el('feed-kind-website').handlers.click();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12&kind=website');
  assert.equal(el('feed-kind-website').attributes['aria-current'], 'true');
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'false');
  el('feed-more').handlers.click();
  await flush();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12&cursor=1.site-one&kind=website');
  await el('feed-kind-image').handlers.click();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12&kind=image');
  await el('feed-kind-all').handlers.click();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12');
  assert.equal(calls.every(([, method]) => method === 'GET'), true);
});

test('the feed only presents available filters', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');
  for (const kind of ['website', 'image', 'audio', 'slides', 'video', 'model3d']) {
    const tag = html.match(new RegExp('<button[^>]*id="feed-kind-' + kind + '"[^>]*>'))[0];
    assert.equal(tag.includes('disabled'), false);
  }
  assert.doesNotMatch(html, />小游戏</);
  assert.equal(feedQuery('中文', '1.site-one', 'website'), 'limit=12&q=%E4%B8%AD%E6%96%87&cursor=1.site-one&kind=website');
});

test('a failed Discover feed shows retry before a successful empty result', async t => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const cases = [
    {name: 'public feed', search: '', path: '/v1/discover/works?limit=12', note: FEED_ACTIVITY_EMPTY_NOTE},
    {name: 'public search', search: '?q=notes', path: '/v1/discover/works?limit=12&q=notes', note: FEED_SEARCH_EMPTY_NOTE},
    {name: 'following feed', search: '?feed=following', path: '/v1/discover/me/works?limit=12&tab=following',
      note: FEED_FOLLOWING_NOTE, viewer: 'alice'},
  ];
  for (const {name, search, path, note, viewer} of cases) {
    await t.test(name, async () => {
      const doc = fakeDocument();
      doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
      const reads = [];
      await mount(doc, {location: {search}, fetcher: async requested => {
        if (requested === '/v1/auth/session') {
          return viewer ? commentResponse({user: {id: 'owner', username: viewer}}) : commentResponse({}, 401);
        }
        reads.push(requested);
        if (reads.length === 1) return commentResponse({}, 503);
        return commentResponse({items: [], viewer_username: viewer || null});
      }});
      const el = id => doc.getElementById(id);
      assert.deepEqual(reads, [path]);
      assert.equal(el('feed-error').hidden, false);
      assert.match(el('feed-error').textContent, /无法加载公开作品/);
      assert.equal(el('feed-note').textContent, '');
      assert.equal(el('feed-following-empty').hidden, true);
      assert.equal(el('feed-retry').hidden, false);

      await el('feed-retry').handlers.click();
      assert.deepEqual(reads, [path, path]);
      assert.equal(el('feed-error').hidden, true);
      assert.equal(el('feed-retry').hidden, true);
      assert.equal(el('feed-note').textContent, note);
      assert.equal(el('feed-following-empty').hidden, !viewer);
    });
  }
});

test('selecting the active feed category refreshes once and preserves its items and cursor on failure', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [], visits = [];
  const delayed = Promise.withResolvers();
  const work = {slug: 'layout-notes', title: '公开笔记', kind: 'document', creator: {username: 'alice'}};
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    calls.push(path);
    if (calls.length === 2) return delayed.promise;
    return {status: 200, json: async () => ({items: [work], cursor: '1.layout-notes'})};
  };
  await mount(doc, {fetcher, location: {search: '?kind=document'}, history: {pushState(...args) { visits.push(args); }}});
  const el = id => doc.getElementById(id);
  const selected = el('feed-kind-document');
  const card = el('feed-grid').children[0];
  assert.equal(card.dataset.slug, 'layout-notes');
  const refresh = selected.handlers.click();
  await selected.handlers.click();
  assert.equal(calls.length, 2);
  assert.equal(calls[1], '/v1/discover/works?limit=12&kind=document');
  assert.equal(el('feed-grid').children[0], card);
  assert.equal(el('feed-filters').dataset.refreshing, 'true');
  assert.equal(el('feed-more').disabled, true);
  delayed.resolve({status: 503, json: async () => ({})});
  await refresh;
  assert.equal(el('feed-grid').children[0], card);
  assert.equal(el('feed-filters').dataset.refreshing, 'false');
  assert.equal(el('feed-more').disabled, false);
  assert.equal(el('feed-retry').hidden, false);
  await el('feed-retry').handlers.click();
  assert.equal(calls[2], calls[1]);
  assert.equal(el('feed-retry').hidden, true);
  assert.deepEqual(visits, []);
});


test('every supported selected type uses the selected category styling', () => {
  const css = readFileSync(new URL('../flybot_workspace/static/discover/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.feed-filters button\[aria-current="true"\]/);
});


test('signed-in feed persists like/collect/follow and loads real private tabs', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument(), calls = [];
  const state = {liked: false, collected: false, following: false, likes: 0};
  const item = {slug: 'shared-doc', title: 'Public work', author: 'bob', path: '/w/shared-doc', kind: 'document'};
  const fetcher = async (path, options) => {
    calls.push([path, options]);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.endsWith('/engagement')) {
      const body = JSON.parse(options.body);
      state[{like: 'liked', collect: 'collected', follow: 'following'}[body.action]] = body.enabled;
      state.likes = state.liked ? 1 : 0;
      return {status: 200, json: async () => state};
    }
    if (path.startsWith('/v1/discover/me/works?')) return {status: 200, json: async () => ({items: [{...item, ...state}], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const grid = doc.getElementById('feed-grid');
  await grid.children[0].children[1].children[0].handlers.click();
  assert.equal(state.liked, true);
  const [liked] = grid.children[0].children[1].children;
  assert.equal(liked.textContent, '点赞 · 1');
  assert.equal(liked.attributes['aria-label'], '取消点赞 · 1');
  await grid.children[0].children[1].children[1].handlers.click();
  assert.equal(state.collected, true);
  await grid.children[0].children[1].children[2].handlers.click();
  assert.equal(state.following, true);
  await doc.getElementById('feed-tab-following').handlers.click();
  assert.match(calls.at(-1)[0], /tab=following/);
  await doc.getElementById('feed-tab-collected').handlers.click();
  assert.match(calls.at(-1)[0], /tab=collected/);
});


test('engaging with a later page keeps every card and a failed save can be retried in place', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const grid = doc.getElementById('feed-grid');
  const pending = Promise.withResolvers();
  const writes = [];
  const reads = [];
  const work = slug => ({slug, title: slug, author:'bob', path:'/w/' + slug, kind:'document'});
  await mount(doc, {location:{search:''}, fetcher(path, options) {
    if (path === '/v1/auth/session') return commentResponse({user:{username:'alice'}});
    if (path.endsWith('/engagement')) {
      writes.push(JSON.parse(options.body));
      return writes.length === 1 ? pending.promise : commentResponse({liked:true,likes:3});
    }
    if (path.startsWith('/v1/discover/me/works?')) {
      reads.push(path);
      return path.includes('cursor=page-2') ? commentResponse({items:[work('second-page')]})
        : commentResponse({items:[work('first-page')],cursor:'page-2'});
    }
    throw new Error(path);
  }});
  await doc.getElementById('feed-more').handlers.click();
  const [first, second] = grid.children;
  const like = second.children[1].children[0];
  const write = like.handlers.click();
  assert.equal(like.attributes['aria-busy'],'true');
  await like.handlers.click();
  assert.equal(writes.length,1);
  pending.resolve({status:503,json:async()=>({})});
  await write;
  assert.equal(like.attributes['aria-pressed'],'false');
  assert.equal(second.children[2].hidden,false);
  assert.equal(first.children[2].hidden,true);
  await like.handlers.click();
  assert.equal(second.children[2].hidden,true);
  assert.equal(like.attributes['aria-label'],'取消点赞 · 3');
  assert.equal(like.attributes['aria-pressed'],'true');
  assert.equal(like.attributes['aria-busy'],'false');
  assert.equal(grid.children[0],first);
  assert.equal(grid.children[1],second);
  assert.equal(reads.length,2);
});

test('a stale following response cannot restore works from an author just unfollowed', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const mutation = Promise.withResolvers();
  const following = Promise.withResolvers();
  const grid = doc.getElementById('feed-grid');
  const work = (slug,author) => ({slug, title:slug, author, path:'/w/' + slug,kind:'document',following:true});
  const items = [work('first-work','first'),work('second-work','first'),work('other-work','other')];
  const reads = [];
  await mount(doc, {location:{search:''}, fetcher(path) {
    if (path === '/v1/auth/session') return commentResponse({user:{username:'alice'}});
    if (path.endsWith('/engagement')) return mutation.promise;
    if (path.startsWith('/v1/discover/me/works?')) {
      reads.push(path);
      return path.includes('tab=following') ? following.promise : commentResponse({items:items.map(item=>({...item}))});
    }
    throw new Error(path);
  }});
  const firstFollow = grid.children[0].children[1].children[2];
  const secondFollow = grid.children[1].children[1].children[2];
  const write = firstFollow.handlers.click();
  assert.equal(secondFollow.attributes['aria-busy'],'true');
  const load = doc.getElementById('feed-tab-following').handlers.click();
  mutation.resolve(commentResponse({following:false}));
  await write;
  following.resolve(commentResponse({items}));
  await load;
  assert.deepEqual(grid.children.map(card=>card.dataset.slug),['other-work']);
  assert.equal(grid.children[0].children[1].children[2].attributes['aria-pressed'],'true');
  assert.equal(reads.length,2);
});

test('switching private feed tabs cannot be overwritten by an older in-flight response', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  let release;
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {id: 'owner'}})};
    if (path.startsWith('/v1/workspaces')) return {status: 200, json: async () => ({items: []})};
    if (path.includes('tab=following')) return new Promise(resolve => {release = resolve;});
    return {status: 200, json: async () => ({items: path.includes('tab=collected') ? [{slug: 'saved-work', title: 'Saved fixture', kind: 'document'}] : []})};
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const pending = doc.getElementById('feed-tab-following').handlers.click();
  await flush();
  await doc.getElementById('feed-tab-collected').handlers.click();
  release({status: 200, json: async () => ({items: [{slug: 'old-work', title: 'Stale fixture', kind: 'document'}]})});
  await pending;
  const grid = doc.getElementById('feed-grid');
  assert.equal(grid.children.length, 1);
  assert.match(JSON.stringify(grid.children[0]), /Saved fixture/);
  assert.doesNotMatch(JSON.stringify(grid.children[0]), /Stale fixture/);
});


test('feed selection round-trips through the URL search', async () => {
  const {feedStateFromSearch, feedSearchText} = await import('../flybot_workspace/static/discover/app.mjs');
  assert.deepEqual(feedStateFromSearch('?feed=following&kind=video&q=cat'),
    {tab: 'following', kind: 'video', sort: 'latest', query: 'cat'});
  assert.deepEqual(feedStateFromSearch('?feed=collected&q=%E4%B8%AD%E6%96%87'),
    {tab: 'collected', kind: '', sort: 'latest', query: '中文'});
  assert.deepEqual(feedStateFromSearch('?tab=agents'),
    {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch('?feed=following&kind=bogus'),
    {tab: 'following', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch('?feed=activity'), {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch(''), {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch(undefined), {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch('?sort=popular&q=cat'), {tab: 'activity', kind: '', sort: 'popular', query: 'cat'});
  assert.deepEqual(feedStateFromSearch('?kind=model3d'), {tab: 'activity', kind: 'model3d', sort: 'latest', query: ''});
  for (const kind of ['document', 'whiteboard', 'dashboard', 'spreadsheet']) {
    assert.equal(feedStateFromSearch('?kind=' + kind).kind, kind);
  }
  assert.equal(feedSearchText(feedStateFromSearch('?sort=popular&q=cat')), '?sort=popular&q=cat');
  assert.equal(feedSearchText({tab: 'following', kind: 'video', query: 'cat'}),
    '?feed=following&kind=video&q=cat');
  assert.equal(feedSearchText({tab: 'collected', kind: '', query: ''}), '?feed=collected');
  const collectionOrder = '?feed=collected&kind=document&sort=collected&q=cat&topic=technology';
  assert.equal(feedSearchText(feedStateFromSearch(collectionOrder)), collectionOrder);
  assert.equal(feedStateFromSearch('?sort=collected').sort, 'latest');
  assert.equal(feedStateFromSearch('?feed=following&sort=collected').sort, 'latest');
  assert.equal(feedSearchText({tab: 'activity', kind: '', query: ''}), '');
  assert.equal(feedSearchText({tab: 'following', kind: 'bogus', query: ''}), '?feed=following');
});

test('热门 and work kinds replace each other and restore their activity URLs', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument(), requests = [], visits = [], handlers = {};
  const location = {search: '?kind=model3d&q=chair', pathname: '/discover'};
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    requests.push(new URL(path, 'https://example.com').searchParams);
    return {status: 200, json: async () => ({items: [], cursor: null})};
  };
  await mount(doc, {fetcher, location, history: {pushState(_state, _title, url) {visits.push(url);}},
    window: {addEventListener(type, handler) {handlers[type] = handler;}}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-kind-model3d').attributes['aria-current'], 'true');
  await el('feed-sort-popular').handlers.click();
  assert.equal(visits.at(-1), '/discover?sort=popular&q=chair');
  assert.equal(requests.at(-1).get('sort'), 'popular');
  assert.equal(requests.at(-1).get('tab'), 'all');
  assert.equal(requests.at(-1).has('kind'), false);
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'false');
  assert.equal(el('feed-sort-popular').attributes['aria-current'], 'true');
  await el('feed-kind-all').handlers.click();
  assert.equal(visits.at(-1), '/discover?q=chair');
  assert.equal(requests.at(-1).has('sort'), false);
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'true');
  location.search = '?sort=popular&q=chair';
  await handlers.popstate();
  assert.equal(el('feed-sort-popular').attributes['aria-current'], 'true');
  await el('feed-tab-following').handlers.click();
  assert.equal(el('feed-sort-popular').hidden, true);
  assert.equal(requests.at(-1).has('sort'), false);
  assert.equal(requests.at(-1).get('tab'), 'following');
});

test('a popularity cursor refreshes from the first page after expiring', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument(), paths = [];
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    paths.push(path);
    if (path.includes('cursor=')) {
      return {status: 409, json: async () => ({error: {code: 'popularity_expired'}})};
    }
    const item = {slug: 'paper-chair', title: paths.length === 1 ? 'Original' : 'Refreshed', kind: 'model3d'};
    return {status: 200, json: async () => ({items: [item], cursor: paths.length === 1 ? 'hot-key' : null})};
  };
  await mount(doc, {fetcher, location: {search: '?sort=popular'}});
  doc.getElementById('feed-more').handlers.click();
  await flush();
  assert.deepEqual(paths, [
    '/v1/discover/works?limit=12&sort=popular',
    '/v1/discover/works?limit=12&cursor=hot-key&sort=popular',
    '/v1/discover/works?limit=12&sort=popular',
  ]);
  assert.match(JSON.stringify(doc.getElementById('feed-grid').children), /Refreshed/);
  assert.equal(doc.getElementById('feed-sort-popular').attributes['aria-current'], 'true');
  assert.equal(doc.getElementById('feed-error').hidden, true);
});


test('a shared feed URL opens the tab, kind and search it names', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [], visit = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.startsWith('/v1/discover/me/works?')) {
      return {status: 200, json: async () => ({items: [{slug: 'followed-work', title: 'Followed', author: 'bob'}], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {
    fetcher, location: {search: '?feed=following&kind=video&q=cat', pathname: '/discover'},
    history: {pushState(_state, _title, url) { visit.push(url); }},
    window: {addEventListener() {}},
  });
  assert.equal(doc.getElementById('feed-query').value, 'cat');
  assert.equal(doc.getElementById('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(doc.getElementById('feed-tab-activity').attributes['aria-selected'], 'false');
  assert.equal(doc.getElementById('feed-kind-video').attributes['aria-current'], 'true');
  assert.equal(doc.getElementById('feed-kind-all').attributes['aria-current'], 'false');
  const loaded = calls.findLast(path => path.startsWith('/v1/discover/me/works?'));
  assert.match(loaded, /tab=following/);
  assert.match(loaded, /kind=video/);
  assert.match(loaded, /q=cat/);
  assert.equal(visit.length, 0, 'opening a link must not add a history entry');
});


test('choosing a category keeps the feed tab instead of resetting to 动态', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.startsWith('/v1/discover/me/works?')) {
      return {status: 200, json: async () => ({items: [{slug: 'followed-work', title: 'Followed', author: 'bob'}], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'},
    history: {pushState() {}}, window: {addEventListener() {}}});
  const el = id => doc.getElementById(id);
  await el('feed-tab-following').handlers.click();
  assert.match(calls.at(-1), /tab=following/);
  await el('feed-kind-image').handlers.click();
  assert.match(calls.at(-1), /tab=following/);
  assert.match(calls.at(-1), /kind=image/);
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'false');
  assert.equal(el('feed-kind-image').attributes['aria-current'], 'true');
  el('feed-query').value = 'cat';
  await el('feed-search').handlers.submit({preventDefault() {}});
  assert.match(calls.at(-1), /tab=following/);
  assert.match(calls.at(-1), /kind=image/);
  assert.match(calls.at(-1), /q=cat/);
});


test('feed tab and category changes push a shareable URL and back/forward restores them', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const visit = [];
  const handlers = {};
  const location = {search: '', pathname: '/discover'};
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.startsWith('/v1/discover/me/works?')) return {status: 200, json: async () => ({items: [], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location,
    history: {pushState(_state, _title, url) { visit.push(url); location.search = url.split('?')[1] ? '?' + url.split('?')[1] : ''; }},
    window: {addEventListener(type, handler) { handlers[type] = handler; }}});
  const el = id => doc.getElementById(id);
  assert.equal(visit.length, 0);
  await el('feed-tab-following').handlers.click();
  assert.equal(visit.at(-1), '/discover?feed=following');
  await el('feed-kind-image').handlers.click();
  assert.equal(visit.at(-1), '/discover?feed=following&kind=image');
  el('feed-query').value = 'cat';
  await el('feed-search').handlers.submit({preventDefault() {}});
  assert.equal(visit.at(-1), '/discover?feed=following&kind=image&q=cat');
  assert.equal(typeof handlers.popstate, 'function');

  location.search = '';
  await handlers.popstate();
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'true');
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'true');
  assert.equal(el('feed-query').value, '');
  assert.doesNotMatch(calls.at(-1), /tab=following/);
  assert.equal(visit.at(-1), '/discover?feed=following&kind=image&q=cat', 'back must not push a new entry');

  location.search = '?feed=following&kind=image&q=cat';
  await handlers.popstate();
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(el('feed-kind-image').attributes['aria-current'], 'true');
  assert.equal(el('feed-query').value, 'cat');
  assert.match(calls.at(-1), /tab=following/);
  assert.match(calls.at(-1), /kind=image/);
});


test('following nobody from a shared URL shows the following empty note, not a blank feed', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    return {status: 200, json: async () => ({items: [], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?feed=following', pathname: '/discover'},
    history: {pushState() {}}, window: {addEventListener() {}}});
  const empty = doc.getElementById('feed-following-empty');
  assert.equal(empty.hidden, false);
  assert.equal(doc.getElementById('feed-tab-following').attributes['aria-selected'], 'true');
  assert.match(doc.getElementById('feed-note').textContent, /你关注的作者已公开/);
  assert.match(calls.at(-1), /tab=following/);
});

test('feed arrow and boundary keys select real tabs immediately with one tab stop', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument(), visits = [], paths = [];
  const html = readFileSync(new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="feed-tabs" role="tablist" aria-label="动态类型"/);
  assert.match(html, /id="feed-results" role="tabpanel" aria-labelledby="feed-tab-activity"/);
  const tabs = ['following', 'activity', 'collected'];
  const el = name => doc.getElementById('feed-tab-' + name);
  for (const name of tabs) {
    assert.match(html, new RegExp('id="feed-tab-' + name + '"[^>]*role="tab" aria-controls="feed-results"'));
    el(name).focus = () => { doc.activeElement = el(name); };
  }
  await mount(doc, {
    location: {search: '', pathname: '/discover'},
    history: {pushState(_state, _title, url) { visits.push(url); }},
    async fetcher(path) {
      if (path === '/v1/auth/session') return commentResponse({user: {id: 'user-a', username: 'alice'}});
      paths.push(path);
      return commentResponse({items: []});
    },
  });
  async function move(from, key, to) {
    let prevented = false;
    const pending = el(from).handlers.keydown({key, preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    assert.equal(doc.activeElement, el(to));
    assert.deepEqual(tabs.map(name => el(name).attributes.tabindex), tabs.map(name => name === to ? '0' : '-1'));
    assert.deepEqual(tabs.map(name => el(name).attributes['aria-selected']), tabs.map(name => String(name === to)));
    assert.equal(doc.getElementById('feed-results').attributes['aria-labelledby'], 'feed-tab-' + to);
    await pending;
  }
  await move('activity', 'ArrowLeft', 'following');
  await move('following', 'ArrowLeft', 'collected');
  await move('collected', 'Home', 'following');
  await move('following', 'ArrowRight', 'activity');
  await move('activity', 'End', 'collected');
  assert.deepEqual(visits, ['/discover?feed=following', '/discover?feed=collected', '/discover?feed=following',
    '/discover', '/discover?feed=collected']);
  assert.match(paths.at(-1), /tab=collected/);
  const before = paths.length;
  await el('collected').handlers.keydown({key: 'ArrowRight', altKey: true});
  assert.equal(paths.length, before);
});

test('empty filtered following offers a reset and keeps the selected feed', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument(), paths = [];
  await mount(doc, {
    location: {search: '?feed=following&kind=image', pathname: '/discover'},
    async fetcher(path) {
      if (path === '/v1/auth/session') return commentResponse({user: {id: 'user-a', username: 'alice'}});
      paths.push(path);
      return commentResponse({items: []});
    },
  });
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-note').textContent, FEED_SEARCH_EMPTY_NOTE);
  assert.equal(el('feed-empty-reset').hidden, false);
  await el('feed-empty-reset').handlers.click();
  assert.match(paths.at(-1), /tab=following/);
  assert.doesNotMatch(paths.at(-1), /kind=/);
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(el('feed-following-empty').hidden, false);
  assert.equal(el('feed-empty-reset').hidden, true);
});

test('returning to a visited tab restores pages with a fresh cursor without pulling keyboard focus away', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument(), paths = [];
  let activityReads = 0;
  await mount(doc, {
    location: {search: '?q=launch', pathname: '/discover'},
    async fetcher(path) {
      if (path === '/v1/auth/session') return commentResponse({user: {id: 'user-a', username: 'alice'}});
      if (path.endsWith('/preview')) return commentResponse({preview: null});
      const params = new URL(path, 'https://example.test').searchParams;
      paths.push(params);
      if (params.get('tab') === 'following') return commentResponse({items: []});
      if (params.has('cursor')) return commentResponse({items: [detailFixture({slug: 'second-page'})]});
      return commentResponse({items: [detailFixture({slug: 'first-page'})], cursor: 'fresh-' + ++activityReads});
    },
  });
  const el = id => doc.getElementById(id);
  const activity = el('feed-tab-activity');
  const following = el('feed-tab-following');
  activity.id = 'feed-tab-activity';
  following.id = 'feed-tab-following';
  let focusCount = 0;
  activity.focus = () => { doc.activeElement = activity; focusCount++; };
  following.focus = () => { doc.activeElement = following; };
  await el('feed-more').handlers.click();
  const before = activityReads;
  el('main').scrollTop = 570;
  await activity.handlers.keydown({key: 'ArrowLeft', preventDefault() {}});
  assert.equal(el('main').scrollTop, 0);
  assert.equal(doc.activeElement, following);
  await following.handlers.keydown({key: 'ArrowRight', preventDefault() {}});
  assert.equal(paths.at(-1).get('cursor'), 'fresh-' + (before + 1));
  assert.equal(paths.at(-1).get('q'), 'launch');
  assert.equal(el('feed-grid').children.length, 2);
  assert.equal(el('main').scrollTop, 570);
  assert.equal(doc.activeElement, activity);
  assert.equal(focusCount, 1, 'the key handler, not the async restore, moves focus');
});


test('work covers use real same-origin published media, not invented screenshots', () => {
  const doc = fakeDocument();
  const photo = {slug: 'real-photo', path: '/social/w/real-photo', title: '<safe>',
    kind: 'image', file_available: true, file_mime: 'image/png'};
  const image = renderFeedCard(doc, photo);
  const [cover] = classHits(image, 'work-cover');
  const [photoImage] = classHits(cover, 'work-cover-image');
  assert.equal(cover.tagName, 'div');
  assert.equal(photoImage.tagName, 'img');
  assert.equal(photoImage.src, '/social/w/real-photo/file');
  assert.equal(photoImage.loading, 'lazy');
  assert.equal(photoImage.decoding, 'async');
  assert.equal(photoImage.fetchPriority, 'low');
  assert.equal(photoImage.alt, '');
  photoImage.handlers.error();
  assert.equal(photoImage.hidden, true);
  assert.equal(cover.dataset.kind, 'image', 'the fixed cover remains after an image fails');
  assert.equal(classHits(renderFeedCard(doc, {...photo, file_available: false}), 'work-cover-image').length, 0);
  assert.equal(classHits(renderFeedCard(doc, {...photo, file_mime: 'video/mp4'}), 'work-cover-image').length, 0);
  assert.equal(classHits(renderFeedCard(doc, {...photo, slug: '../photo'}), 'work-cover-image').length, 0);
  assert.equal(classHits(renderFeedCard(doc, {...photo, file_available: undefined}), 'work-cover-image').length, 0);
  assert.equal(classHits(renderFeedCard(doc, {...photo, file_available: undefined}, {legacyImage: true}), 'work-cover-image').length, 1);
  const website = renderFeedCard(doc, {slug: 'real-site', title: 'Site', kind: 'website'});
  const fallback = website.children.find(node => node.className === 'work-cover');
  assert.equal(fallback.tagName, 'div');
  assert.equal(fallback.dataset.kind, 'website');
  assert.equal(fallback.dataset.pattern, coverPattern('Site'));
  assert.equal(fallback.textContent, '');
  assert.equal(fallback.src, undefined);
  const badge = website.children.find(node => node.className === 'kind');
  assert.equal(badge.textContent, '网页');
});

test('search excerpts highlight validated UTF-16 ranges using literal content', () => {
  const doc = fakeDocument();
  const prefix = '🚀 <script>';
  const title = '标题';
  const hit = '<img src=x>';
  const text = prefix + hit + '</script>';
  const item = detailFixture({title, match: {kind: 'body', text, start: prefix.length, end: prefix.length + hit.length}});
  const card = renderFeedCard(doc, item);
  const [before, mark, after] = classHits(card, 'feed-search-excerpt')[0].children;
  assert.equal(before, prefix);
  assert.equal(mark.tagName, 'mark');
  assert.equal(mark.textContent, hit);
  assert.equal(after, '</script>');
  assert.equal(card.children[2].textContent, title);
  const titleCard = renderFeedCard(doc, {...item, match: {kind: 'title', text: title, start: 1, end: 2}});
  assert.equal(titleCard.children[2].children[1].textContent, '题');
  assert.equal(classHits(titleCard, 'feed-search-excerpt').length, 0);
  const bad = renderFeedCard(doc, {...item, match: {...item.match, end: text.length + 1}});
  assert.equal(classHits(bad, 'feed-search-excerpt').length, 0);
});

test('the search debounces an IME commit, aborts an older query, retries the active filter, then clears on Escape', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const calls = [], visits = [];
  const slow = Promise.withResolvers();
  const started = Promise.withResolvers();
  const location = {search: '?kind=document', pathname: '/discover'};
  let retry = false;
  await mount(doc, {
    location,
    history: {pushState(_state, _title, url) {visits.push(url);}},
    async fetcher(path, {signal} = {}) {
      if (path === '/v1/auth/session') return commentResponse({}, 401);
      if (path.endsWith('/preview')) return commentResponse({preview: null});
      const params = new URL(path, 'https://example.test').searchParams;
      calls.push({params, signal});
      if (params.get('q') === '中文') {
        started.resolve();
        return slow.promise;
      }
      if (params.get('q') === '最新' && !retry) {
        retry = true;
        return commentResponse({}, 503);
      }
      return commentResponse({items: [detailFixture({title: params.get('q') || '目录'})]});
    },
  });
  const el = id => doc.getElementById(id);
  const input = el('feed-query');
  input.handlers.compositionstart();
  input.value = '中';
  input.handlers.input();
  assert.equal(el('feed-clear').hidden, false);
  assert.equal(calls.length, 1);
  input.value = '中文';
  input.handlers.compositionend();
  assert.equal(calls.length, 1, 'composition waits for the debounce');
  await started.promise;
  assert.equal(calls.at(-1).params.get('q'), '中文');
  const old = calls.at(-1);
  input.value = '最新';
  await el('feed-search').handlers.submit({preventDefault() {}});
  assert.equal(old.signal.aborted, true);
  assert.match(el('feed-error').textContent, /无法加载/);
  assert.equal(el('feed-retry').hidden, false);
  await el('feed-retry').handlers.click();
  assert.equal(el('feed-retry').hidden, true);
  assert.equal(calls.at(-1).params.get('q'), '最新');
  assert.equal(calls.at(-1).params.get('kind'), 'document');
  slow.resolve(commentResponse({items: [detailFixture({title: '过期结果'})]}));
  await flush();
  assert.equal(el('feed-grid').children[0].children[0].children[2].textContent, '最新');
  assert.match(el('feed-count').textContent, /1 件匹配作品/);
  await input.handlers.keydown({key: 'Escape', preventDefault() {}});
  assert.equal(el('feed-clear').hidden, true);
  assert.equal(input.value, '');
  assert.equal(visits.at(-1), '/discover?kind=document');
  assert.equal(calls.at(-1).params.has('q'), false);
});

test('Back after changing a filter rereads fresh cursors to restore the previous depth, position and card focus', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const createElement = doc.createElement;
  doc.createElement = tag => {
    const element = createElement(tag);
    element.focus = () => { doc.activeElement = element; };
    return element;
  };
  const location = {pathname: '/discover', search: '?q=layout'};
  const calls = [], handlers = {};
  let firstPages = 0;
  await mount(doc, {
    location,
    window: {addEventListener(type, handler) {handlers[type] = handler;}},
    history: {pushState(_state, _title, url) {location.search = new URL(url, 'https://example.test').search;}},
    async fetcher(path) {
      if (path === '/v1/auth/session') return commentResponse({}, 401);
      if (path.endsWith('/preview')) return commentResponse({preview: null});
      const params = new URL(path, 'https://example.test').searchParams;
      calls.push(params);
      if (params.has('kind')) return commentResponse({items: []});
      if (params.has('cursor')) return commentResponse({items: [detailFixture({slug: 'second-page'})]});
      return commentResponse({items: [detailFixture({slug: 'first-page'})], cursor: 'page-' + ++firstPages});
    },
  });
  const el = id => doc.getElementById(id);
  await el('feed-more').handlers.click();
  const second = el('feed-grid').children[1];
  const original = second.children[0];
  original.closest = selector => selector === '.feed-entry' ? second : null;
  original.focus();
  el('main').scrollTop = 550;
  await el('feed-kind-dashboard').handlers.click();
  assert.equal(location.search, '?kind=dashboard&q=layout');
  assert.equal(el('main').scrollTop, 0);
  location.search = '?q=layout';
  await handlers.popstate();
  assert.equal(calls.at(-1).get('cursor'), 'page-2');
  assert.equal(el('feed-grid').children.length, 2);
  const restored = el('feed-grid').children[1].children[0];
  assert.notEqual(restored, original);
  assert.equal(doc.activeElement, restored);
  assert.equal(el('main').scrollTop, 550);
});

test('feed cover patterns are stable for a title and stay in 0-7', () => {
  assert.equal(coverPattern('Site'), coverPattern('Site'));
  assert.match(coverPattern('Site'), /^[0-7]$/);
  assert.notEqual(coverPattern('Site'), coverPattern('Other title completely different'));
});

import { thumbModel } from '../flybot_workspace/static/shell/thumb.mjs';
import { feedPreviewPath, attachFeedThumb } from '../flybot_workspace/static/discover/app.mjs';

test('thumbModel keeps only bounded text and validated shapes from the preview', () => {
  assert.equal(thumbModel(null), null);
  assert.equal(thumbModel({type: 'unknown'}), null);
  const doc = thumbModel({type: 'document', heading: '  标题  ', lines: ['a', '', 'b', 'c', 'd', 'e']});
  assert.deepEqual(doc, {type: 'document', heading: '标题', lines: ['a', 'b', 'c', 'd']});
  assert.equal(thumbModel({type: 'website', heading: '', lines: []}).empty, true);
  const slides = thumbModel({type: 'slides', title: '首页', bullets: ['1', '2', '3', '4'], count: 5});
  assert.equal(slides.bullets.length, 3);
  assert.equal(slides.count, 5);
});

test('feed covers load from the public work preview path, never for images or odd slugs', () => {
  assert.equal(feedPreviewPath({slug: 'public-note', kind: 'document'}), '/w/public-note/preview');
  assert.equal(feedPreviewPath({slug: 'photo-1', kind: 'image'}), '');
  assert.equal(feedPreviewPath({slug: 'music-1', kind: 'audio'}), '');
  assert.equal(feedPreviewPath({slug: 'movie-1', kind: 'video'}), '');
  assert.equal(feedPreviewPath({slug: '../x', kind: 'document'}), '');
  assert.equal(feedPreviewPath(null), '');
  assert.equal(attachFeedThumb({}, null, {type: 'document'}), false);
});


async function setupRemix({status = 201, workspaceStatus = 200, workspaces = [{id:'space-1',name:'我的工作区'}],
  signedIn = true, preview, submit, language = 'zh-CN'} = {}) {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.documentElement = {lang: language};
  const calls = [];
  const response = (status, body) => ({status, json:async()=>body});
  const fetcher = async (path, options) => {
    calls.push([path, options.method, options]);
    if (path === '/v1/auth/session') return response(signedIn ? 200 : 401, {user:{username:'alice'}});
    if (path === '/v1/workspaces?limit=100') return response(workspaceStatus, {items:workspaces});
    if (path === '/v1/discover/agents/weekly-digest/remix' && options.method === 'GET') {
      if (preview) return preview();
      return response(200, {template:{revision:'public-revision',name:'竞品周报助手',summary:'每周竞品摘要',instructions:'公开指令',
        quick_starts:['汇总本周的竞品变化。', '列出三个值得关注的信号。']}});
    }
    if (options.method === 'POST' && submit) return submit();
    if (options.method === 'POST') return response(status, status === 201
      ? {agent:{id:'agent-1',workspace_id:'space-1',name:'竞品周报助手'}}
      : {error:{code:'name_conflict',message:'工作区已有同名智能体，请换个名称。'}});
    return response(200, {items:[{name:'竞品周报助手',slug:'weekly-digest',summary:'每周竞品摘要'}]});
  };
  const navigation = [];
  await mount(doc, {fetcher, location:{search:'?tab=agents',assign:url=>navigation.push(url)}});
  const el = id => doc.getElementById(id);
  const use = classHits(el('discover-list'), 'catalog-use')[0];
  return {calls, el, use, navigation};
}

test('copy previews the released instructions and quick starts before creating a real agent', async () => {
  const {calls, el, use, navigation} = await setupRemix();
  await use.handlers.click();
  assert.equal(el('catalog-remix-prompt').textContent,'公开指令');
  assert.equal(el('catalog-remix-quick-starts').hidden,false);
  assert.equal(el('catalog-remix-quick-starts-heading').textContent,'将复制的快捷开场');
  assert.deepEqual(el('catalog-remix-quick-starts-list').children.map(item=>item.textContent),
    ['汇总本周的竞品变化。', '列出三个值得关注的信号。']);
  assert.equal(calls.filter(([,method])=>method==='POST').length,0);
  el('catalog-remix-workspace').value='space-1';
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  const [path,method,options]=calls.at(-1);
  assert.equal(path,'/v1/discover/agents/weekly-digest/remix');
  assert.equal(method,'POST');
  assert.deepEqual(JSON.parse(options.body),{revision:'public-revision',workspace_id:'space-1',name:'竞品周报助手'});
  assert.match(options.headers['Idempotency-Key'],/^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(navigation,['/chat#workspace=space-1&agent=agent-1']);
});

test('copy presents a duplicate name error in the preview dialog', async () => {
  const {el, use, navigation}=await setupRemix({status:409});
  await use.handlers.click();
  el('catalog-remix-workspace').value='space-1';
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  assert.match(el('catalog-remix-status').textContent,/已有同名智能体/);
  assert.deepEqual(navigation,[]);
});

test('copy retains the draft name through a slow preview and a stale release', async () => {
  const firstPreview = Promise.withResolvers();
  const template = {revision:'initial-revision',name:'原发布名称',summary:'每周竞品摘要',instructions:'旧指令',quick_starts:['旧开场']};
  let reads = 0;
  const {calls, el, use} = await setupRemix({
    preview: () => ++reads === 1 ? firstPreview.promise
      : commentResponse({template:{...template,revision:'new-revision',instructions:'新指令',quick_starts:['新开场']}}),
    submit: () => commentResponse({error:{code:'listing_changed'}},409),
  });
  const opening = use.handlers.click();
  el('catalog-remix-name').value = '我的名称';
  firstPreview.resolve(commentResponse({template}));
  await opening;
  assert.equal(el('catalog-remix-name').value,'我的名称');
  assert.equal(el('catalog-remix-quick-starts-list').children[0].textContent,'旧开场');
  el('catalog-remix-workspace').value = 'space-1';
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  assert.equal(el('catalog-remix-dialog').open,true);
  assert.equal(el('catalog-remix-refresh').hidden,false);
  assert.equal(el('catalog-remix-submit').disabled,true);
  assert.equal(el('catalog-remix-quick-starts').hidden,true);
  assert.deepEqual(el('catalog-remix-quick-starts-list').children,[]);
  await el('catalog-remix-refresh').handlers.click();
  assert.equal(el('catalog-remix-name').value,'我的名称');
  assert.equal(el('catalog-remix-prompt').textContent,'新指令');
  assert.equal(el('catalog-remix-quick-starts-list').children[0].textContent,'新开场');
  assert.equal(el('catalog-remix-submit').disabled,false);
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  const [first,last] = calls.filter(([,method])=>method==='POST').map(([, ,options])=>options);
  assert.notEqual(first.headers['Idempotency-Key'],last.headers['Idempotency-Key']);
  assert.equal(JSON.parse(last.body).revision,'new-revision');
});

test('copy localizes quick starts and clears them when the next release omits them', async () => {
  let reads = 0;
  const {el, use} = await setupRemix({language:'en-US', preview: () => commentResponse({template:{
    name:'Writer',summary:'A summary',instructions:'',revision:'release-' + reads,
    quick_starts: reads++ === 0 ? ['Plan the release <this week>'] : [],
  }})});
  await use.handlers.click();
  assert.equal(el('catalog-remix-quick-starts-heading').textContent,'Quick starts included in the copy');
  assert.equal(el('catalog-remix-quick-starts-list').children[0].textContent,'Plan the release <this week>');
  assert.equal(el('catalog-remix-description').textContent,
    'You can add your own instructions after creating the copy. Configure tools separately in the new copy.');
  el('catalog-remix-cancel').handlers.click();
  assert.deepEqual(el('catalog-remix-quick-starts-list').children,[]);
  await use.handlers.click();
  assert.equal(el('catalog-remix-quick-starts').hidden,true);
  assert.deepEqual(el('catalog-remix-quick-starts-list').children,[]);
});

test('copy reuses the request key after an ambiguous response for the same submission', async () => {
  let writes = 0;
  const {calls, el, use, navigation} = await setupRemix({
    submit: () => {
      if (++writes === 1) throw new Error('connection interrupted');
      return commentResponse({agent:{id:'agent-1',workspace_id:'space-1'}});
    },
  });
  await use.handlers.click();
  el('catalog-remix-workspace').value = 'space-1';
  const submit = () => el('catalog-remix-form').handlers.submit({preventDefault() {}});
  const pending = submit();
  assert.equal(el('catalog-remix-name').disabled,true);
  assert.equal(el('catalog-remix-cancel').disabled,true);
  await pending;
  assert.match(el('catalog-remix-status').textContent,/暂时无法确认/);
  assert.equal(el('catalog-remix-name').disabled,false);
  await submit();
  const keys = calls.filter(([,method])=>method==='POST').map(([, ,{headers}])=>headers['Idempotency-Key']);
  assert.equal(keys.length,2);
  assert.equal(keys[0],keys[1]);
  assert.deepEqual(navigation,['/chat#workspace=space-1&agent=agent-1']);
});

test('copy distinguishes a failed workspace read from an empty workspace list', async () => {
  for (const [status,text] of [[500,'无法读取工作区'],[200,'暂无可用工作区']]) {
    const {calls, el, use}=await setupRemix({workspaceStatus:status,workspaces:[]});
    await use.handlers.click();
    assert.ok(el('catalog-remix-status').textContent.includes(text));
    assert.equal(el('catalog-remix-submit').disabled,true);
    assert.equal(calls.some(([,method])=>method==='POST'),false);
  }
});

test('guest agent cards link to the public homepage without exposing private copy actions', async () => {
  const {el, calls, use}=await setupRemix({signedIn:false});
  assert.equal(use,undefined);
  assert.equal(classHits(el('discover-list'), 'catalog-chat')[0].href, '/a/weekly-digest');
  assert.equal(calls.some(([path, method])=>method!=='GET' || path.endsWith('/remix')), false);
});

test('a received private agent link waits for sign-in and uses the pinned personal copy review', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const id = 'otag_' + 'A'.repeat(26);
  const path = '/v1/agent-copy-grants/' + id + '/remix';
  const requests = [];
  const grant = {id,state:'active',agent_name:'私享助理',sender:{display_name:'团队伙伴'}};
  const init = mount(doc,{location:{search:'?tab=agents&share='+id},fetcher:async (route, options)=>{
    requests.push([route,options]);
    if (route === '/v1/auth/session') return session.promise;
    if (route === path && options.method === 'GET') return commentResponse({grant,template:{
      name:grant.agent_name,summary:'只在授权后出现的简介',instructions:'分享的指令',quick_starts:['看看讨论摘要'],revision:'pinned-release',
    }});
    if (route === path && options.method === 'POST') return commentResponse({error:{code:'agent_copy_revoked'}},410);
    return commentResponse({items:[],viewer_username:'alice'});
  }});
  await flush();
  assert.ok(!requests.some(([route])=>route===path));
  assert.ok(doc.getElementById('discover-login').href.includes('share%3D'+id));
  session.resolve(commentResponse({user:{id:'recipient',username:'alice'}}));
  await init;
  const el = id => doc.getElementById(id);
  assert.equal(el('catalog-remix-dialog').open,true);
  assert.equal(el('catalog-remix-share-sender').textContent,'来自 团队伙伴');
  assert.equal(el('catalog-remix-workspace-field').hidden,true);
  assert.equal(el('catalog-remix-personal-destination').hidden,false);
  assert.equal(el('catalog-remix-quick-starts-list').children[0].textContent,'看看讨论摘要');
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  const write = requests.find(([route,options])=>route===path&&options.method==='POST')[1];
  assert.deepEqual(JSON.parse(write.body),{revision:'pinned-release',name:grant.agent_name});
  assert.match(write.headers['Idempotency-Key'],/^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(el('catalog-remix-submit').disabled,true);
  assert.equal(el('catalog-remix-share-sender').hidden,true);
  assert.equal(el('catalog-remix-quick-starts').hidden,true);
  assert.equal(el('catalog-remix-summary').textContent,'');
  assert.equal(el('catalog-remix-status').textContent,'此分享已不可用。');
});

test('the status line is a polite live region for the create receipt', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="status" role="status" aria-live="polite">/);
  assert.equal(html.includes('catalog-reuse-note'), false);
});

test('document thumbnails preserve only bounded semantic text blocks', () => {
  const model = thumbModel({type:'document',heading:'Title',lines:['one'],blocks:[
    {type:'heading',text:'Title'}, {type:'list',text:'item'}, {type:'code',text:'x = 1'},
    {type:'script',text:'not a supported shape'}, {type:'quote',text:'quote'},
  ]});
  assert.deepEqual(model.blocks.map(block=>block.type), ['heading','list','code','quote']);
  assert.equal(model.blocks[1].text,'item');
});

// A work detail retains the originating feed and links out to the public work.
function classHits(node, wanted, hits = []) {
  if (String(node.className || '').split(/\s+/).includes(wanted)) hits.push(node);
  for (const child of node.children || []) classHits(child, wanted, hits);
  return hits;
}

function feedDocument() {
  return fakeDocument();
}

function detailFixture(extra = {}) {
  return Object.assign({
    slug: 'ci-fixture-doc',
    title: '[CI FIXTURE] Document',
    kind: 'document',
    kind_label: '文档',
    author: 'alice',
    updated: 1800000000,
    path: '/w/ci-fixture-doc',
  }, extra);
}

function detailFetcher(item, previewResult) {
  const requests = [];
  const fetcher = async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works')) {
      return {status: 200, json: async () => ({items: [item], cursor: null})};
    }
    if (path === '/w/' + item.slug + '?view=preview') return {status: 200, json: async () => item};
    if (path === '/w/' + item.slug + '/preview') return previewResult(path);
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

test('a public work copy with a lost response can recover across reload and withdrawal for its original viewer', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const work = detailFixture({remix_available:true});
  const workspace = 'a'.repeat(32);
  const artifactId = 'b'.repeat(32);
  const revision = 'c'.repeat(64);
  const copyTitle = 'Copy the reviewed version';
  const detailPath = '/v1/discover/works/' + work.slug;
  const remixPath = detailPath + '/remix';
  const storage = new Map();
  const writes = [];
  let withdrawn = false;
  async function reopen(viewer) {
    const doc = feedDocument();
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    await mount(doc, {
      location:{search:'?work=' + work.slug},
      window:{sessionStorage:{
        getItem:key => storage.get(key) ?? null,
        setItem:(key,value) => storage.set(key,value),
        removeItem:key => storage.delete(key),
      }},
      fetcher:async (path, options) => {
        if (path === '/v1/auth/session') return commentResponse({user:{id:viewer+'-id',username:viewer}});
        if (path === detailPath) return withdrawn ? commentResponse({},404) : commentResponse({work,viewer_username:viewer});
        if (path.startsWith('/v1/discover/works?')) return commentResponse({items:[],viewer_username:viewer});
        if (path.startsWith('/w/')) return commentResponse({},404);
        assert.equal(path,remixPath);
        if (options.method === 'GET') return commentResponse({
          template:{revision,title:work.title,kind:work.kind},viewer_username:viewer,
        });
        writes.push({viewer,body:JSON.parse(options.body),key:options.headers['Idempotency-Key']});
        return writes.length === 1 ? commentResponse({},503) : commentResponse({
          artifact:{id:artifactId,workspace_id:workspace,kind:work.kind},viewer_username:viewer,
        });
      },
    });
    return id => doc.getElementById(id);
  }
  const started = await reopen('reader');
  started('work-detail-remix').handlers.click();
  await flush();
  started('work-remix-name').value = copyTitle;
  await started('work-remix-form').handlers.submit({preventDefault() {}});
  assert.equal(writes.length,1);
  assert.equal(started('work-remix-submit').textContent,'确认副本');
  withdrawn = true;
  const other = await reopen('other-reader');
  assert.equal(other('work-detail-resume-remix').hidden,true);
  const reload = await reopen('reader');
  assert.equal(reload('work-detail-resume-remix').hidden,false);
  reload('work-detail-resume-remix').handlers.click();
  assert.equal(writes.length,1);
  assert.equal(reload('work-remix-name').disabled,true);
  assert.equal(reload('work-remix-name').value,copyTitle);
  await reload('work-remix-form').handlers.submit({preventDefault() {}});
  assert.equal(writes.length,2);
  assert.deepEqual(writes[0],writes[1]);
  assert.deepEqual(writes[1].body,{title:copyTitle,revision});
  assert.equal(reload('work-remix-open').href,`/space?workspace=${workspace}&artifact=${artifactId}`);
  assert.equal(storage.size,0);
  assert.equal(reload('work-detail-resume-remix').hidden,true);
});

test('public work bylines link to canonical creator directories from cards and details', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const creator = {handle: 'writer.home', name: '作者'};
  const {fetcher} = detailFetcher(detailFixture({creator}));
  await mount(doc, {fetcher, location: {search: ''}});

  const [entry] = doc.getElementById('feed-grid').children;
  assert.equal(classHits(entry.children[0], 'work-author-link').length, 0);
  const [author] = classHits(entry, 'work-author-link');
  assert.equal(author.textContent, creator.name);
  assert.equal(author.href, '/discover?creator=writer.home');

  await classHits(entry, 'feed-detail-toggle')[0].handlers.click();
  const [detailAuthor] = classHits(doc.getElementById('work-detail-meta'), 'work-author-link');
  assert.equal(detailAuthor.href, author.href);
});

test('the 3D detail exposes an explicit preview and direct download without prefetching the file', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture({
    kind: 'model3d', kind_label: '', path: '/social/w/ci-fixture-doc',
  }), () => {
    assert.fail('a 3D cover does not need a text preview');
  });
  await mount(doc, {fetcher, location: {search: '?kind=model3d'}});
  const grid = doc.getElementById('feed-grid');
  assert.equal(grid.children[0].children[0].children[1].textContent, '3D 作品');
  const [detail] = classHits(grid, 'feed-detail-toggle');
  await detail.handlers.click();
  const surface = doc.getElementById('work-detail-preview');
  const [preview] = classHits(surface, 'feed-model3d-preview-toggle');
  const [download] = classHits(surface, 'feed-model3d-download');
  assert.equal(preview.textContent, '预览 3D 模型');
  assert.equal(preview.disabled, false);
  assert.equal(download.href, '/social/w/ci-fixture-doc/file');
  assert.equal(download.download, '');
  assert.equal(requests.some(path => path.endsWith('/preview') || path.endsWith('/file')), false);
  await doc.getElementById('work-detail-back').handlers.click();
  assert.equal(preview.disabled, true);
});

test('3D card URLs fall back to the matching same-origin work route', () => {
  const doc = feedDocument();
  const item = detailFixture({kind: 'model3d'});
  for (const path of ['//other.example/w/ci-fixture-doc', '/social/w/other-asset', '/w/ci-fixture-doc?next=outside']) {
    assert.equal(renderFeedCard(doc, {...item, path}).href, '/w/ci-fixture-doc');
  }
});

test('a work card opens a shareable detail and returns to the originating feed and focus', async () => {
  const app = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture(), () => ({status: 200, json: async () => ({preview: {
    type: 'document', heading: '季报摘要', lines: ['第一行正文', '第二行正文', '第三行正文', '第四行不该出现'],
  }})}));
  const visits = [];
  const location = {search: '?q=季报', pathname: '/discover'};
  const history = {
    pushState(_state, _title, url) { visits.push(url); },
    replaceState(_state, _title, url) { visits.push(url); },
  };
  await app.mount(doc, {fetcher, location, history});

  const grid = doc.getElementById('feed-grid');
  const cell = grid.children[0];
  const toggles = classHits(cell, 'feed-detail-toggle');
  assert.equal(toggles.length, 1);
  const toggle = toggles[0];
  let focused = false;
  toggle.isConnected = true;
  toggle.focus = () => { focused = true; };
  assert.equal(toggle.textContent, app.FEED_DETAIL_MORE);
  assert.equal(toggle.attributes['aria-controls'], 'work-detail');
  assert.equal(doc.getElementById('work-detail').hidden, true);
  doc.getElementById('main').scrollTop = 184;

  await toggle.handlers.click();

  assert.deepEqual(visits, ['/discover?q=%E5%AD%A3%E6%8A%A5&work=ci-fixture-doc']);
  assert.equal(doc.getElementById('work-detail').hidden, false);
  assert.equal(doc.getElementById('feed-panel').hidden, true);
  assert.match(doc.getElementById('work-detail-meta').textContent, /文档 · alice · 2027/);
  assert.deepEqual(classHits(doc.getElementById('work-detail-preview'), 'feed-detail-lines')[0]
    .children.map(row => row.textContent), ['季报摘要', '第一行正文', '第二行正文', '第三行正文']);
  assert.equal(doc.getElementById('work-detail-open').href, '/w/ci-fixture-doc');
  assert.equal(doc.getElementById('work-detail-previous').disabled, true);

  await doc.getElementById('work-detail-back').handlers.click();
  assert.equal(visits[1], '/discover?q=%E5%AD%A3%E6%8A%A5');
  assert.equal(doc.getElementById('work-detail').hidden, true);
  assert.equal(doc.getElementById('feed-panel').hidden, false);
  assert.equal(doc.getElementById('main').scrollTop, 184);
  assert.equal(focused, true);
  assert.equal(grid.children[0], cell);
  assert.equal(requests.filter(path => path.startsWith('/v1/discover/works?')).length, 1);
});

test('work feed reload restores only saved cursor pages after confirming the viewer', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const search = '?kind=document&q=release';
  for (const viewer of ['original-owner', 'different-owner']) {
    const doc = feedDocument();
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    const session = Promise.withResolvers();
    const history = {state:{discoverWorkFeed:{
      key:JSON.stringify(['signed-in','original-owner',search]),pageCount:2,scroll:240,
    }}};
    const requests = [];
    const first = detailFixture({slug:'release-first'});
    const next = detailFixture({slug:'release-second'});
    const mounted = mount(doc, {history, location:{pathname:'/discover',search},fetcher(path) {
      if (path === '/v1/auth/session') return session.promise;
      const url = new URL(path, 'https://discover.test');
      assert.equal(url.pathname, '/v1/discover/works');
      assert.equal(url.searchParams.get('kind'), 'document');
      assert.equal(url.searchParams.get('q'), 'release');
      const cursor = url.searchParams.get('cursor');
      requests.push(cursor);
      return commentResponse({items:cursor ? [next] : [first],cursor:cursor ? '' : 'release-cursor',viewer_username:'alice'});
    }});
    await flush();
    assert.deepEqual(requests, [null]);
    assert.equal(doc.getElementById('feed-grid').children.length, 1);
    session.resolve(commentResponse({user:{id:viewer,username:'alice'}}));
    await mounted;
    const same = viewer === 'original-owner';
    assert.deepEqual(requests,same ? [null,'release-cursor'] : [null]);
    assert.equal(doc.getElementById('feed-grid').children.length,same ? 2 : 1);
    if (same) assert.equal(doc.getElementById('main').scrollTop,240);
  }
});

test('work navigation keeps the signed-in feed context and sharing copies the canonical public URL', async () => {
  const {mount, workDetailFromSearch} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const first = detailFixture({slug: 'first-work'});
  const second = detailFixture({slug: 'second-work', title: '首篇之后', path: '/social/w/second-work'});
  const requests = [];
  const visits = [];
  const copies = [];
  const location = {
    search: '?feed=following&kind=slides&q=设计&work=first-work',
    origin: 'https://management.test',
  };
  const history = {replaceState(_state, _title, url) { visits.push(url); }};
  const window = {navigator: {clipboard: {writeText(value) { copies.push(value); }}}};
  const fetcher = async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user: {id: 'viewer', username: 'viewer'}});
    if (path.startsWith('/v1/discover/me/works?')) return commentResponse({items: [first]});
    if (path.startsWith('/v1/discover/works/first-work?')) return commentResponse({work: first, next: second});
    if (path.startsWith('/v1/discover/works/second-work?')) return commentResponse({work: second, previous: first});
    if (path.endsWith('/preview')) return commentResponse({preview: null});
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location, history, window});
  assert.equal(doc.getElementById('work-detail-next').disabled, false);
  assert.equal(doc.getElementById('work-detail-previous').disabled, true);
  await doc.getElementById('work-detail-next').handlers.click();
  const context = new URL(requests.find(path => path.startsWith('/v1/discover/works/second-work?')),
    'https://management.test').searchParams;
  assert.deepEqual(Object.fromEntries(context), {kind: 'slides', q: '设计', tab: 'following'});
  assert.equal(visits[0], '/discover?feed=following&kind=slides&q=%E8%AE%BE%E8%AE%A1&work=second-work');
  assert.equal(doc.getElementById('work-detail-title').textContent, '首篇之后');
  assert.equal(doc.getElementById('work-detail-open').href, '/social/w/second-work');
  assert.equal(doc.getElementById('work-detail-next').disabled, true);
  assert.equal(doc.getElementById('work-detail-previous').disabled, false);
  assert.equal(workDetailFromSearch('?work=../../secret&share=1'), null);
  assert.equal(workDetailFromSearch('?work=first-work&work=second-work'), null);
  doc.getElementById('work-detail-share').handlers.click();
  assert.equal(doc.getElementById('work-share-dialog').open, true);
  await doc.getElementById('work-share-copy').handlers.click();
  assert.deepEqual(copies, ['https://management.test/w/second-work']);
  assert.equal(doc.getElementById('work-share-status').textContent, '已复制链接。');
});

test('a signed-in Discover work can share its canonical link to one selected chat and retry a lost receipt', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const work = detailFixture();
  const workspace = 'a'.repeat(32);
  const activeChat = '/v1/workspaces/' + workspace + '/social/conversations';
  const writes = [];
  const requests = [];
  const url = 'https://discover.test/w/' + work.slug;
  await mount(doc, {location:{origin:'https://discover.test', search:'?work=' + work.slug}, fetcher:async (path, options) => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user:{id:'owner',username:'alice'}});
    if (path.startsWith('/v1/discover/works?')) return commentResponse({items:[],viewer_username:'alice'});
    if (path === '/v1/discover/works/' + work.slug) return commentResponse({work,viewer_username:'alice'});
    if (path.startsWith('/w/')) return commentResponse({preview:null},404);
    if (path === '/v1/workspaces?limit=100') return commentResponse({items:[{id:workspace,name:'个人空间'}]});
    if (path === activeChat + '?limit=100') return commentResponse({items:[
      {id:'example-group',kind:'group',title:'项目讨论'},
      {id:'private-dm',kind:'dm',title:'朋友',direct:{open:true}},
      {id:'closed-dm',kind:'dm',title:'关闭的私聊',direct:{open:false}},
      {id:'public-agent',public_agent:{slug:'agent'}},
    ]});
    if (path === activeChat + '/example-group/messages') {
      writes.push({method:options.method,body:JSON.parse(options.body),key:options.headers['Idempotency-Key']});
      if (writes.length === 1) throw new Error('Lost receipt');
      return commentResponse({message:{workspace_id:workspace,conversation_id:'example-group',id:'receipt-id'}},201);
    }
    throw new Error(path);
  }});
  const share = id => doc.getElementById('work-chat-share-' + id);
  assert.equal(requests.includes('/v1/workspaces?limit=100'), false);
  await doc.getElementById('work-detail-share').handlers.click();
  assert.equal(share('panel').hidden, false);
  assert.equal(requests.includes('/v1/workspaces?limit=100'), false);
  share('panel').open = true;
  await share('panel').handlers.toggle();
  assert.deepEqual(share('conversation').children.map(option => option.value), ['', 'example-group', 'private-dm']);
  assert.equal(share('send').disabled, true);
  share('conversation').value = 'example-group';
  share('conversation').handlers.change();
  assert.equal(share('send').disabled, false);
  assert.equal(writes.length, 0);
  await share('form').handlers.submit({preventDefault(){}});
  assert.match(share('status').textContent, /未能确认发送结果/);
  await share('form').handlers.submit({preventDefault(){}});
  assert.equal(writes.length, 2);
  assert.match(writes[0].key, /^work-share-/);
  assert.deepEqual(writes, [writes[0],writes[0]]);
  assert.deepEqual(writes[0].body,{body:url});
  assert.equal(writes[0].method,'POST');
  assert.equal(share('receipt').href, '/chat#workspace=' + workspace + '&social=example-group&message=receipt-id');
  assert.equal(share('send').disabled, true);
});

test('guest Discover sharing keeps the public link and leaves the conversation picker closed', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const work = detailFixture();
  const requests = [];
  await mount(doc, {location:{origin:'https://discover.test', search:'?work=' + work.slug}, fetcher:async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({},401);
    if (path.startsWith('/v1/discover/works?')) return commentResponse({items:[]});
    if (path.startsWith('/w/')) return commentResponse({...work,preview:'可见的公开内容'});
    throw new Error(path);
  }});
  doc.getElementById('work-detail-share').handlers.click();
  assert.equal(doc.getElementById('work-share-url').value, 'https://discover.test/w/' + work.slug);
  assert.equal(doc.getElementById('work-chat-share-panel').hidden, true);
  assert.ok(!requests.some(path => path.startsWith('/v1/workspaces')));
});

test('the native direct excerpt paints before auth and is retained through a mismatched viewer reply', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const scoped = Promise.withResolvers();
  const work = detailFixture({creator: {handle: 'writer.home', name: '作者'}});
  const next = detailFixture({slug: 'next-work'});
  const publicPath = '/w/' + work.slug + '?view=preview&nav=latest';
  const privatePath = '/v1/discover/works/' + work.slug;
  const requests = [];
  const loaded = mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async (path, options) => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username: 'alice', items: []});
    if (path === publicPath) {
      assert.equal(options.headers.Accept, 'application/json');
      return commentResponse({...work, preview: '正文预览'});
    }
    if (path === privatePath) return requests.filter(url => url === privatePath).length < 2
      ? commentResponse({viewer_username: 'bobby', work: {...work, liked: true, collected: true, following: true}, next})
      : scoped.promise;
    throw new Error(path);
  }});
  const el = id => doc.getElementById('work-detail-' + id);
  await flush();
  assert.deepEqual(requests, ['/v1/auth/session', publicPath, privatePath, '/v1/discover/works?limit=12']);
  const [preview] = classHits(el('preview'), 'feed-detail-lines');
  assert.equal(preview.children[0].textContent, '正文预览');
  assert.equal(el('title').textContent, work.title);
  assert.equal(el('open').href, '/w/' + work.slug);
  assert.equal(el('actions').hidden, false);
  for (const action of ['comments', 'like', 'collect', 'follow', 'library']) assert.equal(el(action).hidden, true);
  assert.equal(el('next').disabled, true);
  await el('comments').handlers.click();

  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await flush();
  assert.equal(requests.filter(url => url === privatePath).length, 2);
  assert.equal(el('like').hidden, true);
  assert.equal(el('library').hidden, true);
  assert.equal(el('next').disabled, true);
  scoped.resolve(commentResponse({viewer_username: 'alice', work: {...work, liked: false, collected: true, following: true}, next}));
  await loaded;
  assert.equal(classHits(el('preview'), 'feed-detail-lines')[0], preview);
  assert.equal(el('comments').hidden, false);
  assert.equal(el('like').hidden, false);
  assert.equal(el('like').attributes['aria-pressed'], 'false');
  assert.equal(el('library').hidden, false);
  assert.equal(el('library-saved').href, '/discover?feed=collected&sort=collected');
  assert.equal(el('library-author').href, '/discover?feed=following&creator=writer.home');
  assert.equal(el('next').disabled, false);
});

test('a native filtered detail reuses its verified viewer response without waiting for public preview', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const publicWork = Promise.withResolvers();
  const work = detailFixture();
  const next = detailFixture({slug: 'filtered-next'});
  const requests = [];
  const privatePath = '/v1/discover/works/' + work.slug + '?kind=document&q=release&tab=following';
  const loaded = mount(doc, {location: {search: '?feed=following&kind=document&q=release&work=' + work.slug}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path.startsWith('/v1/discover/me/works?')) return commentResponse({viewer_username: 'alice', items: []});
    if (path.startsWith('/w/' + work.slug + '?')) return publicWork.promise;
    if (path === '/w/' + work.slug + '/preview') return commentResponse({preview: 'Signed preview'});
    if (path === privatePath) return commentResponse({viewer_username: 'alice', work: {...work, liked: true}, next});
    throw new Error(path);
  }});
  const el = id => doc.getElementById('work-detail-' + id);
  await flush();
  assert.equal(requests.filter(url => url === privatePath).length, 1);
  assert.notEqual(el('title').textContent, work.title);
  assert.equal(el('like').hidden, true);
  assert.equal(el('next').disabled, true);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;

  assert.equal(requests.filter(url => url === privatePath).length, 1);
  assert.equal(el('title').textContent, work.title);
  assert.equal(el('like').hidden, false);
  assert.equal(el('like').attributes['aria-pressed'], 'true');
  assert.equal(el('next').disabled, false);
  publicWork.resolve(commentResponse({...work, title: 'Late public title', preview: 'Late excerpt'}));
  await flush();
  assert.equal(el('title').textContent, work.title);
  assert.equal(classHits(el('preview'), 'feed-detail-lines')[0].children[0].textContent, 'Signed preview');
});

test('leaving a native deep link aborts its pending work detail reads', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const details = Promise.withResolvers();
  const work = detailFixture();
  const signals = [];
  const loaded = mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async (path, options) => {
    if (path === '/v1/auth/session') return session.promise;
    if (path.startsWith('/v1/discover/works?')) return commentResponse({viewer_username: 'alice', items: []});
    if (path.startsWith('/w/') || path === '/v1/discover/works/' + work.slug) {
      signals.push(options.signal);
      return details.promise;
    }
    throw new Error(path);
  }});
  await flush();
  assert.equal(signals.length, 2);
  doc.getElementById('work-detail-back').handlers.click();
  assert.ok(signals.every(signal => signal.aborted));
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  details.resolve(commentResponse({viewer_username: 'alice', work}));
  await loaded;
  assert.equal(doc.getElementById('work-detail').hidden, true);
  assert.equal(signals.length, 2);
});

test('a guest detail pages only its filtered feed and a late page cannot reopen the detail after Back', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const first = detailFixture({slug:'guest-first', title:'前一件公开作品'});
  const last = detailFixture({slug:'guest-edge', title:'首尾公开作品'});
  const later = detailFixture({slug:'guest-later', title:'下一页公开作品'});
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const paths = [];
  const history = {replaceState(_state, _unused, path) { paths.push(path); }};
  const detailRequests = [];
  const publicPath = '/w/guest-edge?kind=document&q=%E5%85%AC%E5%BC%80&view=preview&nav=latest';
  await mount(doc, {history, location:{search:'?kind=document&q=公开&work=guest-edge'}, fetcher: async path => {
    if (path === '/v1/auth/session') return commentResponse({},401);
    if (path.startsWith('/v1/discover/works?')) {
      const args = new URL(path,'https://discover.test').searchParams;
      assert.equal(args.get('kind'),'document');
      assert.equal(args.get('q'),'公开');
      if (args.has('cursor')) {
        assert.equal(args.get('cursor'),'guest-next-cursor');
        started.resolve();
        return pending.promise;
      }
      return commentResponse({items:[first,last],cursor:'guest-next-cursor'});
    }
    if (path.startsWith('/w/')) {
      detailRequests.push(path);
      if (path === publicPath) return commentResponse({...last,preview:'公开详情正文'});
    }
    assert.fail('Unexpected request ' + path);
  }});
  const button = name => doc.getElementById('work-detail-' + name);
  assert.equal(button('previous').disabled,false);
  assert.equal(button('next').disabled,false);
  const advancing = button('next').handlers.click();
  await started.promise;
  assert.equal(button('next').disabled,true);
  assert.equal(button('next').attributes['aria-busy'],'true');
  button('back').handlers.click();
  pending.resolve(commentResponse({items:[later],cursor:null}));
  await advancing;
  assert.equal(doc.getElementById('work-detail').hidden,true);
  assert.deepEqual(paths,['/discover?kind=document&q=%E5%85%AC%E5%BC%80']);
  assert.deepEqual(detailRequests,[publicPath]);
  assert.deepEqual(doc.getElementById('feed-grid').children.map(child=>child.dataset.slug),[first.slug,last.slug,later.slug]);
});

test('a failed public detail cannot block the native scoped work or its preview', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const work = detailFixture();
  const publicPath = '/w/' + work.slug;
  const requests = [];
  await mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user: {id: 'owner', username: 'alice'}});
    if (path === publicPath + '?view=preview&nav=latest') return commentResponse({}, 503);
    if (path === publicPath + '/preview') return commentResponse({preview: 'Normal scoped preview'});
    if (path === '/v1/discover/works/' + work.slug) return commentResponse({viewer_username: 'alice', work});
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username: 'alice', items: []});
    throw new Error(path);
  }});
  const preview = doc.getElementById('work-detail-preview');
  assert.equal(classHits(preview, 'feed-detail-lines')[0].children[0].textContent, 'Normal scoped preview');
  assert.equal(doc.getElementById('work-detail-like').hidden, false);
  assert.equal(requests.filter(path => path === publicPath + '/preview').length, 1);
});

test('a signed Discover card starts a fresh public preview while confirming viewer actions', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const responses = [Promise.withResolvers(), Promise.withResolvers()];
  const work = detailFixture({liked:true});
  const publicPath = '/w/' + work.slug + '?view=preview';
  const scopedPath = '/v1/discover/works/' + work.slug;
  const requests = [];
  let scoped = 0;
  await mount(doc, {location:{search:''}, fetcher:async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user:{id:'reader-id',username:'alice'}});
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username:'alice',items:[work]});
    if (path === publicPath) return commentResponse({...work,preview:'Fresh published excerpt'});
    if (path === '/w/' + work.slug + '/preview') return commentResponse({preview:'Cached cover excerpt'});
    if (path === scopedPath) return responses[scoped++].promise;
    throw new Error(path);
  }});
  const el = id => doc.getElementById('work-detail-' + id);
  const [card] = classHits(doc.getElementById('feed-grid'), 'feed-detail-toggle');
  const open = card.handlers.click();
  await flush();
  assert.deepEqual(requests.filter(path => path === publicPath || path === scopedPath), [publicPath,scopedPath]);
  const [excerpt] = classHits(el('preview'), 'feed-detail-lines');
  assert.equal(excerpt.children[0].textContent, 'Fresh published excerpt');
  for (const action of ['comments','like','collect','follow']) assert.equal(el(action).hidden, true);
  assert.equal(el('next').disabled, true);
  responses[0].resolve(commentResponse({viewer_username:'alice',work}));
  await open;
  assert.equal(classHits(el('preview'), 'feed-detail-lines')[0], excerpt);
  assert.equal(el('comments').hidden, false);
  assert.equal(el('like').attributes['aria-pressed'], 'true');

  await el('back').handlers.click();
  const reopen = card.handlers.click();
  await flush();
  assert.equal(classHits(el('preview'), 'feed-detail-lines').length, 1);
  responses[1].resolve(commentResponse({},404));
  await reopen;
  assert.equal(classHits(el('preview'), 'feed-detail-lines').length, 0);
  assert.equal(el('actions').hidden, true);
  assert.match(el('status').textContent, /下架或不可访问/);
});

test('an authoritative withdrawal clears the optimistic public preview and actions', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const work = detailFixture();
  const loaded = mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async path => {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/w/' + work.slug + '?view=preview&nav=latest') return commentResponse({...work, preview: 'Was public'});
    if (path === '/v1/discover/works/' + work.slug) return commentResponse({}, 404);
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username: 'alice', items: []});
    throw new Error(path);
  }});
  const el = id => doc.getElementById('work-detail-' + id);
  await flush();
  assert.equal(el('actions').hidden, false);
  assert.equal(classHits(el('preview'), 'feed-detail-lines').length, 1);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;

  assert.equal(classHits(el('preview'), 'feed-detail-lines').length, 0);
  assert.equal(el('actions').hidden, true);
  assert.equal(el('retry').hidden, true);
  assert.match(el('status').textContent, /下架或不可访问/);
});

test('an older detail response cannot overwrite a newer work', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const first = detailFixture({slug: 'slow-work'});
  const second = detailFixture({slug: 'new-work', title: '当前作品'});
  let finish;
  const fetcher = async path => {
    if (path === '/v1/auth/session') return commentResponse({}, 401);
    if (path.startsWith('/v1/discover/works?')) return commentResponse({items: [first, second]});
    if (path === '/w/slow-work?view=preview') return new Promise(resolve => { finish = resolve; });
    if (path === '/w/new-work?view=preview') return commentResponse(second);
    if (path.endsWith('/preview')) return commentResponse({preview: null});
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const [slow, fast] = classHits(doc.getElementById('feed-grid'), 'feed-detail-toggle');
  const opening = slow.handlers.click();
  doc.getElementById('work-detail-back').handlers.click();
  await fast.handlers.click();
  finish(commentResponse(first));
  await opening;
  assert.equal(doc.getElementById('work-detail-title').textContent, '当前作品');
});

test('a detail whose preview cannot be read says so instead of faking an empty summary', async () => {
  const app = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher} = detailFetcher(detailFixture(), () => ({status: 500, json: async () => ({})}));
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  await classHits(cell, 'feed-detail-toggle')[0].handlers.click();
  assert.equal(doc.getElementById('work-detail-preview').textContent, app.FEED_DETAIL_UNREADABLE);
  assert.equal(doc.getElementById('work-detail-open').href, '/w/ci-fixture-doc');
});

test('an image work uses the public media file without reading a text preview', async () => {
  const app = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture({kind: 'image', kind_label: '图片'}), () => {
    assert.fail('an image work must not request a text preview');
  });
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  await classHits(cell, 'feed-detail-toggle')[0].handlers.click();
  const [image] = classHits(doc.getElementById('work-detail-preview'), 'work-detail-image');
  assert.equal(image.src, '/w/ci-fixture-doc/file');
  assert.equal(doc.getElementById('work-detail-download').href, image.src);
  assert.equal(requests.some(path => path.endsWith('/preview')), false);
});

test('audio and video have no feed player but offer a real controllable player and original download in detail', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  for (const [kind, mime] of [['audio', 'audio/wav'], ['video', 'video/webm']]) {
    const doc = feedDocument();
    const work = detailFixture({kind, kind_label: '', path: '/social/w/ci-fixture-doc',
      file_available: true, file_mime: mime, file_bytes: 4096});
    const {fetcher, requests} = detailFetcher(work, () => assert.fail('media needs no text preview'));
    await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
    const grid = doc.getElementById('feed-grid');
    const [cover] = classHits(grid, 'work-cover');
    assert.equal(cover.dataset.kind, kind);
    assert.equal(cover.children.length, 0);
    assert.equal(requests.some(path => path.endsWith('/file') || path.endsWith('/preview')), false);
    await classHits(grid, 'feed-detail-toggle')[0].handlers.click();
    const surface = doc.getElementById('work-detail-preview');
    const [player] = classHits(surface, 'work-detail-' + kind);
    const download = doc.getElementById('work-detail-download');
    assert.equal(player.tagName, kind);
    assert.equal(player.src, '/social/w/ci-fixture-doc/file');
    assert.equal(player.controls, true);
    assert.equal(player.preload, 'none');
    assert.notEqual(player.autoplay, true);
    if (kind === 'video') assert.equal(player.playsInline, true);
    assert.equal(download.href, player.src);
    assert.equal(download.download, '');
    assert.match(download.textContent, /下载原文件 · 4 KB/);
    player.handlers.error();
    assert.equal(player.hidden, true);
    assert.match(classHits(surface, 'work-media-status')[0].textContent, /可以尝试下载原文件/);
    assert.equal(download.hidden, false);
    let paused = false, unloaded = false;
    player.pause = () => { paused = true; };
    player.load = () => { unloaded = true; };
    doc.getElementById('work-detail-back').handlers.click();
    assert.equal(paused && unloaded, true);
    assert.equal(surface.children.length, 0);
  }
});

test('known missing video visibly reports unavailable without a player or download', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture({kind: 'video', file_available: false}),
    () => assert.fail('known missing video needs no text or binary read'));
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  await classHits(doc.getElementById('feed-grid'), 'feed-detail-toggle')[0].handlers.click();
  const preview = doc.getElementById('work-detail-preview');
  assert.equal(classHits(preview, 'work-detail-video').length, 0);
  assert.match(classHits(preview, 'work-media-status')[0].textContent, /暂无可用的视频文件/);
  assert.equal(doc.getElementById('work-detail-download').hidden, true);
  assert.equal(requests.some(path => path.endsWith('/file') || path.endsWith('/preview')), false);
});

test('a native plain-text snapshot appears verbatim and is bounded in the work detail', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const preview = '<img src="not-public">\n可公开阅读的示例内容。\n' + '长'.repeat(500) + '\n第四行\n第五行';
  const {fetcher} = detailFetcher(detailFixture(), () => commentResponse({preview}));
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  await classHits(doc.getElementById('feed-grid'), 'feed-detail-toggle')[0].handlers.click();
  const [list] = classHits(doc.getElementById('work-detail-preview'), 'feed-detail-lines');
  assert.deepEqual(list.children.map(row => row.textContent),
    ['<img src="not-public">', '可公开阅读的示例内容。', '长'.repeat(90), '第四行']);
  assert.ok(list.children.every(row => row.childElementCount === 0));
});

test('a work with an empty preview says it has no content yet', async () => {
  const app = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher} = detailFetcher(detailFixture(), () => ({status: 200, json: async () => ({preview: {
    type: 'document', heading: '', lines: [],
  }})}));
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  await classHits(cell, 'feed-detail-toggle')[0].handlers.click();
  assert.equal(doc.getElementById('work-detail-preview').textContent, app.FEED_DETAIL_EMPTY);
});

const commentResponse = (body, status = 200) => ({status, json: async () => body});

test('guest comments are loaded on demand and render literal text with a safe sign-in link', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const work = detailFixture({comment_count: 1});
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return commentResponse({}, 401);
    if (path === '/v1/discover/works?limit=12') return commentResponse({items: [work]});
    if (path === '/w/ci-fixture-doc/comments?limit=12') return commentResponse({items: [{
      id: 'fixture-comment', body: '<script>公开文本</script>', author: {name: 'Alice'},
      created_at: 1_800_000_000_000,
    }], comment_count: 1});
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  assert.equal(requests.some(([path]) => path.includes('/comments')), false);
  const [toggle] = classHits(doc.getElementById('feed-grid'), 'feed-comments-toggle');
  assert.equal(toggle.textContent, '评论 · 1');
  await toggle.handlers.click();
  const [row] = classHits(doc.getElementById('feed-comments-list'), 'feed-comment-body');
  assert.equal(row.textContent, '<script>公开文本</script>');
  assert.equal(doc.getElementById('feed-comments-form').hidden, true);
  assert.equal(doc.getElementById('feed-comments-login').href, '/login#discover=work%3Dci-fixture-doc%26comments%3D1');
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
});

test('posting a comment clears the editor and exposes pending text before the reply, then retries with the same key', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const work = detailFixture({comment_count: 0});
  const writes = [];
  let finishFirst;
  const fetcher = (path, options) => {
    if (path === '/v1/auth/session') return Promise.resolve(commentResponse({user: {id: 'a', username: 'alice'}}));
    if (path.startsWith('/v1/discover/me/works?')) return Promise.resolve(commentResponse({items: [work]}));
    if (path.endsWith('/comments?limit=12')) return Promise.resolve(commentResponse({items: [], comment_count: 0}));
    if (path === '/v1/discover/works/ci-fixture-doc/comments' && options.method === 'POST') {
      writes.push({key: options.headers['Idempotency-Key'], body: JSON.parse(options.body)});
      if (writes.length === 1) return new Promise(resolve => { finishFirst = resolve; });
      return Promise.resolve(commentResponse({comment: {
        id: 'posted', body: '第一行\n第二行', author: {name: 'Alice'}, parent_id: null,
      }, comment_count: 1}));
    }
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const [toggle] = classHits(doc.getElementById('feed-grid'), 'feed-comments-toggle');
  await toggle.handlers.click();
  const form = doc.getElementById('feed-comments-form');
  const input = doc.getElementById('feed-comments-input');
  const list = doc.getElementById('feed-comments-list');
  input.value = '第一行\n第二行';
  input.handlers.input();
  const posting = form.handlers.submit({preventDefault() {}});
  assert.equal(input.value, '');
  assert.equal(doc.getElementById('feed-comments-submit').disabled, true);
  assert.equal(classHits(list, 'is-pending').length, 1);
  assert.equal(classHits(list, 'feed-comment-body')[0].textContent, '第一行\n第二行');
  finishFirst(commentResponse({}, 503));
  await posting;
  assert.equal(input.value, '第一行\n第二行');
  assert.match(doc.getElementById('feed-comments-status').textContent, /草稿已保留/);
  assert.equal(classHits(list, 'is-pending').length, 0);

  await form.handlers.submit({preventDefault() {}});
  assert.equal(writes.length, 2);
  assert.match(writes[0].key, /^comment-/);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(input.value, '');
  assert.equal(classHits(list, 'feed-comment-body').length, 1);
  assert.equal(toggle.textContent, '评论 · 1');
});

test('an unconfirmed comment survives a later successful send and can be retried after reload only by its original account', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const work = detailFixture({comment_count: 0});
  const saved = new Map();
  const storage = {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)};
  const writes = [];
  const draft = '尚未确认的评论';
  const next = '之后发送成功的评论';
  async function openComments(id) {
    const doc = feedDocument();
    doc.defaultView = {sessionStorage: storage};
    await mount(doc, {location: {search: ''}, async fetcher(path, options) {
      if (path === '/v1/auth/session') return commentResponse({user: {id, username: 'same-display-name'}});
      if (path.startsWith('/v1/discover/me/works?')) return commentResponse({items: [work]});
      if (path.endsWith('/comments?limit=12')) return commentResponse({items: [], comment_count: 0});
      if (path.endsWith('/comments') && options.method === 'POST') {
        const {body} = JSON.parse(options.body);
        writes.push({id, key: options.headers['Idempotency-Key'], body});
        if (writes.length === 1) return commentResponse({}, 503);
        return commentResponse({comment: {id: 'posted-' + body, body, parent_id: null}, comment_count: 2});
      }
      throw new Error('Unexpected ' + path);
    }});
    const [toggle] = classHits(doc.getElementById('feed-grid'), 'feed-comments-toggle');
    await toggle.handlers.click();
    return part => doc.getElementById('feed-comments-' + part);
  }

  const first = await openComments('account-one');
  first('input').value = draft;
  first('input').handlers.input();
  await first('form').handlers.submit({preventDefault() {}});
  first('input').value = next;
  first('input').handlers.input();
  await first('form').handlers.submit({preventDefault() {}});
  assert.equal(writes[1].body, next);
  assert.notEqual(writes[0].key, writes[1].key);
  const otherAccount = await openComments('account-two');
  assert.equal(otherAccount('input').value, '');
  assert.equal(otherAccount('retry-post').hidden, true);

  const recovered = await openComments('account-one');
  assert.equal(recovered('input').value, draft);
  assert.match(recovered('status').textContent, /未确认/);
  assert.equal(recovered('submit').textContent, '重试发送');
  assert.equal(writes.length, 2);
  await recovered('form').handlers.submit({preventDefault() {}});
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[2], writes[0]);
  assert.equal(saved.size, 0);
});

test('comment permalinks open a published work missing from the feed without waiting for the feed', async () => {
  const {mount, workDetailFromSearch} = await import('../flybot_workspace/static/discover/app.mjs');
  assert.equal(workDetailFromSearch('?work=../private&comments=1'), null);
  const doc = feedDocument();
  const requests = [];
  let finishFeed;
  const fetcher = (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return Promise.resolve(commentResponse({user: {id: 'a', username: 'alice'}}));
    if (path.startsWith('/v1/discover/me/works?')) return new Promise(resolve => { finishFeed = resolve; });
    if (path === '/v1/discover/works/older-work') return Promise.resolve(commentResponse({
      work: detailFixture({slug: 'older-work', title: '早期作品', comment_count: 0}),
    }));
    if (path === '/v1/discover/works/older-work/comments?limit=12') {
      return Promise.resolve(commentResponse({items: [], comment_count: 0}));
    }
    throw new Error('Unexpected ' + path);
  };
  const mounted = mount(doc, {fetcher, location: {search: '?work=older-work&comments=1'}});
  await flush();
  assert.equal(doc.getElementById('feed-comments-dialog').open, true);
  assert.equal(doc.getElementById('feed-comments-work').textContent, '早期作品');
  assert.equal(doc.getElementById('feed-comments-empty').hidden, false);
  assert.ok(requests.includes('/v1/discover/works/older-work/comments?limit=12'));
  finishFeed(commentResponse({items: []}));
  await mounted;
  assert.equal(doc.getElementById('feed-comments-dialog').open, true);
});

test('published interactive websites load a same-origin isolated frame only inside the work detail', async () => {
  const {mount} = await import('../flybot_workspace/static/discover/app.mjs');
  const doc = feedDocument();
  const item = detailFixture({
    kind: 'website', title: '互动作品', site_available: true, path: '/social/w/ci-fixture-doc',
  });
  const {fetcher} = detailFetcher(item, () => commentResponse({preview: '公开简介'}));
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const grid = doc.getElementById('feed-grid');
  const reader = doc.getElementById('work-detail-preview');
  assert.equal(classHits(grid, 'work-detail-site').length, 0);
  assert.equal(reader.children.length, 0);
  await classHits(grid, 'feed-detail-toggle')[0].handlers.click();
  const [frame] = classHits(reader, 'work-detail-site');
  assert.equal(frame.src, '/w/ci-fixture-doc/site');
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
  assert.match(frame.title, /互动作品/);
  doc.getElementById('work-detail-back').handlers.click();
  assert.equal(classHits(reader, 'work-detail-site').length, 0);
});
