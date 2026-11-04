// Unix FIFOs carry credentials in kernel buffers, never regular files or SDK history.
import { constants, watch } from 'node:fs'
import { open, lstat, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const pause = () => new Promise(resolve => setTimeout(resolve, 20))
const maxBytes = 20000
async function pipe(path, flags) {
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  if (!(await file.stat()).isFIFO()) { await file.close(); throw Error('Role credential channel is not a FIFO') }
  return file
}
async function writePipe(path, value) {
  const data = Buffer.from(JSON.stringify(value))
  if (data.length > maxBytes) throw Error('Role credential exceeds transport budget')
  const file = await pipe(path, constants.O_WRONLY), end = Date.now() + 10000
  try {
    let offset = 0
    while (offset < data.length) {
      if (Date.now() > end) throw Error('Role credential pipe timed out')
      try { const { bytesWritten } = await file.write(data, offset, data.length - offset); offset += bytesWritten }
      catch (error) { if (error.code !== 'EAGAIN') throw error; await pause() }
    }
  } finally { await file.close() }
}
export function serveRoleCredentials(directory, credential) {
  let closed = false, scanning = false
  const active = new Set()
  async function scan() {
    if (closed || scanning) return
    scanning = true
    try {
      const names = await readdir(directory)
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.request$/.test(name) || active.has(name) || active.size >= 4) continue
        active.add(name)
        void (async () => {
          const requestPath = join(directory, name), responsePath = join(directory, name.replace('.request', '.pipe'))
          try {
            if (!(await lstat(requestPath)).isFile() || !(await lstat(responsePath)).isFIFO()) throw Error('Invalid role credential request')
            const result = await credential()
            if (closed) throw Error('Closed role credential channel')
            await writePipe(responsePath, result)
          } catch { // Refuse without persisting errors, tokens or arbitrary private responses.
            if (!closed) await writePipe(responsePath, { denied: true }).catch(() => {}) // A closed/absent reader cannot receive a refusal; never persist private errors.
          } finally { await rm(requestPath, { force: true }).catch(() => {}); active.delete(name); if (!closed) void scan() }
        })()
      }
    } catch { // A removed/unavailable private channel fails closed; clients have a bounded timeout.
      closed = true; watcher.close()
    } finally { scanning = false }
  }
  const watcher = watch(directory, () => { void scan() })
  watcher.on('error', () => { closed = true; watcher.close() })
  return { close() { closed = true; watcher.close() } }
}
export async function requestRoleCredential(directory) {
  const id = randomUUID(), responsePath = join(directory, id + '.pipe'), requestPath = join(directory, id + '.request'), temporary = requestPath + '.tmp'
  let file
  try {
    await exec('mkfifo', ['-m', '600', responsePath], { timeout: 5000 })
    file = await pipe(responsePath, constants.O_RDONLY)
    await writeFile(temporary, '{}', { mode: 0o600 }); await rename(temporary, requestPath)
    const end = Date.now() + 30000, buffer = Buffer.alloc(4096), chunks = []
    let bytes = 0
    while (Date.now() < end) {
      try {
        const result = await file.read(buffer, 0, buffer.length, null)
        if (result.bytesRead) {
          bytes += result.bytesRead; if (bytes > maxBytes) throw Error('Role credential response exceeds budget')
          chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)))
          // A complete JSON value is the private transport frame; no disk staging.
          try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (value.denied) throw Error('Role credential authorization refused'); return value }
          catch (error) { if (!(error instanceof SyntaxError)) throw error }
        }
      } catch (error) { if (error.code !== 'EAGAIN') throw error }
      await pause()
    }
    throw Error('Role credential response timed out')
  } finally { await file?.close(); await Promise.all([responsePath, requestPath, temporary].map(path => rm(path, { force: true }))) }
}
