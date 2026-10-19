// -------------------------------------------------------------------------
// A face-to-face room's "@" lists the people and the Bots in the room, nothing else (#305).
// The shell's own reference source adds its Sessions (and Subagents) rows to every "@" menu,
// and DSH gives a plugin no way to drop a built-in source for one Session (asked for in #422),
// so in a face room FlyBot filters them on its side: CSS takes those rows and their section
// title out of view, the highlight is moved off them (arrow keys skip them, Enter never picks
// one), and a menu left with nothing but them is dismissed, so Enter sends the line.
// Files stay: only Session rows are filtered. Replace with a DSH API once #422 has one.

export const REFERENCE_SOURCE = 'reference'
// MenuView's option id, `dsh-slash-option-<source>-<index>` (the listbox's aria-activedescendant).
const optionId = (source, index) => `dsh-slash-option-${source}-${index}`

const isSessionRow = (group, item) => group.source === REFERENCE_SOURCE && item?.icon === 'session'
const same = (a, b) => a != null && b != null && a.source === b.source && a.index === b.index

// What to do with one menu snapshot: the rows to hide (each with whether its section title
// goes too), whether nothing visible is left, and where the highlight must go instead.
// `previous` is the last highlight seen, so a move that lands on a hidden row keeps going the
// same way.
export function planFaceMenu(state, previous = null) {
  const hidden = []
  const ready = []
  let shown = 0
  let loading = false
  for (const group of state?.groups ?? []) {
    const items = group.items ?? []
    if (group.status !== 'ready' && items.length === 0) loading = true
    items.forEach((item, index) => {
      const hide = isSessionRow(group, item)
      if (hide) hidden.push({ source: group.source, index, title: item.section !== undefined && item.section !== items[index - 1]?.section })
      else shown += 1
      if (group.status === 'ready') ready.push({ source: group.source, index, hide })
    })
  }
  const open = state?.open === true
  const blank = open && hidden.length > 0 && shown === 0 && !loading
  const dismiss = blank && (state.groups ?? []).every(group => group.status === 'ready')
  return { hidden, blank, dismiss, target: dismiss ? null : steer(ready, state?.highlight ?? null, previous) }
}

function steer(ready, highlight, previous) {
  const at = ready.findIndex(row => same(row, highlight))
  if (at < 0 || !ready[at].hide) return null
  const from = ready.findIndex(row => same(row, previous))
  const n = ready.length
  const dir = from >= 0 && from !== at && (from - at + n) % n === 1 ? -1 : 1
  for (let step = 1; step < n; step += 1) {
    const row = ready[(((at + dir * step) % n) + n) % n]
    if (!row.hide) return { source: row.source, index: row.index }
  }
  return null
}

export function faceMenuCss({ hidden, blank }) {
  if (hidden.length === 0) return ''
  const rows = hidden.map(row => `[data-trigger-menu] [id="${optionId(row.source, row.index)}"]`)
  const titles = hidden.filter(row => row.title)
    .map(row => `[data-trigger-menu] [role="presentation"]:has(+ [id="${optionId(row.source, row.index)}"])`)
  const css = [`${[...rows, ...titles].join(',')}{display:none!important}`]
  if (blank) css.push('[data-trigger-menu]{display:none!important}')
  return css.join('\n')
}

// Keep one Session's "@" menu filtered while a face room shows; returns the stop function.
// `controller` is the shell's trigger controller for that Session (inputTriggers.sessionOf).
export function watchFaceMenu(controller, doc = globalThis.document) {
  if (typeof controller?.menu?.subscribe !== 'function' || !doc?.head) return () => {}
  const style = doc.createElement('style')
  style.setAttribute('data-bt-face-at', '')
  doc.head.appendChild(style)
  let previous = null
  let stopped = false
  const later = typeof queueMicrotask === 'function' ? queueMicrotask : fn => Promise.resolve().then(fn)
  const apply = () => {
    if (stopped) return
    const state = controller.menu.getSnapshot()
    const plan = planFaceMenu(state, previous)
    const css = faceMenuCss(plan)
    if (style.textContent !== css) style.textContent = css
    // The store notifies inside the shell's own reducer, so the correction runs right after it.
    if (plan.dismiss) later(() => { if (!stopped && planFaceMenu(controller.menu.getSnapshot(), previous).dismiss) controller.dismiss() })
    else if (plan.target) later(() => { if (!stopped) controller.hover(plan.target.source, plan.target.index) })
    else previous = state.open ? state.highlight : null
  }
  const unsubscribe = controller.menu.subscribe(apply)
  apply()
  return () => {
    stopped = true
    unsubscribe?.()
    style.remove()
  }
}
