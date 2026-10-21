// The decisions a Bot records (#396). A Bot often considers a correct or risky option and then
// decides not to use it; those "considered and rejected" choices are invisible to a reviewer
// today. This gives a Bot one small tool to record such a choice, and the host appends it to a
// capped, append-only log. A Bot has no tool to edit or delete a past entry, so what a reviewer
// reads is what was really considered.
//
// Opt-in (config.decisions): with the flag off nothing is registered, written or fired, so a
// default install behaves exactly as before. The log is local text, one JSON line per entry; the
// same entry is fired on the activity feed as `decision` so a consumer (Timeline, an audit view)
// can show it without reading the file.
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { looksSecret } from './memory.js'
import { output } from './tools.js'

const OPTION_MAX = 200
const WHY_MAX = 300
const CHOICES = new Set(['used', 'rejected'])
const KEPT = 2_000
// The log is bounded on disk as well as in the answer: next to the line cap there is a byte cap,
// so a burst of long entries cannot make the file (and every read) expensive.
const MAX_BYTES = 1_000_000
const NAME_SAFE = /^[\w-]{1,128}$/

const oneLine = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function install(rt) {
  if (rt.config?.decisions !== true) {
    rt.decisionsEnabled = false
    return
  }
  const { home } = rt
  const path = join(home, 'decisions.jsonl')
  // One append at a time, and a failure is a warning, never a turn failure (the log is a side
  // record, not part of the Bot's work).
  let writing = Promise.resolve()
  // Lines on disk after the last append/trim, so a record does not re-read the file every time
  // (null until the first record counts once).
  let linesOnDisk = null
  const countLines = async () => (await readFile(path, 'utf8')).split('\n').filter(Boolean).length
  // Keep the file bounded in place: the newest entries under both caps, written through a temp
  // file so a reader never sees a half-trimmed log. The Bot side stays append-only; this is the
  // host's own housekeeping.
  async function trim() {
    let text
    try { text = await readFile(path, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return 0; throw error }
    const lines = text.split('\n').filter(Boolean)
    const kept = []
    let bytes = 0
    for (let i = lines.length - 1; i >= 0 && kept.length < KEPT; i--) {
      const size = Buffer.byteLength(lines[i], 'utf8') + 1
      if (kept.length > 0 && bytes + size > MAX_BYTES) break
      kept.push(lines[i])
      bytes += size
    }
    kept.reverse()
    const next = kept.length > 0 ? `${kept.join('\n')}\n` : ''
    if (next !== text) {
      const tmp = `${path}.tmp`
      await writeFile(tmp, next, 'utf8')
      await rename(tmp, path)
    }
    return kept.length
  }
  function record(entry) {
    const line = `${JSON.stringify(entry)}\n`
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, line, 'utf8')
      linesOnDisk = linesOnDisk === null ? await countLines() : linesOnDisk + 1
      const { size } = await stat(path)
      if (linesOnDisk > KEPT || size > MAX_BYTES) linesOnDisk = await trim()
    }).catch(error => rt.warn('ds-bot: a decision was not written: %s', error))
    return writing
  }
  // The entries, oldest first, capped to the newest `KEPT` lines and `MAX_BYTES`. A read takes at
  // most the byte cap from the end, so it does not grow with a file an older build left oversized.
  async function list() {
    try {
      let text
      const { size } = await stat(path)
      if (size > MAX_BYTES) {
        const handle = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(MAX_BYTES)
          const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, size - MAX_BYTES)
          text = buffer.toString('utf8', 0, bytesRead)
          const firstNewline = text.indexOf('\n')
          text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
        } finally { await handle.close() }
      } else {
        text = await readFile(path, 'utf8')
      }
      return text.split('\n').filter(Boolean).slice(-KEPT).map(line => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: decisions could not be read: %s', error)
      return []
    }
  }

  rt.decisionsEnabled = true
  rt.decisionsList = list
  rt.ctx.tools.register(defineTool({
    name: 'record_decision',
    description: 'Record one decision that mattered — an option you considered and whether you used or rejected it, and why. A reviewer reads this log to see near-misses and judgment drift. One line per decision; not for routine steps, and never for secrets.',
    parameters: {
      option: { type: 'string', required: true, description: `What you considered, at most ${OPTION_MAX} characters` },
      choice: { type: 'string', required: true, enum: ['used', 'rejected'], description: 'Whether you used it or rejected it' },
      why: { type: 'string', description: `Why, in one short line, at most ${WHY_MAX} characters` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const botId = rt.selfOf(exec?.agent?.id)
      const bot = rt.botOf(botId)
      if (bot === undefined) return 'Only Bots on the team keep a decision log.'
      const option = oneLine(args.option, OPTION_MAX)
      const why = oneLine(args.why, WHY_MAX)
      const choice = String(args.choice ?? '').trim().toLowerCase()
      if (option === '') return 'Write the option you considered.'
      if (!CHOICES.has(choice)) return 'choice must be "used" or "rejected".'
      if (looksSecret(option) || looksSecret(why)) return 'A decision never holds a key, token or password; record the choice without it.'
      const safeName = NAME_SAFE.test(botId) ? botId : 'bot'
      const entry = { time: Date.now(), bot: safeName, botName: oneLine(bot.name, 40), option, choice, ...(why ? { why } : {}) }
      await record(entry)
      // The feed payload drops the id to a safe shape and adds the live botId (a consumer keys by it).
      rt.fireFeed?.('decision', { botId, option, choice, ...(why ? { why } : {}), time: entry.time })
      return `Recorded: ${choice} "${option}"${why ? ` — ${why}` : ''}.`
    },
  }))
}
