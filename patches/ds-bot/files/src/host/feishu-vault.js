import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

// Separate from user Secrets: no shell environment, model schema, or connection view can expose these.
export function createFeishuVault(home) {
  let key, records, loading, tail = Promise.resolve()
  const path = join(home, 'feishu-credentials.json')
  const load = () => loading ??= (async () => {
    await mkdir(home, { recursive: true, mode: 0o700 })
    const keyPath = join(home, 'feishu-credentials.key')
    try { key = await readFile(keyPath) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      key = randomBytes(32)
      try { await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 }) }
      catch (err) { if (err.code !== 'EEXIST') throw err; key = await readFile(keyPath) }
    }
    if (key.length !== 32) throw new Error('Invalid Feishu credential key')
    try { records = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read Feishu credentials'); records = {} }
  })()
  const get = async id => {
    await load()
    const item = records[id]
    if (!item) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'))
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(Buffer.from(item.tag, 'base64'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString())
  }
  const set = (id, value) => {
    const job = tail.then(async () => {
      await load()
      const next = { ...records }
      if (value === undefined) delete next[id]
      else {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(Buffer.from(id))
        next[id] = { iv: iv.toString('base64'), data: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') }
      }
      const temp = `${path}.${randomBytes(8).toString('hex')}`
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 })
      await rename(temp, path)
      records = next
    })
    tail = job.catch(() => {})
    return job
  }
  return { get, set }
}
