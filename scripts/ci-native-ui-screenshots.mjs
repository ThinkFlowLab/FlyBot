import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startNativeUI} from './ci-native-ui.mjs';

const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: ci-native-ui-screenshots.mjs <output-directory>');
await mkdir(output, {recursive:true});
const fixture = await startNativeUI();
const screenshots = [];
const errors = [];
let browser;

async function contextFor(viewport) {
  const context = await browser.newContext({viewport,locale:'zh-CN',reducedMotion:'reduce'});
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return {context,page};
}

async function screenshot(page, name) {
  const dimensions = await page.evaluate(() => ({width:innerWidth, content:document.documentElement.scrollWidth}));
  assert.ok(dimensions.content <= dimensions.width + 1, name + ' has horizontal overflow');
  await page.screenshot({path:join(output,name+'.png'),animations:'disabled'});
  screenshots.push(name+'.png');
  console.log('Captured', name);
}

async function signIn(page, account) {
  const login = page.locator('#login-form');
  await page.goto(fixture.origin+'/login');
  await login.locator('input[name="username"]').fill(account.user.username);
  await login.locator('input[name="password"]').fill(fixture.password);
  await login.locator('button[type="submit"]').click();
  await page.locator('#home-greeting').waitFor({state:'visible'});
  const session = await page.request.get(fixture.origin+'/v1/auth/session');
  assert.equal((await session.json()).user.id, account.user.id);
}

function chatPath({instanceId,agent,chat}) {
  return '/chat#'+new URLSearchParams({workspace:instanceId,agent:agent.id,conversation:chat.id});
}

async function openNative(page, path, instanceId, selector) {
  const response = await page.goto(fixture.origin+path);
  assert.equal(response.status(),200,path);
  assert.equal(await page.locator('meta[name="flybot-workspace-instance"]').getAttribute('content'),instanceId,path);
  await page.locator(selector).waitFor({state:'visible'});
  const stylesheet = await page.locator('link[rel="stylesheet"][href$="/shell/app.css"]').getAttribute('href');
  assert.match(stylesheet, /^\/chat\/assets\/[a-f0-9]{32}\/shell\/app\.css$/, path);
  assert.equal(await page.evaluate(asset => Array.from(document.styleSheets).some(sheet =>
    sheet.href === new URL(asset,location.href).href),stylesheet),true,path);
}

async function contactApprovalRecovery(sender, receiver) {
  const lookup = async (page, account) => {
    await page.locator('#add-contact').click();
    await page.locator('#contact-handle').fill('@' + account.profile.handle);
    await page.locator('#lookup-contact').click();
    await page.locator('#lookup-handle').getByText('@' + account.profile.handle, {exact:true}).waitFor();
  };
  await openNative(sender,'/contacts',fixture.owner.instanceId,'#add-contact');
  await lookup(sender,fixture.peer);
  await sender.getByRole('button',{name:'发送申请',exact:true}).click();
  await sender.locator('#status').getByText('已发送申请。',{exact:true}).waitFor();

  await openNative(receiver,'/contacts',fixture.peer.instanceId,'#add-contact');
  await lookup(receiver,fixture.owner);
  const routePath = '**/b/api/flybot-workspace';
  let approvals = 0;
  const loseReceipt = async route => {
    const {endpoint,payload} = route.request().postDataJSON() || {};
    if (endpoint !== 'social/v1' || payload?.method !== 'POST' || payload.body?.action !== 'accept' ||
        !/^\/v1\/contacts\/otcpt_/.test(payload.path)) return route.fallback();
    approvals++;
    if (approvals !== 1) return route.fallback();
    const saved = await route.fetch();
    const result = (await saved.json()).value;
    assert.equal(result.status,200);
    assert.equal(result.body.status,'accepted');
    return route.fulfill({json:{ok:true,value:{status:503,body:{error:{message:'确认结果暂未收到。'}}}}});
  };
  await receiver.route(routePath,loseReceipt);
  try {
    await receiver.getByRole('button',{name:'接受申请',exact:true}).click();
    await receiver.locator('#lookup-relationship').getByText('已添加',{exact:true}).waitFor();
    assert.equal(await receiver.locator('#request-contact').textContent(),'聊天');
    assert.equal(approvals,1);
    await screenshot(receiver,'mobile-contact-approval-recovered');
    await receiver.getByRole('button',{name:'关闭',exact:true}).click();
  } finally {
    await receiver.unroute(routePath,loseReceipt);
  }
  for (const [page,account] of [[sender,fixture.peer],[receiver,fixture.owner]]) {
    await page.reload();
    await page.locator('[data-section=accepted]').click();
    await page.locator('#contacts-list li').filter({hasText:'@'+account.profile.handle})
      .getByRole('button',{name:'聊天',exact:true}).waitFor();
  }
}

async function chat(page, name, send) {
  const owner = fixture.owner;
  await openNative(page,chatPath(owner),owner.instanceId,'#chat-body');
  await page.locator('#chat-title').getByText(owner.chat.name,{exact:true}).waitFor();
  const messages = page.locator('#message-list');
  const composer = page.locator('#chat-body');
  if (send) {
    await composer.fill('这是一条正式的浏览器验收消息');
    const [stream] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/b/api/flybot-workspace/reply-stream'),
      page.locator('#chat-send').click(),
    ]);
    await page.waitForFunction(() => document.querySelector('#chat-body').value === '');
    await messages.getByText('这是一条正式的浏览器验收消息',{exact:true}).waitFor();
    assert.equal(stream.headers()['content-type']?.split(';')[0],'text/event-stream');
  }
  await messages.getByText(owner.chat.reply,{exact:true}).waitFor();
  await messages.getByRole('table').getByRole('cell',{name:'通过'}).waitFor();
  await messages.locator('.chat-flowchart').getByText('收到回复',{exact:true}).waitFor();
  assert.equal(await messages.getByText('这是一条正式的浏览器验收消息',{exact:true}).count(),1);
  await screenshot(page,name);
}

async function connectors(page) {
  await openNative(page,'/settings/connectors',fixture.owner.instanceId,'#connectors-filters');
  const rows = page.locator('#connectors-catalog .connector-row:visible');
  const group = id => page.locator('[data-connector-group="'+id+'"]');
  const search = page.locator('#connector-search');
  const jump = page.locator('#connectors-key-jump');
  const focusKey = page.locator('#connectors-catalog button[data-composio-action="focus-key"]:enabled');
  await jump.waitFor();
  assert.equal(await page.locator('#connectors-catalog-count').innerText(),'39 个应用 · 8 个分类');
  assert.equal(await page.locator('#connectors-connected-count').textContent(),'0 个已连接');
  assert.equal(await page.locator('#connectors-filters button').count(),9);
  assert.equal(await rows.count(),39);
  assert.equal(await focusKey.count(),31);
  assert.equal(await page.locator('#connectors-catalog button:disabled').count(),8);
  const writes = [];
  const recordRequest = request => {
    if (new URL(request.url()).pathname !== '/b/api/flybot-workspace' || request.method() !== 'POST') return;
    const body = request.postDataJSON();
    if (body?.endpoint === 'connectors/v1' && body.payload?.method === 'POST') writes.push(body.payload.path);
  };
  page.on('request',recordRequest);
  try {
    await jump.click();
    await page.waitForFunction(() => document.activeElement.id === 'composio-key-input');
    await focusKey.first().click();
    await page.waitForFunction(() => document.activeElement.id === 'composio-key-input');
    await group('dev').press('Enter');
    assert.equal(await group('dev').getAttribute('aria-pressed'),'true');
    assert.equal(await rows.count(),6);
    await search.fill('cloudflare');
    assert.equal(await rows.count(),1);
    assert.equal(await rows.first().getAttribute('data-connector-id'),'cloudflare');
    await group('docs').click();
    assert.equal(await rows.count(),1);
    assert.equal(await rows.first().getAttribute('data-connector-id'),'cloudflare-docs');
    await group('mail').click();
    assert.equal(await rows.count(),0);
    await page.locator('#connectors-empty').waitFor();
    await search.clear();
    await group('all').click();
    assert.equal(await rows.count(),39);
    assert.deepEqual(writes,[]);
  } finally {
    page.off('request',recordRequest);
  }
  await screenshot(page,'desktop-connectors');
}

async function meetingActionContinuity(page, account, name) {
  const workspace = account.instanceId;
  const path = '/v1/workspaces/'+workspace+'/meetings';
  const now = Math.floor(Date.now()/1000);
  const actionName = index => '验收行动项 '+index;
  for (let index = 0; index < 2; index++) {
    const saved = await account.rpc('meetings/v1',{
      method:'POST',path,idempotency_key:randomUUID().replaceAll('-',''),
      body:{title:'CI 行动项验收 '+index,started_at:now-index,attendees:[],summary:'浏览器验收',
        action_items:Array.from({length:40},(_,offset) => ({text:actionName(index*40+offset),owner:account.user.username}))},
    });
    assert.equal(saved.status,201);
  }
  await openNative(page,'/meetings#workspace='+workspace,workspace,'#meeting-inbox-open');
  const list = page.locator('#meeting-inbox-list');
  const open = page.locator('#meeting-inbox-open');
  const more = page.locator('#meeting-inbox-more');
  const row = index => list.getByRole('listitem').filter({has:page.getByText(actionName(index),{exact:true})});
  const source = index => row(index).getByRole('button',{name:'查看会议'});
  const toggle = (index, label) => row(index).getByRole('button',{name:label,exact:true});
  const waitForRows = count => page.waitForFunction(expected => {
    const queue = document.getElementById('meeting-inbox-list');
    return queue.getAttribute('aria-busy') === 'false' && queue.children.length === expected;
  },count);

  await open.click();
  for (const count of [20,40,60]) {
    if (count > 20) await more.click();
    await waitForRows(count);
  }
  const chosen = source(53);
  await chosen.evaluate(button => {
    button.addEventListener('click', () => {
      window.ciMeetingActionTop = button.getBoundingClientRect().top;
    }, {capture:true, once:true});
  });
  await chosen.click();
  const y = await page.evaluate(() => window.ciMeetingActionTop);
  assert.ok(Number.isFinite(y));
  const action = page.getByRole('textbox',{name:'行动项 14',exact:true});
  await page.waitForFunction(text => document.activeElement?.value === text,actionName(53));
  assert.equal(await action.inputValue(),actionName(53));
  await (name.startsWith('mobile') ? page.locator('#meeting-inbox-return') : open).click();
  await waitForRows(60);
  assert.equal(await chosen.evaluate(button => button === document.activeElement),true);
  await chosen.evaluate(async button => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    if (!button.isConnected) throw new Error('Restored action lost focus');
  });
  const restoredY = (await chosen.boundingBox()).y;
  assert.ok(Math.abs(restoredY-y) <= 2, `Action position changed from ${y} to ${restoredY}`);
  await screenshot(page,name);

  await toggle(53,'标记完成').click();
  await page.locator('#meeting-inbox-status').getByText('已标记完成。',{exact:true}).waitFor();
  await waitForRows(60);
  assert.equal(await chosen.count(),0);
  await source(60).waitFor();
  assert.equal(await toggle(54,'标记完成').evaluate(button => button === document.activeElement),true);
  await more.click();
  await waitForRows(79);
  assert.equal(await source(61).evaluate(button => button === document.activeElement),true);
  await page.locator('#meeting-inbox-state').selectOption('completed');
  await waitForRows(1);
  await toggle(53,'重新打开').click();
  await page.locator('#meeting-inbox-status').getByText('已重新打开，行动项已回到待完成。',{exact:true}).waitFor();
  await waitForRows(0);
}

async function agentDraftFromCatalog(page, account, name) {
  const workspace = account.instanceId;
  const path = '/v1/workspaces/'+workspace+'/agents';
  const list = async () => (await account.rpc('agents/v1',{method:'GET',path})).body.items;
  const before = (await list()).length;
  await openNative(page,'/discover?tab=agents',workspace,'#catalog-create-agent');
  await page.locator('#catalog-create-agent').click();
  const form = page.locator('#create-form');
  await form.getByLabel('描述你需要的智能体').fill('整理客户访谈，归纳需求和待确认的问题。');
  await form.getByRole('button',{name:'生成草稿'}).click();
  await form.getByText('草稿已填入下方设置，请核对后创建。',{exact:true}).waitFor();
  assert.equal(await form.locator('[name="name"]').inputValue(),'访谈整理员');
  assert.equal(await form.locator('[name="instructions"]').inputValue(),'按主题归纳访谈，列出待确认问题。');
  assert.equal((await list()).length,before);
  await form.getByLabel('头像').selectOption('mint');
  await form.locator('.agent-portrait-preview .look-avatar[data-color="薄荷绿"]').waitFor();
  assert.equal(await form.locator('fieldset').evaluate(el=>{
    const box=el.getBoundingClientRect();
    const fields = [...el.querySelectorAll('input:not([type="hidden"]), textarea, select')];
    return box.left >= 0 && box.right <= innerWidth + 1 && fields.every(field=>{
      const fieldBox = field.getBoundingClientRect();
      return fieldBox.left >= box.left && fieldBox.right <= box.right + 1;
    });
  }),true);
  await screenshot(page,name);
  await form.getByRole('button',{name:'取消',exact:true}).click();
  await form.waitFor({state:'hidden'});
}

async function agentApiKey(page, account) {
  await openNative(page,'/agents',account.instanceId,'#agent-search');
  const open = page.locator('#agent-list button[data-id="'+account.agent.id+'"]');
  await open.click();
  const form = page.locator('#api-key-form');
  const name = 'CI 一次性验收密钥 '+page.viewportSize().width;
  await form.locator('#api-key-name').fill(name);
  await form.locator('button[type="submit"]').click();
  const row = page.locator('#api-key-list li').filter({hasText:name});
  await row.getByRole('button',{name:'撤销'}).waitFor();
  assert.equal(await page.locator('#api-key-token').isVisible(),true,
    'the one-time token must stay visible after the key list has reloaded');
  const value = page.locator('#api-key-value');
  const token = await value.textContent();
  assert.ok(token?.startsWith('ota_'+account.instanceId+'_'));
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.origin});
  await page.getByRole('button',{name:'复制密钥'}).click();
  assert.ok(await page.evaluate(async expected => await navigator.clipboard.readText() === expected,token));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await row.getByRole('button',{name:'撤销'}).click();
  await row.getByText(name+' · 10 次/分钟 · 已撤销 · 未使用',{exact:true}).waitFor();
  assert.equal(await page.locator('#api-key-token').isVisible(),false);
  assert.equal((await value.textContent()).trim(),'');
  await page.locator('#cancel-edit').click();
}

async function spaceCatalogQueryReturn(page, account) {
  const workspace = account.instanceId;
  const root = '/v1/workspaces/'+workspace+'/artifacts';
  const title = 'CI 工作区链接验收 '+page.viewportSize().width;
  const created = await account.rpc('artifacts/v1',{method:'POST',path:root,
    idempotency_key:randomUUID().replaceAll('-',''),body:{title,kind:'document',body:'用于验证筛选往返。'}});
  assert.equal(created.status,201);

  await openNative(page,'/space?workspace='+workspace,workspace,'#search');
  const search = page.locator('#search');
  const titleButton = page.getByRole('button',{name:title,exact:true});
  const row = page.locator('#artifact-list .artifact-item').filter({has:titleButton});
  const item = row.getByRole('button',{name:title,exact:true});
  await search.fill(title);
  await search.press('Enter');
  await row.locator('.artifact-cover').click();
  await page.locator('#editor-title').waitFor();
  assert.equal(await page.locator('#editor-title').inputValue(),title);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(title => document.querySelector('#editor-title')?.value === title,title);
  await page.locator(page.viewportSize().width < 700 ? '#cancel-editor-load' : '#cancel-editor').click();
  await item.waitFor();
  assert.equal(await search.inputValue(),title,'a workspace-qualified catalog URL restores its saved search');
  assert.equal(await item.evaluate(el => el === document.activeElement),true);
  assert.deepEqual([...new URL(page.url()).searchParams],[['workspace',workspace]]);

  const grid = page.getByRole('tab',{name:'网格视图'});
  const list = page.getByRole('tab',{name:'列表视图'});
  const originalRow = await item.elementHandle();
  await grid.press('ArrowRight');
  assert.equal(await list.getAttribute('aria-selected'),'true');
  assert.equal(await originalRow.evaluate(el => el.isConnected),true);
  await originalRow.dispose();
  assert.equal(await row.getByRole('button',{name:'收藏',exact:true}).isVisible(),true);
  const more = row.getByRole('button',{name:title+'：更多操作'});
  await more.click();
  await page.getByRole('menuitem',{name:'发送到聊天'}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await more.evaluate(el => el === document.activeElement),true);

  await search.fill(title+' 未匹配');
  await search.press('Enter');
  await page.locator('#reset-artifact-search').click();
  await item.waitFor();
  assert.equal(await search.inputValue(),'');
  assert.equal(await search.evaluate(el => el === document.activeElement),true);
}

async function memoryGraphReturn(page, account) {
  const workspace = account.instanceId;
  const base = '/v1/workspaces/'+workspace+'/memory';
  const mobile = page.viewportSize().width < 700;
  const title = mobile ? 'CI 手机图谱来源' : 'CI 桌面图谱来源';
  const create = async title => {
    const result = await account.rpc('memory/v1',{method:'POST',path:base,
      idempotency_key:randomUUID().replaceAll('-',''),body:{title,body:'图谱返回验收'}});
    assert.equal(result.status,201);
    return result.body.page.id;
  };
  const id = await create(title);
  await create(title+'关联节点');

  await openNative(page,'/memory?workspace='+workspace,workspace,'#main-panel');
  const graphToggle = page.locator('#memory-mobile-graph');
  if (mobile) await graphToggle.click();
  const filter = page.locator('#topic-search');
  await filter.fill(title);
  await page.locator('#graph-zoom-in').click();
  const graph = page.locator('#graph-world');
  const zoom = await graph.getAttribute('transform');
  const node = graph.locator('[data-id="'+id+'"]');
  if (mobile) await node.locator('circle').click();
  else await node.press('Enter');
  const editor = page.locator('#editor-form');
  const back = page.locator('#close-editor');
  await editor.waitFor();
  assert.equal(await editor.locator('[name="title"]').inputValue(),title);
  assert.equal(new URL(page.url()).searchParams.get('page'),id);
  await back.click();
  await editor.waitFor({state:'hidden'});
  if (mobile) assert.equal(await graphToggle.getAttribute('aria-expanded'),'true',
    'closing a graph node on mobile returns to the graph');
  assert.equal(await node.evaluate(element => element === document.activeElement),true,
    'closing a graph node restores focus to that node');
  assert.equal(await filter.inputValue(),title);
  assert.equal(await graph.getAttribute('transform'),zoom);
  assert.equal(new URL(page.url()).searchParams.get('page'),null);

  if (!mobile) {
    await node.press('Space');
    await editor.waitFor();
    assert.equal(await editor.locator('[name="title"]').inputValue(),title);
    await back.click();
  }
}

async function memoryTableEditing(page, account, name) {
  const workspace = account.instanceId;
  const base = '/v1/workspaces/'+workspace+'/memory';
  const body = '- [x] 核对内容\n\n| 内容 | 状态 |\n| :--- | ---: |\n| 初稿 | 待处理 |';
  const created = await account.rpc('memory/v1',{method:'POST',path:base,
    idempotency_key:randomUUID().replaceAll('-',''),body:{title:'记忆表格验收',body}});
  assert.equal(created.status,201);
  const pageId = created.body.page.id;
  await openNative(page,'/memory?workspace='+workspace+'&page='+pageId,workspace,'#editor-rich');
  const editor = page.locator('#editor-rich');
  const table = editor.getByRole('table');
  const actions = page.locator('#editor-table-actions');
  const summary = actions.locator('summary');
  const action = label => actions.getByRole('button',{name:label,exact:true});
  await table.getByRole('cell',{name:'初稿',exact:true}).click();
  await summary.click();
  await screenshot(page,name);
  await action('下方插入行').click();
  await page.keyboard.insertText('终稿 | 核对');
  await table.getByRole('cell',{name:'终稿 | 核对',exact:true}).waitFor();
  await summary.click();
  await action('右侧插入列').click();
  await page.keyboard.insertText('已复核');
  await summary.click();
  await action('删除当前列').click();
  assert.equal(await table.getByRole('columnheader').count(),2);
  await page.locator('[data-rich="undo"]').click();
  await table.getByRole('cell',{name:'已复核',exact:true}).waitFor();
  assert.equal(await table.getByRole('columnheader').count(),3);
  await page.locator('#save-page').click();
  await page.locator('#editor-meta').getByText(/修订 2/).waitFor();
  const saved = await account.rpc('memory/v1',{method:'GET',path:base+'/'+pageId});
  assert.ok(saved.body.page.body.includes('| 终稿 \\| 核对 | 已复核 |'));
  assert.ok(saved.body.page.body.includes('| :--- | --- | ---: |'));
  await page.reload();
  await table.getByRole('cell',{name:'终稿 | 核对',exact:true}).waitFor();
  assert.equal(await editor.getByRole('checkbox',{name:'核对内容'}).isChecked(),true);
}

async function memoryHistory(page, account, name) {
  const workspace = account.instanceId;
  const base = '/v1/workspaces/'+workspace+'/memory';
  const body = revision => '浏览器验收正文 '+revision;
  const created = await account.rpc('memory/v1',{method:'POST',path:base,
    idempotency_key:crypto.randomUUID().replaceAll('-',''),body:{title:'CI 记忆历史验收',body:body(1)}});
  assert.equal(created.status,201);
  const id = created.body.page.id;
  const path = base+'/'+id;
  for (let revision = 1; revision < 55; revision++) {
    const saved = await account.rpc('memory/v1',{method:'POST',path,
      body:{revision,changes:{body:body(revision+1)}}});
    assert.equal(saved.status,200);
  }
  await openNative(page,'/memory?workspace='+workspace+'&page='+id,workspace,'#page-history-open');
  const list = page.locator('#page-history-list');
  const more = page.locator('#page-history-more');
  const oldest = list.locator('[data-revision="6"]');
  const heading = page.locator('#page-history-preview-title');
  const previewBody = page.locator('#page-history-preview-body');
  await page.locator('#page-history-open').click();
  for (const count of [20,40,49]) {
    if (count > 20) await more.click();
    await page.waitForFunction(expected => document.getElementById('page-history-list').children.length === expected,count);
  }
  assert.equal(await more.isVisible(),false);
  assert.equal(await list.locator('[data-revision="5"]').count(),0);
  await oldest.click();
  await previewBody.getByText(body(6),{exact:true}).waitFor();
  assert.equal(await heading.evaluate(el => el === document.activeElement),true);
  await screenshot(page,name);
  await page.locator('#page-history-preview-back').click();
  assert.equal(await oldest.evaluate(el => el === document.activeElement),true);
  await oldest.click();
  await previewBody.getByText(body(6),{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('revision'),'6');
  await page.reload();
  await previewBody.getByText(body(6),{exact:true}).waitFor();
  await page.locator('#page-history-restore').click();
  await page.locator('#editor-meta').getByText(/修订 56/).waitFor();
  const current = await account.rpc('memory/v1',{method:'GET',path});
  assert.equal(current.body.page.revision,56);
  assert.equal(current.body.page.body,body(6));
  const previouslyCurrent = await account.rpc('memory/v1',{method:'GET',path:path+'/versions/55'});
  assert.equal(previouslyCurrent.body.version.body,body(55));
}

try {
  browser = await chromium.launch({executablePath:process.env.FLYBOT_WORKSPACE_UI_CHROMIUM_EXECUTABLE});
  const desktop = await contextFor({width:1440,height:900});
  const {page} = desktop;
  await page.goto(fixture.origin+'/login');
  await page.locator('#login-form').waitFor({state:'visible'});
  assert.equal(await page.locator('link[rel="stylesheet"][href="/shell/app.css"]').count(),1);
  await screenshot(page,'desktop-login');
  await signIn(page,fixture.owner);
  await screenshot(page,'desktop-home');
  await chat(page,'desktop-chat',true);
  const scenes = [
    ['/settings','#settings-panel','desktop-settings'],
    ['/agents','#agent-search','desktop-agents'],
    ['/space','#artifact-list','desktop-space','CI 合成工作文档'],
    ['/memory','#main-panel','desktop-memory','CI 合成记忆'],
    ['/automations','#list-empty','desktop-automations'],
    ['/meetings','#meetings-empty','desktop-meetings'],
    ['/discover','#main-panel','desktop-discover'],
  ];
  for (const [path,selector,name,expected] of scenes) {
    await openNative(page,path,fixture.owner.instanceId,selector);
    if (expected) await page.getByText(expected,{exact:true}).first().waitFor();
    await screenshot(page,name);
  }
  await agentApiKey(page,fixture.owner);
  await spaceCatalogQueryReturn(page,fixture.owner);
  await memoryGraphReturn(page,fixture.owner);
  await agentDraftFromCatalog(page,fixture.owner,'desktop-agent-draft');
  await memoryHistory(page,fixture.owner,'desktop-memory-history');
  await memoryTableEditing(page,fixture.owner,'desktop-memory-table');
  await connectors(page);
  await meetingActionContinuity(page,fixture.owner,'desktop-meeting-actions');
  await openNative(page,'/members#workspace='+fixture.team.workspace_id,fixture.owner.instanceId,'#main-panel');
  await page.locator('#member-list').getByText(fixture.peer.profile.handle.split('.')[0],{exact:true}).first().waitFor();
  await screenshot(page,'desktop-members');
  await openNative(page,chatPath(fixture.owner),fixture.owner.instanceId,'#chat-body');
  await page.locator('#new-conversation').click();
  await page.locator('#compose-new-group').click();
  await page.locator('#compose-mode-team').click();
  await page.locator('#team-template-choices input').first().check();
  await page.locator('#compose-dialog-submit').click();
  await page.locator('#compose-dialog').waitFor({state:'hidden'});
  await page.locator('#chat-title').getByText('产品研发小队',{exact:true}).waitFor();
  await page.locator('#conversation-agents-label').click();
  const roster = page.locator('#group-agent-chips .group-roster-name');
  await roster.filter({hasText:'产品经理助理'}).waitFor();
  assert.equal(await roster.count(),3);
  await screenshot(page,'desktop-template-group');

  const mobile = await contextFor({width:390,height:844});
  await signIn(mobile.page,fixture.owner);
  await chat(mobile.page,'mobile-chat',false);
  await agentApiKey(mobile.page,fixture.owner);
  await mobile.context.close();

  const peer = await contextFor({width:1440,height:900});
  await signIn(peer.page,fixture.peer);
  assert.notEqual(fixture.peer.instanceId,fixture.owner.instanceId);
  await openNative(peer.page,'/chat',fixture.peer.instanceId,'#session-pane');
  const otherPrivateChat = await peer.page.request.post(fixture.origin+'/b/api/flybot-workspace',{
    data:{endpoint:'agents/v1',payload:{method:'GET',
      path:'/v1/workspaces/'+fixture.owner.instanceId+'/agents/'+fixture.owner.agent.id+'/conversations/'+fixture.owner.chat.id}},
  });
  const isolation = await otherPrivateChat.json();
  assert.equal(isolation.ok,true);
  assert.equal(isolation.value.status,404);
  assert.ok(!JSON.stringify(isolation).includes(fixture.owner.chat.reply));
  await peer.page.setViewportSize({width:390,height:844});
  await meetingActionContinuity(peer.page,fixture.peer,'mobile-meeting-actions');
  await spaceCatalogQueryReturn(peer.page,fixture.peer);
  await memoryGraphReturn(peer.page,fixture.peer);
  await agentDraftFromCatalog(peer.page,fixture.peer,'mobile-agent-draft');
  await memoryHistory(peer.page,fixture.peer,'mobile-memory-history');
  await memoryTableEditing(peer.page,fixture.peer,'mobile-memory-table');
  await contactApprovalRecovery(page,peer.page);
  await peer.context.close();
  await desktop.context.close();
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'coverage.json'), JSON.stringify({screenshots,privateChatIsolated:true},null,2)+'\n');
} finally {
  await browser?.close();
  await fixture.close();
}
