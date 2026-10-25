// Narrow multi-pane windows (#705): the Details panel is fixed to the right edge with its width
// reserved as a margin on the conversation column, so a long value that cannot wrap (the About
// text, "4.1M tok · Cache hit …") widens the panel's content past that reservation and the row
// overflows — the panel ends up clipped and a dead strip is left between the panes. Every flexing
// pane gets min-width:0 so it can shrink, and the long values wrap. Installed after the shell
// styles, so these declarations win at equal specificity.
//
// #1086: a centered error toast (left:50% + translateX(-50%), or DSH's own) and the focus
// restore after its dialog grow the scroll width, then typing in the composer scrolls an
// ancestor sideways. overflow:hidden still honors scrollLeft and scrollIntoView; clip does
// not, and it does not turn the other axis into a scrollport. The frame is matched only when
// it directly contains the center column — other "_frame" classes (image, zoom) stay alone.
// The child rule outranks DSH's .centerCol { overflow:hidden } even when that sheet loads later.
export const PANE_MIN_WIDTH_CSS = `
.bt-panel{min-width:0}
.bt-panel-view{min-width:0}
.bt-drawer-body{min-width:0;overflow-wrap:anywhere}
.bt-drawer-body :is(.bt-muted,.bt-note,.bt-section-title,.bt-drawer-role,.bt-drawer-permission){min-width:0;overflow-wrap:anywhere}
.bt-panel :is(.bt-member,.bt-members,.bt-bcard-row,.bt-drawer-model,.bt-usage-row){min-width:0}
.bt-panel :is(.bt-muted,.bt-note){white-space:normal}
[class*="_centerCol"]{min-width:0}
html,body,#root{overflow-x:clip}
[class*="_frame"]>[class*="_centerCol"]{overflow-x:clip}
[class*="_frame"]:has(> [class*="_centerCol"]){overflow-x:clip}
`

const COMPOSER = '[data-composer-input], [data-composer-card]'

function clipScroll(el) {
  if (el && el.scrollLeft > 0) el.scrollLeft = 0
}

// The app frame is the only "_frame" whose direct child is the center column.
function appFrameOf(doc) {
  if (typeof doc.querySelector !== 'function') return null
  const col = doc.querySelector('[class*="_centerCol"]')
  const frame = col?.parentElement
  if (!frame) return null
  const name = frame.className
  const text = typeof name === 'string' ? name : (name?.baseVal ?? '')
  return text.includes('_frame') ? frame : null
}

// Put a leftover sideways offset back on the page, the app frame, and — when `from` is the
// composer — every ancestor of it. The composer itself is left alone (a long line may scroll
// inside the field) and so is a transcript scroller, which is not an ancestor (#274, #1086).
export function levelShell(doc, from) {
  const page = doc.scrollingElement || doc.documentElement
  clipScroll(page)
  clipScroll(doc.documentElement)
  clipScroll(doc.body)
  clipScroll(appFrameOf(doc))
  for (let at = from?.parentElement || null; at; at = at.parentElement) clipScroll(at)
}

function composerOf(node) {
  let el = node
  if (el && el.nodeType !== 1) el = el.parentElement
  if (!el || typeof el.closest !== 'function') return null
  return el.closest(COMPOSER)
}

// Focus, typing, and a document scroll can each land the offset after the first reset
// (the dialog's focus restore does not use preventScroll). Twice across frames, as
// keepSidebarStill does for the sidebar gear.
export function watchShellLevel(doc) {
  const later = (from) => {
    const reset = () => levelShell(doc, from)
    reset()
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(reset))
  }
  const onFocus = (event) => later(composerOf(event.target) || undefined)
  const onInput = (event) => {
    const composer = composerOf(event.target)
    if (composer) later(composer)
  }
  const onScroll = (event) => {
    const target = event.target
    if (target === doc || target === doc.documentElement || target === doc.body) levelShell(doc)
  }
  doc.addEventListener('focusin', onFocus)
  doc.addEventListener('input', onInput)
  doc.addEventListener('scroll', onScroll, true)
  return () => {
    doc.removeEventListener('focusin', onFocus)
    doc.removeEventListener('input', onInput)
    doc.removeEventListener('scroll', onScroll, true)
  }
}
