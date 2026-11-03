import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// -------------------------------------------------------------------------
// Overlays: new chat, bot exchange, details drawer, context menu

// Escape closes only the newest open layer, so a dialog over the details pane does
// not take the pane down with it.
const escapeLayers = []
const onEscapeKey = (event) => { if (event.key === 'Escape') escapeLayers.at(-1)?.current() }
export function useEscape(onClose) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (escapeLayers.length === 0) window.addEventListener('keydown', onEscapeKey)
    escapeLayers.push(ref)
    return () => {
      escapeLayers.splice(escapeLayers.indexOf(ref), 1)
      if (escapeLayers.length === 0) window.removeEventListener('keydown', onEscapeKey)
    }
  }, [])
}

// A dialog takes focus when it opens, so Tab starts inside it and Escape reaches it,
// and gives that focus back to the still-connected opener when it closes (#2251, #274).
// It lingers for DIALOG_EXIT_MS (160 ms) with `pointer-events: none` on the leaving layer,
// so a click there lands on the page behind it: restore only while the dialog still holds
// focus (or nothing does), never over a place the user picked during the exit (#2270).
export function useDialogFocus(ref) {
  useEffect(() => {
    const before = document.activeElement
    ref.current?.focus?.({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const stillInDialog = active === ref.current || ref.current?.contains?.(active) === true
      const noFocusHeld = !active || active === document.body || active.isConnected === false
      if (before && typeof before.focus === 'function' && before.isConnected && (stillInDialog || noFocusHeld || active === before)) before.focus({ preventScroll: true })
    }
  }, [])
}

// New chat and Bot exchanges show in place of the conversation, right of the sidebar.
export function usePaneLeft() {
  const [paneLeft, setPaneLeft] = useState(280)
  useLayoutEffect(() => {
    const column = document.querySelector('[class*="_footArea"]')?.parentElement
    if (column) setPaneLeft(Math.round(column.getBoundingClientRect().right))
  }, [])
  return paneLeft
}
