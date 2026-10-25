import { lookAvoidingLocals, lookOf, maskOf, DEFAULT_MASK } from './characters.js'
import { inkText, paintCss } from './inks.js'
import { MENTION_ORIGIN } from './text.js'

// One @Name file chip per display name. A local Bot owns the chip when a
// friend has the same name; a later local still replaces an earlier local,
// and a later friend replaces an earlier friend only when no local has it (#963).
function chipKey(bot) {
  if (/\s/.test(bot?.name)) return null
  return String(bot?.name ?? '').toLowerCase()
}

export function mentionCss(bots) {
  const list = Array.isArray(bots) ? bots : []
  const owner = new Map()
  for (const bot of list) {
    const key = chipKey(bot)
    if (key === null) continue
    const prev = owner.get(key)
    if (prev && !prev.remote && bot?.remote) continue
    owner.set(key, bot)
  }
  return list.map((bot) => {
    const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
    const key = chipKey(bot)
    const chip = key !== null && owner.get(key) === bot
      ? `[class*="_userRow"] [data-ref-chip="file"][title="@${String(bot.name).replace(/["\\]/g, '\\$&')}" i]`
      : ''
    // The same decision BotMark makes, so a friend's anchor does not keep a raw look the
    // sidebar has already stepped off (#1088). A local Bot still owns a shared @Name chip.
    const look = bot?.remote ? lookAvoidingLocals(bot) : lookOf(bot)
    const marks = chip ? `${anchor}::before,${chip}::before` : `${anchor}::before`
    const mark = look.image
      ? `${marks}{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
      : `${marks}{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
    const chipBase = chip ? `${chip}{color:inherit;font-weight:600}${chip}>svg{display:none}${chip}::before{content:"";display:inline-block;flex:none;width:16px;height:16px;margin-right:3px;vertical-align:-3px;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}` : ''
    return `${anchor}{color:${inkText(look.color)}}${chipBase}${mark}`
  }).join('\n')
}
