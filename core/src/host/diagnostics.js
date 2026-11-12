// Diagnostics: what went wrong on this host, kept where the user can see it and report it.
// DSH mounts no exporter for ctx.logger once it has started, so warnings would otherwise
// reach only stderr. Entries are kept in memory and in <home>/logs/diagnostics.jsonl, so
// a report written after a restart still has them. Every text is cleaned of saved keys,
// credential-like strings and the home folder before it is kept and again before it is
// shown, because the report is meant for a public issue.
import { constants, readFileSync } from 'node:fs'
import { access, appendFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { arch, homedir, platform, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { pluginSwitches, pluginSwitchesAtStart, pluginSwitchesPending } from './plugins.js'
import { fileKind } from './real-dir.js'
import { cut } from './text.js'

export const KEEP = 200
const LOG_MAX_BYTES = 1 << 20
const STACK_LINES = 8
const TEXT_MAX = 2000
export const REPORT_ENTRIES = 20
export const ISSUES_URL = 'https://github.com/ThinkFlowLab/FlyBot/issues/new'

const quote = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The folders one line may name, longest first (#2944): this host's own home can sit outside the
// OS home, and a row that shortened one of them disagreed with the row beside it. The longer folder
// goes first so a prefix that is not a folder of its own never eats part of the longer name.
// A folder inside another listed folder is left to the outer one (#2956): the outer home shortens to
// `~` first, so a home under it keeps `~/.dsh/bot` and two different files can never print one
// string. Otherwise the inner folder would shorten to bare `~` as well, exactly like the OS home.
const inside = (folder, folderOf) => folderOf.some(other => other !== folder
  && (folder.startsWith(`${other}/`) || folder.startsWith(`${other}\\`)))

const homeFolders = home => {
  const folders = [...new Set((Array.isArray(home) ? home : [home])
    .filter(folder => typeof folder === 'string' && folder.length > 1))]
  return folders.filter(folder => !inside(folder, folders)).sort((a, b) => b.length - a.length)
}

// Shapes of credentials that are not saved keys: provider keys, bearer tokens, and
// token or key parameters in addresses (the Web login address carries one).
const CREDENTIALS = [
  [/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-[hidden]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[hidden]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[hidden]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[hidden]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[hidden]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[hidden]'],
  // JSON web tokens: three base64url parts, the first always starting eyJ.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[hidden]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]{8,}/gi, '$1 [hidden]'],
  [/([?&#](?:token|access_token|api_key|apikey|key|secret|password)=)[^&\s"']+/gi, '$1[hidden]'],
  [/(["']?(?:api[_-]?key|authorization|x-api-key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1[hidden]'],
]

// The bound is taken here, after the home folder has been abbreviated to `~` (#2936): a bound taken
// on the raw text measures a path that is about to shrink, so a sentence could end mid-word with no
// mark at all. One function decides both, so the `…` has exactly one owner and never doubles.
// `home` is one folder or the set this host prints under `~` (#2944).
export function cleanText(text, { redact = value => value, home = homedir(), max = TEXT_MAX } = {}) {
  let out = redact(String(text ?? ''))
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement)
  for (const folder of homeFolders(home)) {
    out = out.replace(new RegExp(quote(folder), 'g'), '~')
    // JSON and Windows paths spell the same folder with doubled or forward slashes.
    const slashes = folder.replace(/\\/g, '/')
    if (slashes !== folder) out = out.replace(new RegExp(quote(slashes), 'g'), '~')
    const doubled = folder.replace(/\\/g, '\\\\')
    if (doubled !== folder) out = out.replace(new RegExp(quote(doubled), 'g'), '~')
  }
  const kept = cut(out, max)
  if (!kept.cut) return out
  // A cut that lands inside a word drops the word it was cut in, and the reader cannot tell what
  // is missing: back off to the last whole word, and mark the cut once, at the end.
  const next = out[kept.text.length]
  const words = next !== undefined && !/\s/.test(next) ? kept.text.replace(/\s+\S*$/, '') : kept.text
  return `${(words || kept.text).trimEnd()}…`
}

const errorText = error => `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`

// One log line, as the downloaded log and the report show it. The reader of the log keeps a line on
// a numeric `time` and a string `text` alone, so a hand-edited line — or one an older build wrote —
// can lack the level or the source, and a `time` JSON parses as `Infinity` is a number that is not a
// time. Those parts are defaulted the way the browser-entry reader defaults a missing level, because
// one unusable field must not cost the whole report (#2591).
export function entryLine(entry) {
  const where = [entry.bot, entry.where].filter(Boolean).join(' · ')
  const code = entry.code ? ` [${entry.code}${entry.status ? ` ${entry.status}` : ''}]` : ''
  const when = typeof entry.time === 'number' && Number.isFinite(entry.time) ? `${new Date(entry.time).toISOString()} ` : ''
  const level = (typeof entry.level === 'string' && entry.level ? entry.level : 'error').toUpperCase()
  const source = typeof entry.source === 'string' && entry.source ? entry.source : 'host'
  return `${when}${level} ${source}${where ? ` (${where})` : ''}${code} ${entry.text}`
}

// The Markdown block for an issue. `facts` come from this host, `client` from the
// browser that asked; `entries` are already cleaned.
export function reportMarkdown({ facts, client = {}, entries = [], clientEntries = [] }) {
  const row = (label, value) => (value === undefined || value === null || value === '' ? null : `| ${label} | ${String(value).replace(/\|/g, '\\|')} |`)
  const lines = [
    '| | |',
    '|---|---|',
    row('FlyBot', facts.botVersion),
    row('DSH', facts.dshVersion),
    row('Surface', client.surface),
    row('OS', facts.os),
    row('Node', facts.node),
    row('Browser', client.userAgent),
    row('Language', client.language),
    row('Team', facts.team),
    row('Models', facts.models),
    row('Read-only', facts.readOnly),
    row('Plugins', facts.plugins),
  ].filter(Boolean)
  const recent = entries.slice(-REPORT_ENTRIES)
  // The team file, right after the table that counts the team (#2394): a report about a team has to
  // say what that team is saved in, in the shape the two file lines below already have.
  const stateFile = facts.stateFile === undefined ? [] : ['', `state file: ${facts.stateFile}`]
  // The backups beside that file, in the same block: what a person reading a report about a team
  // that cannot be read needs next is whether an earlier copy is still on disk and readable.
  const stateBackups = facts.stateBackups === undefined ? [] : [`state backups: ${facts.stateBackups}`]
  // The journal is only mentioned while the host runs one: an off journal is not a fact about
  // this host, and a stopped one is exactly what a report about a bug it was meant to catch misses.
  // Its file follows in the same shape (#2388): the sentence says whether the host records, and
  // this line says what the file it records into is, or that there is none yet.
  const journalFile = facts.journalFile === undefined ? [] : ['', `journal file: ${facts.journalFile}`]
  const journal = facts.stateJournal === undefined ? [] : ['', `state journal: ${facts.stateJournal}`, ...journalFile]
  // The log's own line, in the journal's shape (#2134): a host whose log is off says nothing, and
  // every other bundle gets the one fact the recent errors cannot show — whether they were written.
  const log = facts.diagnosticsLog === undefined ? [] : ['', `diagnostics log: ${facts.diagnosticsLog}`]
  // A log this host could not read is not a log with no errors (#2604): the sentence stands where
  // `No host errors recorded.` would claim otherwise, and the entries below it stay listed.
  const unread = facts.diagnosticsLogUnread === undefined ? []
    : ['', `The diagnostics log could not be read (${facts.diagnosticsLogUnread}); the errors it holds are not shown.`]
  const out = [...lines, ...stateFile, ...stateBackups, ...journal, ...log, ...unread, '']
  if (recent.length > 0) out.push(`Recent host errors (${recent.length} of ${entries.length}, oldest first):`)
  else if (unread.length === 0) out.push('No host errors recorded.')
  if (recent.length > 0) out.push('```', ...recent.map(entryLine), '```')
  const stacks = recent.filter(entry => entry.stack).slice(-3)
  for (const entry of stacks) out.push('', `<details><summary>Stack: ${cut(entry.text, 80).text.replace(/</g, '&lt;')}</summary>`, '', '```', entry.stack, '```', '</details>')
  if (clientEntries.length > 0) {
    out.push('', `Recent browser errors (${Math.min(clientEntries.length, 10)}):`, '```', ...clientEntries.slice(-10).map(entryLine), '```')
  }
  return out.join('\n')
}

const ownVersion = () => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version
  } catch {
    return undefined
  }
}

// DSH packages share one version; the LLM package is always beside the plugin.
const dshVersion = () => {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm')))
    for (let depth = 0; depth < 5; depth += 1, dir = dirname(dir)) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (manifest.name === '@deepseek-ai/dsh-llm') return manifest.version
      } catch { /* no readable manifest at this depth: keep walking up */ }
    }
  } catch { /* the package does not resolve here: no version to report */ }
  return undefined
}

export function install(rt) {
  const { ctx, home, statePath, config } = rt
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const toFile = config.diagnosticsFile !== false
  let fresh = []
  let writing = Promise.resolve()
  // `fileFailed` keeps stderr to one line per host; `fileFailure` is the reason the report shows,
  // and a later append that lands clears it again so the line describes this host's log now.
  let fileFailed = false
  let fileFailure

  // What this host writes to its own log and stderr is cleaned against the process's home alone:
  // that text is for the person at this machine, and a warning names the folder they can open.
  const clean = (text, options) => cleanText(text, { redact: rt.redactSecrets, ...options })
  // What the report and the downloaded log print is cleaned against both folders (#2944): this
  // host's own home can sit outside the OS home, and then one row of the report said `~` while the
  // row beside it carried the folder in full.
  const reportHomes = [homedir(), home]
  const show = (text, options) => cleanText(text, { redact: rt.redactSecrets, home: reportHomes, ...options })

  // Entries from earlier runs, read once; new ones are kept apart until then. A read that failed
  // (`EACCES`, `EISDIR`, a name this host may not open) is not a log without errors (#2604): the
  // rejection is kept, the report names it, and the entries this host records still count.
  let earlierFailure
  const earlier = toFile
    ? readFile(logPath, 'utf8').then(text => text.split('\n').filter(Boolean).slice(-KEEP).flatMap((line) => {
        try {
          const entry = JSON.parse(line)
          return typeof entry?.time === 'number' && typeof entry.text === 'string' ? [entry] : []
        } catch {
          return []
        }
      }), (error) => {
        earlierFailure = error?.code ?? clean(error?.message ?? String(error))
        return []
      })
    : Promise.resolve([])
  let cleared = 0

  // The log is one leaf file under the home, so a link there is not a place to write (#2089). The
  // check sits inside the chain, before the append and before the size rename, so a linked leaf is
  // left alone entirely; one line on stderr per host says so, without the home folder in it.
  // `refusedLeaf` is that latch and never clears. The report answers a different question — what the
  // last append attempt met — so `leafRefusedNow` is cleared when an attempt starts and a refusal
  // sets it again; an append that fails for another reason leaves it clear, and `fileFailure` says
  // which reason that was.
  let refusedLeaf = false
  let leafRefusedNow = false
  const refuseLeaf = () => {
    leafRefusedNow = true
    if (refusedLeaf) return
    refusedLeaf = true
    console.error('[ds-bot] diagnostics log is not a plain file of its own; nothing was written there')
  }

  const append = (entry) => {
    if (!toFile) return
    writing = writing.then(async () => {
      leafRefusedNow = false
      if (await fileKind(logPath) === 'other') { refuseLeaf(); return }
      await mkdir(dirname(logPath), { recursive: true })
      const size = await stat(logPath).then(info => info.size, () => 0)
      if (size > LOG_MAX_BYTES) await rename(logPath, `${logPath}.1`)
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
      fileFailure = undefined
      // A line that landed describes a log this host writes to again, so the read failure clears
      // the way the write one does; the start-up read is not repeated either way.
      earlierFailure = undefined
    }).catch((error) => {
      fileFailure = error?.code ?? clean(error?.message ?? String(error))
      if (fileFailed) return
      fileFailed = true
      console.error('[ds-bot] diagnostics log not written:', fileFailure)
    })
  }

  // The log is written in the background, so a shutdown has to drain it: a caller that removes the
  // home (a test's teardown, #1983) otherwise races an `appendFile` that puts `logs/` back after the
  // removal started. `settled` waits out the last entry queued before it was called, including one
  // queued by another cleanup; `writing` never rejects, so awaiting it is safe.
  const settled = async () => {
    for (;;) {
      const tail = writing
      await tail
      if (tail === writing) return
    }
  }
  ctx.effect(() => () => settled(), 'ds-bot: diagnostics log')

  // `fields`: source ('host', 'turn', 'api'), level, code, status, bot, where, sessionId, stack.
  const note = ({ level = 'error', source = 'host', text, stack, ...fields }) => {
    const entry = { time: Date.now(), level, source, text: clean(text) }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') entry[key] = typeof value === 'string' ? clean(value) : value
    }
    // Frames only: the first line repeats the message, which is already the text.
    const frames = typeof stack === 'string' ? stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, STACK_LINES).map(line => line.trim()) : []
    if (frames.length > 0) entry.stack = clean(frames.join('\n'))
    fresh.push(entry)
    if (fresh.length > KEEP) fresh = fresh.slice(-KEEP)
    append(entry)
    return entry
  }

  const warn = (template, ...args) => {
    const error = args.find(arg => arg instanceof Error)
    const line = clean(format(template, ...args.map(arg => (arg instanceof Error ? errorText(arg) : arg))))
    const frames = typeof error?.stack === 'string' ? error.stack.split('\n').filter(item => /^\s+at /.test(item)).slice(0, STACK_LINES).map(item => item.trim()) : []
    // DSH may export no ctx.logger at all (see the header); a host or test ctx can also
    // carry a logger without warn. Either way stderr and the diagnostics log still get it.
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn('%s', line)
    console.error(`[ds-bot] ${line}${frames.length > 0 ? `\n${clean(frames.join('\n'))}` : ''}`)
    note({
      level: 'warn',
      source: 'host',
      text: line.replace(/^ds-bot: /, ''),
      code: typeof error?.code === 'string' ? error.code : undefined,
      stack: error?.stack,
    })
  }

  const entries = async () => {
    const old = (await earlier).filter(entry => entry.time > cleared)
    const list = [...old, ...fresh].slice(-KEEP).map(entry => ({
      ...entry,
      text: show(entry.text),
      ...(entry.stack ? { stack: show(entry.stack) } : {}),
    }))
    // A log this host could not read is not an empty one (#2604): the answer carries the reason
    // beside the entries, so a caller that would show "no entries" can say why instead. It is a
    // property of the answer, so every caller that reads the array still gets the array it knew.
    if (earlierFailure !== undefined) list.unread = earlierFailure
    return list
  }

  // A file named without opening it (#2388): `lstat` answers what the name is — a missing file is
  // the writer's to create, a plain file of this host's own has a size and a last write time worth
  // reporting, and a link, a second name or a check that cannot run is bytes this report may not
  // quote. So the answer is a sentence in every case, never a throw, and no read permission is
  // needed for a file that would otherwise have to be opened.
  const NOT_PLAIN = 'not a plain file (nothing is read or written)'
  // The team file is not a journal leaf (#2404): the store reads it through the link
  // (`readFile(statePath)` follows the last name) and its next save renames a temp name over this
  // one (`rename(temp, statePath)`), so a link to a plain file is read and replaced, not ignored. A
  // directory or a check that cannot run keeps the leaf sentence above: no read of those lands
  // either.
  const LINKED_STATE = 'not a plain file (described only; the store reads the team file through the link and the next save replaces the name)'
  // A link names a target, and the store's answer depends on it: a link to a plain file is the
  // shape above, while a link to a folder makes `readFile(statePath)` fail with EISDIR — the store
  // lands in `stuck`, `writable()` stays false and no save ever renames over the name, so the leaf
  // sentence is the true one. `stat` follows the link for its metadata only; the bytes behind it
  // stay unread, which is all this report may do with them.
  const stateNotPlain = async path => {
    try {
      const info = await lstat(path)
      if (!info.isSymbolicLink()) return info.isFile() && info.nlink > 1 ? LINKED_STATE : NOT_PLAIN
      if (!(await stat(path)).isFile()) return NOT_PLAIN
      // A target can be a plain file this host still cannot read: `readFile(statePath)` then fails
      // EACCES, the store lands in `stuck`, `writable()` stays false and the save the sentence above
      // promises never happens — the leaf sentence is the true one there too. `access` asks the
      // permission without opening the file and without reading a byte of it.
      await access(path, constants.R_OK)
      return LINKED_STATE
    } catch {
      return NOT_PLAIN
    }
  }
  // A path is cleaned like every other text (#2944): this host's own home first, the process's too,
  // so a machine shows `~/.dsh/...` and a test's temporary home shows `~/...` — no report carries
  // the folder a person lives in.
  const cleanPath = text => show(text)
  const fileFact = async (path, { missing, notPlain }) => {
    if (path === undefined) return undefined
    try {
      const kind = await fileKind(path)
      if (kind === 'absent') return missing
      if (kind !== 'real') return notPlain === undefined ? NOT_PLAIN : await notPlain(path)
      const info = await lstat(path)
      return `${cleanPath(path)} (${info.size} bytes, last written ${new Date(info.mtimeMs).toISOString()})`
    } catch {
      return NOT_PLAIN
    }
  }

  // What the store leaves beside the team file, named without opening it: one `state.json.v1`
  // taken before a version-1 migration, and the `state.json.broken-<stamp>` copies of a file that
  // could not be read. A report about a team that cannot be read has to say whether those are
  // there and whether this host can describe them, so the line lists name, size and age — `lstat`
  // for each name and one `readdir` for the broken ones, never an open: a backup holds the same
  // members, messages and saved keys as the team file itself.
  const BACKUPS_SHOWN = 3
  const sizeText = bytes => bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
      : `${Math.round(bytes / (1024 * 1024))} MB`
  const ageText = mtimeMs => {
    const ms = Date.now() - mtimeMs
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`
    return `${Math.round(ms / 86_400_000)} d ago`
  }
  // One name this host may describe, always from the metadata `lstat` gave: size and age. A name
  // `lstat` itself cannot answer for is named with the code it failed with, never guessed at; a
  // folder or a link is a name like any other here, drawn from its own metadata and never opened.
  const backupFact = (name, info) => `${name} (${sizeText(info.size)}, ${ageText(info.mtimeMs)})`
  const backupProblem = (name, error) => `${name} (unreadable: ${typeof error?.code === 'string' ? error.code : 'cannot be read'})`
  const stateBackups = async () => {
    if (statePath === undefined) return undefined
    const named = []
    const v1 = basename(`${statePath}.v1`)
    try {
      named.push(backupFact(v1, await lstat(`${statePath}.v1`)))
    } catch (error) {
      if (error?.code !== 'ENOENT') named.push(backupProblem(v1, error))
    }
    // The store names its unreadable-team copies with this one fixed prefix (#199 and #143), so a
    // listing filtered by it names only files the store itself wrote; the rest of the folder is
    // never guessed at.
    const prefix = `${basename(statePath)}.broken-`
    const broken = []
    try {
      for (const name of (await readdir(home)).filter(name => name.startsWith(prefix))) {
        try {
          broken.push({ name, info: await lstat(join(home, name)) })
        } catch (error) {
          broken.push({ name, error })
        }
      }
    } catch {
      // a home this host cannot list adds no broken copies and no sentence of its own
    }
    // Newest first: the copy a person restoring a team wants is the last one taken, and the rest
    // are only counted — a home that failed to read the team repeatedly has one per attempt.
    broken.sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))
    for (const item of broken.slice(0, BACKUPS_SHOWN)) {
      named.push(item.info === undefined ? backupProblem(item.name, item.error) : backupFact(item.name, item.info))
    }
    if (broken.length > BACKUPS_SHOWN) named.push(`and ${broken.length - BACKUPS_SHOWN} more`)
    return named.length === 0 ? 'none' : named.join(', ')
  }

  // The write side and the read side of the log are different facts (#2383, #2604): an append that
  // lands says nothing about the lines this host never read, so the one line names both when both
  // apply, and `recording` only when neither does.
  const logState = () => {
    const written = leafRefusedNow ? 'not written (not a plain file of its own)'
      : fileFailure ? `not written (${fileFailure})`
        : undefined
    const read = earlierFailure === undefined ? undefined : `not read (${earlierFailure})`
    return [written, read].filter(Boolean).join(', ') || 'recording'
  }

  // The owner's switches, read once (#2940): a report about "Projects is gone" has to say whether
  // the Project plugin was switched off on this host, not only what the host is running. Values
  // only — `loaded` and `installed` are other facts (#2868) and belong to Settings → Plugins. A
  // switch that no longer answers what this start read is what the next restart loads, so the row
  // says so too; `pluginSwitchesAtStart(statePath)` is the same pair `pendingRestart` uses, and a
  // flip that comes back to the start value leaves nothing pending.
  const plugins = () => {
    const off = pluginSwitches(rt.state).filter(plugin => !plugin.enabled)
    if (off.length === 0) return undefined
    const pending = pluginSwitchesPending(rt.state, pluginSwitchesAtStart(statePath))
    const names = off.map(plugin => plugin.id).join(', ')
    return `${names} off${off.some(plugin => pending[plugin.id]) ? ' (restart pending)' : ''}`
  }

  const facts = async () => {
    const bots = Object.values(rt.state.bots)
    const models = [...new Set(bots.map(bot => bot.model ?? bot.appliedModel).filter(Boolean))]
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
    const groups = Object.keys(rt.state.rooms).length
    const journal = rt.journal?.status()
    const readOnly = rt.readOnly?.()
    return {
      botVersion: ownVersion(),
      dshVersion: dshVersion(),
      os: `${platform()} ${release()} ${arch()}`,
      node: process.version,
      team: `${count(bots.length, 'Bot', 'Bots')}, ${rt.state.mainBotIds.length} Main, ${count(groups, 'group chat', 'group chats')}`,
      // The file that team is saved in, in the same shape as the two below (#2394): `lstat` only,
      // because the team file holds members and messages and a report may describe it and never
      // open it. `none yet` is a computer that has not saved this team — naming it creates nothing.
      // A link is described by the store's own shape (#2404), not by the journal leaf's sentence.
      stateFile: await fileFact(statePath, { missing: 'none yet (this computer has not saved the team)', notPlain: stateNotPlain }),
      // The backups beside it, in the same reading: a report about a team that cannot be read says
      // whether an earlier copy is still there, and never opens one.
      stateBackups: await stateBackups(),
      models: models.length > 0 ? models.join(', ') : undefined,
      // The store's own sentence (#2153): `stuck` (a team file that could not be read) and a
      // live state.lock are different faults, and the sidebar shows this same sentence, so the
      // report must not compress both into "another dsh holds the team".
      readOnly: readOnly ? show(readOnly, { max: 200 }) : undefined,
      plugins: plugins(),
      // The writer opens on the first save that got past `writable()` (#2351), so a window that
      // has not saved yet never read or repaired the file: `recording` there promises a line
      // nobody asked for, and `opened: false` says so instead. A window another dsh keeps
      // read-only says that, because it never reaches that first save either. A journal that
      // genuinely stopped keeps its own reason, which is the fault a report is usually for.
      stateJournal: journal === undefined ? undefined
        : journal.recording ? (readOnly ? 'paused (this window is read-only)'
          : journal.opened === false ? 'not started (opens with the first save)' : 'recording')
          : `stopped (${show(journal.because)})`,
      // The file that sentence is about, in the same shape (#2388): the path with the home as `~`
      // and its size and last write time, `none yet` before the first save creates it, or the one
      // sentence for a leaf this host would not read. A host without the journal says nothing.
      journalFile: journal === undefined ? undefined : await fileFact(rt.journal.path, { missing: 'none yet' }),
      // Where those errors are kept is the other half of that sentence, in the same shape: a host
      // with the log off says nothing (#2134), a host whose appends land says so, and a refused
      // leaf or a failed append names its own reason — the words stderr already used, never the
      // folder, and never a claim about a file behind a link this host did not write (#2089). Both
      // reasons are read as they stand now, not as the stderr latches left them (#2383). The
      // start-up read is the third (#2604): a log this host could not open leaves every earlier
      // line out of the list, so `recording` alone would claim a read that never happened.
      diagnosticsLog: !toFile ? undefined : show(logState()),
      // The read's own reason, so the report's text can say the earlier lines are missing without
      // reading it back out of the sentence above (#2604).
      diagnosticsLogUnread: !toFile ? undefined : (earlierFailure === undefined ? undefined : show(earlierFailure)),
    }
  }

  const sanitizeClient = (client) => {
    const pick = (value, max) => (typeof value === 'string' ? show(value, { max }) : undefined)
    return {
      surface: pick(client?.surface, 40),
      language: pick(client?.language, 20),
      userAgent: pick(client?.userAgent, 200),
    }
  }
  const sanitizeClientEntries = list => (Array.isArray(list) ? list : []).slice(-20).flatMap((item) => {
    if (typeof item?.text !== 'string' || typeof item.time !== 'number') return []
    return [{ time: item.time, level: item.level === 'warn' ? 'warn' : 'error', source: 'browser', text: show(item.text, { max: 500 }), ...(typeof item.code === 'string' ? { code: show(item.code, { max: 40 }) } : {}) }]
  })

  async function report(body = {}) {
    await rt.loadSecrets?.().catch(() => { /* without stored secrets the report is still built, redacting what it can */ })
    const list = await entries()
    const client = sanitizeClient(body.client)
    const clientEntries = sanitizeClientEntries(body.clientErrors)
    const hostFacts = await facts()
    return {
      facts: hostFacts,
      entries: list.slice(-50).reverse(),
      total: list.length,
      // The read failure on its own (#2604): additive, so a window that knows no such field keeps
      // reading `entries` and `total` as it did, and one that does can tell an empty log from one
      // this host never opened.
      ...(list.unread === undefined ? {} : { unread: list.unread }),
      markdown: reportMarkdown({ facts: hostFacts, client, entries: list, clientEntries }),
      issuesUrl: ISSUES_URL,
    }
  }

  async function logText() {
    await rt.loadSecrets?.().catch(() => { /* without stored secrets the log is still built, redacting what it can */ })
    const list = await entries()
    const lines = list.map(entry => (entry.stack ? `${entryLine(entry)}\n${entry.stack.replace(/^/gm, '    ')}` : entryLine(entry)))
    // The download is what a user hands over with a fault report, so it must not read as a log with
    // no entries when the reason it is empty is that this host could not read it (#2604).
    if (list.unread !== undefined) lines.push(`the diagnostics log could not be read (${list.unread}); the errors it holds are not shown`)
    return lines.join('\n')
  }

  async function clear() {
    // What the window's sentence is chosen from (#2360): the leaf is only `truncated` once the
    // truncate ran and the rotated copy only `removed` once its name is gone, so a page cannot say
    // "cleared" about a file it left alone.
    const result = { leaf: 'absent', rotated: 'none' }
    if (!toFile) { cleared = Date.now(); fresh = []; return result }
    const stamp = Date.now()
    // Clearing truncates the leaf, so it is the same question as the append: a link is not ours to
    // truncate, and the old file behind it stays exactly as it was.
    writing = writing.then(async () => {
      const kind = await fileKind(logPath)
      if (kind === 'other') { refuseLeaf(); result.leaf = 'kept'; return }
      // `rotated` says what this call did to `<logPath>.1`, so the probe runs before the truncate:
      // when the leaf cannot be emptied nothing is removed, and a copy that is there answers `kept`
      // rather than claiming there was none (#2364).
      const rotatedKind = await fileKind(`${logPath}.1`)
      if (rotatedKind !== 'absent') result.rotated = 'kept'
      // The truncate runs first, exactly as it did before #2360, a leaf that is not there yet
      // included (the write lands a new empty file, as this line always did): only the answer is new.
      // A folder that is not there makes the write fail the way it always did, and nothing is on disk
      // to report as kept, so that answer stays `absent` rather than sending the page a refusal.
      try {
        await writeFile(logPath, '', 'utf8')
        result.leaf = 'truncated'
      } catch (error) {
        // `ENOENT` is not a refusal: there was no leaf on disk to empty, so there was nothing to
        // truncate — the same answer the `!toFile` host above gives, and it says so on no line at
        // all. Every other code is a leaf we wanted to empty and could not: the window hears
        // `kept`, and the host log names the code on exactly one line (#2364), never the folder.
        // The throw stays so the chain ends here either way.
        if (error?.code === 'ENOENT') {
          result.leaf = 'absent'
        } else {
          result.leaf = 'kept'
          console.error('[ds-bot] diagnostics log not truncated:', error?.code ?? clean(error?.message ?? String(error)))
        }
        throw error
      }
      // Rotation moves the full log to `<logPath>.1`, and the truncate alone left every rotated line
      // on disk after the user asked for the error log to be cleared. That one name belongs to this
      // log, so it goes in the same chain and behind the same guard — and behind the truncate: a leaf
      // that cannot be emptied leaves the copy where it is, because the lines it holds are the only
      // copy of those lines that is left. The removal keeps a try of its own: a copy that cannot be
      // removed (a directory under that name, a folder without its write bit) must not reject the
      // chain, or the window says "cleared" while both names still hold every line. The line names
      // the leftover, never the folder.
      if (rotatedKind === 'absent') return
      try {
        await rm(`${logPath}.1`, { force: true })
        result.rotated = 'removed'
      } catch (error) {
        console.error('[ds-bot] diagnostics log rotated copy not removed:', error?.code ?? clean(error?.message ?? String(error)))
      }
    }).catch(() => {})
    await writing
    // #2364 (P-530): a Clear that did not empty the leaf has no readable surface to clear either.
    // `entries()` reads the old lines through `cleared` and the live ones out of `fresh`, so moving
    // either one on a refusal wiped the list and the Download while every byte was still on disk —
    // the page read "not cleared" next to "0 recent errors". Only a leaf that really was truncated
    // moves them, plus the `!toFile` host above, which keeps no log file to begin with; every other
    // answer, an `ENOENT` write included, leaves both exactly as they were. A line noted while the
    // chain was running keeps its place, because it is newer than the request.
    if (result.leaf === 'truncated') {
      cleared = stamp
      fresh = fresh.filter(entry => entry.time > stamp)
    }
    return result
  }

  Object.assign(rt, { warn, noteFailure: note, diagnostics: { report, logText, clear, entries } })
}
