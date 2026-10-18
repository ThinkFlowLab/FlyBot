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
  const out = Component({})
  inst.rendered = true
  return out
}

test('#254: the approvals overlay renders again with the same hooks when the first held message arrives', async () => {
  const { FlyBotApprovals } = await import('../src/client/flybot-slots.js')
  const inst = { hooks: {}, effects: [], rendered: false }
  assert.equal(render(FlyBotApprovals, inst), null) // nothing held yet: nothing drawn
  const setPending = inst.hooks[2] // useSlot takes hooks 0 and 1 (version, subscription); pending is next
  assert.ok(setPending, 'pending state exists')
  setPending.value = [{ id: 'a1', status: 'pending', by: 'social', reason: 'needs approval', senderName: 'Helper', targetName: 'Chief', request: { to: { handle: '@chief.uia.home' }, text: 'Which file?', hop: 0 } }]
  let tree
  assert.doesNotThrow(() => { tree = render(FlyBotApprovals, inst) })
  assert.ok(tree && tree.props.className === 'bt-flybot-approvals')
  const text = JSON.stringify(tree)
  assert.match(text, /Which file\?/)
  assert.match(text, /Approve/)
  // And it goes back to nothing, still without a hook mismatch.
  setPending.value = []
  assert.doesNotThrow(() => render(FlyBotApprovals, inst))
})
