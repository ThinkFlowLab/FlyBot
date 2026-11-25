// Immutable package versions and binding metadata live with this runtime.
// Effective instructions are real native DS-Bot capabilities, not a server list.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'
import { importJsonBundles } from '../../lib/b4/importer.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
const builtin = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
const SCOPED = /^(?:(automation):)?([0-9a-f]{32}):([0-9a-f]{32})$/
export const BOUND_PREFIX = 'ot-bound-'
const libraries = new Map()
const sha = s => createHash('sha256').update(s).digest('hex')
const now = () => Math.floor(Date.now()/1000)
const reject = (status,message) => { throw new Fault(status,'package_rejected',message) }
function validate(v) {
  const required = ['id','name','version','content','format','permissions']
  if (!v || typeof v !== 'object' || required.some(k => v[k] === undefined) || Object.keys(v).some(k => ![...required,'digest','source'].includes(k))) reject(400,'Only declarative instruction manifests are accepted')
  if (!/^import-[a-z0-9][a-z0-9-]{1,39}$/.test(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120 || !/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(v.version) || typeof v.content !== 'string' || !v.content.length || v.content.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.name+v.content) || JSON.stringify(v.permissions) !== '["model_context"]' || v.format !== 'flybot-workspace.prompt-skill.v2' || (v.source && v.source !== 'user-imported')) reject(400,'Use a bounded import- manifest, x.y.z version and only model_context permission')
  const digest = sha(v.content)
  if (v.digest && v.digest !== digest) reject(409,'Content digest mismatch')
  return { id:v.id,name:v.name,version:v.version,content:v.content,format:v.format,permissions:v.permissions,digest,source:'user-imported' }
}
function libraryEntry(directory) {
  if (!libraries.has(directory)) {
    const store = openJsonStore(directory, 'library', () => ({ packages:{}, bindings:[], installed:[], imports:[] }))
    let queue = Promise.resolve()
    const serial = fn => {
      const next = queue.then(fn, fn)
      queue = next.catch(() => {})
      return next
    }
    libraries.set(directory, {store, serial})
  }
  return libraries.get(directory)
}
const activeCatalog = data => [...builtin,
  ...Object.values(data.packages).filter(p => p.active).flatMap(p => {
    const version = p.versions.find(v => v.manifest.version === p.version)
    return version ? [version.manifest] : []
  })]
function approved(scope, data, active = activeCatalog(data)) {
  const bindings = data.bindings.filter(binding => binding.scope === 'account' || binding.scope === scope)
  return active.filter(item => bindings.some(binding =>
    binding.skill_id === item.id && binding.version === item.version && binding.digest === item.digest) &&
    JSON.stringify(item.permissions) === '["model_context"]' && sha(item.content) === item.digest)
}
const botScope = bot => bot.flybotWorkspace?.agent_id ? bot.flybotWorkspace.workspace_id + ':' + bot.flybotWorkspace.agent_id : 'account'
const managed = name => typeof name === 'string' && name.startsWith(BOUND_PREFIX)
const matches = (saved, item) => saved?.kind === 'skill' &&
  saved.description === item.name.trim() && saved.content === item.content.trim()
const directoryOf = dataDir => join(dataDir, 'flybot-workspace', 'features', 'skills')

// The DS-Bot native client also mounts capabilities directly. Check its saved
// roster against the same consent store before mounting, even through a pack.
export function nativeSkillFilter(dataDir, boundName) {
  return (bot, names, saved) => {
    if (![...names].some(managed)) return names
    let current = new Map()
    try {
      const {store} = libraryEntry(directoryOf(dataDir))
      current = new Map(approved(botScope(bot), store.read()).map(item => [boundName(item.id), item]))
    } catch {
      // If authorization data cannot be read, leave only unmanaged native capabilities available.
    }
    return new Set([...names].filter(name => !managed(name) ||
      (current.has(name) && matches(saved[name], current.get(name)))))
  }
}

async function applyToBot(rt, botId, items, boundName) {
  const wanted = new Map(items.map(item => [boundName(item.id), item]))
  for (const name of [...(rt.botOf(botId)?.capabilities ?? [])]) {
    if (managed(name) && !wanted.has(name)) await rt.changeCapabilityAttachment('detach', {name}, botId)
  }
  for (const [name, item] of wanted) {
    const saved = rt.state?.capabilities?.items?.[name]
    if (!matches(saved, item)) await rt.capabilitySave({name, kind:'skill', description:item.name, content:item.content}, {ui:true})
    if (!rt.botOf(botId)?.capabilities?.includes(name)) await rt.changeCapabilityAttachment('attach', {name}, botId)
  }
}

function hasCurrentSkills(rt, botId, items, boundName) {
  const bot = rt.botOf(botId)
  if (!bot) return false
  const attached = new Set((bot.capabilities ?? []).filter(managed))
  const wanted = new Map(items.map(item => [boundName(item.id), item]))
  if (attached.size !== wanted.size) return false
  const saved = rt.state?.capabilities?.items
  for (const [name, item] of wanted) {
    if (!attached.has(name) || !matches(saved?.[name], item)) return false
  }
  return true
}

// Reconcile the existing native roster without selecting a provider or creating a bot.
export async function reconcileStartupSkills(rt, dataDir, boundName) {
  await rt.load()
  if (rt.readOnly() !== undefined || !Object.keys(rt.state.bots).length) return
  const {store, serial} = libraryEntry(directoryOf(dataDir))
  await serial(async () => {
    const data = store.read()
    const active = activeCatalog(data)
    for (const bot of Object.values(rt.state.bots)) {
      const items = approved(botScope(bot), data, active)
      const wanted = bot.flybotWorkspace?.agent_id || rt.isMain(bot.id) ? items :
        items.filter(item => bot.capabilities?.includes(boundName(item.id)))
      await applyToBot(rt, bot.id, wanted, boundName)
    }
  })
}

export function skillLibrary(host, { boundName }) {
  const {store, serial} = libraryEntry(host.featureDir())
  importJsonBundles({ host, feature: { name:'skills', importTables:{ imported_skill_heads:[], imported_skill_versions:[], skill_bindings:[], skill_installs:[] } }, store,
    apply(d,t) {
      for (const h of t.imported_skill_heads || []) {
        if (d.packages[h.skill_id]) continue
        const versions = (t.imported_skill_versions || []).filter(v => v.skill_id === h.skill_id).map(v => ({ manifest:validate(JSON.parse(v.manifest)),created:v.created }))
        d.packages[h.skill_id] = { version:h.version, revision:h.revision,active:!!h.active,versions }
      }
      if (!d.bindings.length) d.bindings = (t.skill_bindings || []).map(({scope,skill_id,version,digest,installed}) => ({scope,skill_id,version,digest,installed}))
      if (!d.installed.length) d.installed = (t.skill_installs || []).map(v => v.skill_id)
    }, log: () => host.log('skill library import rejected; bundle retained') })
  const catalog = () => activeCatalog(store.read())
  const metadata = id => { const p=store.read().packages[id]; if (!p) reject(404,'Package not found'); return { id,version:p.version,revision:p.revision,active:p.active,versions:p.versions.map(v => ({version:v.manifest.version,digest:v.manifest.digest,created:v.created})).reverse() } }
  async function target(scope, nativeBotId) {
    const s = await host.runtime()
    if (scope === 'account' && nativeBotId === undefined) return { rt:s.rt, botId:await s.mainBot() }
    const m = SCOPED.exec(scope || '')
    if (!m) throw new Fault(400,'invalid','Invalid skill scope')
    if (nativeBotId !== undefined) {
      // The native turn already resolved its own agent. Match that mapping
      // locally to avoid re-authorizing a binding write on every message.
      const bot = s.rt.botOf(nativeBotId)
      if (!m[1] && bot?.flybotWorkspace?.workspace_id === m[2] && bot.flybotWorkspace.agent_id === m[3]) {
        return { rt:s.rt, botId:nativeBotId }
      }
      throw new Fault(404,'not_found','Native Bot does not match this skill scope')
    }
    const binding = await host.call('agents/personal-binding', {})
    if (binding?.workspace_id !== m[2]) {
      const team = await sharedBotSocial(host).get('/v1/ot/teams/by-workspace/'+m[2])
      if (!['owner','admin'].includes(team.role)) throw new Fault(403,'forbidden','Scope requires workspace administration')
    }
    if (m[1]) { await host.call('automations/get',{workspace_id:m[2],id:m[3]}); return { rt:s.rt, automation:true } }
    const { agent } = await host.call('agents/get',{workspace_id:m[2],id:m[3]})
    if (!agent.native_bot_id || agent.native_deleted) throw new Fault(409,'native_deleted','Native Bot unavailable')
    return { rt:s.rt, botId:agent.native_bot_id }
  }
  async function sync(scope, nativeBotId) {
    const {rt,botId,automation} = await target(scope, nativeBotId)
    const items = approved(scope, store.read())
    if (!automation) await applyToBot(rt, botId, items, boundName)
    return items
  }
  async function syncAll() {
    const {rt, botId} = await target('account')
    const data = store.read()
    const active = activeCatalog(data)
    await applyToBot(rt, botId, approved('account', data, active), boundName)
    for (const bot of Object.values(rt.state.bots)) {
      if (!bot.flybotWorkspace?.agent_id || bot.id === botId) continue
      await applyToBot(rt, bot.id, approved(botScope(bot), data, active), boundName)
    }
  }
  const routes=[
    {method:'GET',path:/^\/v1\/skills\/scopes$/,handle:async()=>{
      const listed = await host.call('teams/v1', {method:'GET',path:'/v1/workspaces?limit=100'})
      if (listed.status !== 200) throw new Fault(listed.status, 'workspaces_unavailable', 'Could not list workspaces')
      const items=[{scope:'account',kind:'account',workspace_id:null,label:'我的账户'}]
      for(const {id:workspaceId, role, name} of listed.body.items){
        if(!['owner','admin'].includes(role))continue
        const [agents,automations]=await Promise.all([host.call('agents/list',{workspace_id:workspaceId}),host.call('automations/list',{workspace_id:workspaceId})])
        items.push(...agents.items.map(a=>({scope:workspaceId+':'+a.id,kind:'agent',workspace_id:workspaceId,id:a.id,label:name+' / '+a.name,administration:true})),...automations.items.map(a=>({scope:'automation:'+workspaceId+':'+a.id,kind:'automation',workspace_id:workspaceId,id:a.id,label:name+' / '+a.title,administration:true})))
      }
      return [200,{items}]
    }},
    {method:'GET',path:/^\/v1\/skills\/catalog$/,handle:async()=>[200,{items:catalog()}]},
    {method:'GET',path:/^\/v1\/skills\/bindings$/,handle:async()=>[200,{items:store.read().bindings}]},
    {method:'POST',path:/^\/v1\/skills\/bindings$/,handle:async({body:b})=>serial(async()=>{
      const item=catalog().find(i=>i.id===b?.skill_id)
      if(!item || typeof b.enabled!=='boolean' || JSON.stringify(b.permissions)!=='["model_context"]') throw new Fault(400,'invalid','Select a known package, scope and explicit model_context permission')
      if(item.version!==b.version || item.digest!==b.digest) throw new Fault(409,'conflict','Package version/digest changed')
      if (b.scope !== 'account' && !SCOPED.test(b.scope || '')) throw new Fault(400,'invalid','Invalid skill scope')
      if (b.enabled) await target(b.scope)
      const d=store.read(), others=d.bindings.filter(x=>x.scope!==b.scope || x.skill_id!==item.id)
      if(b.enabled && (others.length>=200 || new Set([...others.map(x=>x.skill_id),item.id]).size>10)) throw new Fault(429,'quota','Binding capacity reached')
      store.update(d=>{d.bindings=b.enabled?[...others,{scope:b.scope,skill_id:item.id,version:item.version,digest:item.digest,installed:now()}]:others})
      await syncAll(); return [200,{enabled:b.enabled,scope:b.scope,skill_id:item.id}]
    })},
    ...['GET','POST','DELETE'].map(method=>({method,path:/^\/v1\/skills\/installed$/,handle:async({body})=>serial(async()=>{
      if(method!=='GET') {
        if (!catalog().some(i => i.id === body?.skill)) throw new Fault(400,'invalid','Select a known catalog skill')
        store.update(d=>{d.installed=method==='POST'?[...new Set([...d.installed,body.skill])]:d.installed.filter(id=>id!==body.skill)})
      }
      return [200,{installed:store.read().installed}]
    })})),
    {method:'GET',path:/^\/v1\/skills\/packages$/,handle:async()=>[200,{items:Object.keys(store.read().packages).map(metadata)}]},
    {method:'POST',path:/^\/v1\/skills\/packages$/,handle:async({body:b})=>serial(async()=>{
      const item=validate(b?.package), p=store.read().packages[item.id]
      if(b.consent!==true || !Number.isInteger(b.revision) || b.revision!==(p?.revision||0)) reject(409,'Provide current revision and explicit consent')
      const old=p?.versions.find(v=>v.manifest.version===item.version)
      if(old && JSON.stringify(old.manifest)!==JSON.stringify(item)) reject(409,'Versions are immutable')
      const newer=!p || item.version.split('.').map(n=>+n).reduce((v,n)=>v*10000+n,0)>p.version.split('.').map(n=>+n).reduce((v,n)=>v*10000+n,0)
      if(!newer && !(old&&p.active&&p.version===item.version)) reject(409,'Import a newer version; revoked versions cannot regain availability')
      if(!p && Object.keys(store.read().packages).length>=25 || p?.versions.length>=10 && !old) reject(429,'Package capacity reached')
      if(newer)store.update(d=>{d.packages[item.id]={version:item.version,revision:b.revision+1,active:true,versions:[...(p?.versions||[]),{manifest:item,created:now()}]}})
      await syncAll();return [200,{package:item,...metadata(item.id),installed:false}]
    })},
    {method:'GET',path:/^\/v1\/skills\/packages\/(import-[a-z0-9][a-z0-9-]{1,39})(?:\/versions)?$/,handle:async({match})=>[200,metadata(match[1])]},
    {method:'GET',path:/^\/v1\/skills\/packages\/(import-[a-z0-9][a-z0-9-]{1,39})\/versions\/([0-9.]+)$/,handle:async({match})=>{
      const p=store.read().packages[match[1]], v=p?.versions.find(v=>v.manifest.version===match[2]);if(!v)reject(404,'Version not found')
      return [200,v.manifest]
    }},
    {method:'POST',path:/^\/v1\/skills\/packages\/(import-[a-z0-9][a-z0-9-]{1,39})\/revoke$/,handle:async({match,body})=>serial(async()=>{
      const p=metadata(match[1]);if(body?.revision!==p.revision)reject(409,'Package changed; reload')
      if(p.active)store.update(d=>{d.packages[p.id].active=false;d.packages[p.id].revision++;d.bindings=d.bindings.filter(b=>b.skill_id!==p.id);d.installed=d.installed.filter(id=>id!==p.id)})
      await syncAll();return [200,metadata(p.id)]
    })},
  ]
  return { v1:compatHandler(routes), materialForScope: async (payload, call) => {
    if (!call?.internal) throw new Fault(404, 'skills/not-found', 'Internal skill operation')
    const scope = payload?.scope || 'account'
    const nativeBotId = payload?.bot_id
    if (nativeBotId !== undefined) {
      const {rt, botId} = await target(scope, nativeBotId)
      const items = approved(scope, store.read())
      // Read the committed consent and current roster together. A turn with
      // no changes needed can proceed while another scope checks access.
      if (hasCurrentSkills(rt, botId, items, boundName)) return {items}
    }
    return serial(async () => ({items:await sync(scope, nativeBotId)}))
  }}
}
