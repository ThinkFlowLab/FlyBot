// #968: one predicate answers "can this failure ever succeed", for both spellings a record arrives in
// and for the sentence a record written before #954 carries instead of a flag.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canRetry } from '../src/shared/held-retry.js'

test('#968: both spellings of a terminal failure answer false, and a retryable one answers true', () => {
  assert.equal(canRetry({ retry: false }), false)
  assert.equal(canRetry({ noRetry: true }), false)
  assert.equal(canRetry({ retry: true }), true)
  assert.equal(canRetry({ noRetry: false }), true)
  assert.equal(canRetry({}), true)
  assert.equal(canRetry(undefined), true)
  for (const error of ['HTTP 500', '429 Too Many Requests', 'timeout', 'the Bot is paused']) assert.equal(canRetry({ error }), true, error)
})

test('#968: a record written before #954 carries no flag, only the sentence, and is still terminal', () => {
  const sentences = [
    'Coder (Bob) (@coder.bob.home) is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.',
    'Not sent: no such remote bot. Try again.',
    'Chief (SelfA) (@chief.selfa.home) is not shared with your Bots yet, so messages to it cannot be delivered. Sending again will not help until then.',
    'peer has not granted chat.public. Try again.',
  ]
  for (const error of sentences) assert.equal(canRetry({ status: 'failed', error }), false, error)
  // A code can arrive instead of the sentence. These two stay terminal on the code alone.
  // capability_not_granted does not: the same code names other capabilities (#988).
  assert.equal(canRetry({ code: 'bot_not_shared' }), false)
  assert.equal(canRetry({ code: 'bot_not_found' }), false)
  // The flag wins even when the text looks retryable: the sender knows more than its message.
  assert.equal(canRetry({ noRetry: true, error: 'HTTP 500' }), false)
})

// #988: capability_not_granted is Bot Social's generic "peer has not granted <capability>", not
// "this Bot is not shared". Only the chat.public sentence is that fact. Restoring the bare-code
// match makes the first assertions fail; dropping the chat.public sentence match makes the last fail.
test('#988: capability_not_granted is terminal only for the chat.public sentence', () => {
  assert.equal(canRetry({ error: 'peer has not granted profile.read', code: 'capability_not_granted' }), true)
  assert.equal(canRetry({ error: 'peer has not granted calendar.freebusy.read', code: 'capability_not_granted' }), true)
  assert.equal(canRetry({ code: 'capability_not_granted' }), true)
  assert.equal(canRetry({ error: 'capability_not_granted' }), true)
  assert.equal(canRetry({ error: 'peer has not granted chat.public', code: 'capability_not_granted' }), false)
  assert.equal(canRetry({ error: 'peer has not granted chat.public. Try again.' }), false)
  // The sender's own mark still wins when the capability is not chat.public.
  assert.equal(canRetry({ noRetry: true, error: 'peer has not granted profile.read', code: 'capability_not_granted' }), false)
})
