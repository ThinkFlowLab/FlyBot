// Media objects for this user's works library, stored under the artifacts
// feature directory (legacy artifacts.py write_media/read_media/unlink_media).
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { HEX32, SHA256, MAX_MEDIA_OBJECT_BYTES, MAX_MEDIA_BYTES, MEDIA_MIMES } from './model.js'
import { GLB_MIME, MAX_GLB_BYTES } from '../../lib/glb.js'
import { refuse } from '../../featurekit/http.js'

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants

export function mediaRoot(featureDir) {
  return join(featureDir, 'objects')
}

export function mediaPath(featureDir, workspaceId, digestHex) {
  if (!HEX32.test(workspaceId) || !SHA256.test(digestHex)) throw new Error('invalid object path')
  return join(mediaRoot(featureDir), workspaceId, digestHex)
}

function privateDir(path) {
  if (existsSync(path)) {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('invalid media directory')
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('invalid media directory')
  if (info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('media directory must be private')
}

export function writeMedia(featureDir, workspaceId, payload) {
  const digestHex = createHash('sha256').update(payload).digest('hex')
  privateDir(mediaRoot(featureDir))
  privateDir(join(mediaRoot(featureDir), workspaceId))
  const path = mediaPath(featureDir, workspaceId, digestHex)
  if (existsSync(path)) {
    const info = lstatSync(path)
    if (!info.isSymbolicLink() && info.isFile()) return digestHex
  }
  const fd = openSync(path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
  try {
    let written = 0
    while (written < payload.length) written += writeSync(fd, payload, written, payload.length - written, written)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  return digestHex
}

export function readMediaBytes(featureDir, workspaceId, digestHex, expected, mime) {
  const path = mediaPath(featureDir, workspaceId, digestHex)
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    const limit = mime === GLB_MIME ? MAX_GLB_BYTES : MEDIA_MIMES.has(mime) ? MAX_MEDIA_OBJECT_BYTES : MAX_MEDIA_BYTES
    if (!info.isFile() || info.size > limit) throw new Error('invalid media object')
    if (expected != null && info.size !== expected) throw new Error('media size mismatch')
    const data = Buffer.alloc(info.size)
    const read = readSync(fd, data, 0, info.size, 0)
    if (read !== info.size) throw new Error('short media read')
    return data
  } finally { closeSync(fd) }
}

export function unlinkMedia(featureDir, store, workspaceId, digestHex) {
  const current = store.get(
    'SELECT COUNT(*) AS n FROM artifact_media md JOIN artifacts a ON a.id=md.artifact_id WHERE a.workspace_id=? AND md.sha256=?',
    workspaceId, digestHex,
  ).n
  const historic = store.get(
    'SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.workspace_id=? AND v.sha256=?',
    workspaceId, digestHex,
  ).n
  if (current || historic) return
  try { unlinkSync(mediaPath(featureDir, workspaceId, digestHex)) } catch { /* already gone */ }
}

export function attachMedia(store, artifactId, mime, byteCount, digestHex, filename) {
  store.run('DELETE FROM artifact_media WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_media VALUES(?,?,?,?,?)', artifactId, mime, byteCount, digestHex, filename)
}

export function mediaDigests(store, artifactId) {
  const values = new Set()
  const current = store.get('SELECT sha256 FROM artifact_media WHERE artifact_id=?', artifactId)
  if (current?.sha256) values.add(current.sha256)
  for (const item of store.all('SELECT sha256 FROM artifact_versions WHERE artifact_id=? AND sha256 IS NOT NULL', artifactId)) values.add(item.sha256)
  return values
}

export function decodeUpload(multipart) {
  if (!multipart || multipart._multipart !== true || !multipart.files || typeof multipart.files !== 'object') {
    refuse(400, 'invalid', 'Upload a media file')
  }
  const upload = multipart.files.file
  if (!upload || typeof upload.data !== 'string') refuse(400, 'invalid', 'Upload a media file')
  let data
  try { data = Buffer.from(upload.data, 'base64') } catch { refuse(400, 'invalid', 'Upload a media file') }
  if (!data.length || data.length > MAX_MEDIA_BYTES) refuse(data.length > MAX_MEDIA_BYTES ? 413 : 400, 'invalid', data.length > MAX_MEDIA_BYTES ? 'Request body is too large' : 'Upload a media file')
  return { fields: multipart.fields ?? {}, data, filename: upload.filename }
}

export function importMedia(bundle, { featureDir }) {
  const text = bundle?.media
  if (!text) return
  const declared = bundle.manifest?.media
  const digest = createHash('sha256').update(text, 'utf8').digest('hex')
  if (!declared || declared.sha256 !== digest) throw new Error('media digest mismatch')
  const items = JSON.parse(text)
  if (!Array.isArray(items) || items.length !== declared.rows) throw new Error('media row count mismatch')
  for (const item of items) {
    if (!HEX32.test(item.workspace_id) || !SHA256.test(item.sha256) || typeof item.data !== 'string') throw new Error('invalid media object')
    const data = Buffer.from(item.data, 'base64')
    if (item.byte_count != null && data.length !== item.byte_count) throw new Error('media size mismatch')
    const stored = writeMedia(featureDir, item.workspace_id, data)
    if (stored !== item.sha256) throw new Error('media object hash mismatch')
  }
}
