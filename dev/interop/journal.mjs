import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireValue } from './codec.mjs'

// Offline fixture storage only. A lock left by a killed process is deliberately
// not auto-stolen: the operator must establish that the old writer is gone.
export class Journal {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.dir = dir
    this.path = join(dir, 'journal.json')
    this.lock = join(dir, 'writer.lock')
    this.fd = openSync(this.lock, 'wx', 0o600)
    try {
      this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { version: 1, tasks: {}, inbox: {}, cursors: {} }
      requireValue(this.state.version === 1 && this.state.tasks && this.state.inbox && this.state.cursors, 'invalid journal')
    } catch (error) { this.close(); throw error }
  }
  transaction(fn) {
    requireValue(this.fd !== undefined, 'journal closed')
    const next = structuredClone(this.state)
    const result = fn(next)
    const temporary = `${this.path}.tmp`
    const file = openSync(temporary, 'w', 0o600)
    try { writeFileSync(file, JSON.stringify(next)); fsyncSync(file) } finally { closeSync(file) }
    renameSync(temporary, this.path)
    const directory = openSync(this.dir, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
    this.state = next
    return structuredClone(result)
  }
  close() {
    if (this.fd === undefined) return
    closeSync(this.fd); this.fd = undefined; unlinkSync(this.lock)
  }
}
