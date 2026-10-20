// State journal (#511): an opt-in, append-only record of the changes to the saved team
// (state.json), so a multi-Bot bug that reproduces only sometimes can be replayed step by
// step. Off unless the `bot` config sets `stateJournal: true`. It records state mutations
// only (decisions are #396's), stays on this host (<home>/journal/state.jsonl, mode
// 0600, folder 0700, no network), and keeps 7 days or 20 MB, whichever comes first, by
// folding the oldest lines into the base line that starts the file.
//
// Each line is one JSON entry `{ seq, t, op, key, prev, next, botId, actor }`:
//   base    `next` is the whole team; the journal starts with one, and a line that cannot
//           be written as a smaller change is a base too.
//   set     `key` (a path into the team) now holds `next`; it held `prev` (absent: new).
//   delete  `key` held `prev` and is gone.
//   append  the list at `key` had `prevLength` items, lost `drop` from the front and
//           gained the `next` items at the end (the exchange log is capped this way).
// Replay is strict: an unreadable or unknown line, a gap in `seq`, or a `prev` that does
// not match what the earlier lines built refuses the whole journal (no partial team).
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const JOURNAL_MAX_BYTES = 20 * 1024 * 1024
export const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// A prune keeps this share of the caps, so the file is not rewritten on every save once
// it reaches one of them.
const PRUNE_TO = 0.9
// `bots.<id>.<field>` is the deepest path; anything below changes as one value.
const MAX_DEPTH = 3
const OPS = new Set(['base', 'set', 'delete', 'append'])

export class JournalError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JournalError'
    this.code = 'EJOURNAL'
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The bytes store.js writes to state.json for this team.
export const stateText = state => JSON.stringify(state, null, 2)

// Own-property writes only: a key such as `__proto__` from the file stays plain data.
const put = (target, key, value) => {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

// Smallest d such that `prev` without its first d items starts `next`; undefined when
// `next` is not `prev` slid forward.
const slide = (prev, next) => {
  const before = prev.map(item => JSON.stringify(item))
  const after = next.map(item => JSON.stringify(item))
  // Dropping every earlier item is a replacement, which `set` records with its `prev`.
  const most = before.length === 0 ? 0 : before.length - 1
  for (let drop = 0; drop <= most; drop += 1) {
    const kept = before.length - drop
    if (kept > after.length) continue
    let match = true
    for (let at = 0; at < kept; at += 1) {
      if (before[drop + at] !== after[at]) {
        match = false
        break
      }
    }
    if (match) return drop
  }
  return undefined
}

const diffValue = (prev, next, key, out) => {
  if (same(prev, next)) return
  if (isRecord(prev) && isRecord(next) && key.length < MAX_DEPTH) {
    for (const name of Object.keys(prev)) {
      if (!Object.hasOwn(next, name)) out.push({ op: 'delete', key: [...key, name], prev: prev[name] })
    }
    for (const name of Object.keys(next)) {
      if (!Object.hasOwn(prev, name)) out.push({ op: 'set', key: [...key, name], next: next[name] })
      else diffValue(prev[name], next[name], [...key, name], out)
    }
    return
  }
  if (Array.isArray(prev) && Array.isArray(next) && key.length > 0) {
    const drop = slide(prev, next)
    if (drop !== undefined) {
      out.push({ op: 'append', key, prevLength: prev.length, drop, next: next.slice(prev.length - drop) })
      return
    }
  }
  if (key.length === 0) {
    out.push({ op: 'base', next })
    return
  }
  out.push({ op: 'set', key, prev, next })
}

// The changes from one saved team to the next. A change only a key reorder explains
// (which the per-key changes cannot carry) becomes one base line, so replay always
// rebuilds the exact bytes.
export function diffState(prev, next) {
  const changes = []
  diffValue(prev, next, [], changes)
  const want = stateText(next)
  if (changes.length === 0 && stateText(prev) === want) return []
  if (changes.some(change => change.op === 'base')) return [{ op: 'base', next }]
  let rebuilt = JSON.parse(JSON.stringify(prev))
  for (const change of changes) rebuilt = applyChange(rebuilt, change)
  return stateText(rebuilt) === want ? changes : [{ op: 'base', next }]
}

const parentOf = (state, key) => {
  let at = state
  for (const name of key.slice(0, -1)) {
    if (!isRecord(at) || !Object.hasOwn(at, name)) throw new JournalError(`path ${key.join('.')} does not exist`)
    at = at[name]
  }
  if (!isRecord(at)) throw new JournalError(`path ${key.join('.')} is not inside a record`)
  return at
}

// Applies one change and returns the team (a base replaces it).
export function applyChange(state, change) {
  if (change.op === 'base') return JSON.parse(JSON.stringify(change.next))
  if (state === undefined) throw new JournalError('the journal does not start with a base line')
  const { key } = change
  const parent = parentOf(state, key)
  const name = key.at(-1)
  const had = Object.hasOwn(parent, name)
  if (change.op === 'set') {
    if (Object.hasOwn(change, 'prev') ? !had || !same(parent[name], change.prev) : had) throw new JournalError(`path ${key.join('.')} does not hold the recorded earlier value`)
    put(parent, name, JSON.parse(JSON.stringify(change.next)))
  } else if (change.op === 'delete') {
    if (!had || !same(parent[name], change.prev)) throw new JournalError(`path ${key.join('.')} does not hold the recorded earlier value`)
    delete parent[name]
  } else {
    const list = parent[name]
    if (!had || !Array.isArray(list) || list.length !== change.prevLength) throw new JournalError(`path ${key.join('.')} is not the recorded list`)
    put(parent, name, [...list.slice(change.drop), ...JSON.parse(JSON.stringify(change.next))])
  }
  return state
}

const checkEntry = (entry, line) => {
  const where = `line ${line}`
  if (!isRecord(entry)) throw new JournalError(`${where} is not an entry`)
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) throw new JournalError(`${where} has no valid seq`)
  if (!Number.isFinite(entry.t)) throw new JournalError(`${where} has no valid time`)
  if (!OPS.has(entry.op)) throw new JournalError(`${where} has an unknown op ${JSON.stringify(entry.op)}`)
  if (entry.op === 'base') {
    if (!isRecord(entry.next)) throw new JournalError(`${where} is a base without a team`)
    return
  }
  if (!Array.isArray(entry.key) || entry.key.length === 0 || entry.key.length > MAX_DEPTH || !entry.key.every(name => typeof name === 'string')) throw new JournalError(`${where} has no valid key`)
  if (entry.op === 'set' && !Object.hasOwn(entry, 'next')) throw new JournalError(`${where} sets no value`)
  if (entry.op === 'delete' && !Object.hasOwn(entry, 'prev')) throw new JournalError(`${where} deletes without the earlier value`)
  if (entry.op === 'append') {
    const valid = Number.isSafeInteger(entry.prevLength) && Number.isSafeInteger(entry.drop) && entry.drop >= 0 && entry.drop <= entry.prevLength && Array.isArray(entry.next)
    if (!valid) throw new JournalError(`${where} is not a valid append`)
  }
}

// Every entry of a journal file, checked: whole lines only, consecutive seq, a base first.
export function parseJournal(text) {
  if (text === '') return []
  if (!text.endsWith('\n')) throw new JournalError('the last line is incomplete')
  const entries = text.slice(0, -1).split('\n').map((line, at) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      throw new JournalError(`line ${at + 1} is not valid JSON`)
    }
    checkEntry(entry, at + 1)
    return entry
  })
  if (entries[0].op !== 'base') throw new JournalError('the journal does not start with a base line')
  for (let at = 1; at < entries.length; at += 1) {
    if (entries[at].seq !== entries[at - 1].seq + 1) throw new JournalError(`line ${at + 1} breaks the seq order (${entries[at - 1].seq} then ${entries[at].seq})`)
  }
  return entries
}

const replayEntries = (entries, seq) => {
  let state
  for (const entry of entries) {
    if (entry.seq > seq) break
    state = applyChange(state, entry)
  }
  return state
}

// The team as it was right after entry `seq` (default: the last one). A seq the
// journal no longer or not yet holds is refused, never approximated.
export function replayTo(text, seq) {
  const entries = parseJournal(text)
  if (entries.length === 0) throw new JournalError('the journal is empty')
  const first = entries[0].seq
  const last = entries.at(-1).seq
  const to = seq ?? last
  if (!Number.isSafeInteger(to) || to < first || to > last) throw new JournalError(`seq ${seq} is outside this journal (${first}–${last})`)
  return replayEntries(entries, to)
}

const lineOf = entry => `${JSON.stringify(entry)}\n`
const bytesOf = entries => entries.reduce((sum, entry) => sum + Buffer.byteLength(lineOf(entry)), 0)

// Drops the oldest changes once the journal is older than `maxAgeMs` or larger than
// `maxBytes`, folding them into the base line, so the kept lines still replay from it.
export function pruneEntries(entries, { now, maxBytes = JOURNAL_MAX_BYTES, maxAgeMs = JOURNAL_MAX_AGE_MS }) {
  const over = list => bytesOf(list) > maxBytes || (list.length > 1 && now - list[1].t > maxAgeMs)
  if (!over(entries)) return entries
  const keepBytes = maxBytes * PRUNE_TO
  const keepAge = maxAgeMs * PRUNE_TO
  let bytes = bytesOf(entries)
  let cut = 1
  while (cut < entries.length && (bytes > keepBytes || now - entries[cut].t > keepAge)) {
    bytes -= Buffer.byteLength(lineOf(entries[cut]))
    cut += 1
  }
  const folded = entries[cut - 1]
  const base = { seq: folded.seq, t: folded.t, op: 'base', next: replayEntries(entries, folded.seq), actor: 'retention' }
  return [base, ...entries.slice(cut)]
}

// The writer one host keeps while `stateJournal` is on. `record(snapshot)` takes the exact
// text just written to state.json. Any problem (a journal that does not replay, a path
// that is not a plain file, a failed write) stops recording for this run with a warning
// and leaves the file as it is; it never stops the team from saving.
export function openJournal({ path, warn, now = Date.now, maxBytes = JOURNAL_MAX_BYTES, maxAgeMs = JOURNAL_MAX_AGE_MS }) {
  let stopped = false
  let lastText
  let seq = 0
  let bytes = 0
  let oldest
  let queue = Promise.resolve()

  const stop = (error) => {
    stopped = true
    warn('ds-bot: state journal %s is not recording: %s', path, error)
  }

  const open = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await chmod(dirname(path), 0o700)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (!info.isFile()) throw new JournalError('the journal path is not a plain file')
    await chmod(path, 0o600)
    const text = await readFile(path, 'utf8')
    const entries = parseJournal(text)
    if (entries.length === 0) return
    lastText = stateText(replayEntries(entries, Infinity))
    seq = entries.at(-1).seq
    bytes = Buffer.byteLength(text)
    oldest = entries[1]?.t
  }
  const opened = open().catch(stop)

  const write = async (snapshot, actor) => {
    await opened
    if (stopped || snapshot === lastText) return
    const next = JSON.parse(snapshot)
    const changes = lastText === undefined ? [{ op: 'base', next }] : diffState(JSON.parse(lastText), next)
    const t = now()
    const fresh = changes.map((change) => {
      seq += 1
      const botId = change.key?.[0] === 'bots' && change.key.length > 1 ? change.key[1] : undefined
      return { seq, t, ...change, ...(botId === undefined ? {} : { botId }), actor }
    })
    const text = fresh.map(lineOf).join('')
    const added = Buffer.byteLength(text)
    const firstChange = oldest ?? fresh.find(entry => entry.op !== 'base')?.t
    if (lastText !== undefined && (bytes + added > maxBytes || (firstChange !== undefined && t - firstChange > maxAgeMs))) {
      const kept = pruneEntries([...parseJournal(await readFile(path, 'utf8')), ...fresh], { now: t, maxBytes, maxAgeMs })
      const whole = kept.map(lineOf).join('')
      if (Buffer.byteLength(whole) > maxBytes) throw new JournalError('the team alone is larger than the journal cap')
      const temp = `${path}.${process.pid}.tmp`
      try {
        await writeFile(temp, whole, { mode: 0o600, flag: 'wx' })
        await rename(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => { /* the temp file may not exist */ })
        throw error
      }
      bytes = Buffer.byteLength(whole)
      oldest = kept[1]?.t
    } else {
      await appendFile(path, text, { mode: 0o600 })
      bytes += added
      oldest = firstChange
    }
    lastText = snapshot
  }

  const record = (snapshot, actor = 'host') => {
    queue = queue.then(() => write(snapshot, actor)).catch(stop)
    return queue
  }
  return { record, path }
}
