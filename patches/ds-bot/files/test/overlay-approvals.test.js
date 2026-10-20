// The held-send overlay (FlyBotApprovals) must run the same hooks on every render: a hook after its
// early `return null` made React throw "Rendered more hooks than during the previous render" when
// the first held message arrived, so no approval card ever drew (#254). React is replaced by a small
// renderer that enforces React's rule (the hook count must not change between renders).
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) {
      if (inst.rendered) throw new Error('Rendered more hooks than during the previous render.')
      inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    }
    const slot = inst.hooks[i]
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) {
      if (inst.rendered) throw new Error('Rendered more hooks than during the previous render.')
      inst.hooks[i] = { deps: undefined }
    }
    inst.effects.push([i, fn, deps])
  },
}
// Hooks the host modules import but this test never calls.
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

// Hook slots of FlyBotApprovals: useSlot x2 (entries, docks) = 0-3, claimed = 4-5, then these.
const PENDING = 6
const CLAIMED = 4
const SHOWN = 9

const held = (extra = {}) => ({ id: 'a1', status: 'pending', by: 'social', reason: "messages to @chief.uia.home's Bots need your approval", senderName: 'Helper', targetName: '@chief.uia.home', request: { from: 'bot-helper', to: { handle: '@chief.uia.home' }, text: 'Which file?', hop: 0 }, ...extra })

test('#254: the approvals overlay renders again with the same hooks when the first held message arrives', async () => {
  const { FlyBotApprovals } = await import('../src/client/flybot-slots.js')
  const inst = { hooks: {}, effects: [], rendered: false }
  assert.equal(render(FlyBotApprovals, inst), null) // nothing held yet: nothing drawn
  const setPending = inst.hooks[PENDING] // useSlot takes hooks 0-3, claimed 4-5; pending is next
  assert.ok(setPending, 'pending state exists')
  // Another policy (no dock draws it): the overlay is its card.
  setPending.value = [held({ by: 'tree' })]
  let tree
  assert.doesNotThrow(() => { tree = render(FlyBotApprovals, inst) })
  const text = JSON.stringify(tree)
  assert.match(text, /bt-flybot-approvals/)
  assert.match(text, /Which file\?/)
  assert.match(text, /Approve/)
  // And it goes back to nothing, still without a hook mismatch.
  setPending.value = []
  assert.doesNotThrow(() => render(FlyBotApprovals, inst))
})

test('#260: one card per approval: a dock-drawn one is not repeated, and reads like the dock\'s card', async () => {
  const { FlyBotApprovals, registry } = await import('../src/client/flybot-slots.js')
  const off = registry().register('flybot.session.dock', { id: 'social-approval', policy: 'social', component: () => null })
  try {
    const inst = { hooks: {}, effects: [], rendered: false, props: {} }
    render(FlyBotApprovals, inst)
    inst.hooks[PENDING].value = [held({ by: 'tree' }), held({ id: 'a2' })]
    // The social approval a2 is not claimed yet and no pointer is due yet: only the other policy's card.
    let text = JSON.stringify(render(FlyBotApprovals, inst))
    assert.match(text, /Waiting for approval/)
    assert.match(text, /Helper → @chief\.uia\.home/)
    assert.doesNotMatch(text, /Sent by/)
    assert.doesNotMatch(text, /"children":\["[^"]*need your approval/, 'the long policy reason is a tooltip, not a headline')
    assert.equal((text.match(/bt-flybot-approval"/g) ?? []).length, 1)
    // A chat that shows a2 claims it: nothing more to draw for it.
    inst.hooks[PENDING].value = [held({ id: 'a2' })]
    inst.hooks[CLAIMED].value = new Set(['a2'])
    assert.equal(render(FlyBotApprovals, inst), null)
  } finally { off() }
})

test('#260: an approval no open chat shows becomes a pointer to its chat, after a short wait', async () => {
  const { FlyBotApprovals, registry } = await import('../src/client/flybot-slots.js')
  const off = registry().register('flybot.session.dock', { id: 'social-approval', policy: 'social', component: () => null })
  try {
    const opened = []
    const roster = { bots: [{ id: 'f1', name: 'Chief', remote: { handle: '@chief.uia.home', owner: 'UiA1415' } }] }
    const inst = { hooks: {}, effects: [], rendered: false, props: { actions: { openSession: id => opened.push(id) }, useRoster: pick => pick(roster) } }
    render(FlyBotApprovals, inst)
    inst.hooks[PENDING].value = [held(), held({ id: 'a2' })]
    // Not yet: moving between chats must not flash the pointer.
    assert.equal(render(FlyBotApprovals, inst), null)
    inst.hooks[SHOWN].value = 'a1,a2'
    const tree = render(FlyBotApprovals, inst)
    const text = JSON.stringify(tree)
    assert.match(text, /bt-flybot-pointer/)
    // The person who gets it (#418, #498), not the friend's Bot by name.
    assert.match(text, /Helper → UiA1415/)
    assert.doesNotMatch(text, /Chief \(UiA1415\)/)
    assert.match(text, /\+1 more/)
    assert.doesNotMatch(text, /Approve/, 'a pointer has no decision buttons: the chat\'s card does')
    const find = (node, pred) => (node && typeof node === 'object' ? (pred(node) ? [node] : [...(node.children ?? []), ...(Array.isArray(node) ? node : [])].flatMap(child => find(child, pred))) : [])
    const [review] = find(tree, node => node.type === 'button')
    review.props.onClick()
    assert.deepEqual(opened, ['f1'], 'Review opens the friend\'s chat the message is addressed to, the one place it is drawn (#278)')
  } finally { off() }
})

test('#271: no pointer for an approval whose chat is the open one, whatever the open chat draws', async () => {
  const { FlyBotApprovals, FlyBotSessionDock, registry, chatOpened } = await import('../src/client/flybot-slots.js')
  const off = registry().register('flybot.session.dock', { id: 'social-approval', policy: 'social', component: () => null })
  try {
    const roster = { bots: [], byId: { 'bot-helper': { sessionId: 'session-helper' } } }
    const inst = { hooks: {}, effects: [], rendered: false, props: { useRoster: pick => pick(roster) } }
    render(FlyBotApprovals, inst)
    inst.hooks[PENDING].value = [held({ id: 'a1' })]
    inst.hooks[SHOWN].value = 'a1'
    assert.match(JSON.stringify(render(FlyBotApprovals, inst)), /bt-flybot-pointer/, 'a chat that is not open: the pointer')
    // Helper's chat is open (its session id), though nothing in it claimed the approval.
    inst.hooks[CLAIMED].value = Object.assign(new Set(), { chats: new Set(['session-helper']) })
    assert.equal(render(FlyBotApprovals, inst), null)
    inst.hooks[CLAIMED].value = Object.assign(new Set(), { chats: new Set(['bot-helper']) })
    assert.equal(render(FlyBotApprovals, inst), null)
    // A session dock registers its chat as open for as long as it is mounted.
    const dock = { hooks: {}, effects: [], rendered: false, props: { sessionId: 'session-x' } }
    render(FlyBotSessionDock, dock)
    // Mounted: the chat counts as open for the overlay; unmounted: it does not.
    const stops = dock.effects.map(([, fn]) => fn()).filter(fn => typeof fn === 'function')
    assert.ok(stops.length >= 1, 'the dock registers and releases its chat')
    stops.forEach(fn => fn())
    assert.equal(typeof chatOpened, 'function')
  } finally { off() }
})
