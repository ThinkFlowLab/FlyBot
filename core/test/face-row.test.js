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
  assert.match(row, /className: face \? 'bt-row-title bt-row-title-face' : 'bt-row-title' \}, face \? faceRowTitle\(title\) : title\)/)
})

test('#1102: a face-room row wraps its number-first title, and the session breadcrumb wraps too', () => {
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const header = readFileSync(new URL('../src/client/header.js', import.meta.url), 'utf8')
  const row = sidebar.slice(sidebar.indexOf('function RoomRow('), sidebar.indexOf('function AgentSessionRow('))
  assert.match(row, /bt-row-title-face/)
  // One line cut "739184 · SelfA1025, SelfB…". Up to three lines keep every name; other rows stay nowrap.
  assert.match(styles, /\.bt-row-title\.bt-row-title-face\{[^}]*white-space:normal[^}]*-webkit-line-clamp:3/)
  assert.match(styles, /\.bt-row-title\{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/)
  // The in-app session title is the header breadcrumb, a 244px nowrap line
  // ("Face-to-face · SelfA1025, SelfB…"). Two lines keep both names and the number.
  assert.match(styles, /\[class\*="switcherTitle"\]\{[^}]*white-space:normal[^}]*-webkit-line-clamp:2/)
  const pill = header.slice(header.indexOf('export function HeaderPill'), header.indexOf('function useTranscriptView'))
  assert.match(pill, /bt-pill-name-face/)
  assert.match(pill, /faceRowTitle\(/)
  assert.match(styles, /\.bt-pill-name\.bt-pill-name-face\{[^}]*white-space:normal/)
})

test("#458: a face room's turns never take over its Bots' sidebar preview; other groups still show", () => {
  const roomsById = { g1: { id: 'g1', origin: 'face-to-face', name: 'Face-to-face · A, B · 482915' }, g2: { id: 'g2', name: 'Team' } }
  assert.deepEqual(awayGroups([{ id: 'g1', tool: 'think' }], roomsById), [])
  assert.deepEqual(awayGroups([{ id: 'g1' }, { id: 'g2', tool: 'read' }], roomsById), [{ id: 'g2', tool: 'read' }])
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  const row = sidebar.slice(sidebar.indexOf('function BotRow('), sidebar.indexOf('function RemoteMark('))
  assert.match(row, /const shownAway = away \? awayGroups\(groups, roster\.roomsById\) : \[\]/)
})
