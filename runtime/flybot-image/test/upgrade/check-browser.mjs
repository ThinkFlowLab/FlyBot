import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const request = JSON.parse(readFileSync(0,'utf8'));
const {origin, accounts, phase} = request;
const modulePath = resolve(process.env.FLYBOT_WORKSPACE_UPGRADE_PLAYWRIGHT || 'node_modules/playwright/index.mjs');
const {chromium} = await import(pathToFileURL(modulePath).href);
const chrome = await chromium.launch({
  headless: true,
  ...(process.env.FLYBOT_WORKSPACE_UPGRADE_CHROME ? {executablePath:process.env.FLYBOT_WORKSPACE_UPGRADE_CHROME} : {}),
  args: ['--no-sandbox'],
});
const shots = process.env.FLYBOT_WORKSPACE_UPGRADE_SHOTS;
if (shots) mkdirSync(shots,{recursive:true});

function chatUrl(account, conversation) {
  return '/chat#'+new URLSearchParams({workspace:account.workspaceId,agent:account.agentId,conversation:conversation.id});
}

function apiPath(account, conversation) {
  return '/v1/workspaces/'+account.workspaceId+'/agents/'+account.agentId+'/conversations/'+conversation.id;
}

async function retainedText(page, text) {
  const row = page.locator('#message-list').getByText(text,{exact:true});
  await row.waitFor();
  assert.equal(await row.count(),1,'one durable message after upgrade: '+text);
}

async function send(page, text) {
  const composer = page.locator('#chat-body');
  await composer.fill(text);
  const streamReady = page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/flybot-workspace/reply-stream'));
  await page.locator('#chat-send').click();
  const stream = await streamReady;
  assert.equal(stream.status(),200);
  assert.equal(stream.headers()['content-type']?.split(';')[0],'text/event-stream');
  await page.waitForFunction(()=>document.getElementById('chat-body').value==='');
  await retainedText(page,text);
}

try {
  for (const [index, account] of accounts.entries()) {
    const foreign = accounts[1-index];
    const context = await chrome.newContext({
      viewport: {width:index===0 ? 1280 : 390,height:850},
      reducedMotion:'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    const errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    await page.goto(origin+'/login');
    const form = page.locator('#login-form');
    await form.locator('[name=username]').fill(account.username);
    await form.locator('[name=password]').fill(account.password);
    const login = page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/auth/login');
    await form.locator('button[type=submit]').click();
    assert.equal((await login).status(),200,'platform login succeeds');
    await page.waitForURL(url=>url.pathname!=='/login');
    const cookies = await context.cookies();
    assert.ok(cookies.some(cookie=>cookie.name==='ot_dev_session'),'platform cookie present');
    assert.ok(cookies.every(cookie=>!cookie.name.startsWith('dsh-auth-')),'runtime cookie stays behind the gateway');

    for (const [slot, conversation] of account.conversations.slice(0,2).entries()) {
      const navigation = await page.goto(origin+chatUrl(account,conversation)) ?? await page.reload();
      assert.equal(navigation.status(),200);
      assert.equal(navigation.headers()['x-flybot-workspace-served-by'],'ds-bot; instance='+account.instanceId);
      assert.equal(await page.locator('meta[name=flybot-workspace-instance]').getAttribute('content'),account.instanceId);
      await page.locator('#chat-body').waitFor();
      await retainedText(page,conversation.marker);
      const detail = await page.request.get(origin+apiPath(account,conversation));
      assert.equal(detail.status(),200);
      assert.equal((await detail.json()).conversation.native_session_id,conversation.sessionId);
      if (slot===0 && phase!=='baseline') await retainedText(page,account.conversations[2].marker);
      if (phase==='restart') await retainedText(page,conversation.postUpgrade);
      const excluded = [account.conversations[1-slot].marker,account.conversations[3].marker,foreign.conversations[slot].marker];
      if (slot===1 && phase!=='baseline') excluded.push(account.conversations[2].marker);
      for (const marker of excluded) assert.equal(await page.locator('#message-list').getByText(marker,{exact:true}).count(),0,marker);

      const denied = await page.request.get(origin+apiPath(foreign,foreign.conversations[slot]));
      assert.equal(denied.status(),404);
      if (phase==='upgraded') {
        await send(page,conversation.postUpgrade);
        await page.waitForFunction(async ({path, marker})=>{
          const response = await fetch(path);
          const {items} = await response.json();
          const own = items?.findIndex(row=>row.role==='user' && row.body===marker) ?? -1;
          return own >= 0 && items.slice(own+1).some(row=>row.role==='assistant' && row.status==='succeeded' && row.body?.startsWith('CI-DSBOT-REPLY'));
        }, {path:apiPath(account,conversation),marker:conversation.postUpgrade}, {timeout:90000});
      }
      if (shots) await page.screenshot({path:join(shots,phase+'-'+index+'-'+slot+'.png')});
    }
    assert.deepEqual(errors,[]);
    await context.close();
    console.log(JSON.stringify({phase,account:index,conversations:2,foreignDenied:true}));
  }
} finally {
  await chrome.close();
}
