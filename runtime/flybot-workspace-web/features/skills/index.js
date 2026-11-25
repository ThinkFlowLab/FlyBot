// Skills live in the user's own DS-Bot as instruction-only capabilities.
import { createHash } from 'node:crypto'
import { fail } from '../../src/store.js'
import { BOUND_PREFIX, skillLibrary } from './library.js'
import { skillRunsV1 } from './runs.js'

const NAME = /^[a-z0-9][a-z0-9-]{1,47}$/
const PREFIX = 'ot-user-skill-'
// DS-Bot's native validator caps the complete capability name at 32 chars and
// permits only single hyphens. Keep existing valid names; hash the full source
// identity otherwise (never truncate into collisions or weaken native validation).
const nativeName = (prefix, id) => {
  const name = prefix + String(id).toLowerCase()
  return name.length <= 32 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
    ? name : prefix + createHash('sha256').update(String(id)).digest('hex').slice(0, 32 - prefix.length)
}
export const boundName = (id) => nativeName(BOUND_PREFIX, id)
export const userSkillName = (slug) => nativeName(PREFIX, slug)

export default function skills(host) {
  const library = skillLibrary(host, { boundName })
  const runs = skillRunsV1(host, { userSkillName })
  const ready = async () => {
    const services = await host.runtime()
    if (typeof services.mainBot !== 'function') fail('skills/runtime-unavailable', 'DS-Bot skills are not available in this runtime')
    const botId = await services.mainBot()
    return { rt: services.rt, botId }
  }
  return {
    pages: ['skills'],
    endpoints: {
      v1: async p => { const result=await library.v1(p); return result.status === 404 && result.body?.error?.code === 'not_moved' ? runs(p) : result },
      materialForScope: library.materialForScope,
      async list() {
        const { rt, botId } = await ready()
        const attached = [...(rt.botOf(botId)?.capabilities ?? [])].filter((name) => typeof name === 'string')
        return { items: attached.filter((name) => name.startsWith('ot-')).sort().map((name) => ({ name, source: name.startsWith(PREFIX) ? 'user' : name.startsWith(BOUND_PREFIX) ? 'bound' : 'flybot-workspace' })) }
      },
      async save(payload) {
        const slug = String(payload?.name ?? '')
        if (!NAME.test(slug)) fail('skills/invalid', 'name: 2–48 lowercase letters, digits or dashes')
        const content = typeof payload?.content === 'string' ? payload.content : ''
        if (!content.trim() || content.length > 20000) fail('skills/invalid', 'content must be 1–20000 characters')
        const description = String(payload?.description ?? slug).slice(0, 200)
        const { rt, botId } = await ready()
        const name = userSkillName(slug)
        await rt.capabilitySave({ name, kind: 'skill', description, content }, { ui: true })
        if (!(rt.botOf(botId)?.capabilities ?? []).includes(name)) await rt.changeCapabilityAttachment('attach', { name }, botId)
        return { name, attached: true }
      },
      async remove(payload) {
        const slug = String(payload?.name ?? '')
        if (!NAME.test(slug)) fail('skills/invalid', 'invalid name')
        const { rt, botId } = await ready()
        const name = userSkillName(slug)
        if ((rt.botOf(botId)?.capabilities ?? []).includes(name)) await rt.changeCapabilityAttachment('detach', { name }, botId)
        return { removed: true }
      },
    },
  }
}
