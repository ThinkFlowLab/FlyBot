import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { roomTitle } from '../src/shared/remote-label.js'

const source = (file) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('#892: a room a link opened is named by its own name; a friend\'s shared room still says who shared it', () => {
  const from = { inviterName: 'Ann', inviterHandle: '@chief.ann.home' }
  assert.equal(roomTitle({ id: 'r', name: 'Trip plan', origin: 'inbound-share', sharedFrom: { ...from, ticket: 'TktAbCdEfGhIjKlMnOpQrS' } }), 'Trip plan')
  // The host's per-viewer label for an invited owner does not hide a link room's name either.
  assert.equal(roomTitle({ id: 'r', name: 'Trip plan', displayName: 'Shared room from Ann', sharedFrom: { ...from, ticket: 'TktAbCdEfGhIjKlMnOpQrS' } }), 'Trip plan')
  // No name: who shared it.
  assert.equal(roomTitle({ id: 'r', name: '', sharedFrom: { ...from, ticket: 'TktAbCdEfGhIjKlMnOpQrS' } }), 'Shared room from Ann')
  // A friend's share (no ticket) keeps today's title, whatever the room is called on the far side.
  assert.equal(roomTitle({ id: 'r', name: 'Trip plan', sharedFrom: from }), 'Shared room from Ann')
  assert.equal(roomTitle({ id: 'r', name: 'Trip plan', displayName: 'Shared room from Ann', sharedFrom: from }), 'Shared room from Ann')
  // A room that lives here is unchanged.
  assert.equal(roomTitle({ id: 'r', name: 'Team' }), 'Team')
  assert.equal(roomTitle({ id: 'r', name: 'Team', displayName: 'Kitchen' }), 'Kitchen')
  assert.equal(roomTitle(undefined), '')
})

test('#892: the sidebar, the header, its effects, the drawer and the brand all name a room through roomTitle', () => {
  for (const file of ['sidebar.js', 'header.js', 'header-effects.js', 'details-drawer.js', 'brand.js']) {
    const text = source(file)
    assert.match(text, /roomTitle\(room\)/, `${file} names the room through roomTitle`)
    assert.doesNotMatch(text, /sharedRoomTitle\(room\??\.sharedFrom\.inviterName\) : room\??\.name/, `${file} has no title of its own for a shared room`)
  }
  // The row keeps who shared it as secondary text: its hover, its spoken label and the Shared tag.
  const sidebar = source('sidebar.js')
  const row = sidebar.slice(sidebar.indexOf('function RoomRow('), sidebar.indexOf('function AgentSessionRow('))
  assert.match(row, /const from = room\.sharedFrom \? sharedRoomTitle\(room\.sharedFrom\.inviterName\) : ''/)
  assert.match(row, /const hover = from && from !== title \? `\$\{title\} · \$\{from\}` : title/)
  assert.match(row, /const label = \[hover, /)
  assert.match(row, /title: hover,/)
  assert.match(row, /h\('span', \{ className: 'bt-tag', title: from \}, t\('Shared'\)\)/)
})
