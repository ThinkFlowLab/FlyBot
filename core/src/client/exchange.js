import { createElement as h, Fragment, useEffect, useState } from 'react'
import { inkText } from './inks.js'
import { dayLabel, stripTrace } from './text.js'
import { colorOf, BotMark } from './mark.js'
import { Bubbles } from './cells.js'
import { stripFence } from '../shared/preview.js'
import { useEscape, usePaneLeft } from './overlay-hooks.js'
import { t } from './i18n.js'

const SHEET_EXIT_MS = 220

// What a person reads and copies from the exchange sheet. A stored line carries its routing: a
// leading `Chief → 助手` delegation trace and, for a remote writer, an `<untrusted-message …>` fence.
// Neither is content, so the sheet reads the line the way a sidebar row does (#1347) — except that a
// reply is not one line: the paragraph breaks are the writer's own and stay exactly as stored.
export function exchangeText(text) {
  if (typeof text !== 'string') return ''
  const CLOSE = '</untrusted-message>'
  let body = text
  // A complete wrap, possibly nested: keep the inner text, with its line breaks, and whatever
  // stood before or after it.
  for (let previous; previous !== body;) {
    previous = body
    const open = body.indexOf('<untrusted-message')
    if (open < 0) break
    const close = body.lastIndexOf(CLOSE)
    const inner = close > open ? body.slice(body.indexOf('>', open) + 1, close) : body
    body = stripFence(body.slice(0, open) + inner + (close > open ? body.slice(close + CLOSE.length) : ''))
  }
  // The trace can sit above the wrap or just inside it, after the fence's newline; stripFence
  // catches the leftover fragments. A trace on a sentence is prose, and stripTrace leaves it.
  return stripFence(stripTrace(body.replace(/^\s+/, ''))).trim()
}

// One stored exchange turn: the same cleaned text reaches the bubble and the message tools' copy.
export function ExchangeLine({ entry, roster, actions }) {
  const bot = roster.byId[entry.from] ?? { id: entry.from, name: t('You'), color: 'gray' }
  // #2123: a stored line that is only routing (a delegation trace, a fence) has no words for a person.
  const body = exchangeText(entry.text)
  if (body === '') return null
  return h('div', { className: 'bt-group-msg' },
    h('span', { className: 'bt-group-name', style: { color: inkText(colorOf(bot)) } }, bot.name),
    h(Bubbles, { texts: [body], roster, selfId: bot.id, actions, lead: h('span', { className: 'bt-lead' }, h(BotMark, { bot: bot, size: 22 })) }))
}
export function ExchangeDialog({ pair, roster, actions }) {
  const [entries, setEntries] = useState(null)
  const [leaving, setLeaving] = useState(false)
  // The sheet slides back down before it unmounts.
  const close = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => actions.closeOverlay(), SHEET_EXIT_MS)
  }
  useEscape(close)
  useEffect(() => {
    let stop = false
    let timer
    let seen = null
    const load = async () => {
      const result = await actions.exchange(pair[0], pair[1])
      if (stop) return
      const key = JSON.stringify(result ?? [])
      if (key !== seen) { seen = key; setEntries(result ?? []) }
      timer = setTimeout(load, document.hidden ? 8000 : 2000)
    }
    void load()
    return () => { stop = true; clearTimeout(timer) }
  }, [pair[0], pair[1]])
  const left = roster.byId[pair[0]]
  const right = roster.byId[pair[1]]
  let lastDay = 0
  const paneLeft = usePaneLeft()
  return h('div', { className: 'bt-pane bt-exchange', style: { left: paneLeft }, 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-dialog', role: 'dialog', 'aria-label': t('Bot exchange') },
      h('div', { className: 'bt-head' }, h('span', { className: 'bt-pill', style: { cursor: 'default' } },
        left ? h(BotMark, { bot: left, size: 22 }) : null, left?.name ?? '?',
        h('span', { className: 'bt-swap' }, '⇄'),
        right ? h(BotMark, { bot: right, size: 22 }) : null, right?.name ?? '?')),
      h('div', { className: 'bt-dialog-log', role: 'log', 'aria-label': t('Bot exchange transcript') },
        entries === null ? h('div', { className: 'bt-hint' }, t('Loading…'))
          : entries.length === 0 ? h('div', { className: 'bt-hint' }, t('No messages yet'))
            : entries.map((entry) => {
              const showDay = entry.time - lastDay > 30 * 60 * 1000
              lastDay = entry.time
              return h(Fragment, { key: entry.id },
                showDay ? h('time', { className: 'bt-time' }, dayLabel(entry.time)) : null,
                h(ExchangeLine, { entry, roster, actions }))
            })),
      h('div', { className: 'bt-dialog-foot' }, h('button', { type: 'button', className: 'bt-soft', onClick: close }, t('Close Chat')))))
}
