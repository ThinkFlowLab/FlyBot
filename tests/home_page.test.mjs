import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationTitle, formatWhen, kindLabel, meetingMeta, mount } from '../flybot_workspace/static/home/app.mjs';
import { confirmSignupSession, pendingSignupSession, personalDraftScope, readChatDrafts, rememberColdDraftHandoff, rememberSignupSession, signupDraftScope, takeColdDraftHandoff, takeSignupSession, waitForRuntime, workspaceLoginHash, workspaceLoginTarget, writeChatDrafts } from '../flybot_workspace/static/home/runtime-readiness.mjs';
import { mountRuntimeStarting } from '../flybot_workspace/static/home/runtime-starting.mjs';
import { discoverIntentFromHash, discoverLoginHref } from '../flybot_workspace/static/shell/discover-link.mjs';
import { spaceHref } from '../flybot_workspace/static/shell/thumb.mjs';

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

test('runtime readiness retries temporary failures and stops at confirmed states', async () => {
  const replies = [null, {status: 200, body: {state: 'starting'}}, {status: 200, body: {state: 'ready'}}];
  const waits = [];
  const state = await waitForRuntime(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error('network interruption');
    return reply;
  }, {delay: async ms => waits.push(ms)});
  assert.equal(state, 'ready');
  assert.deepEqual(waits, [300, 300]);
  assert.equal(await waitForRuntime(async () => ({status: 401})), 'signed-out');
  assert.equal(await waitForRuntime(async () => ({status: 200, body: {state: 'starting'}}), {attempts: 1}), 'timeout');
});

test('runtime polling stays responsive during cold starts and keeps its original time bound', async () => {
  const waits = [];
  const result = await waitForRuntime(async () => ({status: 200, body: {state: 'starting'}}), {
    delay: async ms => waits.push(ms),
  });
  assert.equal(result, 'timeout');
  assert.deepEqual(waits.slice(0, 10), new Array(10).fill(300));
  assert.deepEqual(waits.slice(10, 37), new Array(27).fill(1000));
  assert.deepEqual(waits.slice(37), new Array(35).fill(3000));
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 135_000);
});

test('an expected signup needs a valid account ID before a ready state can be trusted', async () => {
  let calls = 0;
  const state = await waitForRuntime(async () => {
    calls += 1;
    return {status: 200, body: {state: 'ready', user_id: calls === 1 ? null : alice}};
  }, {expectedUser: alice, delay: async () => {}});
  assert.equal(calls, 2);
  assert.equal(state, 'ready');
  const {view} = homeFixture();
  rememberSignupSession(view, alice);
  assert.equal(confirmSignupSession(view, {status: 503, body: {}}), false);
  assert.equal(confirmSignupSession(view, {status: 200, body: {user: {id: 'bad-data'}}}), false);
  assert.equal(pendingSignupSession(view), alice);
  assert.equal(confirmSignupSession(view, {status: 200, body: {user: {id: alice}}}), true);
  assert.equal(pendingSignupSession(view), null);
});

function homeFixture(pathname = '/', hash = '') {
  const fixtureNode = () => ({hidden: true, dataset: {}, addEventListener() {}, replaceChildren() {}, append() {}});
  const nodes = new Map();
  const read = id => {
    if (!nodes.has(id)) nodes.set(id, fixtureNode());
    return nodes.get(id);
  };
  const register = fixtureNode();
  read('login-panel').querySelector = () => register;
  const values = new Map();
  const view = {
    location: {pathname, hash, replace() { assert.fail('unexpected navigation'); }},
    sessionStorage: {setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), removeItem: key => values.delete(key)},
  };
  const document = {
    defaultView: view, cookie: '', getElementById: read, createElement:fixtureNode,
    querySelector: selector => selector === '.home-personal' ? read('home-personal') : null,
    querySelectorAll: () => [],
  };
  return {document, view, read, register};
}

test('a first draft shares only the registered owner and exact personal chat scope', () => {
  const hash = '#workspace=' + alice + '&agent=' + bob;
  const {view} = homeFixture('/chat', hash);
  const now = Date.now();
  assert.equal(rememberSignupSession(view, alice, now, '/chat' + hash), true);
  const scope = signupDraftScope(view, alice, now);
  assert.deepEqual(JSON.parse(scope), [alice, alice, 'agent', bob, null]);
  assert.equal(signupDraftScope(view, bob, now), null);
  assert.equal(signupDraftScope(view, alice, now + 301_000), null);
  view.location.hash = hash + '&conversation=' + bob;
  assert.equal(signupDraftScope(view, alice, now), null);
  const peerScope = JSON.stringify([bob, alice, 'agent', bob, null]);
  assert.equal(writeChatDrafts(view, alice, new Map([[scope,'第一条'], [peerScope,'different account']])), true);
  assert.deepEqual([...readChatDrafts(view, alice)], [[scope,'第一条']]);
  assert.equal(readChatDrafts(view, bob).size, 0);
});

test('workspace login resumes the exact page, query and fragment', async () => {
  const target = '/space?workspace=' + alice + '&artifact=' + bob + '#versions';
  const {document, view} = homeFixture('/login', workspaceLoginHash(target));
  const paths = [];
  view.location.replace = path => paths.push(path);
  mount(document, {fetcher: async url => {
    assert.equal(url, '/v1/auth/session');
    return {status: 200, json: async () => ({user: {id: alice, username: 'alice'}})};
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(paths, [target]);
  for (const invalid of ['/', '/register', '/v1/auth/logout', '/chat/app.mjs', 'https://workspace.invalid/chat']) {
    assert.equal(workspaceLoginTarget(workspaceLoginHash(invalid)), '');
  }
  assert.equal(workspaceLoginTarget(workspaceLoginHash(target) + '&resume=/team'), '');
});

test('a new tab can draft only for the exact authenticated personal chat', () => {
  const hash = '#workspace=' + alice + '&agent=' + bob;
  const {view} = homeFixture('/chat', hash);
  const personal = {workspace_id: alice, agent_id: bob};
  assert.equal(pendingSignupSession(view), null);
  const scope = personalDraftScope(view, alice, personal);
  assert.deepEqual(JSON.parse(scope), [alice, alice, 'agent', bob, null]);
  assert.equal(rememberColdDraftHandoff(view, scope), true);
  assert.equal(takeColdDraftHandoff(view, personalDraftScope(view, bob, personal)), null);
  assert.equal(takeColdDraftHandoff(view, scope), scope);
  assert.equal(takeColdDraftHandoff(view, scope), null);
  assert.equal(personalDraftScope(view, 'bad-owner', personal), null);
  assert.equal(personalDraftScope(view, alice, {workspace_id: alice, agent_id: alice}), null);
  view.location.search = '?q=also-a-search';
  assert.equal(personalDraftScope(view, alice, personal), null);
  view.location.search = '';
  view.location.hash = hash + '&conversation=' + bob;
  assert.equal(personalDraftScope(view, alice, personal), null);
  assert.equal(personalDraftScope(view, alice, personal, {allowBare:true}), null);
  view.location.hash = '';
  assert.equal(personalDraftScope(view, alice, personal), null);
  assert.equal(personalDraftScope(view, alice, personal, {allowBare:true}), scope);
  assert.equal(personalDraftScope(view, alice, {workspace_id:alice, agent_id:'other'}, {allowBare:true}), null);
});

test('bare Chat opens the verified personal destination for a startup draft', async () => {
  const {document, read, view} = homeFixture('/chat');
  const workspace = 'c'.repeat(32);
  const route = '/chat#workspace=' + workspace + '&agent=' + bob;
  const scope = JSON.stringify([alice, workspace, 'agent', bob, null]);
  assert.equal(writeChatDrafts(view, alice, new Map([[scope, '第一条草稿']])), true);
  const requests = [], navigation = [];
  view.history = {state:null, replaceState:(_state, _title, path) => navigation.push(path)};
  view.location.reload = () => navigation.push('reload');
  await mountRuntimeStarting(document, {fetcher: async path => {
    requests.push(path);
    if (requests.length === 1) {
      return {status:200, json:async () => ({state:'starting', user_id:alice, personal_chat:{workspace_id:workspace, agent_id:bob}})};
    }
    assert.equal(read('runtime-draft').hidden, false);
    assert.equal(read('runtime-first-message').value, '第一条草稿');
    return {status:200, json:async () => ({state:'ready', user_id:alice})};
  }});
  assert.deepEqual(requests, ['/v1/auth/runtime-readiness?include=personal-chat', '/v1/auth/runtime-readiness']);
  assert.deepEqual(navigation, [route, 'reload']);
  assert.equal(takeColdDraftHandoff(view, scope), scope);
});

test('bare Chat without a startup draft preserves default navigation', async () => {
  const {document, read, view} = homeFixture('/chat');
  let reloaded = false;
  view.location.reload = () => { reloaded = true; };
  await mountRuntimeStarting(document, {fetcher: async path => {
    assert.equal(path, '/v1/auth/runtime-readiness?include=personal-chat');
    return {status:200, json:async () => ({state:'ready', user_id:alice, personal_chat:{workspace_id:alice, agent_id:bob}})};
  }});
  assert.equal(reloaded, true);
  assert.equal(read('runtime-first-message').value, '');
});

test('the startup composer drops its visible draft when another account signs in', async () => {
  const hash = '#workspace=' + alice + '&agent=' + bob;
  const {document, read, view} = homeFixture('/chat', hash);
  const requests = [];
  const paths = [];
  const draftScope = JSON.stringify([alice, alice, 'agent', bob, null]);
  assert.equal(writeChatDrafts(view, alice, new Map([[draftScope, '只在 Alice 的草稿']])), true);
  view.location.replace = target => paths.push(target);
  await mountRuntimeStarting(document, {fetcher: async path => {
    requests.push(path);
    if (requests.length === 1) {
      return {status: 200, json: async () => ({state: 'starting', user_id: alice, personal_chat: {workspace_id: alice, agent_id: bob}})};
    }
    assert.equal(read('runtime-first-message').value, '只在 Alice 的草稿');
    assert.equal(read('runtime-draft').hidden, false);
    assert.match(read('runtime-title').textContent, /正在启动/);
    return {status: 200, json: async () => ({state: 'ready', user_id: bob})};
  }});
  assert.deepEqual(requests, ['/v1/auth/runtime-readiness?include=personal-chat', '/v1/auth/runtime-readiness']);
  assert.deepEqual(paths, ['/login' + workspaceLoginHash('/chat' + hash)]);
  assert.equal(read('runtime-first-message').value, '');
  assert.equal(read('runtime-draft').hidden, true);
  assert.deepEqual([...readChatDrafts(view, alice)], [[draftScope, '只在 Alice 的草稿']]);
  assert.equal(readChatDrafts(view, bob).size, 0);
});

test('a cold route sends an unexpected signup session to manual login without starting the wrong runtime', async () => {
  const hash = '#team-invite=validSyntheticInvite';
  const {document, view} = homeFixture('/chat', hash);
  const paths = [];
  view.location.replace = target => paths.push(target);
  rememberSignupSession(view, alice);
  await mountRuntimeStarting(document, {fetcher: async path => {
    assert.equal(path, '/v1/auth/runtime-readiness');
    return {status: 200, json: async () => ({state: 'setup', user_id: bob})};
  }});
  assert.deepEqual(paths, ['/login' + hash]);
  assert.equal(takeSignupSession(view), alice, 'login still sees the expected account and can prevent the wrong session from proceeding');
});

test('runtime startup uses the ready result of setup without polling again and resumes the original chat link', async () => {
  const hash = '#workspace=' + alice + '&agent=' + bob;
  const {document, view} = homeFixture('/chat', hash);
  document.cookie = 'ot_dev_csrf=expected-csrf';
  const requests = [];
  let restored = '';
  view.location.reload = () => { restored = view.location.pathname + view.location.hash; };
  rememberSignupSession(view, alice);
  await mountRuntimeStarting(document, {fetcher: async (path, options) => {
    requests.push(path);
    if (path === '/v1/auth/runtime-readiness') {
      return {status: 200, json: async () => ({state: 'setup', user_id: alice})};
    }
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-CSRF-Token'], 'expected-csrf');
    return {status: 201, json: async () => ({personal_agent: {runtime_provisioning: {readiness: 'ready'}}})};
  }});
  assert.deepEqual(requests, ['/v1/auth/runtime-readiness', '/v1/personal-agent']);
  assert.equal(restored, '/chat' + hash);
  assert.equal(pendingSignupSession(view), alice);
  assert.equal(takeSignupSession(view), alice);
  assert.equal(pendingSignupSession(view), null);
});

test('capacity is a signed-in Chat state and rechecking does not provision until there is room', async () => {
  const {document, read, view} = homeFixture('/chat');
  document.cookie = 'ot_dev_csrf=expected-csrf';
  rememberSignupSession(view, alice);
  const requests = [];
  const reply = (body, status = 200) => ({status, json: async () => body});
  let retry;
  let state = 'capacity';
  let reloaded = false;
  read('runtime-retry').addEventListener = (type, handler) => { if (type === 'click') retry = handler; };
  view.location.reload = () => { reloaded = true; };
  await mountRuntimeStarting(document, {fetcher: async (path, opts) => {
    const method = opts.method || 'GET';
    requests.push([method, path]);
    if (path === '/v1/auth/runtime-readiness') return reply({state, user_id:alice});
    assert.equal(path, '/v1/personal-agent');
    assert.equal(opts.headers['X-CSRF-Token'], 'expected-csrf');
    return reply({personal_agent:{runtime_provisioning:{readiness:'ready'}}}, 201);
  }});
  assert.equal(read('runtime-title').textContent, '专属智能体名额已满');
  assert.match(read('runtime-status').textContent, /账户已登录.*联系管理员/);
  assert.equal(read('runtime-progress').hidden, true);
  assert.equal(read('runtime-retry').textContent, '重新检查');
  await retry();
  assert.deepEqual(requests, [
    ['GET','/v1/auth/runtime-readiness'], ['GET','/v1/auth/runtime-readiness'],
  ]);
  assert.equal(pendingSignupSession(view), alice);
  state = 'setup';
  await retry();
  assert.deepEqual(requests.slice(2), [['GET','/v1/auth/runtime-readiness'], ['POST','/v1/personal-agent']]);
  assert.equal(reloaded, true);
});

test('Home shows the capacity reason without another provisioning attempt after signup', async () => {
  const {document, read, view} = homeFixture();
  rememberSignupSession(view, alice);
  const calls = [];
  let retry;
  read('status').append = element => { retry = element; };
  mount(document, {fetcher: async (path,{method}) => {
    calls.push([method,path]);
    return {status: 200,json: async () => ({user:{id:alice,username:'alice'},home:{runtime_state:'capacity'}})};
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['GET','/v1/auth/session?include=home']]);
  assert.equal(read('login-panel').hidden, true);
  assert.equal(read('main-panel').hidden, true);
  assert.match(read('status').textContent, /名额已满.*账户已登录.*联系管理员/);
  assert.equal(retry.textContent, '重新检查');
  assert.equal(takeSignupSession(view), null);
});

test('a ready personal chat becomes clickable while the workspace list and onboarding are still pending', async () => {
  const {document, read, view} = homeFixture();
  rememberSignupSession(view, alice);
  const pending = [];
  const reply = (body, status = 200) => ({status, json: async () => body});
  mount(document, {fetcher: async url => {
    if (url === '/v1/auth/session?include=home') return reply({user: {id: alice, username: 'alice'}, home: {
      runtime_state: 'ready', personal_agent: {workspace: {id: alice}, agent: {id: bob, name: 'Personal Agent'}},
    }});
    return new Promise(resolve => pending.push({url, resolve}));
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read('main-panel').hidden, false);
  assert.equal(read('home-personal').hidden, false);
  assert.equal(read('home-personal-chat').href, `/chat#workspace=${alice}&agent=${bob}`);
  assert.equal(read('home-workspace').disabled, true);
  assert.equal(takeSignupSession(view), null);
  assert.deepEqual(pending.map(({url}) => url), [
    '/v1/workspaces/'+alice+'/overview?limit=5', '/v1/onboarding', '/v1/workspaces?limit=100',
  ]);
  for (const {url, resolve} of pending) {
    resolve(url.endsWith('onboarding') ? reply({onboarding: {industry: '测试'}})
      : url.includes('/overview') ? reply({counts:{agents:1}}) : reply({items: [{id:alice,name:'个人空间'}]}));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read('home-context').textContent, '工作背景：测试');
});

test('a stopped home runtime still uses the explicit startup page', async () => {
  const {document, read, view} = homeFixture();
  const calls = [], destinations = [];
  view.location.replace = target => destinations.push(target);
  mount(document, {fetcher: async (url, {method}) => {
    calls.push([method, url]);
    const body = url.endsWith('include=home')
      ? {user:{id:alice, username:'alice'}, home:{runtime_state:'stopped', personal_agent:null}}
      : {personal_agent:{runtime_provisioning:{readiness:'stopped'}}};
    return {status:200, json:async()=>body};
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['GET', '/v1/auth/session?include=home'], ['POST', '/v1/personal-agent']]);
  assert.deepEqual(destinations, ['/runtime-starting#home=1']);
  assert.equal(read('main-panel').hidden, true);
});

test('a blocked or different signup session cannot resume an invitation as another account', async () => {
  const hash = '#team-invite=validSyntheticInvite';
  for (const session of [{status: 401, body: {}}, {status: 200, body: {user: {id: bob, username: 'bob'}}}]) {
    const {document, read, register, view} = homeFixture('/login', hash);
    rememberSignupSession(view, alice);
    mount(document, {fetcher: async url => {
      assert.equal(url, '/v1/auth/session');
      return {status: session.status, json: async () => session.body};
    }});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read('login-panel').hidden, false);
    assert.equal(read('main-panel').hidden, true);
    assert.equal(register.href, '/register' + hash);
    assert.match(read('status').textContent, /账户已创建.*登录会话尚未确认/);
  }
});

test('conversationTitle names agent, DM and group rows without inventing data', () => {
  assert.equal(conversationTitle({source: 'agent', agent_name: 'Helper', title: 'Old'}, alice), 'Old');
  assert.equal(conversationTitle({source: 'agent', agent_name: 'Helper'}, alice), 'Helper');
  assert.equal(conversationTitle({source: 'agent', title: 'Thread'}, alice), 'Thread');
  assert.equal(conversationTitle({source: 'social', kind: 'dm', members: [
    {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'}]}, alice), 'bob');
  assert.equal(conversationTitle({source: 'social', kind: 'group', title: '产品群'}, alice), '产品群');
  assert.equal(conversationTitle({source: 'social', kind: 'group'}, alice), '群聊');
});

test('formatWhen uses compact real-time labels', () => {
  const now = 1800000000;
  assert.equal(formatWhen(now - 30, now), '刚刚');
  assert.equal(formatWhen(now - 120, now), '2 分钟前');
  assert.match(formatWhen(now - 7200, now), /^\d{2}:\d{2}$/);
  assert.equal(formatWhen(now - 86400, now), '昨天');
  assert.match(formatWhen(now - 86400 * 10, now), /2027|2026/);
  assert.equal(formatWhen(null, now), '');
});

test('kindLabel and meetingMeta keep summaries honest', () => {
  assert.equal(kindLabel('slides'), '幻灯片');
  assert.equal(kindLabel('unknown'), '作品');
  assert.equal(meetingMeta({action_count: 3, done_count: 1}), '3 个行动项 · 1 已完成');
  assert.equal(meetingMeta({action_count: 0}), '没有行动项');
});


test('home artifact rows deep-link to the existing space editor query', () => {
  const workspace = 'a'.repeat(32);
  const artifact = 'b'.repeat(32);
  assert.equal(spaceHref(workspace, artifact), '/space?workspace=' + workspace + '&artifact=' + artifact);
  assert.equal(spaceHref(workspace), '/space?workspace=' + workspace);
});

test('public work login resumes the requested panel for one safe work slug', async () => {
  const {publicWorkIntentFromHash} = await import('../flybot_workspace/static/shell/public-work-link.mjs');
  assert.deepEqual(publicWorkIntentFromHash('#work-comments=writer-demo'), {
    slug: 'writer-demo', panel: 'comments', continuation: '#work-comments=writer-demo',
    target: '/discover?work=writer-demo&comments=1',
  });
  assert.deepEqual(publicWorkIntentFromHash('#work-detail=writer-demo'), {
    slug: 'writer-demo', panel: 'share', continuation: '#work-detail=writer-demo',
    target: '/discover?work=writer-demo&share=1',
  });
  for (const hash of [
    '#work-comments=one&work-comments=two', '#work-comments=writer-demo&next=/profile',
    '#work-detail=https%3A%2F%2Fexample.invalid', '#work-comments=..%2Fwork', '#public-agent=writer-demo',
  ]) assert.equal(publicWorkIntentFromHash(hash), null);
});

test('Discover continuation preserves the public view and drops private or unknown parameters', () => {
  const href = discoverLoginHref('?work=public-example&kind=document&q=%E4%BC%9A%E8%AE%AE&comments=1&workspace=secret&next=//outside.test');
  const hash = href.slice('/login'.length);
  assert.deepEqual(discoverIntentFromHash(hash), {
    continuation: hash,
    target: '/discover?kind=document&q=%E4%BC%9A%E8%AE%AE&work=public-example&comments=1',
  });
  assert.equal(discoverIntentFromHash('#discover=%2F%2Foutside.test').target, '/discover');
  assert.equal(discoverIntentFromHash('#discover=&next=%2Fsettings'), null);
  assert.equal(discoverIntentFromHash('#discover=&discover='), null);
  assert.equal(discoverIntentFromHash('#discover=' + 'a'.repeat(2400)), null);
});

test('confirmed sign-in opens the same Discover view without a dashboard detour', async () => {
  const href = discoverLoginHref('?tab=agents&category=education&q=Tutor');
  const {document, view} = homeFixture('/login', href.slice('/login'.length));
  const destinations = [], calls = [];
  view.location.replace = target => destinations.push(target);
  mount(document, {fetcher: async (path, {method}) => {
    calls.push([method, path]);
    const result = {
      '/v1/auth/session': {user: {id: alice, username: 'alice'}},
      '/v1/personal-agent': {personal_agent: {runtime_provisioning: {readiness: 'ready'}}},
      '/v1/workspaces?scope=personal': {items: [{id: bob}]},
    };
    assert.ok(Object.hasOwn(result, path));
    return {status: 200, json: async () => result[path]};
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(destinations, ['/discover?tab=agents&category=education&q=Tutor']);
  assert.deepEqual(calls, [
    ['GET', '/v1/auth/session'], ['POST', '/v1/personal-agent'], ['GET', '/v1/workspaces?scope=personal'],
  ]);
});

test('a stopped runtime waits for explicit start before reloading the original workspace link', async () => {
  const {document, read, view} = homeFixture('/space', '#workspace=' + alice);
  const calls = [];
  document.cookie = 'ot_dev_csrf=expected-csrf';
  let click, reloaded = false;
  read('runtime-retry').addEventListener = (_event, handler) => { click = handler; };
  view.location.reload = () => { reloaded = true; };
  await mountRuntimeStarting(document, {fetcher: async (path, options) => {
    calls.push(path);
    if (path === '/v1/auth/runtime-start') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-CSRF-Token'], 'expected-csrf');
      assert.equal(options.body, '{}');
      return {status: 202, json: async () => ({state: 'starting'})};
    }
    return {status: 200, json: async () => ({state: calls.length === 1 ? 'stopped' : 'ready'})};
  }});
  assert.deepEqual(calls, ['/v1/auth/runtime-readiness']);
  assert.equal(read('runtime-retry').textContent, '启动我的智能体');
  assert.equal(reloaded, false);
  await click();
  assert.deepEqual(calls, ['/v1/auth/runtime-readiness', '/v1/auth/runtime-start', '/v1/auth/runtime-readiness']);
  assert.equal(reloaded, true);
});
