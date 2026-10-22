// A sanctioned way for a feature plugin to make one short model call (#450).
//
// Plugins are otherwise pure: they read fields, register tools and slots, and route
// messages. Some work needs a model of its own (a short classification, a title, a
// one-line summary), and until now there was no pattern for it, so such work either
// was not done or reached into the host. This module is that pattern, kept small on
// purpose:
//
//   - OFF unless the host names the plugin. config.flybot.modelPlugins is an allow-list;
//     an unnamed plugin gets `not-allowed`, so nothing calls a model by default.
//   - One default per plugin, if the host wants it. config.flybot.modelFor maps a plugin to the
//     model its calls use when the call does not name one, so a host can keep a cheap plugin cheap
//     while the rest of the team stays on the team default (#579).
//   - Capped. A call carries one prompt and one optional system line; input length,
//     output tokens and calls-per-minute are all bounded, so a plugin cannot spend the
//     owner's quota without limit.
//   - Safe. It streams through the host's own model selection, never returns provider
//     text (a provider may echo part of a key), and refuses on a read-only host.
//   - Epic-less. It answers with text only; it does not create or change a Bot, a room
//     or memory, so a plugin's model call has no side effect the owner cannot see.
//
// The reply is returned as `{ ok: true, text }` or `{ ok: false, code }`; `code` is a
// short machine token, never a provider message.
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { splitRef } from './text.js'
import { testFailure } from './models.js'

// Fixed ceilings in one place, so a host can lower them per deployment.
export const MODEL_LIMITS = Object.freeze({ maxTokens: 512, defaultTokens: 256, maxPromptChars: 8_000, maxSystemChars: 2_000, perMinute: 30, timeoutMs: 30_000 })

const clamp = (value, low, high, fallback) => (Number.isFinite(value) ? Math.min(high, Math.max(low, Math.floor(value))) : fallback)

/**
 * Builds the `ask(plugin, input)` the host exposes as `flybot.model.ask`.
 * `allow` is the allow-list from config; an empty list refuses every plugin.
 * `models` is the per-plugin default map (config.flybot.modelFor): a plugin's call uses its entry
 * unless the call names a model, and an unnamed plugin falls back to the team default (#579).
 */
export function createPluginModel(rt, { allow = [], models = {}, now = Date.now, limits = {} } = {}) {
  const caps = { ...MODEL_LIMITS, ...limits }
  const allowed = new Set(Array.isArray(allow) ? allow : [])
  const perPlugin = models && typeof models === 'object' ? models : {}
  // A model name the host can use: a non-empty string. Anything else (missing, empty, not a string)
  // counts as not set, so it falls through to the next step instead of being passed to splitRef.
  const modelName = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  /** @type {Map<string, number[]>} recent call times per plugin */
  const calls = new Map()

  const withinRate = (plugin) => {
    const at = now()
    const recent = (calls.get(plugin) ?? []).filter(time => at - time < 60_000)
    if (recent.length >= caps.perMinute) return false
    recent.push(at)
    calls.set(plugin, recent)
    return true
  }

  return async function ask(plugin, input) {
    if (!allowed.has(plugin)) return { ok: false, code: 'not-allowed' }
    if (rt.readOnly?.() !== undefined) return { ok: false, code: 'read-only' }
    const prompt = String(input?.prompt ?? '').trim()
    if (prompt === '') return { ok: false, code: 'empty-prompt' }
    if (prompt.length > caps.maxPromptChars) return { ok: false, code: 'prompt-too-long' }
    const system = input?.system === undefined ? undefined : String(input.system).slice(0, caps.maxSystemChars)
    const maxTokens = clamp(input?.maxTokens, 1, caps.maxTokens, caps.defaultTokens)
    const route = splitRef(modelName(input?.model) ?? modelName(perPlugin[plugin]) ?? (await rt.defaultModel()))
    if (route === undefined) return { ok: false, code: 'no-model' }
    if (!withinRate(plugin)) return { ok: false, code: 'rate-limited' }
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of rt.ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(system === undefined ? {} : { system }),
        messages,
        maxTokens,
        signal: AbortSignal.timeout(caps.timeoutMs),
      })) assembler.push(chunk)
    } catch (error) {
      return { ok: false, code: testFailure(error, false) }
    }
    const finish = assembler.finish
    if (finish?.kind === 'error' || finish?.kind === 'aborted') return { ok: false, code: testFailure(finish.failure, finish.kind === 'aborted') }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (text === '') return { ok: false, code: 'empty-reply' }
    return { ok: true, text }
  }
}
