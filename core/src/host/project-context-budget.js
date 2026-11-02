// One host budget for scoped context. Capacity is observed/configured, never guessed
// from a model name; provider/SDK compaction remains a separate lifecycle.
import { createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { estimateTokens, splitRef } from './text.js'
const contextDigest = text => createHash('sha256').update(text).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/context-budget' })
const integer = (value, name, fallback, { min = 0, max = 10_000_000 } = {}) => {
  value ??= fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`Invalid context budget ${name}`)
  return value
}
export function createContextBudget(config = {}, { harness = 'flybot', model = null, providerWindow, providerOutput } = {}) {
  for (const value of [config, config.defaults, config.harnesses, config.models]) if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw fail('Context budget configuration must be an object')
  const harnessOptions = ownEntry(config.harnesses ?? {}, harness), modelOptions = model === null ? undefined : ownEntry(config.models ?? {}, model)
  for (const value of [harnessOptions, modelOptions]) if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw fail('Selected context budget must be an object')
  const options = { ...(config.defaults ?? {}), ...(harnessOptions ?? {}), ...(modelOptions ?? {}) }
  const configuredWindow = options.windowTokens === undefined ? null : integer(options.windowTokens, 'windowTokens', null, { min: 256 })
  const observedWindow = providerWindow === undefined ? null : integer(providerWindow, 'provider window', null, { min: 256 })
  const windowTokens = configuredWindow && observedWindow ? Math.min(configuredWindow, observedWindow) : configuredWindow ?? observedWindow
  const capacitySource = configuredWindow && observedWindow ? 'operator-and-provider-min' : configuredWindow ? 'operator' : observedWindow ? 'provider' : 'unknown'
  const threshold = options.threshold ?? 0.8
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.1 || threshold >= 1) throw fail('Context threshold must be between0.1 and1')
  const estimator = options.estimator ?? 'utf8-upper-bound'
  if (!['utf8-upper-bound', 'flybot-estimate'].includes(estimator)) throw fail('Unknown context token estimator')
  const outputTokens = integer(options.outputTokens, 'outputTokens', providerOutput ?? Math.ceil((windowTokens ?? 0) * 0.1))
  const toolTokens = integer(options.toolTokens, 'toolTokens', Math.ceil((windowTokens ?? 0) * 0.1))
  const protocolTokens = integer(options.protocolTokens, 'protocolTokens', Math.ceil((windowTokens ?? 0) * 0.02))
  const inputTokens = windowTokens === null ? null : Math.floor(windowTokens * threshold) - outputTokens - toolTokens - protocolTokens
  if (inputTokens !== null && inputTokens < 1) throw fail('Context reservations leave no room for mandatory input')
  const limits = { characters: integer(options.maxChars, 'maxChars', 48000, { min: 256, max: 1_000_000 }),
    memoryTokens: integer(options.memoryTokens, 'memoryTokens', inputTokens === null ? 8000 : Math.floor(inputTokens * 0.2)),
    knowledgeTokens: integer(options.knowledgeTokens, 'knowledgeTokens', inputTokens === null ? 8000 : Math.floor(inputTokens * 0.2)),
    summaryTokens: integer(options.summaryTokens, 'summaryTokens', inputTokens === null ? 4000 : Math.floor(inputTokens * 0.15)),
    toolOutputTokens: integer(options.toolOutputTokens, 'toolOutputTokens', Math.max(1, toolTokens || 2000), { min: 1 }),
    fixedTokens: options.fixedTokens === undefined ? inputTokens : integer(options.fixedTokens, 'fixedTokens'),
    currentInputTokens: options.currentInputTokens === undefined ? inputTokens : integer(options.currentInputTokens, 'currentInputTokens'),
    readChars: integer(options.readChars, 'readChars', 6000, { min: 128, max: 64000 }) }
  if (windowTokens !== null && toolTokens > 0 && limits.toolOutputTokens > toolTokens) throw fail('A single tool output exceeds the reserved tool budget')
  return { version: 'project-context-budget/v1', harness, model, windowTokens, capacitySource, threshold, estimator,
    estimated: true, inputTokens, reserved: { outputTokens, toolTokens, protocolTokens }, limits }
}
export function countContextTokens(text, budget) {
  if (typeof text !== 'string') throw fail('Context measurement needs text')
  return budget.estimator === 'utf8-upper-bound' ? Buffer.byteLength(text) : Math.ceil(estimateTokens(text) * 1.5)
}
export function checkContextPrompt(text, budget) {
  const tokens = countContextTokens(text, budget)
  if (budget.inputTokens !== null && tokens > budget.inputTokens) throw fail(`Mandatory execution input exceeds context budget (${tokens} estimated tokens; ${budget.inputTokens} available); retain constraints and reduce optional retrieval or configure a compatible model`)
  return { version: budget.version, estimator: budget.estimator, estimated: true, tokens, inputTokens: budget.inputTokens,
    capacitySource: budget.capacitySource, reserved: { ...budget.reserved }, withinBudget: budget.inputTokens === null ? null : true }
}
export async function resolveContextBudget(rt, definition = {}, { projectId, resourceId, model } = {}) {
  const harness = definition.execution?.harness ?? 'flybot'
  model ??= definition.execution?.model
  if (!model && projectId && resourceId) {
    const resource = rt.projectResources.setting(projectId, resourceId), ownerId = rt.readProject(projectId).ownerUserId
    model = ownEntry(ownEntry(resource.profiles ?? {}, ownerId) ?? {}, harness)?.model
  }
  model ||= definition.model || null
  let providerWindow, providerOutput
  const route = harness === 'flybot' && splitRef(model)
  if (route && rt.ctx?.llm?.resolveModelInfo) {
    let info
    try { info = await rt.ctx.llm.resolveModelInfo(route.provider, route.model) } catch { /* Unknown metadata stays explicit; do not guess capacity. */ }
    providerWindow = info?.context?.contextWindow
    providerOutput = info?.defaultMaxTokens
  }
  return createContextBudget(rt.config.projectContext, { harness, model, providerWindow, providerOutput })
}

export function contextValuePage(value, budget, { offset = 0, sha256 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail('Invalid context source offset')
  const text = JSON.stringify(value), digest = contextDigest(text)
  if (sha256 !== undefined && sha256 !== digest) throw fail('Context source changed; restart the bounded read')
  if (offset > text.length) throw fail('Context source offset is beyond its end')
  return { version: 'project-context-page/v1', sha256: digest, offset, totalChars: text.length, text: text.slice(offset, offset + budget.limits.readChars), nextOffset: offset + budget.limits.readChars < text.length ? offset + budget.limits.readChars : null }
}
// Context tools are indexes plus exact scoped source pages. Optional histories
// yield before any permission/identity fields; a source page never pretends a cut
// was complete. Call before memory writes as well as on the final confirmed result.
export function fitContextToolResult(result, budget) {
  result = structuredClone(result)
  result.retrieval ??= { omitted: {} }
  result.retrieval.omitted ??= {}
  result.contextUsage = { estimated: true, estimator: budget.estimator, tokens: 0, capacitySource: budget.capacitySource }
  const arrays = ['tasks', 'runs', 'knowledge', 'publicMessages', 'privateMemory', 'privateConversation']
  for (;;) {
    result.contextUsage.tokens = countContextTokens(JSON.stringify(result), budget)
    const encoded = JSON.stringify(result)
    if (budget.windowTokens === null ? encoded.length <= budget.limits.readChars : countContextTokens(encoded, budget) <= budget.reserved.toolTokens) return result
    const candidates = arrays.filter(key => Array.isArray(result[key]) && result[key].length).map(key => ({ key, rows: result[key], tokens: countContextTokens(JSON.stringify(result[key]), budget) }))
    for (const [index, memory] of (result.memories ?? []).entries()) if (memory.entries?.length > 1) candidates.push({ key: `memories.${index}`, rows: memory.entries, tokens: countContextTokens(JSON.stringify(memory.entries), budget), memory })
    const largest = candidates.sort((a, b) => b.tokens - a.tokens)[0]
    if (largest) {
      if (largest.memory) largest.rows.pop()
      else largest.rows.shift()
      result.retrieval.omitted[largest.key] = (result.retrieval.omitted[largest.key] ?? 0) + 1
      if (largest.memory) largest.memory.nextOffset = largest.memory.offset + largest.rows.length
      continue
    }
    const pages = [...(result.reads ?? []), ...(result.contextPage ? [result.contextPage] : []), ...(result.memories ?? []).flatMap(memory => memory.entries ?? [])].filter(page => typeof page.text === 'string' && page.text.length)
    const page = pages.sort((a, b) => b.text.length - a.text.length)[0]
    if (!page || page.text.length < 2) throw fail('Context tool metadata/mandatory fields exceed the result budget; request one bounded source or reduce the batch')
    page.text = page.text.slice(0, Math.floor(page.text.length / 2))
    page.nextOffset = page.offset + page.text.length // The old longer page proves more source remains.
  }
}
