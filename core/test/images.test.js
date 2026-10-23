import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { attachmentFilePath, attachmentObjectPath, imagePlaceholder, offloadTargets } from '../src/host/images.js'

test('offloadTargets selects live images from prior user and tool messages', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'user/message' },
    { type: 'user/message' },
  ]
  const messages = new Map([
    [events[0], { content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ] }],
    [events[1], { content: [{ type: 'image', attachment: { attachmentId: 'ignored' } }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'd' } }] }],
    [events[3], { content: [{ type: 'text', text: 'no image' }] }],
    [events[4], { content: [{ type: 'image', attachment: { attachmentId: 'new' } }] }],
  ])
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
  }

  assert.deepEqual(offloadTargets(session, 4), [
    { seq: 0, imageIndexes: [0, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
})

// #779: an image the host cannot read is placeholder text, and the placeholder has to say where the
// bytes are — a path the Bot's own file tools can open. Everything below is about that sentence.

const SHA = 'bdc77c709327f813556c2c685d907f351f16a624da9173ed90a06c698b9082df'
const id = `sha256:${SHA}`
const attachment = { attachmentId: id, name: 'IMG_2431.jpeg', mediaType: 'image/jpeg', width: 1080, height: 1596, bytes: 213569 }

function homeWith(file) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-images-'))
  if (file !== undefined) {
    const path = join(home, 'attachments', 'v1', 'objects', SHA.slice(0, 2), SHA)
    mkdirSync(join(home, 'attachments', 'v1', 'objects', SHA.slice(0, 2)), { recursive: true })
    writeFileSync(path, 'jpeg-bytes')
  }
  return home
}

test('#779: the object path is the store layout, and only a content-addressed image id has one', () => {
  assert.equal(attachmentObjectPath('/h', id), join('/h', 'attachments', 'v1', 'objects', 'bd', SHA))
  for (const bad of ['attachment_01', 'sha256:xyz', 'sha256:' + 'a'.repeat(63), undefined, null, '']) {
    assert.equal(attachmentObjectPath('/h', bad), undefined, `no path for ${String(bad)}`)
  }
})

test('#779: a file the Bot can open is named, and one that is not there is never invented', async (t) => {
  const home = homeWith('object')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assert.equal(await attachmentFilePath(attachment, { home }), join(home, 'attachments', 'v1', 'objects', 'bd', SHA), 'the local object layout, when the file is there')

  const empty = homeWith(undefined)
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  assert.equal(await attachmentFilePath(attachment, { home: empty }), undefined, 'no path for a file that is not on disk')
  assert.equal(await attachmentFilePath({ attachmentId: 'attachment_01' }, { home }), undefined, 'no path for an id that is not content-addressed')

  // A directory where the object should be is not a file a Bot can read.
  const dir = homeWith(undefined)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'attachments', 'v1', 'objects', 'bd', SHA), { recursive: true })
  assert.equal(await attachmentFilePath(attachment, { home: dir }), undefined)
})

test('#779: the attachment store\'s path wins when the file sandbox can map it', async (t) => {
  const home = homeWith(undefined)
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const hostPath = join(home, 'elsewhere.jpg')
  writeFileSync(hostPath, 'mapped-bytes')
  const attachments = { imageHostPath: () => hostPath }
  assert.equal(await attachmentFilePath(attachment, { home, attachments, fs: { processPathFromHostPath: path => path } }), hostPath)
  // An unmapped host path is not offered: the Bot's tools could not open it.
  assert.equal(await attachmentFilePath(attachment, { home, attachments }), undefined, 'no host path without a mapping')
  assert.equal(await attachmentFilePath(attachment, { home, attachments, fs: {} }), undefined, 'no host path without a mapping function')
  // The mapping answering a path that is not a file falls back to the object store.
  assert.equal(await attachmentFilePath(attachment, { home, attachments, fs: { processPathFromHostPath: () => join(home, 'gone.jpg') } }), undefined)
  const withObject = homeWith('object')
  t.after(() => rmSync(withObject, { recursive: true, force: true }))
  assert.equal(
    await attachmentFilePath(attachment, { home: withObject, attachments, fs: { processPathFromHostPath: () => join(withObject, 'gone.jpg') } }),
    join(withObject, 'attachments', 'v1', 'objects', 'bd', SHA),
  )
})

test('#779: the placeholder names the file, its size and its type; without a path it stays as it was', () => {
  const named = imagePlaceholder(attachment, { path: '/workspace/.dsh/objects/bd/x' })
  assert.match(named, /^\[Image "IMG_2431\.jpeg" \(image\/jpeg, 1080x1596, 213569 bytes\): you cannot see images and it could not be read right now\./)
  assert.match(named, /The file is at "\/workspace\/\.dsh\/objects\/bd\/x"; your own file tools can open it\./)
  assert.match(named, /Ask the user what it shows if it matters\.\]$/)

  const none = imagePlaceholder(attachment)
  assert.doesNotMatch(none, /The file is at/, 'no path is invented when the bytes cannot be named')
  assert.match(none, /could not be read right now\. Ask the user/)

  // The group relay says the same thing, without the "you cannot see images" half.
  const group = imagePlaceholder(attachment, { path: '/p/x', group: true })
  assert.match(group, /\[Image "IMG_2431\.jpeg" \(image\/jpeg, 1080x1596, 213569 bytes\): it could not be read right now\./)
  assert.doesNotMatch(group, /you cannot see images/)

  // An unnamed image keeps the sha prefix the host has always shown.
  assert.match(imagePlaceholder({ attachmentId: id }), /\[Image sha256:bdc77c70:/)
})
