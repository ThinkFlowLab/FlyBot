// Map Bot Social profile look fields (optional on older servers) to FlyBot's
// { color, avatar: { shape | emoji | image } }. Server avatar is a preset id,
// a single emoji, or a data:image/(png|jpeg|webp);base64 string <= 64KiB.
// Color is #rrggbb. Peers without a look keep the handle-seeded palette.

export const AVATAR_MAX = 64 * 1024
const PRESET = /^[a-z0-9][a-z0-9_-]{0,31}$/
const HEX = /^#[0-9a-f]{6}$/i
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i

// Light ink of each FlyBot named color (core/src/client/inks.js), lowercase #rrggbb.
export const COLOR_HEX = {
  deepseek: '#4d6bfe', charcoal: '#141416', graphite: '#2d2d2d',
  rose: '#ec2f6b', sky: '#0aa8d6', tangerine: '#ff6900', cobalt: '#082dff',
  black: '#000000', brown: '#a27952', red: '#ff3e51', orange: '#ff781c',
  yellow: '#ffaf38', green: '#00c972', cyan: '#1cc3b0', blue: '#2a92fe',
  violet: '#a97efe', magenta: '#ff5eb1', gray: '#959595', aurora: '#00b8d4',
}

export function hexOfColor(color) {
  const value = String(color ?? '').trim()
  if (HEX.test(value)) return value.toLowerCase()
  return COLOR_HEX[value] || undefined
}

function isEmojiAvatar(value) {
  const text = String(value ?? '').trim()
  if (!text || text.length > 16 || /[\n<>#]/.test(text)) return false
  if (PRESET.test(text) || /^data:/i.test(text) || /^https?:/i.test(text)) return false
  return true
}

export function lookFromServer(row = {}) {
  const out = {}
  const rawColor = String(row.color ?? '').trim()
  if (HEX.test(rawColor)) out.color = rawColor.toLowerCase()
  const raw = row.avatar
  const kind = String(row.avatar_kind ?? '')
  const avatar = {}
  if (typeof raw === 'string') {
    const text = raw.trim()
    if ((kind === 'image' || (!kind && DATA_IMAGE.test(text))) && text.length <= AVATAR_MAX && DATA_IMAGE.test(text)) {
      avatar.image = text
    } else if ((kind === 'preset' || (!kind && PRESET.test(text))) && PRESET.test(text)) {
      avatar.shape = text
    } else if ((kind === 'emoji' || (!kind && isEmojiAvatar(text))) && isEmojiAvatar(text)) {
      avatar.emoji = text.slice(0, 16)
    }
  } else if (raw && typeof raw === 'object') {
    if (typeof raw.shape === 'string' && PRESET.test(raw.shape)) avatar.shape = raw.shape
    if (typeof raw.image === 'string' && raw.image.length <= AVATAR_MAX && /^(https?:\/\/|data:image\/)/i.test(raw.image.trim()) && !/[\s<>]/.test(raw.image)) {
      avatar.image = raw.image.trim()
    }
    if (typeof raw.emoji === 'string' && isEmojiAvatar(raw.emoji)) avatar.emoji = raw.emoji.trim().slice(0, 16)
  }
  if (Object.keys(avatar).length) out.avatar = avatar
  const at = String(row.avatar_updated_at ?? row.avatarUpdatedAt ?? '').trim()
  if (at && !/[\n<>]/.test(at)) out.avatarUpdatedAt = at.slice(0, 40)
  return out
}

// The order the owner's home draws a stored look in (core mark.js BotMark): image, emoji, shape.
export function lookToServer(bot = {}) {
  const patch = {}
  const color = hexOfColor(bot.color)
  if (color) patch.color = color
  const avatar = bot.avatar && typeof bot.avatar === 'object' ? bot.avatar : {}
  if (typeof avatar.image === 'string' && DATA_IMAGE.test(avatar.image) && avatar.image.length <= AVATAR_MAX) {
    patch.avatar = avatar.image
  } else if (typeof avatar.emoji === 'string' && isEmojiAvatar(avatar.emoji)) {
    patch.avatar = avatar.emoji.trim()
  } else if (typeof avatar.shape === 'string' && PRESET.test(avatar.shape)) {
    patch.avatar = avatar.shape
  }
  return patch
}

// A Bot with no stored shape or color is drawn at home with a look picked from its id
// (core/src/client/characters.js defaultShape / defaultColor). That generated look is the
// owner's look too, so it is what Bot Social gets: without it the other home falls back to a
// look seeded by the handle, and the Bot looks different on each home (#182). Same functions
// and lists as core; plugins/social/test/social.test.js checks they agree.
export const DEFAULT_SHAPES = ['star', 'moon', 'gumdrop', 'peanut', 'bunny', 'kitty', 'acorn']
export const DEFAULT_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta']
function fnv1a(text) {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return value >>> 0
}
export function defaultColorOf(id) {
  const t = (fnv1a(String(id)) + 1831565813) | 0
  let n = Math.imul(t ^ (t >>> 15), 1 | t)
  n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n
  return DEFAULT_COLORS[Math.floor((((n ^ (n >>> 14)) >>> 0) / 4294967296) * DEFAULT_COLORS.length)]
}
export function defaultShapeOf(id) {
  let value = fnv1a(String(id)) | 0
  value = Math.imul(value ^ (value >>> 16), 73244475)
  value = Math.imul(value ^ (value >>> 13), 3266489909)
  return DEFAULT_SHAPES[((value ^ (value >>> 16)) >>> 0) % DEFAULT_SHAPES.length]
}

// The look the owner's home draws for a local Bot: what it stores, with the id-picked shape
// and color filling what it does not. A stored image or emoji is left alone.
export function shownLook(bot = {}) {
  if (bot?.id === undefined || bot?.id === null || bot.id === '') return bot
  const avatar = bot.avatar && typeof bot.avatar === 'object' ? bot.avatar : {}
  const own = lookToServer(bot)
  return {
    ...bot,
    color: own.color ?? defaultColorOf(bot.id),
    avatar: own.avatar !== undefined ? avatar : { ...avatar, shape: defaultShapeOf(bot.id) },
  }
}

export function lookFingerprint(bot) {
  const patch = lookToServer(bot)
  return JSON.stringify({ avatar: patch.avatar ?? null, color: patch.color ?? null })
}
