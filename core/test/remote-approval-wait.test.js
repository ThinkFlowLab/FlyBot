import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { REMOTE_APPROVAL_LABEL, remoteApprovalPhrase } from '../src/client/remote-approval-wait.js'

const row = readFileSync(new URL('../src/client/activity-row.js', import.meta.url), 'utf8')
const cells = readFileSync(new URL('../src/client/cells.js', import.meta.url), 'utf8')

test('#1087: a friend DM wait says their approval is pending, not the thinking pool', () => {
  const phrase = remoteApprovalPhrase(true, { inputAt: 50 })
  assert.deepEqual(phrase, { key: 'remote-approval', label: 'Waiting for their approval', state: 'thinking' })
  assert.equal(phrase.label, REMOTE_APPROVAL_LABEL)
  // The line people were reading for the whole approval wait.
  assert.match(cells, /thinking: \[[^\]]*Sorting out the details/)
  assert.equal(cells.includes(`'${REMOTE_APPROVAL_LABEL}'`), false)
  assert.equal(DICTIONARY.zh[REMOTE_APPROVAL_LABEL], '等对方批准')
  // Fresh input after an older tool is still that wait.
  assert.equal(remoteApprovalPhrase(true, { inputAt: 30, tool: { at: 10, label: 'Searching' } }).key, 'remote-approval')
  // A local tool that is the newest activity keeps its own line.
  assert.equal(remoteApprovalPhrase(true, { inputAt: 10, tool: { at: 20, label: 'Searching' } }), null)
  // A local chat never uses it.
  assert.equal(remoteApprovalPhrase(false, { inputAt: 50 }), null)
  // The row actually asks, and marks the line so the wait is not the thinking pool.
  assert.match(row, /remoteApprovalPhrase\(bot\?\.remote !== undefined, \{ tool, inputAt \}\)/)
  assert.match(row, /phrase \? \{ \.\.\.phrase, label: t\(phrase\.label\) \}/)
  assert.match(row, /shown\.key === 'remote-approval' \? 'remote-approval'/)
})
