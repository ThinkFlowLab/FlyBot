// Pure host helpers for the activity row (#1626). Kept free of React so unit tests
// import them without a DOM renderer.

// DSH 0.2.0 put RunningStatus as a direct child of [data-chat-flow]. DSH 0.2.1+
// appends it inside the conversation.chat.flow slot, so a direct-child selector
// misses the host and the Bot avatar + shimmer never portals (#1626).
export const RUNNING_HOST = '[data-chat-flow] [data-chat-running]'
export const TAIL_HOST = 'tail'

/** Resolve the shell running-status node under a document or flow root (0.2.0 or 0.2.1+). */
export function findRunningHostIn(root) {
  if (!root || typeof root.querySelector !== 'function') return null
  if (typeof root.matches === 'function' && root.matches('[data-chat-running]')) return root
  // An Element (the flow column) scopes to descendants; a Document uses the full path.
  if (typeof Element !== 'undefined' && root instanceof Element) return root.querySelector('[data-chat-running]')
  return root.querySelector(RUNNING_HOST)
}
