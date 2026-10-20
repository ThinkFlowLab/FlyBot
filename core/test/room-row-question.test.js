import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// A group row shows an open question asked about work handed out from that group (#552):
// #550 moved such a card into the group's composer dock, so the asking Bot's own row no
// longer sees it and the group row has to say it waits for me.
test('a group sidebar row shows an open question asked in that group (#552)', () => {
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const row = sidebar.slice(sidebar.indexOf('function RoomRow('), sidebar.indexOf('function AgentSessionRow('))
  assert.match(row, /const question = roster\.questions\?\.\[id\] !== undefined/)
  assert.match(row, /const alert = question \|\| waiting/)
  // The row names the question in its label, after an approval if both wait.
  assert.match(row, /waiting \? t\('Waiting for your approval'\) : alert \? t\('Waiting for your answer'\) : ''/)
  // The waiting dot is drawn for a question too, never only for approvals.
  assert.match(row, /wide && alert && !active \? h\('span', \{ className: 'bt-unread bt-unread-wait'/)
})
