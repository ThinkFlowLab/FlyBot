// The composer's label in a FlyBot chat (#419, #499). The shell picks its placeholder by phase,
// before it knows whose chat this is: the new-session hero copy ("Describe what you want to
// build, …") on a first open and its coding copy ("Message or run a task, …") after a send. A
// FlyBot chat, a friend's Bot above all, always reads "Message <name>": the visible placeholder
// is --bt-placeholder (styles.js draws it over the shell's text), and the input's aria-label and
// data-placeholder are put back whenever the shell renders them again. The mutation callback
// rewrites them in the same task, so no frame paints the shell's copy.
const ATTRIBUTES = ['aria-label', 'data-placeholder']

// Holds `label` on every composer input in `doc` until the returned function is called, which
// stops watching and gives each input the shell's latest own value back.
export function holdComposerLabel(doc, label) {
  doc.body.style.setProperty('--bt-placeholder', JSON.stringify(label))
  // The shell's own value per input and attribute, newest first, for the hand-back.
  const shell = new Map()
  const apply = () => {
    for (const el of doc.querySelectorAll('[data-composer-input]')) {
      for (const name of ATTRIBUTES) {
        const current = el.getAttribute(name)
        if (current === label) continue
        if (!shell.has(el)) shell.set(el, {})
        shell.get(el)[name] = current
        el.setAttribute(name, label)
      }
    }
  }
  apply()
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
  const watcher = typeof Observer === 'function' ? new Observer(apply) : null
  watcher?.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRIBUTES })
  return () => {
    watcher?.disconnect()
    for (const [el, values] of shell) {
      if (!el.isConnected) continue
      for (const [name, value] of Object.entries(values)) {
        if (value == null) el.removeAttribute(name)
        else el.setAttribute(name, value)
      }
    }
  }
}
