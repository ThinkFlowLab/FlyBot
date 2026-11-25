// Small per-user document store on the user's own volume
// (<DSH_HOME>/flybot-workspace/<feature>/<name>.json, directory 0700, file 0600).
// One DSH process owns the volume, and every mutation runs synchronously in
// one event-loop turn, so a write is atomic (tmp + rename) and never interleaves.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function openJsonStore(dir, name, initial = () => ({})) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${name}.json`)
  let cache
  const read = () => {
    if (cache !== undefined) return cache
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : initial()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw Object.assign(new Error(`flybot-workspace store ${name} is unreadable`), { code: 'flybot-workspace/store' })
      cache = initial()
    }
    return cache
  }
  const write = (value) => {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    renameSync(tmp, file)
    cache = value
    return value
  }
  // fn receives a deep copy; whatever it returns (or the mutated copy) is saved.
  const update = (fn) => {
    const draft = structuredClone(read())
    const result = fn(draft)
    write(draft)
    return result
  }
  return { file, read: () => structuredClone(read()), update, write }
}
