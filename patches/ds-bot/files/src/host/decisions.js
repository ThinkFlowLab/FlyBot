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
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { looksSecret } from './memory.js'
import { output } from './tools.js'

const OPTION_MAX = 200
const WHY_MAX = 300
const CHOICES = new Set(['used', 'rejected'])
const KEPT = 2_000
// One line can be ~600 bytes, so a line cap alone would still let the file grow; the byte cap
// bounds it even when every entry is the longest allowed (#603).
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

  // The file is bounded on disk, not only in the answer (#603): trim before each append, so a
  // reader never pays for a file that only ever grew. The rewrite is atomic (temp file + rename),
  // so a crash cannot leave half a log, and it is one more append step, never a Bot-side action.
  async function trim() {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const lines = text.split('\n').filter(Boolean)
    if (lines.length < KEPT && Buffer.byteLength(text) <= MAX_BYTES) return
    const asText = list => (list.length === 0 ? '' : `${list.join('\n')}\n`)
    // One slot is left for the line about to be appended, so the file ends at KEPT, not KEPT + 1.
    let kept = lines.slice(-(KEPT - 1))
    // An entry too big to keep at all is dropped rather than kept and over the cap: the cap wins.
    while (kept.length > 0 && Buffer.byteLength(asText(kept)) > MAX_BYTES) kept = kept.slice(1)
    const tmp = `${path}.trim`
    await writeFile(tmp, asText(kept), 'utf8')
    await rename(tmp, path)
  }

  // One append at a time, and a failure is a warning, never a turn failure (the log is a side
  // record, not part of the Bot's work).
  let writing = Promise.resolve()
  function record(entry) {
    const line = `${JSON.stringify(entry)}\n`
    writing = writing.then(() => mkdir(dirname(path), { recursive: true }).then(() => trim()).then(() => appendFile(path, line, 'utf8')))
      .catch(error => rt.warn('ds-bot: a decision was not written: %s', error))
    return writing
  }
  // The entries, oldest first, capped to the newest `KEPT` lines. Reads only; with the file trimmed
  // on write this is O(KEPT), not O(file).
  async function list() {
    try {
      const text = await readFile(path, 'utf8')
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
