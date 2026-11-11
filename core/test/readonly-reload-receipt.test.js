// #2883: the read-only banner and the Settings header each offer Reload, but a press answered
// nothing. A reload that changes nothing and a reload that frees the slot look the same afterwards —
// the host's sentence stays up until the next read, and a reader cannot tell "it did not work" from
// "it did, and something else still holds the team". The receipt is one sentence naming which of the
// two happened, and a writable window's reload has none, because there was no lock to report on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as readOnly from '../src/client/read-only.js'

const SENTENCE = 'The Bot team in /home/chief/.flybot is open in another dsh (Web or Desktop, pid 41 on host).'
const receipt = () => {
  assert.equal(typeof readOnly.reloadReceipt, 'function', 'a reload names its outcome')
  return readOnly.reloadReceipt
}

test('#2883: a reload that leaves the window read-only says it is still read-only', () => {
  assert.equal(receipt()({ readOnly: SENTENCE }, { readOnly: SENTENCE }), 'Reloaded just now — this window is still read-only.')
})

test('#2883: a reload that frees the slot says the window can write again', () => {
  assert.equal(receipt()({ readOnly: SENTENCE }, { readOnly: undefined }), 'Reloaded — this window can write again.')
  assert.equal(receipt()({ readOnly: SENTENCE }, { readOnly: '' }), 'Reloaded — this window can write again.',
    'a sentence a writer left empty is a writable window, read the way the banner reads it')
  assert.equal(receipt()({ readOnly: SENTENCE }, { readOnly: '   ' }), 'Reloaded — this window can write again.',
    'whitespace is not a lock')
})

test('#2883: a writable window\'s reload writes no receipt', () => {
  assert.equal(receipt()({}, {}), null, 'there was no lock to report on')
  assert.equal(receipt()({ readOnly: '' }, { readOnly: SENTENCE }), null, 'a window that was not locked reads no receipt')
  assert.equal(receipt()({ readOnly: '  ' }, { readOnly: '  ' }), null, 'whitespace is not a lock on the way in either')
})
