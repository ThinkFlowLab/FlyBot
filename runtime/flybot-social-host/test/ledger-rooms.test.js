import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, bookFile, parseBook } from '../../ds-bot-upstream/ds-bot/src/host/ledger.js'
import { createFlybotFacade, groupLedgerBook } from '../src/facade.js'

const host = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ot-social-ledger-'))
  const state = {
    bots: { a: { id: 'a', name: 'Chief' } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'] } },
    prefs: {},
  }
  const rt = { home, state, botOf: id => state.bots[id], roomOf: id => state.rooms[id], warn() {} }
  install(rt)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, home, flybot: createFlybotFacade(rt) }
}

test('façade appends group lines to the upstream write-ahead ledger book', async (t) => {
  const { rt, home, flybot } = host(t)
  assert.equal(flybot.ledger.book('r1'), 'group-r1')
  flybot.ledger.append('r1', { seq: 1, text: 'hello from the adapter' })
  assert.equal(flybot.ledger.records('r1')[0].text, 'hello from the adapter')
  await rt.ledger.flush('group-r1')
  const file = join(home, 'ledger', bookFile(groupLedgerBook('r1')))
  const records = parseBook(readFileSync(file, 'utf8'))
  assert.equal(records.length, 1)
  assert.equal(records[0].text, 'hello from the adapter')
})

test('a read-only façade does not write the ledger', async (t) => {
  const { rt, flybot, home } = host(t)
  rt.readOnly = () => 'another dsh holds the team'
  const facade = createFlybotFacade(rt)
  assert.ok(facade.readOnly())
  facade.ledger.append('r1', { seq: 1, text: 'should not land' })
  await rt.ledger.flush('group-r1')
  assert.equal(facade.ledger.records('r1').length, 0)
  assert.equal(existsSync(join(home, 'ledger', bookFile('group-r1'))), false)
})
