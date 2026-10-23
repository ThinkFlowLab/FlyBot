// Width policy for the single side panel (#705, #462): the Details view and the Bot's browser share
// one width, and the conversation keeps MIN_CHAT beside it as far as the window allows. Pure
// numbers, no DOM, so the narrow-window rule is tested without React or jsdom.
// DETAILS_WIDTH..DETAILS_MAX, so a wider browser comes back to DETAILS_MAX and a narrower one keeps
// its width; the browser takes any width from MIN_WIDTH.
export const DEFAULT_WIDTH = 520
export const DETAILS_WIDTH = 320
export const DETAILS_MAX = 520
export const MIN_WIDTH = 360
// The conversation keeps this much room beside the panel whenever the window can hold it; below
// MIN_CHAT + MIN_DETAILS the panel keeps its MIN_DETAILS floor and the conversation gets less.
export const MIN_CHAT = 420
// A narrow window shrinks the Details panel before it starves the conversation (#705): below
// MIN_CHAT + DETAILS_WIDTH the panel gives way down to MIN_DETAILS, so the row fits the window and
// no pane is pushed past its own edge (the conversation may then be narrower than MIN_CHAT).
export const MIN_DETAILS = 240

export function panelWidthRange(view, viewport) {
  const room = Math.max(0, viewport - MIN_CHAT)
  if (view === 'browser') return [MIN_WIDTH, Math.max(MIN_WIDTH, room)]
  const low = Math.max(MIN_DETAILS, Math.min(DETAILS_WIDTH, room))
  return [low, Math.max(low, Math.min(DETAILS_MAX, room))]
}
