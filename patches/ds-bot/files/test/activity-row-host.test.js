import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { findRunningHostIn, RUNNING_HOST } from '../src/client/activity-row-host.js'

// jsdom comes from the DSH harness (test/harness-resolve.mjs sets DSH_HARNESS).
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')

test('RUNNING_HOST is a descendant selector so DSH 0.2.1 nested RunningStatus still matches (#1626)', () => {
  assert.equal(RUNNING_HOST, '[data-chat-flow] [data-chat-running]')
  assert.equal(RUNNING_HOST.includes('>'), false, 'must not require a direct child of the flow column')
  const src = readFileSync(new URL('../src/client/activity-row.js', import.meta.url), 'utf8')
  assert.match(src, /activity-row-host\.js/)
  assert.doesNotMatch(src, /\[data-chat-flow\] > \[data-chat-running\]/)
  const hostSrc = readFileSync(new URL('../src/client/activity-row-host.js', import.meta.url), 'utf8')
  assert.match(hostSrc, /conversation\.chat\.flow/)
})

test('findRunningHostIn finds RunningStatus as a direct child (DSH 0.2.0 layout)', () => {
  const { document } = new JSDOM(`<!doctype html><div data-chat-flow="">
    <div data-chat-running id="run"></div>
  </div>`).window
  const host = findRunningHostIn(document)
  assert.equal(host?.id, 'run')
  assert.equal(findRunningHostIn(document.querySelector('[data-chat-flow]'))?.id, 'run')
})

test('findRunningHostIn finds RunningStatus nested under conversation.chat.flow (DSH 0.2.1+)', () => {
  const { document } = new JSDOM(`<!doctype html><div data-chat-flow="">
    <div data-slot="conversation.chat.flow">
      <div data-chat-flow-kind="user"></div>
      <div data-chat-running id="nested-run"></div>
    </div>
  </div>`).window
  assert.equal(document.querySelector('[data-chat-flow] > [data-chat-running]'), null, 'direct-child selector misses 0.2.1')
  assert.equal(findRunningHostIn(document)?.id, 'nested-run')
  assert.equal(findRunningHostIn(document.querySelector('[data-chat-flow]'))?.id, 'nested-run')
})

test('findRunningHostIn returns null when the running host is absent', () => {
  const { document } = new JSDOM(`<!doctype html><div data-chat-flow=""><div data-slot="conversation.chat.flow"></div></div>`).window
  assert.equal(findRunningHostIn(document), null)
  assert.equal(findRunningHostIn(null), null)
})
