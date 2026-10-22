// #734: one rule for "this hold still waits for the owner's decision". The host creates holds as
// `pending`, Bot Social's own outbound hold arrives as `pending_approval`, and the held-reply card
// and the approvals dock used to disagree about the pair: a `pending_approval` hold was drawn as a
// settled "Not sent" note with no Approve/Reject, and the dock's card skipped its buttons.
// React is replaced by the same tiny renderer the other client tests use (no jsdom here).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

import { isApprovalWaiting, WAITING_STATUSES } from '../src/client/approval-waiting.js'

const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { deps: undefined }
    inst.effects.push([i, fn, deps])
  },
}
for (const name of ['useRef', 'useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value
globalThis.__reactStub = reactStub
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: 'data:text/javascript,const r=globalThis.__reactStub;export default r;export const {createElement,Fragment,Component,useState,useEffect,useRef,useMemo,useCallback,useLayoutEffect,useContext,useReducer,useId,useSyncExternalStore,useTransition,useDeferredValue,memo,forwardRef,createContext,createPortal,cloneElement,isValidElement,startTransition}=r', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
globalThis.window ??= globalThis
globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

function render(Component, inst) {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  const out = Component(inst.props ?? {})
  inst.rendered = true
  return out
}
const text = node => JSON.stringify(node ?? null)

// The six statuses the issue names, plus the settled spellings the host and the plugin use.
test('#734: an approval is waiting for `pending` and `pending_approval`, and nothing else', () => {
  assert.deepEqual([...WAITING_STATUSES], ['pending', 'pending_approval'])
  assert.equal(isApprovalWaiting('pending'), true)
  assert.equal(isApprovalWaiting('pending_approval'), true)
  assert.equal(isApprovalWaiting('approved'), false)
  assert.equal(isApprovalWaiting('auto'), false)
  assert.equal(isApprovalWaiting('failed'), false)
  assert.equal(isApprovalWaiting(undefined), false)
  // Settled spellings the host also writes, so "not waiting" cannot be read as "pending only".
  for (const settled of ['rejected', 'stale', 'sending', null, '', 0]) assert.equal(isApprovalWaiting(settled), false)
})

test('#734: the held-reply card draws Approve and Reject for both waiting spellings only', async () => {
  const { HeldReplyActions } = await import('../src/client/held-reply.js')
  const held = (extra = {}) => ({ id: 'h1', status: 'pending', by: 'social', from: 'Chief', toName: '@friend.bot', ...extra })
  const draw = status => text(render(HeldReplyActions, { hooks: {}, effects: [], rendered: false, props: { held: held({ status }), actions: {} } }))

  for (const status of ['pending', 'pending_approval']) {
    const tree = draw(status)
    assert.match(tree, /bt-held-card/, `${status} is a waiting card`)
    assert.match(tree, /"Approve"/, `${status} offers Approve`)
    assert.match(tree, /"Reject"/, `${status} offers Reject`)
  }
  for (const status of ['approved', 'auto', undefined]) {
    const tree = draw(status)
    assert.match(tree, /bt-held-note/, `${String(status)} is a settled note`)
    assert.doesNotMatch(tree, /"Approve"/, `${String(status)} offers no Approve`)
  }
  // `failed` keeps its own treatment: the note plus Retry, never Approve.
  const failed = draw('failed')
  assert.match(failed, /bt-held-note/)
  assert.match(failed, /bt-held-retry/)
  assert.match(failed, /"Retry"/)
  assert.doesNotMatch(failed, /"Approve"/)
})

// Hook slots of FlyBotApprovals: useSlot x2 = 0-3, claimed = 4-5, then the pending list (#254).
const PENDING = 6

test('#734: the dock card offers Approve and Reject for a `pending_approval` hold, not for a settled one', async () => {
  const { FlyBotApprovals } = await import('../src/client/flybot-slots.js')
  const held = (extra = {}) => ({ id: 'a1', status: 'pending', by: 'social', senderName: 'Helper', targetName: '@chief.uia.home', request: { from: 'bot-helper', to: { handle: '@chief.uia.home' }, text: 'Which file?', hop: 0 }, ...extra })
  const inst = { hooks: {}, effects: [], rendered: false, props: {} }
  render(FlyBotApprovals, inst)

  for (const status of ['pending', 'pending_approval']) {
    inst.hooks[PENDING].value = [held({ status })]
    const tree = text(render(FlyBotApprovals, inst))
    assert.match(tree, /bt-flybot-approve/, `${status} is approvable by the dock`)
    assert.match(tree, /"Reject"/, `${status} offers Reject`)
  }
  // Settled: the dock draws no decision for it. The host does not list these, but a plugin card or
  // an older payload must not turn into an approvable button the host would refuse.
  for (const status of ['approved', 'auto']) {
    inst.hooks[PENDING].value = [held({ status })]
    const tree = text(render(FlyBotApprovals, inst))
    assert.doesNotMatch(tree, /"Approve"/, `${status} offers no Approve`)
    assert.doesNotMatch(tree, /"Reject"/, `${status} offers no Reject`)
  }
  // `failed`: Retry only, as before (#713).
  inst.hooks[PENDING].value = [held({ status: 'failed', error: 'queue offline' })]
  const failed = text(render(FlyBotApprovals, inst))
  assert.match(failed, /"Retry"/)
  assert.match(failed, /queue offline/)
  assert.doesNotMatch(failed, /"Approve"/)
})

test('#734: both call sites ask the shared predicate instead of comparing a literal status', () => {
  const source = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
  const held = source('held-reply.js')
  assert.match(held, /isApprovalWaiting\(held\?\.status\)/, 'the card asks the predicate')
  const slots = source('flybot-slots.js')
  assert.match(slots, /isApprovalWaiting\(approval\.status\)/, 'the dock asks the predicate')
  assert.match(slots, /status: \[\.\.\.WAITING_STATUSES, 'failed'\]/, 'the dock asks the host for the same set plus failed')
  assert.match(slots, /isApprovalWaiting\(approval\.status\) && !inOpenChat\(approval\)/, 'the pointer list uses the same rule')
  for (const [name, source] of [['held-reply.js', held], ['flybot-slots.js', slots]]) {
    assert.doesNotMatch(source, /status === 'pending'|status === 'pending_approval'/, `${name} has no literal of its own`)
    assert.doesNotMatch(source, /\[['"]pending['"], ?['"]pending_approval['"]\]/, `${name} has no local status list`)
  }
})
