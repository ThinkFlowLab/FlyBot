// The image URL a Bot's look may carry. A friend's Bot publishes its own look, and the
// page-wide mentions stylesheet pastes `avatar.image` into `url("…")` (client/mention-style.js),
// so a value that can close the quote, the url() or the rule is dropped where it enters —
// hooks.js `cleanRemoteLook` and remote-chat.js `applyPublishedLook` — and again at that sink.
// A dropped image draws the colour/mask look instead. The social plugin carries the same test
// for its own threshold (no gif there); plugins/social/test/look.test.js keeps the two in step.
export const LOOK_IMAGE_MAX = 65536
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i
const HTTP = /^https?:\/\//i
const UNSAFE = /["'()\\\u0000-\u001f\u007f\s<>]/

// The trimmed image URL, or null when it is not a plain https URL or a base64 raster image.
export function safeLookImage(value, max = LOOK_IMAGE_MAX) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || text.length > max || UNSAFE.test(text)) return null
  if (DATA_IMAGE.test(text)) return text
  if (!HTTP.test(text)) return null
  try { new URL(text) } catch { return null }
  return text
}

// The same value, ready to sit inside a stylesheet as `url("…")`; null means draw the colour.
export function cssImageUrl(value) {
  const image = safeLookImage(value)
  return image === null ? null : `url("${image}")`
}
