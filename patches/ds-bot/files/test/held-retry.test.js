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
  // A code can arrive instead of the sentence.
  assert.equal(canRetry({ error: 'capability_not_granted' }), false)
  assert.equal(canRetry({ code: 'bot_not_shared' }), false)
  // The flag wins even when the text looks retryable: the sender knows more than its message.
  assert.equal(canRetry({ noRetry: true, error: 'HTTP 500' }), false)
})
