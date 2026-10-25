import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PANE_MIN_WIDTH_CSS, levelShell, watchShellLevel } from '../src/client/panes.js'

// #1086: dismissing an Enter-chat error and typing in the composer used to leave the
// window scrolled sideways (the #274 class, at the shell). overflow:hidden still
// scrolls; overflow-x:clip does not, and a leftover scrollLeft is put back.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

function box(scrollLeft, parent, extra = {}) {
  return { scrollLeft, parentElement: parent, ...extra }
}

function page() {
  const root = box(0, null)
  const body = box(0, root)
  const frame = box(0, body, { className: 'x_frame' })
  const col = box(0, frame, { className: 'x_centerCol' })
  const card = box(0, col)
  const input = box(0, card, {
    nodeType: 1,
    closest(sel) {
      const text = String(sel)
      return text.includes('data-composer-input') || text.includes('data-composer-card') ? input : null
    },
  })
  const code = box(0, col, { nodeType: 1, closest() { return null } })
  const listeners = new Map()
  return {
    scrollingElement: root,
    documentElement: root,
    body,
    frame,
    input,
    code,
    querySelector(sel) {
      return sel === '[class*="_centerCol"]' ? col : null
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== fn))
    },
    fire(type, target) {
      for (const fn of listeners.get(type) ?? []) fn({ target })
    },
  }
}

test('#1086: the document and the app frame cannot scroll sideways', () => {
  assert.match(PANE_MIN_WIDTH_CSS, /html,body,#root\{overflow-x:clip\}/)
  assert.match(PANE_MIN_WIDTH_CSS, /\[class\*="_frame"\]>\[class\*="_centerCol"\]\{overflow-x:clip\}/)
  assert.match(PANE_MIN_WIDTH_CSS, /\[class\*="_frame"\]:has\(> \[class\*="_centerCol"\]\)\{overflow-x:clip\}/)
  const index = read('../src/client/index.js')
  const panesAt = index.indexOf('installCompiledStyles(PANE_MIN_WIDTH_CSS')
  const watchAt = index.indexOf('watchShellLevel(document)')
  assert.ok(panesAt > 0 && watchAt > panesAt, 'watchShellLevel is installed with the pane rules')
  const bundle = read('../client.js')
  assert.ok(bundle.includes('html,body,#root{overflow-x:clip}'), 'client.js carries the document clip')
})

test('#1086: a sideways offset on the page and the frame is cleared, a transcript scroller is not', () => {
  const doc = page()
  doc.scrollingElement.scrollLeft = 40
  doc.body.scrollLeft = 16
  doc.frame.scrollLeft = 9
  doc.code.scrollLeft = 30
  levelShell(doc)
  assert.equal(doc.scrollingElement.scrollLeft, 0)
  assert.equal(doc.body.scrollLeft, 0)
  assert.equal(doc.frame.scrollLeft, 0)
  assert.equal(doc.code.scrollLeft, 30)
  doc.input.scrollLeft = 3
  doc.input.parentElement.scrollLeft = 4
  doc.code.scrollLeft = 30
  levelShell(doc, doc.input)
  assert.equal(doc.input.scrollLeft, 3)
  assert.equal(doc.input.parentElement.scrollLeft, 0)
  assert.equal(doc.code.scrollLeft, 30)
})

test('#1086: typing in the composer puts the shell back; a code block keeps its own scroll', () => {
  const doc = page()
  const stop = watchShellLevel(doc)
  doc.scrollingElement.scrollLeft = 22
  doc.fire('scroll', doc)
  assert.equal(doc.scrollingElement.scrollLeft, 0)
  doc.code.scrollLeft = 18
  doc.fire('scroll', doc.code)
  assert.equal(doc.code.scrollLeft, 18)
  doc.frame.scrollLeft = 11
  doc.body.scrollLeft = 6
  doc.fire('input', doc.input)
  assert.equal(doc.frame.scrollLeft, 0)
  assert.equal(doc.body.scrollLeft, 0)
  doc.scrollingElement.scrollLeft = 7
  doc.code.scrollLeft = 14
  doc.fire('focusin', doc.code)
  assert.equal(doc.scrollingElement.scrollLeft, 0)
  assert.equal(doc.code.scrollLeft, 14)
  stop()
  doc.scrollingElement.scrollLeft = 5
  doc.fire('scroll', doc)
  assert.equal(doc.scrollingElement.scrollLeft, 5)
})

test('#1086: a scrollLeft that lands after the composer focuses is put back', () => {
  const doc = page()
  const queued = []
  const previous = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (fn) => {
    queued.push(fn)
    return queued.length
  }
  try {
    const stop = watchShellLevel(doc)
    doc.fire('focusin', doc.input)
    doc.body.scrollLeft = 24
    assert.ok(queued.length >= 1)
    queued[0]()
    doc.body.scrollLeft = 24
    queued.at(-1)()
    assert.equal(doc.body.scrollLeft, 0)
    stop()
  } finally {
    if (previous === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = previous
  }
})

test('#1086: the error toast is centered without a box that hangs past the viewport', () => {
  const feedback = read('../src/client/feedback.js')
  const toast = feedback.match(/\.bt-toast\{([^}]*)\}/)?.[1] ?? ''
  assert.match(toast, /left:0/)
  assert.match(toast, /right:0/)
  assert.match(toast, /margin-inline:auto/)
  assert.match(toast, /width:fit-content/)
  assert.doesNotMatch(toast, /left:50%/)
  assert.doesNotMatch(toast, /translateX\(-50%\)/)
  const leaving = feedback.match(/\.bt-toast\[data-leaving\]\{([^}]*)\}/)?.[1] ?? ''
  assert.match(leaving, /translateY\(6px\)/)
  assert.doesNotMatch(leaving, /-50%/)
  assert.match(feedback, /@keyframes bt-toast-in\{from\{transform:translateY\(16px\) scale\(\.94\)\}\}/)
})
