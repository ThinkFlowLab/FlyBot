import { mountSkillExecution, readinessLabels } from '../flybot_workspace/static/skills/execution.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountButtonLabel, filterSkills, mountSkills, readInstalled, skillAgentTarget, skillCountLabel, writeInstalled,
} from '../flybot_workspace/static/skills/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.handlers = {};
    this.className = '';
    this.style = {};
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.classList = {
      add: (name) => { if (!this.className.split(' ').includes(name)) this.className = (this.className + ' ' + name).trim(); },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
}

function fakeDocument() {
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element(id === 'skills-search' ? 'input' : 'div'));
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const SKILLS = JSON.parse(execFileSync('python3', ['-c', 'import json;from flybot_workspace.skill_packages import catalogue;print(json.dumps(catalogue()))'], {encoding:'utf8'}));
function service({failWrite=false} = {}) {
  let bindings=[];const calls=[];
  return {calls, fetcher:async(path, options) => {
    calls.push({path,options});
    if(options.method==='POST') {
      if(failWrite)return {status:403,ok:false,json:async()=>({error:{message:'permission denied'}})};
      const b=JSON.parse(options.body);bindings=b.enabled ? [{scope:b.scope,skill_id:b.skill_id,version:b.version,digest:b.digest,last_loaded_task:null}] : [];
      return {status:200,ok:true,json:async()=>({enabled:b.enabled})};
    }
    return {status:200,ok:true,json:async()=>path.endsWith('/catalog') ? {items:SKILLS} : path.endsWith('/bindings') ? {items:bindings} : {items:[]}};
  }};
}

test('authoritative catalogue has real bounded version-pinned prompt packages', () => {
  assert.equal(SKILLS.length,10);
  assert.equal(new Set(SKILLS.map(i=>i.id)).size,10);
  for(const item of SKILLS) {
    assert.ok(item.content.length>100);
    assert.equal(createHash('sha256').update(item.content).digest('hex'),item.digest);
    assert.deepEqual(item.permissions,['model_context']);
  }
});

test('filter searches actual server content and counts it', () => {
  assert.equal(filterSkills(SKILLS,'').length,10);
  assert.deepEqual(filterSkills(SKILLS,'会议').map(i=>i.id),['meeting-notes']);
  assert.equal(filterSkills(SKILLS,'找不到的技能').length,0);
  assert.equal(skillCountLabel(1,10),'显示 1 / 10 个技能');
});

test('skills opened from an Agent start in its verified scope and return to that Agent', async () => {
  const workspace = 'a'.repeat(32), agent = 'b'.repeat(32);
  const hash = '#workspace='+workspace+'&agent='+agent;
  const scope = workspace+':'+agent;
  const {doc,el} = fakeDocument();
  doc.defaultView = {location:{hash}};
  el('skills-scope').value = 'account';
  const svc = service();
  await mountSkills(doc,{fetcher:(path,opts) => path === '/v1/skills/scopes'
    ? Promise.resolve({status:200,ok:true,json:async()=>({items:[{scope,kind:'agent',label:'Personal Agent'}]})})
    : svc.fetcher(path,opts)}).ready;
  assert.equal(el('skills-scope').value,scope);
  assert.equal(el('skills-back-to-agent').href,'/agents'+hash);
  assert.equal(el('skills-back-to-agent').hidden,false);
  assert.equal(skillAgentTarget(hash+'&agent='+agent),null);
});

test('installation needs consent for the reviewed skill, persists through reload, and uninstall revokes', async () => {
  const svc=service();const {doc,el}=fakeDocument();doc.cookie='__Host-ot_csrf=synthetic-csrf';el('skills-scope').value='account';
  const mounted=mountSkills(doc,{fetcher:svc.fetcher});await mounted.ready;
  const list=el('skills-list'), permission=el('skills-permission'), confirm=el('skills-review-confirm');
  assert.equal(list.children.length,10);
  list.children[1].children[2].handlers.click();
  assert.equal(el('skills-review-title').textContent,SKILLS[1].name);
  permission.checked=true;
  permission.handlers.change();
  el('skills-review-close').handlers.click();

  list.children[0].children[2].handlers.click();
  assert.equal(el('skills-review-content').textContent,SKILLS[0].content);
  assert.equal(permission.checked,false);
  assert.equal(confirm.disabled,true);
  await confirm.handlers.click();
  assert.equal(svc.calls.filter(c=>c.options.method==='POST').length,0);

  permission.checked=true;
  permission.handlers.change();
  await confirm.handlers.click();
  assert.equal(list.children[0].children[2].textContent,'卸载');
  assert.match(list.children[0].children[1].children[1].textContent,/已安装/);
  assert.equal(permission.checked,false);
  const posted=svc.calls.find(c=>c.options.method==='POST');
  assert.equal(posted.options.headers['X-CSRF-Token'],'synthetic-csrf');
  assert.equal(JSON.parse(posted.options.body).digest,SKILLS[0].digest);
  const next=fakeDocument();next.doc.cookie='__Host-ot_csrf=x';next.el('skills-scope').value='account';await mountSkills(next.doc,{fetcher:svc.fetcher}).ready;
  assert.equal(next.el('skills-list').children[0].children[2].textContent,'卸载');
  await next.el('skills-list').children[0].children[2].handlers.click();
  assert.equal(next.el('skills-list').children[0].children[2].textContent,'安装');
});

test('server refusal keeps the reviewed version open for retry', async () => {
  const svc=service({failWrite:true}),{doc,el}=fakeDocument();doc.cookie='';el('skills-scope').value='account';
  await mountSkills(doc,{fetcher:svc.fetcher}).ready;
  el('skills-list').children[0].children[2].handlers.click();
  el('skills-permission').checked=true;
  await el('skills-review-confirm').handlers.click();
  assert.equal(el('skills-list').children[0].children[2].textContent,'安装');
  assert.equal(el('skills-review-error').textContent,'permission denied');
  assert.equal(el('skills-review').open,true);
  assert.equal(el('skills-review-confirm').disabled,false);
});

// The per-account library mark (issue #263) is a separate persisted record: it never
// grants model context, so the binding button on the same card stays untouched.
const LIBRARY = [
  {id: 'meeting-notes', name: '会议纪要', version: '1.0.0', digest: 'a'.repeat(64), content: 'c'.repeat(120), permissions: ['model_context']},
  {id: 'trip-plan', name: '行程规划', version: '1.0.0', digest: 'b'.repeat(64), content: 'd'.repeat(120), permissions: ['model_context']},
];

function okJson(payload) {
  return {status: 200, ok: true, json: async () => payload};
}

test('accountButtonLabel names the library action instead of pretending to install', () => {
  assert.equal(accountButtonLabel(false), '加入我的技能库');
  assert.equal(accountButtonLabel(true), '移出我的技能库');
});

test('readInstalled asks the account endpoint with the session cookie', async () => {
  const calls = [];
  const installed = await readInstalled(async (url, options) => {
    calls.push({url, options});
    return okJson({installed: ['meeting-notes', 'trip-plan']});
  });
  assert.deepEqual([...installed], ['meeting-notes', 'trip-plan']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/skills/installed');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
});

test('writeInstalled posts an install and deletes a removal with the CSRF token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    return okJson({installed: options.method === 'POST' ? ['meeting-notes'] : []});
  };
  const cookie = '__Host-ot_csrf=token-value';
  const afterInstall = await writeInstalled('meeting-notes', true, {fetchImpl, cookie});
  assert.deepEqual([...afterInstall], ['meeting-notes']);
  assert.equal(calls[0].url, '/v1/skills/installed');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'token-value');
  assert.deepEqual(JSON.parse(calls[0].options.body), {skill: 'meeting-notes'});
  const afterRemoval = await writeInstalled('meeting-notes', false, {fetchImpl, cookie});
  assert.deepEqual([...afterRemoval], []);
  assert.equal(calls[1].options.method, 'DELETE');
});

test('a refused library write rejects with the server message instead of guessing', async () => {
  const fetchImpl = async () => ({status: 403, ok: false, json: async () => ({error: {code: 'csrf', message: 'A valid CSRF token is required'}})});
  await assert.rejects(() => writeInstalled('meeting-notes', true, {fetchImpl, cookie: ''}), /A valid CSRF token is required/);
});

test('the library mark round-trips through the page without a model-context binding', async () => {
  const {doc, el} = fakeDocument();
  doc.cookie = '__Host-ot_csrf=synthetic-csrf';
  el('skills-scope').value = 'account';
  const writes = [];
  let library = new Set();
  const fetcher = async (path) => okJson({items: []});
  const mounted = mountSkills(doc, {
    fetcher, catalogue: LIBRARY,
    read: async () => new Set(library),
    write: async (id, wanted) => {
      writes.push([id, wanted]);
      library = new Set(wanted ? [...library, id] : [...library].filter((value) => value !== id));
      return new Set(library);
    },
  });
  await mounted.ready;
  assert.equal(el('skills-list').children.length, 2);
  assert.equal(el('skills-list').children[0].children[3].textContent, '加入我的技能库');
  await el('skills-list').children[0].children[3].handlers.click();
  assert.deepEqual(writes, [['meeting-notes', true]]);
  assert.equal(el('skills-list').children[0].children[3].textContent, '移出我的技能库');
  assert.equal(el('skills-list').children[0].children[3].attributes['aria-pressed'], 'true');
  assert.equal(el('skills-list').children[0].className.includes('is-in-library'), true);
  assert.equal(el('skills-list').children[0].children[2].textContent, '安装');
  assert.equal(el('skills-list').children[0].children[2].className, 'skill-install');
  assert.equal(mounted.installed.has('meeting-notes'), true);
  await el('skills-list').children[0].children[3].handlers.click();
  assert.deepEqual(writes, [['meeting-notes', true], ['meeting-notes', false]]);
  assert.equal(el('skills-list').children[0].children[3].textContent, '加入我的技能库');
});

test('execution readiness is authoritative, missing/stale versions cannot appear runnable', async () => {
  const {doc,el}=fakeDocument();el('skills-scope').value='account';let code='runtime_upgrade_required';
  const request=async(method,path)=>path.includes('/readiness')?{code,ready:code==='ready'}:{items:[]};
  const app=mountSkillExecution(doc,{request,scope:el('skills-scope')});
  const binding={scope:'account',skill_id:SKILLS[0].id,version:SKILLS[0].version,digest:SKILLS[0].digest};
  app.setSkills(SKILLS,[binding]);await app.refresh();
  assert.equal(el('skill-run-submit').disabled,true);assert.equal(el('skills-readiness').textContent,readinessLabels.runtime_upgrade_required);
  code='ready';await app.refresh();assert.equal(el('skill-run-submit').disabled,false);assert.equal(el('skill-run-skill').value,SKILLS[0].id);
  app.setSkills(SKILLS,[{...binding,digest:'stale'}]);assert.equal(el('skill-run-submit').disabled,true);
});

test('ambiguous skill-run retry keeps its idempotency key; only server history is shown', async () => {
  const {doc,el}=fakeDocument();el('skills-scope').value='account';let attempt=0;const keys=[];
  const request=async(method,path,body,key)=>{
    if(method==='POST'){keys.push(key);if(++attempt===1)throw new Error('response lost');return {task:{id:'actual'}}}
    if(path.includes('/readiness'))return {ready:true,code:'ready'};
    return {items:[]};
  };
  const app=mountSkillExecution(doc,{request,scope:el('skills-scope'),keyFactory:()=>String(keys.length).padStart(20,'k')});
  app.setSkills(SKILLS,[{scope:'account',skill_id:SKILLS[0].id,version:SKILLS[0].version,digest:SKILLS[0].digest}]);await app.refresh();
  el('skill-run-prompt').value='real supplied task';
  await el('skill-run-form').handlers.submit({preventDefault(){}});
  assert.equal(el('skill-run-error').textContent,'response lost');
  assert.match(el('skill-run-history').children[0].textContent,/暂无运行记录/);
  await el('skill-run-form').handlers.submit({preventDefault(){}});
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
});

test('a recognized skill with an unfinished run only offers cancellation', async () => {
  const {doc,el}=fakeDocument();el('skills-scope').value='account';
  const record = {
    scope: 'account', skill_id: SKILLS[0].id, loaded: true, verified: false,
    skills: [{id: SKILLS[0].id}],
    task: {id: 'actual', status: 'claimed', prompt: 'task', result: null},
  };
  const request=async(method,path)=>path.includes('/readiness')?{ready:true,code:'ready'}:{items:path.endsWith('/runs')?[record]:[]};
  const app=mountSkillExecution(doc,{request,scope:el('skills-scope')});await app.refresh();
  const row = el('skill-run-history').children[0];
  assert.equal(row.children[1].textContent, '已确认所选技能可用。');
  assert.doesNotMatch(row.children[3].textContent, /@undefined/);
  assert.equal(row.children.filter(e=>e.tagName==='BUTTON').length,1);assert.equal(row.children[4].textContent,'取消此任务');
});
