// Models. Every Bot runs on one model of its own, fixed when it is created and changed
// only in its settings or by a Main Bot. The team's first Main Bot has none until the
// user picks one in its chat. The Session keeps the selection durably.
import { normalize, splitRef } from './text.js'

const CATALOG_TTL_MS = 10_000
const ROUTE_WAIT_MS = 30_000
const TEST_TIMEOUT_MS = 30_000
const TEST_MAX_TOKENS = 16
const TEST_PROMPT = 'Reply with the single word OK.'

// The outcome of a connection test as a code only (#409). A provider's own text can
// echo part of a key, so none of it leaves the host: the client words each code.
export function testFailure(failure, aborted = false) {
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const message = String(failure?.message ?? '')
  const status = typeof failure?.status === 'number' ? failure.status : Number(/^HTTP_(\d{3})$/.exec(code)?.[1] ?? NaN)
  if (/\bno api key\b|\bmissing (?:an? )?api key\b|\bapi key (?:is )?(?:missing|not set|not configured)\b/i.test(message)) return 'NO_KEY'
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || status === 401 || status === 403) return 'AUTH'
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || status === 402) return 'QUOTA'
  if (code === 'RATE_LIMIT' || status === 429) return 'RATE_LIMIT'
  if (aborted || code === 'TIMEOUT' || code === 'ABORTED') return 'TIMEOUT'
  if (code === 'NO_ADAPTER') return 'NOT_SERVED'
  if (status === 404 || /\bmodel\b.{0,40}\b(?:not found|does not exist|not exist|unknown|not supported)\b/i.test(message)) return 'MODEL_NOT_FOUND'
  if (code === 'TRANSPORT') return 'TRANSPORT'
  if (code === 'SERVER' || (status >= 500 && status < 600)) return 'SERVER'
  if (code === 'INVALID_REQUEST' || status === 400) return 'INVALID_REQUEST'
  return 'UNKNOWN'
}

export function install(rt) {
  const { ctx, state } = rt

  let modelsSynced = null
  let catalogCache = { at: 0, value: [] }
  // A model's thinking levels, resolved once and kept for a short while: they change
  // only with the provider, which also drops the catalog cache.
  const reasoningCache = new Map()
  ctx.on?.('llm/adapters-updated', () => { catalogCache = { at: 0, value: [] }; reasoningCache.clear() })

  // The thinking levels a model serves: `{efforts: [{id, name, description?}],
  // defaultEffort?}`, or undefined when it has none or the provider cannot say.
  async function reasoningOf(ref) {
    const cached = reasoningCache.get(ref)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
    const route = splitRef(ref)
    const info = route === undefined ? undefined : await ctx.llm.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
    const value = info?.reasoning === undefined ? undefined : {
      efforts: (info.reasoning.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id, ...(effort.description ? { description: effort.description } : {}) })),
      ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
    }
    reasoningCache.set(ref, { at: Date.now(), value })
    return value
  }

  // A provider's model list can change in DSH settings without any event, so a picker
  // that is about to be used asks for a `fresh` one. Entries for models a Bot uses
  // also carry their `reasoning`, so the picker can offer thinking levels.
  async function catalog({ fresh = false } = {}) {
    if (!fresh && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.value.length > 0) return catalogCache.value
    const entries = []
    for (const provider of ctx.llm.listProviders()) {
      let models = []
      try { models = await ctx.llm.listModels(provider.id) } catch { continue }
      for (const model of models) {
        entries.push({
          ref: `${provider.id}/${model.id}`,
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          id: model.id,
          name: model.name ?? model.id,
          ...(model.inputModalities ? { input: [...model.inputModalities] } : {}),
        })
      }
    }
    const used = new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel].filter(Boolean)))
    await Promise.all(entries.filter(entry => used.has(entry.ref)).map(async (entry) => {
      const reasoning = await reasoningOf(entry.ref)
      if (reasoning !== undefined) entry.reasoning = reasoning
    }))
    catalogCache = { at: Date.now(), value: entries }
    return entries
  }

  // The profile default model of DSH as set, served or not.
  const defaultRef = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    return selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : undefined
  }
  // The profile default model of DSH, when it is served; else the first served model.
  function pickDefault(entries) {
    const ref = defaultRef()
    // A friend's Bot's route (remote-chat.js) is never anyone's default model.
    const models = entries.filter(entry => entry.provider !== 'flybot-remote')
    return models.find(entry => entry.ref === ref)?.ref ?? models[0]?.ref
  }
  const defaultModel = async () => pickDefault(await catalog())

  // A full `provider/model` ref, or a model id or name that only one provider serves.
  async function resolveModel(text) {
    const entries = await catalog({ fresh: true })
    const wanted = String(text ?? '').trim()
    const exact = entries.find(entry => entry.ref === wanted)
    if (exact) return exact.ref
    const key = normalize(wanted)
    const named = entries.filter(entry => normalize(entry.id) === key || normalize(entry.name) === key)
    if (named.length === 1) return named[0].ref
    const known = entries.map(entry => entry.ref).join(', ') || 'none'
    throw new Error(named.length > 1
      ? `Model ${wanted} is served by more than one provider; use one of ${named.map(entry => entry.ref).join(', ')}`
      : `Model ${wanted} is not available. Available models: ${known}`)
  }

  // A Bot with no model yet waits for the user to pick one and changes nothing. A
  // model that is no longer served falls back to the last one it ran on, then the default.
  async function desiredModel(bot) {
    if (bot.remote?.handle) return `flybot-remote/${bot.remote.handle}`
    if (!bot.model) return undefined
    const entries = await catalog()
    const served = new Set(entries.map(entry => entry.ref))
    return [bot.model, bot.appliedModel].find(ref => ref && served.has(ref)) ?? pickDefault(entries)
  }

  // The thinking level a Bot asked for, when the model it runs on serves it; else the
  // model's own default applies. A level the model does not have is ignored, never
  // sent: an explicit effort a provider does not know is a hard refusal there.
  async function desiredEffort(bot, ref) {
    if (bot.effort === undefined || ref === undefined) return undefined
    const reasoning = await reasoningOf(ref)
    return reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  }

  // A thinking level id, or a name only one level of the model has, like resolveModel.
  async function resolveEffort(ref, text) {
    const wanted = String(text ?? '').trim()
    if (wanted === '') return undefined
    const reasoning = await reasoningOf(ref)
    const efforts = reasoning?.efforts ?? []
    if (efforts.length === 0) throw new Error(`Model ${ref} has no thinking levels`)
    const key = normalize(wanted)
    const named = efforts.filter(effort => normalize(effort.id) === key || normalize(effort.name) === key)
    if (named.length === 1) return named[0].id
    throw new Error(`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map(effort => effort.name).join(', ')}`)
  }

  // DSH's selectModel also saves the selection as the profile default model, in the
  // background. A Bot's model is its own, so the user's default is written back after
  // it. Selections run one at a time and wait for the write-back: profile writes land in
  // submission order, so the next one reads the user's default, not a Bot's.
  let selecting = Promise.resolve()
  function selectSessionModel(sessionId, { provider, model, reasoningEffort }) {
    const run = selecting.then(async () => {
      const defaults = ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const result = await ctx.sessionController.selectModel({
        sessionId, provider, model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      const saved = result?.selected ?? { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      if (before?.provider && before?.model && !sameSelection(before, saved)) {
        await defaults.saveSelection(before).catch(error => rt.warn('ds-bot: the default model was not restored: %s', error))
      }
      return result
    })
    selecting = run.catch(() => {})
    return run
  }

  const sameSelection = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

  // `force` re-selects even when the record says it is applied: the composer's own
  // model picker can move the Session without telling this plugin.
  async function applyModel(bot, { force = false } = {}) {
    const ref = await desiredModel(bot)
    if (ref === undefined) return ref
    const effort = await desiredEffort(bot, ref)
    if (!force && !bot.modelStale && bot.appliedModel === ref && (bot.appliedEffort ?? undefined) === effort) return ref
    const route = { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    await selectSessionModel(rt.chatOf(bot.id), route)
    // A group Session that did not take the model keeps the Bot "stale", so the next apply (a model
    // list change, a restart, its next group turn) tries it again instead of trusting appliedModel (#289).
    let stale = false
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      await selectSessionModel(sessionId, route)
        .catch((error) => { stale = true; rt.warn('ds-bot: model for %s in a group not applied: %s', bot.name, error) })
    }
    if (stale) bot.modelStale = true
    else delete bot.modelStale
    bot.appliedModel = ref
    if (effort === undefined) delete bot.appliedEffort
    else bot.appliedEffort = effort
    await rt.save()
    return ref
  }

  // A provider may register after the plugin starts; the model is applied once it is
  // served instead of failing with "no adapter registered".
  async function waitForModel(bot, ms = ROUTE_WAIT_MS) {
    const deadline = Date.now() + ms
    for (;;) {
      if (!bot.model) return undefined
      catalogCache = { at: 0, value: [] }
      const served = new Set((await catalog()).map(entry => entry.ref))
      if (served.has(bot.model) || Date.now() >= deadline) return desiredModel(bot)
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(2000, deadline - Date.now()))
        const off = ctx.on?.('llm/adapters-updated', done)
        function done() { clearTimeout(timer); off?.(); resolve() }
      })
    }
  }

  // Sequential, and again whenever the served models change: a provider that
  // registers late still gets its Bots' models selected.
  let syncedKey
  const syncModels = () => {
    const key = catalogCache.value.map(entry => entry.ref).join(',')
    if (key !== syncedKey) { syncedKey = key; modelsSynced = modelsSynced?.then(syncAll, syncAll) ?? syncAll() }
    return modelsSynced
  }
  async function syncAll() {
    for (const bot of Object.values(state.bots)) {
      await applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    }
  }

  // Test connection (#409): one tiny real request on the route the Bot's next run takes,
  // so a pass means that run can reach its model. It may be billed, so a Bot runs
  // at most one test at a time and nothing retries it.
  const testing = new Set()
  async function testModel(botId) {
    const bot = state.bots?.[botId]
    if (bot === undefined) throw Object.assign(new Error('Bot not found'), { code: 'bot/not-found' })
    if (bot.remote) throw Object.assign(new Error('A friend\'s Bot runs on its owner\'s model.'), { code: 'bot/invalid' })
    if (testing.has(botId)) throw Object.assign(new Error('A test is already running for this Bot.'), { code: 'bot/refused' })
    testing.add(botId)
    const started = Date.now()
    try {
      const ref = await desiredModel(bot)
      if (ref === undefined) return { ok: false, code: 'NO_MODEL' }
      const route = splitRef(ref)
      const reasoning = await reasoningOf(ref)
      const efforts = reasoning?.efforts ?? []
      // The least thinking the model offers keeps the test to a handful of tokens.
      const effort = efforts.some(entry => entry.id === 'off') ? 'off' : efforts.at(0)?.id
      const sessionId = rt.chatOf?.(bot.id)
      const messages = [{ role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] }]
      rt.tagUsage?.(messages, { sessionId, kind: 'other' })
      const signal = AbortSignal.timeout(TEST_TIMEOUT_MS)
      let finish
      try {
        for await (const chunk of ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          messages,
          maxTokens: TEST_MAX_TOKENS,
          signal,
        })) if (chunk?.type === 'finish') finish = chunk.reason
      } catch (error) {
        return { ok: false, ref, code: testFailure(error, signal.aborted) }
      }
      // A stream that ends without its finish chunk proved nothing.
      if (finish === undefined) return { ok: false, ref, code: 'UNKNOWN' }
      if (finish.kind === 'error' || finish.kind === 'aborted') return { ok: false, ref, code: testFailure(finish.failure, finish.kind === 'aborted') }
      return { ok: true, ref, ms: Date.now() - started }
    } finally {
      testing.delete(botId)
    }
  }

  Object.assign(rt, {
    testModel,
    catalog, cachedCatalog: () => catalogCache.value, cachedDefault: () => pickDefault(catalogCache.value),
    defaultRef, defaultModel, resolveModel, desiredModel, reasoningOf, resolveEffort, desiredEffort,
    selectSessionModel, applyModel, waitForModel, syncModels,
  })
}
