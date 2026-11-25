import assert from 'node:assert/strict';
import test from 'node:test';
import {mountAgentSharing} from '../flybot_workspace/static/agents/sharing.mjs';

class Element {
  constructor() { this.children=[]; this.handlers={}; this.value=''; this.textContent=''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  focus() {}
  select() {}
}

test('sender shares the saved revision with the selected teammate and can revoke after archiving', async () => {
  const elements = new Map();
  const doc = {defaultView:{location:{origin:'https://local.example'}},createElement:()=>new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id,new Element());
      return elements.get(id);
    }};
  const el = id => doc.getElementById('agent-share-'+id);
  const source = {id:'agent-a', revision:7, name:'草稿助理', instructions:'私人指令', quick_starts:['私人开场']};
  const actor = {agent:source,workspace:'space-a',user:'sender-id'};
  const recipient = {owner_id:'recipient-id',handle:'real-teammate',display_name:'同名成员'};
  const other = {owner_id:'other-id',handle:'other-teammate',display_name:'同名成员'};
  const grant = {id:'otag_'+'A'.repeat(26),state:'active',source_agent_id:source.id,recipient};
  const path = '/v1/workspaces/space-a/agents/agent-a/shares';
  const calls = [];
  let savedGrant;
  let firstAttempt = true;
  const panel = mountAgentSharing(doc,{context:()=>actor,idempotencyKey:()=>`scope-send-key-${calls.length}`,
    request:async (method,route,body,headers)=>{
      calls.push({method,route,body,headers});
      if (route.startsWith('/v1/agent-copy-grants/recipients?')) return {status:200,body:{items:[recipient,other]}};
      if (route === path + '?limit=30') return {status:200,body:{items:savedGrant ? [savedGrant] : []}};
      if (route === path) {
        if (firstAttempt) { firstAttempt = false; throw new Error('response lost'); }
        savedGrant = grant;
        return {status:201,body:{grant}};
      }
      if (route === `${path}/${grant.id}/revoke`) {
        savedGrant = {...grant,state:'revoked'};
        return {status:200,body:{grant:savedGrant}};
      }
      throw new Error(route);
    }});
  panel.open();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('submit').disabled,true);
  assert.deepEqual(el('recipient').children.slice(1).map(row=>row.textContent),['同名成员 · @real-teammate','同名成员 · @other-teammate']);
  el('recipient').value = recipient.owner_id;
  el('recipient').handlers.change();
  assert.equal(el('instructions').checked,false);
  assert.equal(el('quick-starts').checked,false);
  el('quick-starts').checked = true;
  const send = ()=>el('form').handlers.submit({preventDefault() {}});
  await send();
  await send();
  const [first,retry] = calls.filter(call=>call.method==='POST');
  assert.deepEqual(first.body,{recipient_owner_id:recipient.owner_id,revision:7,share_instructions:false,share_quick_starts:true});
  assert.deepEqual(first,retry);
  assert.equal(el('link').value,`https://local.example/discover?tab=agents&share=${grant.id}`);

  panel.close();
  actor.agent = {...source,archived:true};
  panel.open();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('form').hidden,true);
  assert.equal(calls.filter(call=>call.route.includes('/recipients')).length,1);
  const row = el('sent').children[0];
  row.children.find(button=>button.textContent==='撤销').handlers.click();
  assert.equal(calls.some(call=>call.route.endsWith('/revoke')),false);
  row.children.find(button=>button.textContent==='确认撤销').handlers.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.at(-1),{method:'POST',route:`${path}/${grant.id}/revoke`,body:{},headers:undefined});
  assert.equal(el('sent').children[0].children[0].textContent,'同名成员 · @real-teammate · 已撤销');
});

test('original-agent access authorizes and revokes a specific conversation independently of copies', async () => {
  const elements = new Map();
  const doc = {defaultView:{location:{origin:'https://local.example'}},createElement:()=>new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id,new Element());
      return elements.get(id);
    }};
  const el = id => doc.getElementById('agent-share-'+id);
  const source = {id:'a'.repeat(32), revision:8, name:'校对助理', instructions:'保存的指令', quick_starts:['保存的开场']};
  const actor = {agent:source,workspace:'workspace-a',user:'sender-account'};
  const recipient = {owner_id:'recipient-id',handle:'first-peer',display_name:'同名成员'};
  const other = {owner_id:'other-id',handle:'second-peer',display_name:'同名成员'};
  const access = {conversation_id:'otc_'+'A'.repeat(26),agent_id:source.id,owner_id:'sender-social',recipient,created_at:1};
  const existing = {...access,conversation_id:'otc_'+'B'.repeat(26),recipient:other};
  const path = `/v1/workspaces/workspace-a/agents/${source.id}/access`;
  const calls = [];
  const panel = mountAgentSharing(doc,{context:()=>actor,idempotencyKey:()=>`access-key-${calls.length}`,
    request:async (method,route,body,headers)=>{
      calls.push({method,route,body,headers});
      if (route.startsWith('/v1/agent-copy-grants/recipients?')) return {status:200,body:{items:[recipient,other]}};
      if (route === path + '?limit=30') return {status:200,body:{items:[existing]}};
      if (route === path) return {status:201,body:{access}};
      if (route === `${path}/${access.conversation_id}/revoke`) return {status:200,body:{revoked:true}};
      throw new Error(route);
    }});
  panel.open({access:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('title').textContent,'授权与原智能体对话');
  assert.equal(el('content').hidden,true);
  el('recipient').value = recipient.owner_id;
  el('recipient').handlers.change();
  el('instructions').checked = el('quick-starts').checked = true;
  await el('form').handlers.submit({preventDefault() {}});
  const create = calls.find(call=>call.method==='POST');
  assert.equal(create.route,path);
  assert.deepEqual(create.body,{recipient_owner_id:recipient.owner_id,revision:8});
  assert.match(create.headers['Idempotency-Key'],/^access-key-/);
  const href = `/chat#social=${access.conversation_id}&access_owner=${access.owner_id}&access_agent=${source.id}`;
  assert.equal(el('open-chat').href,href);
  assert.equal(el('link').value,'https://local.example'+href);
  assert.equal(el('open-chat').hidden,false);
  assert.equal(el('sent').children.length,2);

  const [target] = el('sent').children;
  target.children.find(button=>button.textContent==='撤销').handlers.click();
  assert.equal(calls.filter(call=>call.method==='POST').length,1);
  target.children.find(button=>button.textContent==='确认撤销').handlers.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.at(-1),{method:'POST',route:`${path}/${access.conversation_id}/revoke`,body:{},headers:undefined});
  assert.equal(el('open-chat').hidden,true);
  assert.equal(el('open-chat').href,undefined);
  assert.equal(el('sent').children[0].children[0].textContent,'同名成员 · @first-peer · 已撤销');
  assert.equal(el('sent').children[1].children[0].textContent,'同名成员 · @second-peer · 有效');
  assert.ok(calls.every(call=>!call.route.includes('/shares')));
});
