import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { awayGroups, faceRowTitle } from '../src/client/text.js'

test('#458: a face-room sidebar row leads with its number, so a cut title never hides it', () => {
  assert.equal(faceRowTitle('Face-to-face · SelfA0056, SelfB0056 · 482915'), '482915 · SelfA0056, SelfB0056')
  assert.equal(faceRowTitle('Face-to-face · 482915'), '482915')
  // A title without a number (an older room, the date form) or any other name stays as it is.
  assert.equal(faceRowTitle('Face-to-face · Alice, Bob · Oct 18 16:27'), 'Face-to-face · Alice, Bob · Oct 18 16:27')
  assert.equal(faceRowTitle('Kitchen'), 'Kitchen')
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  const row = sidebar.slice(sidebar.indexOf('function RoomRow('), sidebar.indexOf('function AgentSessionRow('))
  assert.match(row, /className: 'bt-row-title' \}, face \? faceRowTitle\(title\) : title\)/)
})

test("#458: a face room's turns never take over its Bots' sidebar preview; other groups still show", () => {
  const roomsById = { g1: { id: 'g1', origin: 'face-to-face', name: 'Face-to-face · A, B · 482915' }, g2: { id: 'g2', name: 'Team' } }
  assert.deepEqual(awayGroups([{ id: 'g1', tool: 'think' }], roomsById), [])
  assert.deepEqual(awayGroups([{ id: 'g1' }, { id: 'g2', tool: 'read' }], roomsById), [{ id: 'g2', tool: 'read' }])
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  const row = sidebar.slice(sidebar.indexOf('function BotRow('), sidebar.indexOf('function RemoteMark('))
  assert.match(row, /const shownAway = away \? awayGroups\(groups, roster\.roomsById\) : \[\]/)
})
