// The merge handoff (#450 item 1): one line from the Bot that is archived on a merge into the Bot
// that keeps its role. It has the shape of a part handoff note (parts.js): a note plus a pointer to
// where the rest stays — here the archived Bot's own chat and memory, which are never moved or
// rewritten. The note lands in the kept Bot's own memory through the ordinary memory path
// (secret-scanned, size-capped, journaled), so it outlives a prompt rewrite, and the call answers
// the source reference (Bot id, name, time) a plugin puts in its prompt line.
//
//   - OFF unless the host names the plugin: the same `config.flybot.memoryPlugins` allow-list as
//     `flybot.memory`, because the note is a memory write. An unnamed plugin is refused.
//   - Typed and bounded. A call names two live Bots and one non-empty string note; anything else is
//     refused with a short machine `code`, and a refused call writes nothing.
//   - The source Bot is only read: no entry of it is changed, so an archived Bot keeps its own
//     memory exactly as it was.
// The entry text is the note plus a prefix naming the source, kept under the memory entry cap
// (memory.js MEMORY_LIMITS.entry, 300): a 40-character name, a 24-character id and 21 characters of
// wording leave 200 for the note, so a note at the cap still fits. A longer name or id is clipped,
// never the note.
export const HANDOFF = Object.freeze({ note: 200, name: 40, id: 24 })

const clip = (value, max) => [...String(value ?? '')].slice(0, max).join('')
const iso = at => new Date(at).toISOString()
const fail = code => ({ ok: false, code })
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

/**
 * Builds the `note(input)` the host exposes as `flybot.handoff.note` for one plugin.
 * `allow` is the host's memory allow-list; a plugin not in it may not leave a note.
 */
export function createHandoff(rt, { allow = [], now = Date.now } = {}) {
  const allowed = allow instanceof Set ? allow : new Set(Array.isArray(allow) ? allow : [])
  return async function handoffNote(plugin, input) {
    if (!allowed.has(plugin)) return fail('not-allowed')
    if (rt.readOnly?.() !== undefined) return fail('read-only')
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('bad-input')
    const from = text(input.from)
    if (from === '') return fail('no-source')
    const to = text(input.to)
    if (to === '') return fail('no-target')
    if (from === to) return fail('same-bot')
    if (typeof input.note !== 'string') return fail('bad-note')
    const note = text(input.note)
    if (note === '') return fail('empty-note')
    if ([...note].length > HANDOFF.note) return fail('note-too-long')
    const source = rt.botOf?.(from)
    if (source === undefined) return fail('source-gone')
    if (rt.botOf?.(to) === undefined) return fail('target-gone')
    if (typeof rt.botMemoryAppend !== 'function') return fail('no-api')
    const at = now()
    const line = `${clip(source.name ?? 'a Bot', HANDOFF.name)} (${clip(from, HANDOFF.id)}) was merged into you: ${note}`
    try {
      await rt.botMemoryAppend(to, line, { source: 'handoff', from: clip(from, HANDOFF.id), at: iso(at) })
    } catch (error) {
      return fail(String(error?.code ?? 'failed').slice(0, 40))
    }
    return { ok: true, ref: { bot: from, name: source.name ?? '', at: iso(at) } }
  }
}
