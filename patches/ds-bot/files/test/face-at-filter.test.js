import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faceMenuCss, planFaceMenu, watchFaceMenu } from '../src/client/face-at-filter.js'

const bots = (status = 'ready') => ({ source: 'ds-bot', status, items: [
  { name: 'Chief (SelfB)', icon: 'bot', section: 'Bots', value: '@Chief ' },
  { name: 'Helper (SelfB)', icon: 'bot', section: 'Bots', value: '@Helper ' },
] })
const reference = (status = 'ready', files = 1) => ({ source: 'reference', status, showGroupTitle: false, items: [
  ...Array.from({ length: files }, (_, i) => ({ name: `notes-${i}.md`, icon: 'file', section: 'Files & folders' })),
  { name: 'Child', icon: 'session', section: 'Subagents' },
  { name: 'Old chat', icon: 'session', section: 'Sessions' },
  { name: 'Older chat', icon: 'session', section: 'Sessions' },
] })
const menu = (groups, highlight) => ({ open: true, generation: 1, hit: {}, groups, highlight })

test('#305: a face room\'s "@" hides the shell\'s Session rows and their section titles, files and Bots stay', () => {
  const plan = planFaceMenu(menu([bots(), reference()], { source: 'ds-bot', index: 0 }))
  assert.deepEqual(plan.hidden, [
    { source: 'reference', index: 1, title: true },
    { source: 'reference', index: 2, title: true },
    { source: 'reference', index: 3, title: false },
  ])
  assert.equal(plan.blank, false)
  assert.equal(plan.dismiss, false)
  assert.equal(plan.target, null)
  const css = faceMenuCss(plan)
  for (const index of [1, 2, 3]) assert.match(css, new RegExp(`\\[data-trigger-menu\\] \\[id="dsh-slash-option-reference-${index}"\\]`))
  assert.match(css, /\[role="presentation"\]:has\(\+ \[id="dsh-slash-option-reference-1"\]\)/)
  assert.match(css, /\[role="presentation"\]:has\(\+ \[id="dsh-slash-option-reference-2"\]\)/)
  assert.doesNotMatch(css, /reference-0"|reference-3"\]\)|ds-bot-/)
  assert.doesNotMatch(css, /^\[data-trigger-menu\]\{/m)
  assert.equal(faceMenuCss(planFaceMenu(menu([bots()], null))), '')
})

test('#305: the highlight never rests on a hidden Session row, whichever way the keys move', () => {
  const groups = [bots(), reference()]
  // Down from the file row lands on the first Session row: it goes on, round to the first Bot.
  assert.deepEqual(planFaceMenu(menu(groups, { source: 'reference', index: 1 }), { source: 'reference', index: 0 }).target, { source: 'ds-bot', index: 0 })
  // Up from the first Bot wraps to the last Session row: it goes on up, to the file row.
  assert.deepEqual(planFaceMenu(menu(groups, { source: 'reference', index: 3 }), { source: 'ds-bot', index: 0 }).target, { source: 'reference', index: 0 })
  // Settled on a hidden row with nothing seen before: the next shown row.
  assert.deepEqual(planFaceMenu(menu([bots(), reference('ready', 0)], { source: 'reference', index: 0 })).target, { source: 'ds-bot', index: 0 })
})

test('#305: a face-room menu with nothing but Session rows is out of view and dismissed, so Enter sends', () => {
  const only = menu([{ ...bots(), items: [] }, reference('ready', 0)], { source: 'reference', index: 0 })
  const plan = planFaceMenu(only)
  assert.equal(plan.blank, true)
  assert.equal(plan.dismiss, true)
  assert.equal(plan.target, null)
  assert.match(faceMenuCss(plan), /^\[data-trigger-menu\]\{display:none!important\}$/m)
  // While the Bots still load, the menu stays (their skeleton shows) and nothing is dismissed.
  const loading = planFaceMenu(menu([{ ...bots('pending'), items: [] }, reference('ready', 0)], { source: 'reference', index: 0 }))
  assert.equal(loading.blank, false)
  assert.equal(loading.dismiss, false)
  assert.equal(planFaceMenu({ open: false, groups: [], highlight: null }).dismiss, false)
})

test('#305: the watcher styles the open menu, steers the highlight, dismisses, and cleans up', async () => {
  let state = menu([bots(), reference()], { source: 'ds-bot', index: 0 })
  const listeners = new Set()
  const calls = []
  const set = (next) => { state = next; for (const fn of [...listeners]) fn() }
  const controller = {
    menu: { getSnapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } },
    hover: (source, index) => { calls.push(['hover', source, index]); set({ ...state, highlight: { source, index } }) },
    dismiss: () => { calls.push(['dismiss']); set({ open: false, generation: 1, hit: null, groups: [], highlight: null }) },
  }
  const head = { children: [], appendChild(el) { this.children.push(el) } }
  const doc = {
    head,
    createElement: () => {
      const el = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() { head.children.splice(head.children.indexOf(el), 1) } }
      return el
    },
  }
  const stop = watchFaceMenu(controller, doc)
  assert.equal(head.children.length, 1)
  assert.match(head.children[0].textContent, /reference-1/)
  set({ ...state, highlight: { source: 'reference', index: 0 } })
  set({ ...state, highlight: { source: 'reference', index: 1 } })
  await Promise.resolve()
  assert.deepEqual(calls, [['hover', 'ds-bot', 0]])
  set(menu([{ ...bots(), items: [] }, reference('ready', 0)], { source: 'reference', index: 0 }))
  await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['dismiss'])
  assert.equal(head.children[0].textContent, '')
  stop()
  assert.equal(head.children.length, 0)
  assert.equal(listeners.size, 0)
  assert.equal(typeof watchFaceMenu(null, doc), 'function')
})
