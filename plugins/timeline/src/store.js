// The trace file: an append-only, capped record log with one writer.
//
// Discipline (the same as dev/interop/journal.mjs): one writer holds `writer.lock`, and a
// file is only ever replaced whole: write a temporary file, fsync it, rename it over the
// segment, fsync the directory. A reader therefore sees the old or the new segment, never a
// torn one. Records are appended to the newest segment in memory and flushed on a short
// timer; a segment is bounded (`segmentRecords`), so rewriting it is cheap.
//
// Rotation: when the newest segment is full it is sealed and a new one starts; only the
// newest `segments` files are kept, and a record older than `retentionMs` is dropped when
// the trace is read. The default cap is 3 x 2000 records (about 3000 spans) or 24 hours,
// whichever comes first.
//
// The trace holds ids, times, outcomes and cleaned names: never message text, tool
// arguments or output, so there is no secret in it to protect (the files are 0600 anyway).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRACE_VERSION = 1
export const DEFAULTS = Object.freeze({ segmentRecords: 2000, segments: 3, retentionMs: 24 * 3600 * 1000, flushMs: 2000 })
const SEGMENT = /^trace-(\d{6})\.json$/

// Directories this process holds the writer lock for, so a second recorder on the same
// directory in one process (a plugin reload that did not dispose) is refused, not stolen.
const held = new Set()

export class TraceLocked extends Error {
  constructor(message) {
    super(message)
    this.name = 'TraceLocked'
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function acquire(dir) {
  if (held.has(dir)) throw new TraceLocked(`trace ${dir} is already open in this process`)
  const lock = join(dir, 'writer.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try { writeFileSync(fd, `${process.pid}\n`) } finally { closeSync(fd) }
      held.add(dir)
      return lock
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let pid = NaN
      try { pid = Number.parseInt(readFileSync(lock, 'utf8'), 10) } catch { /* removed meanwhile: try again */ }
      // A lock a killed process left behind is taken over; a live writer's is respected.
      if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) throw new TraceLocked(`another process (pid ${pid}) writes the trace in ${dir}`)
      try { unlinkSync(lock) } catch { /* someone else took it over first: the next attempt decides */ }
    }
  }
  throw new TraceLocked(`could not take the writer lock in ${dir}`)
}

function writeWhole(dir, path, value) {
  const temporary = `${path}.tmp`
  const file = openSync(temporary, 'w', 0o600)
  try { writeFileSync(file, JSON.stringify(value)); fsyncSync(file) } finally { closeSync(file) }
  renameSync(temporary, path)
  const directory = openSync(dir, 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

const segmentName = n => `trace-${String(n).padStart(6, '0')}.json`

// Opens (and creates) the trace in `dir`. `persist: false` keeps everything in memory.
export function openTrace({ dir, persist = true, now = Date.now, warn = () => {}, ...limits } = {}) {
  const { segmentRecords, segments, retentionMs, flushMs } = { ...DEFAULTS, ...limits }
  if (persist && typeof dir !== 'string') throw new Error('openTrace needs a directory')
  /** @type {{ n: number, startedAt: number, names: Record<string, Record<string, string>>, records: object[] }[]} */
  let kept = []
  let lock
  let timer
  let dirty = false
  let closed = false
  let failures = 0

  if (persist) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    lock = acquire(dir)
    const files = readdirSync(dir).filter(name => SEGMENT.test(name)).sort()
    for (const name of files) {
      try {
        const data = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (data?.version !== TRACE_VERSION || !Array.isArray(data.records)) throw new Error('not a trace segment')
        const names = data.names && typeof data.names === 'object' ? data.names : {}
        kept.push({ n: Number(SEGMENT.exec(name)[1]), startedAt: Number(data.startedAt) || 0, names, records: data.records, saved: data.records.length, savedNames: JSON.stringify(names) })
      } catch (error) {
        // Never crash the host over the trace, and never read the same bad file every start.
        warn('flybot-timeline: trace segment %s is unreadable (%s); it is set aside', name, error?.message ?? error)
        try { renameSync(join(dir, name), join(dir, `${name}.corrupt`)) } catch { /* it is ignored either way */ }
      }
    }
  }
  const fresh = () => ({ n: (kept.at(-1)?.n ?? 0) + 1, startedAt: now(), names: {}, records: [] })
  const newest = () => {
    if (kept.length === 0) kept.push(fresh())
    return kept.at(-1)
  }
  newest()

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!persist || !dirty) return true
    try {
      for (const segment of kept) {
        if (segment.saved === segment.records.length && segment.savedNames === JSON.stringify(segment.names)) continue
        writeWhole(dir, join(dir, segmentName(segment.n)), { version: TRACE_VERSION, segment: segment.n, startedAt: segment.startedAt, names: segment.names, records: segment.records })
        segment.saved = segment.records.length
        segment.savedNames = JSON.stringify(segment.names)
      }
      dirty = false
      failures = 0
      return true
    } catch (error) {
      // Disk full, directory removed: record in memory and say so once per streak.
      if (failures++ === 0) warn('flybot-timeline: trace write failed: %s', error?.message ?? error)
      return false
    }
  }
  const schedule = () => {
    if (!persist || timer !== undefined || closed) return
    timer = setTimeout(flush, flushMs)
    timer.unref?.()
  }
  // Files beyond the newest `segments`, segments that hold only expired records, and
  // corrupt leftovers older than every kept segment go.
  const prune = () => {
    const floor = now() - retentionMs
    const expired = segment => segment.records.length > 0 && segment.records.every(record => record.t < floor)
    while (kept.length > 1 && (kept.length > segments || expired(kept[0]))) {
      const [old] = kept.splice(0, 1)
      if (persist) { try { unlinkSync(join(dir, segmentName(old.n))) } catch { /* already gone */ } }
    }
    if (!persist) return
    for (const name of readdirSync(dir)) {
      const match = /^trace-(\d{6})\.json\.corrupt$/.exec(name)
      if (match && Number(match[1]) < kept[0].n) { try { unlinkSync(join(dir, name)) } catch { /* already gone */ } }
    }
  }
  prune()

  return {
    dir,
    // Appends one record; `names` (optional) refreshes the id -> label table kept with the segment.
    append(record, names) {
      if (closed) return
      let segment = newest()
      if (segment.records.length >= segmentRecords) {
        flush()
        segment = fresh()
        kept.push(segment)
        prune()
      }
      segment.records.push(record)
      if (names) {
        for (const [group, table] of Object.entries(names)) {
          segment.names[group] ??= {}
          Object.assign(segment.names[group], table)
        }
      }
      dirty = true
      schedule()
    },
    // The retained records, oldest first, without those past the retention age.
    records() {
      const floor = now() - retentionMs
      return kept.flatMap(segment => segment.records).filter(record => !(record.t < floor))
    },
    // Newest-wins merge of the label tables of the retained segments.
    names() {
      const out = { bots: {}, rooms: {} }
      for (const segment of kept) for (const [group, table] of Object.entries(segment.names)) Object.assign(out[group] ??= {}, table)
      return out
    },
    flush,
    stats: () => ({ segments: kept.length, records: kept.reduce((sum, segment) => sum + segment.records.length, 0), segmentRecords, maxSegments: segments, retentionMs, persist, failing: failures > 0 }),
    close() {
      if (closed) return
      flush()
      closed = true
      clearTimeout(timer)
      if (lock) {
        held.delete(dir)
        try { unlinkSync(lock) } catch { /* already gone */ }
      }
    },
  }
}
export const traceExists = dir => existsSync(dir) && readdirSync(dir).some(name => SEGMENT.test(name))
