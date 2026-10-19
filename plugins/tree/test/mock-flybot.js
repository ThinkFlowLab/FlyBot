// In-memory mock of ctx.flybot matching ds-bot types/flybot.d.ts (API v1) / src/host/hooks.js:
// - flybot.scope(plugin) returns the same API with fields/events namespaced to `plugin`;
//   the unscoped service is plugin 'shared'.
// - fields are sync, stored as bot.fields[plugin][key]; null/undefined removes the key.
// - on('change'|'bot.created'|'bot.removed', fn, { all? }); 'change' is own-plugin unless all.
// - bot.create(spec) is async and resolves to the new id; systemPrompt is on the Bot record.
// - bot.isRemote(ref): { kind: 'remote' } or '@handle'; local ids never.
// - bot.hasAnyGrant(id) (#90): true when the Bot has at least one person-grant.
// - send targets: { remote: false, id } | { remote: true, handle, home }.
// - tools.register drops JSON Schema keywords other than type/description/enum/items.
const clone = v => (v === undefined ? undefined : structuredClone(v))
const isRemote = ref => (ref !== null && typeof ref === 'object' && ref.kind === 'remote') || (typeof ref === 'string' && ref.startsWith('@'))
const toRemote = ref => (typeof ref === 'string' ? { kind: 'remote', handle: ref, home: '@' + ref.split('.').slice(1).join('.') } : ref)
const targetOf = ref => (isRemote(ref) ? { remote: true, handle: toRemote(ref).handle, home: toRemote(ref).home } : { remote: false, id: ref })
const keep = ({ type, description, enum: values, items }) => ({ type, ...(description ? { description } : {}), ...(values ? { enum: values } : {}), ...(items ? { items: keep(items) } : {}) })
export function toParameterMap(p) {
  if (p?.type !== 'object' || typeof p.properties !== 'object') return p ?? {}
  const req = new Set(p.required ?? [])
  return Object.fromEntries(Object.entries(p.properties).map(([k, s]) => [k, { ...keep(s), ...(req.has(k) ? { required: true } : {}) }]))
}

export function createMockFlybot() {
  const bots = new Map() // id -> { id, name, systemPrompt, fields: { [plugin]: {...} } }
  const listeners = { 'change': new Set(), 'bot.created': new Set(), 'bot.removed': new Set(), 'bot.grants': new Set(), 'turn.start': new Set(), 'tool.start': new Set() }
  const apis = new Map()
  const middlewares = []
  const tools = new Map()
  const scopes = []
  const grants = new Map()
  let seq = 0
  const granted = b => (grants.get(b?.id) ?? []).some(g => !g.roomId)
  const view = b => b && { id: b.id, name: b.name, isMain: b.isMain === true, granted: granted(b), createdAt: b.createdAt, createdBy: null, systemPrompt: b.systemPrompt ?? '', fields: clone(b.fields) }
  const fire = (ev, payload) => { for (const fn of [...listeners[ev]]) fn({ ...payload }) }
  const onFor = plugin => (ev, fn, { all = false } = {}) => {
    if (!listeners[ev]) throw new Error(`flybot: unknown event ${ev}`)
    const l = ev === 'change' && !all ? c => { if (c.plugin === plugin) fn(c) } : fn
    listeners[ev].add(l); return () => listeners[ev].delete(l)
  }
  const fieldsFor = plugin => ({
    get: (id, k) => clone(bots.get(id)?.fields?.[plugin]?.[k]),
    all: id => clone(bots.get(id)?.fields?.[plugin] ?? {}),
    set: (id, k, v) => {
      const b = bots.get(id); if (!b) throw new Error('flybot: unknown Bot ' + id)
      const prev = clone(b.fields[plugin]?.[k]); const next = v === null ? undefined : clone(v)
      if (JSON.stringify(prev) === JSON.stringify(next)) return
      b.fields[plugin] ??= {}
      if (next === undefined) delete b.fields[plugin][k]; else b.fields[plugin][k] = next
      if (!Object.keys(b.fields[plugin]).length) delete b.fields[plugin]
      fire('change', { botId: id, plugin, key: k, value: next, prev })
    },
    query: (k, v) => [...bots.values()].filter(b => b.fields[plugin] && Object.hasOwn(b.fields[plugin], k) && (v === undefined || JSON.stringify(b.fields[plugin][k]) === JSON.stringify(v))).map(view),
    on: onFor(plugin),
  })
  // Like the core (ds-bot >=0.1.5-flybot.1): ordered by priority band (default DEFAULT), ties by
  // registration. Social registers in the APPROVAL band.
  const PRIORITY = Object.freeze({ ROUTING: 100, DEFAULT: 500, APPROVAL: 900 })
  const prio = m => (Number.isFinite(m.priority) ? m.priority : m.name === 'social' ? PRIORITY.APPROVAL : PRIORITY.DEFAULT)
  const order = () => middlewares.map((m, i) => ({ m, i })).sort((a, b) => prio(a.m) - prio(b.m) || a.i - b.i).map(e => e.m)
  const remote = new Set() // test hook only: local ids the real host would never call remote
  const send = async (req, { bypassEnabled = false } = {}) => {
    const msg = { role: 'request', hop: 0, via: 'shared', exchangeId: `x${++seq}`, ...req, to: isRemote(req.to) ? toRemote(req.to) : req.to, target: req.target ?? targetOf(req.to) }
    let skip = new Set()
    for (const m of order()) {
      if (skip.has(m.name)) continue
      const r = await m.handle(msg)
      if (r === undefined || r === null) continue
      if (r.action === 'allow' && r.bypass && bypassEnabled) { skip = new Set(r.bypass); continue }
      if (r.action === 'allow') continue
      return { ...r, by: m.name }
    }
    return { action: 'allow', exchangeId: msg.exchangeId }
  }
  const build = plugin => {
    scopes.push(plugin)
    const fields = fieldsFor(plugin)
    return {
      version: 1,
      plugin,
      scope: build,
      on: onFor(plugin),
      fields,
      bot: {
        get: id => view(bots.get(id)),
        list: () => [...bots.values()].map(view),
        find: name => view([...bots.values()].find(b => b.name === name)),
        isRemote: ref => isRemote(ref) || remote.has(ref),
        hasAnyGrant: id => granted(bots.get(id)),
        hasGrant: (id, peer) => (grants.get(id) ?? []).some(g => !peer || g.grantee === peer),
        create: async ({ name, systemPrompt, fields: f } = {}) => {
          await Promise.resolve() // really async, like the host
          const id = `bot${++seq}`
          bots.set(id, { id, name, createdAt: seq, systemPrompt: systemPrompt ?? '', fields: f && Object.keys(f).length ? { [plugin]: clone(f) } : {} })
          for (const [key, value] of Object.entries(f ?? {})) fire('change', { botId: id, plugin, key, value: clone(value), prev: undefined })
          fire('bot.created', view(bots.get(id)))
          return id
        },
        setSystemPrompt: (id, text) => { const b = bots.get(id); if (!b) throw new Error('flybot: unknown Bot ' + id); b.systemPrompt = String(text ?? '').trim() },
        fields,
        send: Object.assign((req, opts) => send({ via: plugin, ...req }, opts), {
          use: m => { if (middlewares.some(x => x.name === m.name)) throw new Error('exists'); middlewares.push(m); return () => { const i = middlewares.indexOf(m); if (i >= 0) middlewares.splice(i, 1) } },
          list: () => order().map(m => ({ name: m.name, priority: prio(m), before: m.before ?? [], after: m.after ?? [] })),
          priority: PRIORITY,
        }),
      },
      api: { handle: (name, fn) => { if (apis.has(name)) throw new Error(`flybot: api ${name} exists`); apis.set(name, fn); return () => apis.delete(name) } },
      tools: { register: t => { const spec = { ...t, parameters: toParameterMap(t.parameters) }; tools.set(t.name, spec); return () => tools.delete(t.name) } },
      grants: {
        of: id => clone(grants.get(id) ?? []),
        has: (id, peer) => (grants.get(id) ?? []).some(g => !peer || g.grantee === peer),
        set: async (id, list) => { grants.set(id, Array.isArray(list) ? list : []); fire('bot.grants', view(bots.get(id))) },
      },
    }
  }
  const flybot = build('shared')
  // Test helpers (not part of the real API).
  // Like ds-bot's setup: the first Bot, 'Chief', is a Main Bot (state.mainBotIds). Fires bot.created.
  const addBot = ({ name, isMain = false, systemPrompt = '', fields: f = {} } = {}) => {
    const id = `bot${++seq}`
    bots.set(id, { id, name, isMain, createdAt: seq, systemPrompt, fields: clone(f) })
    fire('bot.created', view(bots.get(id)))
    return id
  }
  const setGrants = (id, list) => { grants.set(id, Array.isArray(list) ? list : []); fire('bot.grants', view(bots.get(id))) }
  const removeBot = id => { const last = view(bots.get(id)); bots.delete(id); fire('bot.removed', { ...last, botId: id, bot: last }) }
  const call = async (botId, name, args = {}) => {
    const t = tools.get(name)
    const visible = t?.visibleTo(botId)
    if (visible instanceof Promise) throw new Error('visibleTo must be sync')
    if (!t || !visible) throw new Error(`tool ${name} not visible to ${botId}`)
    return t.execute(args, { botId })
  }
  // UI endpoint call (flybot.call in the browser) and an activity feed event, like the host's.
  const api = async (name, payload = {}) => { const fn = apis.get(name); if (!fn) throw new Error(`Unknown FlyBot endpoint ${name}`); return fn(payload) }
  const feed = (ev, payload) => fire(ev, payload)
  return { flybot, bots, tools, middlewares, scopes, remote, removeBot, addBot, setGrants, call, api, feed }
}
