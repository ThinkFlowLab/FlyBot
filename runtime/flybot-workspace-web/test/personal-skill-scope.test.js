import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeSkillFilter, reconcileStartupSkills, skillLibrary } from '../features/skills/library.js'
import { boundName } from '../features/skills/index.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { boot, key } from './helpers.js'

test('local personal skill material does not require a Bot Social team', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-personal-skills-'))
  t.after(() => rmSync(dataDir, { recursive: true }))
  const workspace = 'a'.repeat(32)
  const agent = 'b'.repeat(32)
  const shared = 'c'.repeat(32)
  let socialCalls = 0
  setSharedBotSocial({ async request(method, path) {
    assert.equal(method, 'GET')
    assert.equal(path, '/v1/ot/teams/by-workspace/' + shared)
    socialCalls++
    return {role: 'member'}
  } })
  t.after(() => setSharedBotSocial(undefined))
  const host = {
    featureDir: () => dataDir, dataDir,
    runtime: async () => ({rt: {botOf: () => ({capabilities: []})}}),
    async call(endpoint, payload) {
      if (endpoint === 'agents/personal-binding') return {workspace_id: workspace, agent_id: agent}
      if (endpoint === 'teams/v1') return {status: 200, body: {items: [{id: workspace, role: 'owner', name: '个人工作区'}]}}
      assert.equal(payload.workspace_id, workspace)
      if (endpoint === 'agents/list') return {items: [{id: agent, name: '助手'}]}
      if (endpoint === 'automations/list') return {items: []}
      assert.equal(endpoint, 'agents/get')
      assert.equal(payload.id, agent)
      return {agent: {native_bot_id: 'personal'}}
    },
  }
  const library = skillLibrary(host, {boundName: id => 'ot-bound-' + id})
  const internal = {internal: true}
  assert.deepEqual(await library.materialForScope({scope: workspace + ':' + agent}, internal), {items: []})
  const scopes = await library.v1({method: 'GET', path: '/v1/skills/scopes'})
  assert.equal(scopes.status, 200)
  assert.deepEqual(scopes.body.items.map(item => item.scope), ['account', workspace + ':' + agent])
  assert.equal(socialCalls, 0)
  await assert.rejects(library.materialForScope({scope: shared + ':' + agent}, internal), /Scope requires workspace administration/)
  assert.equal(socialCalls, 1)
})

test('private sends resolve consented current native skills locally and discard stale attachments', async t => {
  const bot = await boot()
  t.after(() => rmSync(bot.vol.root, {recursive: true}))
  const personal = 'a'.repeat(32)
  const shared = 'b'.repeat(32)
  const checkingScope = Promise.withResolvers()
  const releaseScope = Promise.withResolvers()
  let scopeChecks = 0
  setSharedBotSocial({ async request(method, path) {
    assert.equal(method, 'GET')
    assert.equal(path, '/v1/ot/teams/by-workspace/' + shared)
    scopeChecks++
    checkingScope.resolve()
    await releaseScope.promise
    return {role: 'member'}
  } })
  t.after(() => setSharedBotSocial(undefined))
  const turns = []
  const events = new Map()
  const bots = {main: {id:'main', name:'Main', capabilities:[]}}
  const items = {}
  const model = {provider:'platform-model'}
  let writes = 0
  let sessions = 0
  const rt = {
    state: {bots, capabilities:{items}},
    botOf: id => bots[id],
    load: async () => {},
    readOnly: () => undefined,
    isMain: id => id === 'main',
    chatOwners: new Map(),
    live: new Map(),
    save: async () => {},
    createBot: async fields => {
      const id = 'bot-' + Object.keys(bots).length
      return bots[id] = {...fields, id, capabilities:[]}
    },
    createSession: async () => 'session-' + (++sessions),
    workDirOf: () => '/skill-fixture',
    resolveAgent: async id => ({session:{id}}),
    async *eventsBackwards(sessionId) { yield* events.get(sessionId) ?? [] },
    capabilitySave: async (value, options) => {
      assert.equal(value.kind, 'skill')
      assert.deepEqual(options, {ui:true})
      writes++
      items[value.name] = {...value, content:value.content.trim(), description:value.description.trim()}
    },
    changeCapabilityAttachment: async (operation, {name}, botId) => {
      const caps = bots[botId].capabilities
      bots[botId].capabilities = operation === 'attach' ? [...caps,name] : caps.filter(cap => cap !== name)
    },
  }
  bots.main.model = model
  attachRuntime({
    rt, ctx:{sessions:{flush:async () => {}}}, mainBot:async () => 'main', chatTurn:async () => {},
    async nativeTurn(botId, sessionId, prompt, requestId) {
      const target = bots[botId]
      const effective = target.capabilities.map(id => items[id].content)
      turns.push({botId, prompt, model:target.model, effective})
      const history = events.get(sessionId) || []
      history.push({type:'user/message',seq:history.length+1,time:1,data:{content:[{type:'text',text:prompt}],source:{rpcId:requestId}}})
      history.push({type:'assistant/message',seq:history.length+1,time:2,data:{message:{content:[{type:'text',text:'Native reply.'}]}}})
      events.set(sessionId, history)
      return {text:'Native reply.',sessionId,turnId:turns.length}
    },
  })
  t.after(detachRuntime)
  const skills = (method, path, body) => bot.call('skills', method, '/v1/skills/' + path, body)
  const catalogue = () => skills('GET','catalog').then(result => result.body.items)
  const binding = (skill, scope, enabled = true, overrides = {}) => skills('POST','bindings',{
    skill_id:skill.id,version:skill.version,digest:skill.digest,scope,enabled,permissions:['model_context'],...overrides,
  })
  async function conversation(workspace, name) {
    const base = '/v1/workspaces/' + workspace + '/agents'
    const created = await bot.call('agents','POST',base,{name},key())
    assert.equal(created.status, 201)
    const agent = created.body.agent
    const personalScope = workspace + ':' + agent.id
    const path = base + '/' + agent.id + '/conversations'
    const convo = await bot.call('agents','POST',path,{title:'技能私聊'},key())
    assert.equal(convo.status, 201)
    return { scope:personalScope, agent, send: async () => {
      const result = await bot.call('agents','POST',path + '/' + convo.body.conversation.id + '/messages',{body:'按照已安装的指令回答。'},key())
      assert.equal(result.status,201)
      assert.equal(result.body.reply.body,'Native reply.',JSON.stringify(result.body.reply))
      return turns.at(-1)
    }}
  }
  const owner = await conversation(personal,'Personal')
  await bot.features.table['agents/adopt-personal-chat']({workspace_id:personal,id:owner.agent.id,conversations:[]}, false)
  const neighbor = await conversation(shared, 'Team member')
  const builtin = (await catalogue()).find(item => item.id === 'meeting-notes')
  const bundledName = boundName(builtin.id)
  const filter = nativeSkillFilter(bot.vol.data, boundName)
  const ownerBot = bots[owner.agent.native_bot_id]
  items[bundledName] = {kind:'skill',name:bundledName,content:'Unapproved content'}
  ownerBot.capabilities.push(bundledName)
  assert.equal((await skills('POST','installed',{skill:builtin.id})).status,200)
  assert.deepEqual([...filter(ownerBot, new Set([bundledName,'native-office']), items)], ['native-office'])
  assert.deepEqual((await owner.send()).effective, [])
  assert.equal((await binding(builtin, 'account', true, {permissions:[]})).status,400)
  assert.equal((await binding(builtin, 'account', true, {digest:'0'.repeat(64)})).status,409)
  assert.equal((await binding(builtin, 'account')).status,200)
  const obsolete = boundName('unapproved-legacy')
  const description = items[bundledName].description
  items[bundledName].description = description + ' (FlyBot skill meeting-notes v1.0.0, instruction-only)'
  items[obsolete] = {name:obsolete, kind:'skill', content:'Formerly attached without consent'}
  bots.main.capabilities.push(obsolete)
  assert.deepEqual([...filter(bots.main, new Set([bundledName, obsolete]), items)], [])
  await reconcileStartupSkills(rt, bot.vol.data, boundName)
  assert.deepEqual(bots.main.capabilities, [bundledName])
  assert.equal(items[bundledName].description, description)
  assert.deepEqual([...filter(bots.main, new Set([bundledName, obsolete]), items)], [bundledName])
  assert.deepEqual([...filter(bots.main, new Set([bundledName]), {
    [bundledName]: {...items[bundledName], kind:'mcp'},
  })], [])
  const writesAfterInstall = writes
  const accountTurn = await owner.send()
  assert.equal(accountTurn.botId, 'main')
  assert.deepEqual(accountTurn.effective, [builtin.content.trim()])
  assert.equal(accountTurn.model, model)
  assert.doesNotMatch(accountTurn.prompt, /From the transcript supplied/)
  assert.deepEqual((await neighbor.send()).effective, [builtin.content.trim()])
  assert.equal(scopeChecks,0,'sending did not contact the shared workspace')
  assert.equal(writes, writesAfterInstall, 'unchanged material is not resaved on every send')
  const pendingBinding = binding(builtin,neighbor.scope)
  await checkingScope.promise
  const pendingTurn = owner.send()
  let timer
  let earlyTurn
  try {
    earlyTurn = await Promise.race([
      pendingTurn,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 750) }),
    ])
  } finally {
    clearTimeout(timer)
    releaseScope.resolve()
    assert.equal((await pendingBinding).status,403)
    await pendingTurn
  }
  assert.deepEqual(earlyTurn?.effective, [builtin.content.trim()], 'unchanged personal skills do not wait for unresolved team authorization')
  assert.equal(scopeChecks,1,'authorizing a new binding still checks the shared workspace')

  const slug = 'import-' + '0123456789abcdef'.repeat(2)
  const packageAt = (version, revision, content) => skills('POST','packages',{
    package:{id:slug,name:'Owner authored skill',version,content,format:'flybot-workspace.prompt-skill.v2',permissions:['model_context']},
    revision,consent:true,
  })
  assert.equal((await packageAt('1.0.0',0,'Owner instructions V1')).status,200)
  let custom = (await catalogue()).find(item => item.id === slug)
  assert.ok(boundName(slug).length <= 32)
  assert.equal((await binding(custom,owner.scope)).status,200)
  assert.deepEqual((await owner.send()).effective, [builtin.content.trim(),'Owner instructions V1'])
  assert.deepEqual((await neighbor.send()).effective, [builtin.content.trim()])
  assert.equal((await packageAt('1.1.0',1,'Owner instructions V2')).status,200)
  assert.deepEqual((await owner.send()).effective, [builtin.content.trim()])
  assert.equal((await binding(custom,owner.scope)).status,409)
  custom = (await catalogue()).find(item => item.id === slug)
  assert.equal((await binding(custom,owner.scope)).status,200)
  assert.deepEqual((await owner.send()).effective, [builtin.content.trim(),'Owner instructions V2'])
  assert.equal((await binding(builtin,'account',false)).status,200)
  assert.deepEqual((await owner.send()).effective, ['Owner instructions V2'])
  assert.deepEqual((await neighbor.send()).effective, [])
  assert.deepEqual((await skills('GET','installed')).body.installed, [builtin.id])
  assert.equal((await skills('POST','packages/' + slug + '/revoke',{revision:2})).status,200)
  assert.deepEqual((await owner.send()).effective, [])
  assert.equal(scopeChecks,1)
})
