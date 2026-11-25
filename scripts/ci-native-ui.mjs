// Synthetic loopback browser fixture. Product data uses the same per-account
// FlyBot plugin handlers and shared Bot Social transport as production.
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Platform} from '../services/bot-social/src/platform.ts';
import {buildServer} from '../services/bot-social/src/server.ts';
import {bulkAuth} from '../services/bot-social/test/helpers.ts';
import agents from '../runtime/flybot-workspace-web/features/agents/index.js';
import {featureHost, registerFeature} from '../runtime/flybot-workspace-web/src/features.js';
import {createDispatch, createLegacyDispatch, createReplyStreamDispatch} from '../runtime/flybot-workspace-web/src/dispatch.js';
import {createPageHandler} from '../runtime/flybot-workspace-web/src/pages.js';
import {createBotSocial, setSharedBotSocial} from '../runtime/flybot-workspace-web/lib/c/bot-social.js';
import {messengerV1} from '../runtime/flybot-workspace-web/lib/c/legacy-v1.js';
import {movedTarget} from '../flybot_workspace/static/shell/dsbot-api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const answer = '来自当前账号 DS-Bot 的验收回复。';
const fixtureResponse = [
  answer, '',
  '| 阶段 | 状态 |', '| --- | --- |', '| 验收 | 通过 |', '',
  '```mermaid', 'flowchart LR', 'A[发送消息] --> B[收到回复]', '```',
].join('\n');
const password = randomUUID() + 'CiFixture!';
const uid = () => randomUUID().replaceAll('-', '');
const featureNames = ['settings', 'model-api', 'agent-api', 'skills', 'teams', 'team-templates', 'artifacts', 'discover', 'social',
  'search', 'studio', 'memory', 'meetings', 'automations', 'team-runs', 'members', 'invites', 'overview', 'shell', 'chat', 'stickers', 'connectors'];
const platformScript = `
import sys
from wsgiref.simple_server import make_server
from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from flybot_workspace.server import QuietHandler, ThreadedWSGIServer
server = make_server('127.0.0.1', 0, lambda env, start: application(env, start),
                     server_class=ThreadedWSGIServer, handler_class=QuietHandler)
origin = f'http://127.0.0.1:{server.server_port}'
application = SettingsPage(App(Store(sys.argv[1]), Config(origin, insecure_local=True, allow_registration=True)))
print(origin, flush=True)
server.serve_forever()
`;

const bodyBytes = async req => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};
function send(res, status, body) {
  res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
function relay(res, response) {
  const headers = Object.fromEntries(response.headers);
  if (response.headers.has('set-cookie')) headers['set-cookie'] = response.headers.getSetCookie();
  res.writeHead(response.status, headers);
  if (response.body) {
    const body = Readable.fromWeb(response.body);
    res.once('close', () => body.destroy());
    body.once('error', () => res.destroy());
    body.pipe(res);
  } else {
    res.end();
  }
}
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

export async function startNativeUI() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'flybot-native-ui-')));
  const scope = new AsyncLocalStorage();
  const accounts = new Map();
  let auth, app, social, engine, socialSocket;
  const sockets = new Set();

  async function close() {
    await closeServer(app);
    for (const socket of sockets) socket.destroy();
    await closeServer(socialSocket);
    await social?.close();
    engine?.close();
    if (auth && auth.exitCode === null && auth.signalCode === null) {
      const exited = once(auth, 'exit');
      auth.kill('SIGTERM');
      await exited;
    }
    setSharedBotSocial(null);
    await rm(temp, {recursive:true, force:true});
  }

  try {
    process.env.FLYBOT_WORKSPACE_AUTOMATIONS_CLOCK = '0';
    auth = spawn(process.env.FLYBOT_WORKSPACE_UI_PYTHON || 'python3', ['-B','-c',platformScript,join(temp,'auth')],
      {cwd:root,stdio:['ignore','pipe','inherit']});
    const [address] = await Promise.race([once(auth.stdout,'data'),
      once(auth,'exit').then(([status]) => { throw new Error('Fixture authentication exited with status '+status); })]);
    const platformOrigin = address.toString().trim();
    assert.match(platformOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const platformRequest = (path, options) => fetch(platformOrigin+path, options);
    const socketPath = join(temp, 'social.sock');
    engine = new Platform({...bulkAuth, now:Date.now, publicBaseUrl:'http://localhost:8787/social'});
    social = buildServer(engine, {fixedBaseUrl:true});
    const socialOrigin = await social.listen({host:'127.0.0.1', port:0});
    socialSocket = createServer((req,res) => social.server.emit('request',req,res));
    socialSocket.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    socialSocket.listen(socketPath);
    await once(socialSocket, 'listening');
    setSharedBotSocial(Object.fromEntries(['request','get','post','put','patch','del','connection'].map(method =>
      [method,(...args) => scope.getStore().social[method](...args)])));
    const factories = await Promise.all(featureNames.map(async name =>
      [name, (await import('../runtime/flybot-workspace-web/features/'+name+'/index.js')).default]));

    async function account(username) {
      const registration = await platformRequest('/v1/auth/register', {method:'POST',
        headers:{origin:platformOrigin,'content-type':'application/json'},
        body:JSON.stringify({username,password})});
      assert.equal(registration.status,201);
      const user = (await registration.json()).user;
      const connector = await fetch(socialOrigin+'/v1/onboard/flybot', {method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({display_name:username})});
      assert.equal(connector.status,201);
      const {token} = (await connector.json()).connector;
      const headers = {authorization:'Bearer '+token,'content-type':'application/json'};
      const profile = await fetch(socialOrigin+'/v1/ot/me',{headers}).then(response => response.json());
      engine.db.prepare('UPDATE ot_profiles SET platform_user_id=? WHERE owner_id=?').run(user.id,profile.owner_id);
      const instanceId = uid();
      const identity = {instanceId, ownerUserId:user.id};
      const dataDir = join(temp,instanceId);
      const credentialsPath = join(temp,instanceId+'.connector.json');
      await writeFile(credentialsPath,JSON.stringify({server:socialOrigin,token}),{mode:0o600});
      const active = {user,instanceId,social:createBotSocial({server:socialOrigin,credentialsPath,
        localSocket:socketPath,localServer:socialOrigin}),profile};
      accounts.set(user.id,active);
      const table = {};
      const model = new Map([['main',{id:'main',name:'Main',model:'CI fixture',capabilities:[]}]]);
      const runtime = {
        ctx:{sessions:{flush:async()=>{}}},
        rt:{state:{bots:Object.fromEntries(model),rooms:{}},chatOwners:new Map(),botOf:id=>model.get(id),
          roomOf(id) { return this.state.rooms[id]; },
          mobileEndpoint() { assert.fail('Unexpected local mobile-only fixture operation'); },
          sendUser() { assert.fail('Shared group messages must use Bot Social'); },
          updateRoom() { assert.fail('Shared group changes must use Bot Social'); },
          deleteRoom(id) { delete this.state.rooms[id]; },
          async save() {},
          async createBot(fields) {
            const bot = {...fields,id:randomUUID(),capabilities:[]};
            model.set(bot.id,bot);
            this.state.bots[bot.id] = bot;
            return bot;
          },
          async updateBot(id,fields) {Object.assign(model.get(id),fields);},
          async setFlags(id,flags) {Object.assign(model.get(id),flags);},
          createSession:async()=>randomUUID(),workDirOf:()=>dataDir},
        mainBot:async()=> 'main',
        chatTurn:async()=>({text:fixtureResponse,sessionId:uid(),turnId:uid()}),
        nativeTurn:async (bot,sessionId,_prompt,_key,{onProgress}={}) => {
          assert.ok(model.has(bot));
          onProgress?.(answer);
          await delay(350);
          onProgress?.(fixtureResponse);
          return {text:fixtureResponse,sessionId,turnId:uid()};
        },
        backgroundTextOnly:async (_prompt,{onProgress,system}={}) => {
          if (system?.startsWith('Draft a configuration for an AI assistant')) {
            return JSON.stringify({name:'访谈整理员',summary:'提取访谈中的需求。',instructions:'按主题归纳访谈，列出待确认问题。',
              quick_starts:['整理这次访谈。']});
          }
          onProgress?.(fixtureResponse);
          return fixtureResponse;
        },
      };
      const host = name => ({...featureHost({name,identity,dataDir,table}),runtime:async()=>runtime,
        currentRuntime:()=>runtime});
      await scope.run(active, async () => {
        const owned = await agents(host('agents'));
        registerFeature(table,'agents',owned);
        const agentId = uid();
        const name = 'CI 个人人工智能体';
        const imported = await owned.endpoints.import({agents:[{id:agentId,workspace_id:instanceId,
          name,instructions:'This is a synthetic CI account.',summary:'只用于 Chromium 验收。'}]});
        assert.equal(imported.imported,1);
        await owned.endpoints['adopt-personal-chat']({workspace_id:instanceId,id:agentId,conversations:[]},false);
        active.agent = (await owned.endpoints.byId({id:agentId})).agent;
        for (const [feature,factory] of factories) {
          const spec = await factory(host(feature));
          if (['artifacts','memory'].includes(feature)) {
            spec.store.run('INSERT INTO ot_users (id, username, is_owner) VALUES (?,?,1)',user.id,user.username);
          }
          registerFeature(table,feature,spec);
        }
        table['messenger/v1'] = messengerV1(host('messenger'),()=>{});
      });
      active.dispatch = createDispatch({endpoints:table});
      active.legacy = createLegacyDispatch({endpoints:table});
      active.replyStream = createReplyStreamDispatch({endpoints:table});
      active.page = createPageHandler({pagesDir:join(root,'flybot_workspace','static'),identity});
      active.rpc = async (endpoint,payload) => scope.run(active,()=>table[endpoint](payload,
        {internal:true,request:new Request('http://localhost/',{headers:{'x-ot-owner-username':user.username}})}));
      active.chat = {name:active.agent.name,reply:answer};
      return active;
    }

    const owner = await account('ci_owner');
    const peer = await account('ci_peer');
    const team = await owner.social.post('/v1/ot/workspaces',
      {name:'CI 协作工作区',slug:'ci-native-workspace',idempotency_key:uid()});
    await owner.social.post('/v1/ot/teams/'+team.id+'/members',{handle:peer.profile.handle,role:'member'});
    const conversations = await owner.rpc('agents/v1',{method:'POST',
      path:`/v1/workspaces/${owner.instanceId}/agents/${owner.agent.id}/conversations`,
      idempotency_key:uid(),body:{title:'CI 原生会话'}});
    assert.equal(conversations.status,201);
    owner.chat.id=conversations.body.conversation.id;
    const archive = await owner.rpc('artifacts/v1',{method:'POST',path:`/v1/workspaces/${owner.instanceId}/artifacts`,
      idempotency_key:uid(),body:{title:'CI 合成工作文档',kind:'document',body:'Fixture content for FlyBot.'}});
    assert.equal(archive.status,201);
    const note = await owner.rpc('memory/v1',{method:'POST',path:`/v1/workspaces/${owner.instanceId}/memory`,
      idempotency_key:uid(),body:{title:'CI 合成记忆',body:'Fixture memory content.'}});
    assert.equal(note.status,201);

    app = createServer(async (req,res) => {
      const url = new URL(req.url,'http://localhost');
      const path = url.pathname;
      const cookie = req.headers.cookie ?? '';
      try {
        if (path === '/favicon.ico') return res.writeHead(204).end();
        if (path.startsWith('/v1/auth/') && path !== '/v1/auth/runtime-readiness') {
          const options = {method:req.method,headers:{cookie,origin:platformOrigin,
            'content-type':req.headers['content-type'] ?? 'application/json',
            'x-csrf-token':req.headers['x-csrf-token'] ?? ''}};
          if (!['GET','HEAD'].includes(req.method)) options.body=await bodyBytes(req);
          return relay(res,await platformRequest(path+url.search,options));
        }
        if (path === '/login' || path === '/register' || path.startsWith('/shell/') || path.startsWith('/home/')) {
          return relay(res,await platformRequest(path+url.search,{headers:{cookie}}));
        }
        const session = await platformRequest('/v1/auth/session',{headers:{cookie}});
        const bound = session.ok ? accounts.get((await session.json()).user.id) : null;
        if (!bound) {
          if (path.startsWith('/v1/') || path.startsWith('/b/')) return send(res,401,{error:{code:'auth_required'}});
          return res.writeHead(302,{location:'/login'}).end();
        }
        if (path === '/b/api/flybot-workspace' || path === '/b/api/flybot-workspace/reply-stream') {
          const handler = path.endsWith('/reply-stream') ? bound.replyStream : bound.dispatch;
          const body = req.method === 'POST' ? await bodyBytes(req) : undefined;
          const request = new Request(url, {method:req.method,body,headers:{
            'content-type':req.headers['content-type'] ?? 'application/json',
            'x-ot-owner-username':bound.user.username,
          }});
          return relay(res,await scope.run(bound,() => handler(request)));
        }
        if (path === '/v1/personal-agent') return send(res,200,{personal_agent:{
          workspace:{id:bound.instanceId,name:'个人工作区',kind:'personal'},agent:bound.agent}});
        if (path === '/v1/auth/runtime-readiness') return send(res,200,{state:'ready',user_id:bound.user.id});
        // Early page reads go straight to the gateway before the browser shim installs.
        const moved = req.method === 'GET' && movedTarget(url, url.origin);
        if (moved) {
          const legacy = new URL('/api/flybot-workspace/legacy', url);
          legacy.search = new URLSearchParams({feature:moved.feature,path,query:url.search.slice(1)});
          const request = new Request(legacy,{headers:{'x-ot-owner-username':bound.user.username}});
          return relay(res,await scope.run(bound,() => bound.legacy(request)));
        }
        if (path.startsWith('/v1/')) return relay(res,await platformRequest(path+url.search,{headers:{cookie}}));
        const page = new URL('http://localhost/api/flybot-workspace/page');
        page.searchParams.set('path',path === '/' ? '/home' : path === '/space' ? '/artifacts' : path);
        return relay(res,await bound.page(new Request(page)));
      } catch (error) {
        if (!res.destroyed && !res.headersSent) send(res,500,{error:{code:'fixture_failed'}});
        console.error('Native UI request failed',path,error?.name,error?.code);
      }
    });
    app.listen(0,'127.0.0.1');
    await once(app,'listening');
    return {origin:'http://127.0.0.1:'+app.address().port, owner, peer, team, password, close};
  } catch (error) {
    await close();
    throw error;
  }
}
