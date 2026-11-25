import assert from 'node:assert/strict';
import test from 'node:test';
import {mountTeamRuns, removeDraftStep, teamRunDraftFromHistory, teamRunPayload, teamRunTarget} from '../flybot_workspace/static/team-runs/app.mjs';

const WS = 'a'.repeat(32);
const OTHER_WS = 'b'.repeat(32);
const RUN = 'c'.repeat(32);
const AGENT = 'd'.repeat(32);
const OTHER_AGENT = 'e'.repeat(32);
const BASE = `/v1/workspaces/${WS}/team-runs`;
const AGENTS = [{id: AGENT, name: '研究员'}, {id: OTHER_AGENT, name: '校对员'}];
const step = (key, id, instruction, dependencies = []) => ({key, agent: id, instruction, dependencies: new Set(dependencies)});

test('team run addresses allow exact workspace, private run or shared snapshot', () => {
  const shared = 'otsr_' + 'R'.repeat(26);
  assert.deepEqual(teamRunTarget(''), {});
  assert.deepEqual(teamRunTarget('#workspace=' + WS), {workspace: WS});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&run=${RUN}`), {workspace: WS, run: RUN});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&run=${RUN}&step=0`), {workspace:WS, run:RUN, step:0});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&run=${RUN}&step=7`), {workspace:WS, run:RUN, step:7});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&shared=${shared}`), {workspace: WS, shared});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&draft=1`), {workspace: WS, draft: true});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&draft=1&automation=${AGENT}&result=${RUN}`), {
    workspace:WS, draft:true, automationSource:{kind:'automation_run', automation_id:AGENT, run_id:RUN},
  });
  for (const bad of [`#workspace=${WS}&draft=2`, `#workspace=${WS}&draft=1&run=${RUN}`, `#run=${RUN}`, `#workspace=${WS}&run=${RUN}&shared=${shared}`,
    `#workspace=${WS}&workspace=${OTHER_WS}`, `#workspace=${WS}&run=wrong`, `#workspace=${WS}&step=0`,
    `#workspace=${WS}&run=${RUN}&step=8`, `#workspace=${WS}&run=${RUN}&step=0&step=1`,
    `#workspace=${WS}&draft=1&automation=${AGENT}`, `#workspace=${WS}&automation=${AGENT}&result=${RUN}`,
    `#workspace=${WS}&draft=1&automation=${AGENT}&result=${RUN}&result=${RUN}`]) {
    assert.deepEqual(teamRunTarget(bad), {invalid: true});
  }
});

test('draft validates local agents and exports dependencies only to earlier steps', () => {
  const draft = {title: ' 归纳反馈 ', goal: ' 组织建议 ', steps: [
    step(10, AGENT, ' 收集反馈 '),
    step(11, OTHER_AGENT, ' 编写总结 ', [10]),
  ]};
  assert.deepEqual(teamRunPayload(draft, AGENTS), {
    title: '归纳反馈', goal: '组织建议', steps: [
      {agent_id: AGENT, instruction: '收集反馈', depends_on: []},
      {agent_id: OTHER_AGENT, instruction: '编写总结', depends_on: [0]},
    ],
  });
  assert.equal(teamRunPayload(draft, AGENTS.slice(0, 1)), null);
  assert.equal(teamRunPayload({...draft, steps: draft.steps.slice(0, 1)}, AGENTS), null);
  draft.steps[0].dependencies.add(11);
  assert.equal(teamRunPayload(draft, AGENTS), null, 'future dependencies cannot leave the editor');
});

test('removing a draft step removes its own dependencies while stable keys keep unrelated inputs', () => {
  const draft = {title: '计划', goal: '明确步骤', steps: [
    step(41, AGENT, '搜集材料'), step(42, OTHER_AGENT, '再次核对'), step(43, AGENT, '出稿', [41, 42]),
  ]};
  const remaining = removeDraftStep(draft.steps, 41);
  const payload = teamRunPayload({...draft, steps: remaining}, AGENTS);
  assert.deepEqual(payload.steps.map(item => [item.instruction, item.depends_on]), [['再次核对', []], ['出稿', [0]]]);
  assert.equal(removeDraftStep(remaining, 42), remaining);
});

test('terminal run reuse carries definition and dependency identities without copying live state or output', () => {
  let serial = 40;
  const source = {id:RUN, status:'failed', title:'流程'.repeat(39)+'😀', goal:'处理下一轮反馈',
    steps:[{position:0,agent_id:AGENT,instruction:'搜集',depends_on:[],output:'private result',attempts:2},
      {position:1,agent_id:OTHER_AGENT,instruction:'复核',depends_on:[0],status:'blocked'}]};
  const draft = teamRunDraftFromHistory(source, () => ++serial);
  assert.ok(draft.title.length <= 80 && draft.title.endsWith('（副本）') && draft.title.isWellFormed());
  assert.deepEqual(draft.steps, [step(41,AGENT,'搜集'),step(42,OTHER_AGENT,'复核',[41])]);
  assert.equal(draft.sourceRun,RUN);
  assert.equal(teamRunPayload(draft, AGENTS).reused_from,RUN);
  assert.equal(draft.goal,source.goal);
  assert.ok(!JSON.stringify(draft).includes('private result'));
  assert.equal(teamRunDraftFromHistory({...source,status:'running'}, () => ++serial),null);
  source.steps[1].depends_on = [1];
  assert.equal(teamRunDraftFromHistory(source, () => ++serial),null);
});

function fixture(hash = '', storage = new Map()) {
  const nodes = new Map();
  const document = {activeElement: null, cookie: ''};
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.dataset = {};
      this.children = [];
      this.events = {};
      this.value = '';
      this.textContent = '';
    }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0] || null; }
    addEventListener(type, handler) { this.events[type] = handler; }
    removeAttribute(name) { delete this[name]; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    focus() { document.activeElement = this; }
  }
  const node = id => {
    if (['team-shared-runs', 'share-team-run'].includes(id)) return null;
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  document.getElementById = node;
  document.createElement = name => new Element(name);
  document.querySelectorAll = () => [];
  const location = {hash};
  document.defaultView = {
    location, crypto: globalThis.crypto, sessionStorage: {
      getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    events: {},
    addEventListener(type, handler) { this.events[type] = handler; },
    history: {pushState(_state, _title, next) { location.hash = next; }},
  };
  return {document, node};
}

const ok = (body, status = 200) => ({status, json: async () => body});
const user = {id: 'f'.repeat(32), username: 'author'};
const workspace = {id: WS, name: '个人工作区', kind: 'personal'};
const alternate = {id: OTHER_WS, name: '协同工作区', kind: 'team'};
const run = {id: RUN, workspace_id: WS, status: 'failed', title: '正式任务', progress: {total: 2, succeeded: 0},
  steps: [{position: 0, status: 'failed', attempts: 1, agent_name: '研究员', instruction: '归纳', depends_on: []},
    {position: 1, status: 'blocked', attempts: 0, agent_name: '校对员', instruction: '复核', depends_on: [0]}]};
const baseRead = path => {
  if (path === '/v1/auth/session') return ok({user});
  if (path === '/v1/workspaces?scope=personal') return ok({items: [workspace]});
  if (path === '/v1/workspaces?limit=100') return ok({items: [workspace, alternate]});
};
const input = (element, value, type = 'input') => { element.value = value; element.events[type](); };

test('startup overlaps account and workspace reads before rendering private tasks', async () => {
  const {document, node} = fixture();
  const authenticate = Promise.withResolvers();
  const calls = [];
  const mounted = mountTeamRuns(document, async path => {
    calls.push(path);
    if (path === '/v1/auth/session') return authenticate.promise;
    if (path === BASE) return ok({items: []});
    return baseRead(path);
  });
  assert.deepEqual(calls, ['/v1/auth/session', '/v1/workspaces?scope=personal', '/v1/workspaces?limit=100']);
  assert.equal(node('team-run-list').children.length, 0);
  authenticate.resolve(ok({user}));
  await mounted;
  assert.equal(calls.at(-1), BASE);
  assert.equal(node('team-runs-workspace').value, WS);
});

test('native history overlaps sign-in and uses only the exact read for the verified viewer', async () => {
  const {document, node} = fixture(`#workspace=${OTHER_WS}&run=${RUN}`);
  document.querySelector = () => ({content:'ds-bot'});
  const authenticate = Promise.withResolvers();
  const directory = Promise.withResolvers();
  const read = Promise.withResolvers();
  const path = `/v1/workspaces/${OTHER_WS}/team-runs/${RUN}`;
  const exact = {...run, workspace_id:OTHER_WS};
  let requests = 0;
  const mounted = mountTeamRuns(document, async address => {
    if (address === '/v1/auth/session') return authenticate.promise;
    if (address === '/v1/workspaces?limit=100') return directory.promise;
    if (address === path) {
      if (++requests === 1) return ok({viewer_username:'previous-owner', run:{...exact, title:'Different owner'}});
      return read.promise;
    }
    return baseRead(address);
  });
  assert.equal(requests, 1);
  authenticate.resolve(ok({user}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(node('team-run-results').children.length, 0);
  assert.equal(node('team-run-heading').textContent, '');

  directory.resolve(ok({items:[workspace, alternate]}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.equal(node('team-run-heading').textContent, '任务详情');
  read.resolve(ok({viewer_username:user.username, run:exact}));
  await mounted;
  assert.equal(node('team-runs-workspace').value, OTHER_WS);
  assert.equal(node('team-run-heading').textContent, exact.title);
  assert.equal(node('team-run-results').children.length, 2);
});

test('a pending reused draft sends exactly the tracked version of the create body after reload', async () => {
  const sourceRun = '9'.repeat(32);
  const createKey = 'team-run-' + '1'.repeat(32);
  for (const createSourceRun of [undefined, sourceRun]) {
    const storage = new Map([['ot-team-run-draft:' + user.id + ':' + WS, JSON.stringify({
      title:'复用草稿', goal:'确认跟进', sourceRun, createKey, createSourceRun,
      steps:AGENTS.map(agent => ({agent:agent.id, instruction:'执行检查', dependsOn:[]})),
    })]]);
    const {document, node} = fixture(`#workspace=${WS}&draft=1`, storage);
    const requests = [];
    await mountTeamRuns(document, async (path, options) => {
      if (path === BASE && options.method === 'POST') {
        requests.push({key:options.headers['Idempotency-Key'], from:JSON.parse(options.body).reused_from});
        return ok({run});
      }
      if (path.endsWith('/agents?limit=100')) return ok({items:AGENTS});
      return baseRead(path);
    });
    await node('team-run-form').events.submit({preventDefault() {}});
    assert.deepEqual(requests, [{key:createKey, from:createSourceRun}]);
  }
});

test('a lost create response survives reload and only its owner can retry the exact request', async () => {
  const storage = new Map();
  const {document, node} = fixture('', storage);
  const posts = [];
  const fetcher = async (path, options) => {
    const base = baseRead(path);
    if (base) return base;
    if (path === `/v1/workspaces/${WS}/agents?limit=100`) return ok({items: AGENTS});
    if (path === BASE && options.method === 'GET') return ok({items: []});
    if (path === BASE && options.method === 'POST') {
      posts.push({key: options.headers['Idempotency-Key'], body: JSON.parse(options.body)});
      if (posts.length === 1) throw new TypeError('response lost');
      return ok({run});
    }
    throw new Error(path);
  };
  await mountTeamRuns(document, fetcher);
  await node('team-runs-new').events.click();
  input(node('team-run-title'), '正式任务');
  input(node('team-run-goal'), '处理请求');
  for (const [index, row] of node('team-run-steps').children.entries()) {
    input(row.children[1].children[0], AGENTS[index].id, 'change');
    input(row.children[2].children[0], '完成第 ' + (index + 1) + ' 步');
  }
  const submit = () => node('team-run-form').events.submit({preventDefault() {}});
  await submit();
  assert.equal(node('team-run-start').textContent, '确认并重试');
  assert.equal(node('team-run-fields').disabled, true);
  assert.match(node('team-run-start-status').textContent, /无法确认/);
  const hash = document.defaultView.location.hash;
  assert.equal(hash, `#workspace=${WS}&draft=1`);
  const other = fixture(hash, storage);
  await mountTeamRuns(other.document, async (path, options) => path === '/v1/auth/session'
    ? ok({user: {id: OTHER_WS, username: 'different-account'}}) : fetcher(path, options));
  assert.equal(other.node('team-run-title').value, '');
  assert.equal(other.node('team-run-fields').disabled, false);
  const restored = fixture(hash, storage);
  await mountTeamRuns(restored.document, fetcher);
  assert.equal(restored.node('team-run-title').value, '正式任务');
  assert.equal(restored.node('team-run-fields').disabled, true);
  assert.equal(posts.length, 1);
  await restored.node('team-run-form').events.submit({preventDefault() {}});
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.match(posts[0].key, /^team-run-[a-f0-9]{32}$/);
  assert.equal(restored.node('team-run-detail').hidden, false);
  assert.match(restored.node('team-run-progress').textContent, /失败/);
  assert.equal(restored.document.defaultView.location.hash, `#workspace=${WS}&run=${RUN}`);
  assert.equal(storage.size, 0);
});

test('a delayed exact result cannot replace the list after switching workspaces', async () => {
  const {document, node} = fixture(`#workspace=${WS}&run=${RUN}`);
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const mounted = mountTeamRuns(document, async path => {
    const base = baseRead(path);
    if (base) return base;
    if (path === BASE + '/' + RUN) {
      started.resolve();
      return pending.promise;
    }
    if (path === `/v1/workspaces/${OTHER_WS}/team-runs`) return ok({items: []});
    throw new Error(path);
  });
  await started.promise;
  node('team-runs-workspace').value = OTHER_WS;
  await node('team-runs-workspace').events.change();
  pending.resolve(ok({run}));
  await mounted;
  assert.equal(node('team-run-detail').hidden, true);
  assert.equal(node('team-run-list-panels').hidden, false);
  assert.equal(node('team-run-results').children.length, 0);
  assert.equal(document.defaultView.location.hash, '#workspace=' + OTHER_WS);
});

test('task history filters authorized results without requests and keeps the list position in its account and workspace', async () => {
  const storage = new Map();
  const first = fixture(`#workspace=${WS}`, storage);
  const finished = {...run, title:'交接验收', goal:'找出跨团队 CJK 的准备事项', status:'succeeded'};
  const other = {...run, id:OTHER_AGENT, title:'后续检查', goal:'找出未完成的准备事项'};
  const requests = [];
  let listResponse;
  let refused = false;
  const fetcher = async path => {
    requests.push(path);
    if (path === BASE) return listResponse || (refused ? ok({},403) : ok({items:[finished,other]}));
    if (path === BASE + '/' + RUN) return ok({run:finished});
    if (path === `/v1/workspaces/${OTHER_WS}/team-runs`) return ok({items:[]});
    return baseRead(path);
  };
  const rows = instance => instance.node('team-run-list').children.map(row => row.firstElementChild);
  const search = instance => instance.node('team-run-search');
  const status = instance => instance.node('team-run-filter-status');
  await mountTeamRuns(first.document, fetcher);
  const beforeFiltering = requests.length;
  input(search(first),'跨团队 ＣＪＫ');
  assert.deepEqual(rows(first).map(button => button.dataset.runId),[RUN]);
  input(status(first),'failed','change');
  assert.equal(first.node('team-runs-empty').textContent,'没有符合条件的任务。');
  assert.equal(first.node('team-run-filter-count').textContent,'显示 0 / 2 个任务');
  input(status(first),'succeeded','change');
  assert.equal(requests.length,beforeFiltering);
  assert.equal(first.document.defaultView.location.hash,'#workspace=' + WS);
  await rows(first)[0].events.click();
  const pendingList = Promise.withResolvers();
  listResponse = pendingList.promise;
  const view = first.document.defaultView;
  view.location.hash = '#workspace=' + WS;
  const returned = view.events.hashchange();
  assert.deepEqual(rows(first).map(button => button.dataset.runId),[RUN]);
  assert.equal(first.document.activeElement,rows(first)[0]);
  pendingList.resolve(ok({items:[finished,other]}));
  await returned;
  listResponse = undefined;

  const restored = fixture('#workspace=' + WS,storage);
  await mountTeamRuns(restored.document, fetcher);
  assert.equal(search(restored).value,'跨团队 ＣＪＫ');
  assert.equal(status(restored).value,'succeeded');
  assert.equal(restored.document.activeElement,rows(restored)[0]);

  const differentUser = fixture('#workspace=' + WS,storage);
  await mountTeamRuns(differentUser.document, path => path === '/v1/auth/session'
    ? ok({user:{id:OTHER_WS,username:'peer'}}) : fetcher(path));
  assert.equal(search(differentUser).value,'');
  assert.equal(status(differentUser).value,'');

  input(restored.node('team-runs-workspace'),OTHER_WS,'change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(search(restored).value,'');
  input(restored.node('team-runs-workspace'),WS,'change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(search(restored).value,'跨团队 ＣＪＫ');
  refused = true;
  await restored.node('team-runs-refresh').events.click();
  assert.equal(restored.node('team-run-filters').hidden,true);
  assert.equal(search(restored).value,'');
  assert.equal(rows(restored).length,0);
});

test('transient read errors keep visible results, but permission loss clears task output and actions', async () => {
  const {document, node} = fixture(`#workspace=${WS}&run=${RUN}`);
  let status = 200;
  const finished = {...run, status: 'succeeded', goal: '团队目标', steps: [
    {...run.steps[0], status: 'succeeded', output: '属于原工作区的结果'},
    {...run.steps[1], status: 'succeeded', output: '复核后的结果'},
  ]};
  await mountTeamRuns(document, async path => baseRead(path) || ok(status === 200 ? {run: finished} : {}, status));
  assert.equal(node('team-run-results').children.length, 2);
  assert.equal(node('team-run-remove').hidden, false);
  assert.equal(node('team-run-export').href, BASE + '/' + RUN + '/export');
  status = 503;
  await node('team-runs-refresh').events.click();
  assert.equal(node('team-run-results').children.length, 2);
  status = 403;
  await node('team-runs-refresh').events.click();
  assert.equal(node('team-run-results').children.length, 0);
  assert.equal(node('team-run-goal-detail').textContent, '');
  assert.equal(node('team-run-remove').hidden, true);
  assert.equal(node('team-run-export').hidden, true);
  assert.equal(node('team-run-export').href, undefined);
  assert.equal(node('team-runs-new').disabled, true);
  assert.match(node('team-run-status').textContent, /没有权限/);
});

test('lost deletion responses need an empty scoped result from the original signed owner', async () => {
  for (const [listStatus, sessionUser] of [[200, user], [403, user], [200, {id: OTHER_WS}]]) {
    const confirmed = listStatus === 200 && sessionUser === user;
    const {document, node} = fixture(`#workspace=${WS}&run=${RUN}`);
    const requests = [];
    let posted = false;
    const listing = Promise.withResolvers();
    await mountTeamRuns(document, async (path, {method}) => {
      if (path === '/v1/auth/session' && posted) return ok({user: sessionUser});
      const base = baseRead(path);
      if (base) return base;
      requests.push([method, path]);
      if (path === BASE + '/' + RUN + '/remove') {
        posted = true;
        return ok({}, 503);
      }
      if (path === BASE + '/' + RUN) return posted ? ok({}, 404) : ok({run});
      if (path === BASE) return listing.promise;
      throw new Error(path);
    });
    node('team-run-remove').events.click();
    node('team-run-confirm-action').events.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(node('team-run-remove').disabled, true);
    assert.match(node('team-run-status').textContent, /正在核对/);
    listing.resolve(ok({items: []}, listStatus));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.filter(([method]) => method === 'POST').length, 1);
    assert.equal(node('team-run-detail').hidden, confirmed);
    assert.equal(node('team-run-results').children.length, 0);
    assert.equal(document.defaultView.location.hash, `#workspace=${WS}${confirmed ? '' : '&run=' + RUN}`);
  }
});
