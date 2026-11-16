import { HistoryHitDialog } from './history-hit.js'
import { useHistorySearch } from './history-search.js'
import { createElement as h, Fragment, useEffect, useState } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { isMainOf } from './sources.js'
import { botNames, currentPart, readableLine } from './text.js'
import { PlusIcon, SearchIcon, PeopleIcon, CloseIcon, GearIcon } from './icons.js'
import { BotAvatar, RoomAvatar } from './mark.js'
import { useEscape } from './overlay-hooks.js'
import { QUICK_EDGES, useFlip, useGlide } from './motion.js'
import { t } from './i18n.js'
import { isListedRemoteChat, pickerBotLabel } from '../shared/remote-label.js'
import { seatedCount } from './group-settings.js'
import { PALETTE_FILTERS, PALETTE_MESSAGE_MIN, paletteEmptyKind, paletteFilterAllows } from '../shared/palette-search.js'

// Four real categories: names, commands, loaded outlines, and (when supported)
// owner-scoped local Bot history via a bounded read-only host query. Group/remote
// history remains loaded-only. No all-instance or filesystem search is implied.

const paletteText = (raw, names) => readableLine(String(raw ?? ''), names)
const PALETTE_EXIT_MS = 160
export function CommandPalette({ start, token, roster, actions, useSessions }) {
  const [query, setQuery] = useState(start ?? '')
  const [cursor, setCursor] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const [filter, setFilter] = useState('all')
  const [selectedHit, setSelectedHit] = useState(null)
  const history = useHistorySearch(!selectedHit && paletteFilterAllows(filter, 'messages') ? actions.searchMessages : undefined, query.trim())
  const historyEnabled = typeof actions.searchMessages === 'function'
  const historyVisible = paletteFilterAllows(filter, 'messages')
  const wanted = query.trim().toLowerCase()
  const emptyKind = paletteEmptyKind(query, filter)
  const close = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => actions.closePalette(token), PALETTE_EXIT_MS)
  }
  useEscape(close)
  const ids = [...roster.bots.map(currentPart), ...roster.rooms.map(item => item.id)]
  const names = botNames(roster)
  const found = useSessions((list) => {
    if (wanted.length < PALETTE_MESSAGE_MIN) return '[]'
    const hits = []
    for (const id of ids) {
      const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
      if (!Array.isArray(outline)) continue
      const hidden = roster.exchangeTurns[id] ?? []
      for (let index = outline.length - 1; index >= 0 && hits.length < 30; index -= 1) {
        const entry = outline[index]
        if (hidden.includes(entry.turn)) continue
        for (const raw of [entry.response, entry.prompt]) {
          const text = paletteText(raw, names)
          const at = text.toLowerCase().indexOf(wanted)
          if (at < 0) continue
          const from = Math.max(0, at - 24)
          hits.push([id, entry.turn, (from > 0 ? '…' : '') + text.slice(from, at + wanted.length + 60)])
          break
        }
      }
    }
    return JSON.stringify(hits)
  })
  const matchesName = (...fields) => wanted === '' || fields.some(field => (field ?? '').toLowerCase().includes(wanted))
  const sections = []
  const people = [
    ...roster.bots.filter(bot => isListedRemoteChat(bot) && matchesName(bot.name, bot.role, pickerBotLabel(bot))).map(bot => ({
      key: bot.id, avatar: h(BotAvatar, { bot, size: 24, badge: false, live: false }), title: pickerBotLabel(bot),
      subtitle: [bot.role, isMainOf(roster, bot.id) ? t('Main Bot') : ''].filter(Boolean).join(' · '), badge: bot.hidden ? t('Hidden') : undefined,
      run: async () => { if (bot.hidden) await actions.setFlags(bot.id, { hidden: false }); actions.openSession(bot.id) },
    })),
    ...roster.rooms.filter(room => matchesName(room.name)).map(room => ({
      key: room.id, avatar: h(RoomAvatar, { room, roster, size: 24 }), title: room.name, subtitle: t(seatedCount(room) === 1 ? '{count} member' : '{count} members', { count: seatedCount(room) }),
      badge: room.hidden ? t('Hidden') : undefined,
      run: async () => { if (room.hidden) await actions.setFlags(room.id, { hidden: false }); actions.openSession(room.id) },
    })),
  ]
  if (emptyKind !== 'empty' && paletteFilterAllows(filter, 'chats') && people.length) sections.push([t('Bots'), people])
  const agents = (roster.agents ?? []).filter(() => matchesName('DSH Agent')).map(agent => ({
    key: agent.id, avatar: h('span', { className: 'bt-palette-agent' }, h(FishLogo, { size: 18 })), title: 'DSH Agent',
    subtitle: t('Plain dsh session'),
    run: () => actions.openAgent(agent.id),
  }))
  if (emptyKind !== 'empty' && paletteFilterAllows(filter, 'chats') && agents.length) sections.push(['DSH Agent', agents])
  const historyRows = history.items.filter(hit => roster.byId[hit.botId]).map(hit => ({
    key: `history:${hit.sessionId}:${hit.seq}`, title: roster.byId[hit.botId].name, subtitle: hit.snippet,
    avatar: h(BotAvatar, { bot: roster.byId[hit.botId], size: 24, badge: false, live: false }),
    badge: t(hit.earlier ? 'Earlier part; view read-only history' : 'View read-only history'),
    keepOpen: true,
    run: () => setSelectedHit({ botId: hit.botId, sessionId: hit.sessionId, hitToken: hit.hitToken }),
  }))
  if (emptyKind !== 'empty' && historyVisible && historyRows.length) sections.push([t('Local Bot chat history'), historyRows])
  const messages = JSON.parse(found).filter(([id, turn]) => !history.items.some(hit => hit.sessionId === id && hit.turn === turn)).map(([id, turn, snippet]) => {
    const bot = roster.byId[id]
    const room = roster.roomsById[id]
    return {
      key: `${id}:${turn}`, title: bot?.name ?? room?.name ?? t('Bot'), subtitle: snippet,
      avatar: bot ? h(BotAvatar, { bot, size: 24, badge: false, live: false }) : h(RoomAvatar, { room, roster, size: 24 }),
      run: () => actions.openSession(id),
    }
  })
  if (emptyKind !== 'empty' && paletteFilterAllows(filter, 'messages') && messages.length) sections.push([t('Messages'), messages])
  const commands = [
    { key: 'cmd:new', icon: h(PlusIcon), title: t('New chat'), run: () => actions.openNewChat('new') },
    { key: 'cmd:bot', icon: h(PlusIcon), title: t('Create Bot'), run: () => actions.openNewChat('create') },
    { key: 'cmd:group', icon: h(PeopleIcon), title: t('Create group chat'), run: () => actions.openNewChat('group') },
    { key: 'cmd:settings', icon: h(GearIcon), title: t('Settings'), run: () => actions.openSettings('general') },
  ].filter(command => matchesName(command.title))
  if (emptyKind !== 'empty' && paletteFilterAllows(filter, 'commands') && commands.length) sections.push([t('Commands'), commands])
  const rows = sections.flatMap(([, items]) => items)
  const active = Math.min(cursor, Math.max(rows.length - 1, 0))
  const shown = rows.map(row => row.key).join('\n')
  const glide = useGlide(`${active}\n${shown}`, { axis: 'y', ...QUICK_EDGES })
  const listRef = glide.box
  useFlip(listRef, shown, '[data-flip]')
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query])
  const choose = (row) => {
    if (!row || leaving) return
    void Promise.resolve(row.run()).catch(error => actions.reportError(error, 'menu'))
    if (!row.keepOpen) close()
  }
  if (selectedHit) return h(HistoryHitDialog, { key: selectedHit.hitToken, hit: selectedHit, roster, actions, onBack: () => setSelectedHit(null) })
  let index = -1
  return h('div', { className: 'bt-palette-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-backdrop', onMouseDown: close }),
    h('div', { className: 'bt-palette', role: 'dialog', 'aria-label': t('Search'), 'aria-modal': true },
      h('div', { className: 'bt-palette-head' },
        h('span', { className: 'bt-palette-glyph', 'aria-hidden': true }, h(SearchIcon)),
        h('input', {
          autoFocus: true, value: query, placeholder: t(historyEnabled ? 'Search chats and local Bot history' : 'Search Bots, chats, and loaded messages'), 'aria-label': t('Search'),
          role: 'combobox', 'aria-expanded': true, 'aria-controls': 'bt-palette-list',
          onChange: (event) => { setQuery(event.target.value); setCursor(0) },
          onKeyDown: (event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(Math.min(active + 1, rows.length - 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(Math.max(active - 1, 0)) }
            else if (event.key === 'Enter') { event.preventDefault(); choose(rows[active]) }
          },
        }),
        h('button', { type: 'button', className: 'bt-palette-clear', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-palette-filters', role: 'tablist', 'aria-label': t('Search filters') },
        PALETTE_FILTERS.map(id => h('button', {
          key: id, type: 'button', role: 'tab', className: 'bt-palette-filter',
          'data-filter': id, 'aria-selected': filter === id,
          tabIndex: filter === id ? 0 : -1,
          onKeyDown: event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = PALETTE_FILTERS.indexOf(filter)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? PALETTE_FILTERS.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + PALETTE_FILTERS.length) % PALETTE_FILTERS.length
            setFilter(PALETTE_FILTERS[next]); setCursor(0)
            event.currentTarget.parentElement?.querySelectorAll('[role=tab]')?.[next]?.focus()
          }, onClick: () => { setFilter(id); setCursor(0) },
        }, t(id === 'all' ? 'All' : id === 'chats' ? 'Chats' : id === 'messages' ? 'Messages' : 'Commands')))),
      historyVisible ? h('div', { className: 'bt-palette-history' },
        h('p', { className: 'bt-palette-scope' }, t(historyEnabled ? 'History: your local Bots in this instance. Other chats: loaded messages only.' : 'History unavailable; searching loaded messages only.')),
        h('span', { role: 'status', 'aria-live': 'polite' },
          [...query].length > 256 ? t('History query is limited to 256 characters.')
            : history.status === 'loading' ? t('Searching history…')
              : history.status === 'error' ? t('History query failed; showing loaded messages only.')
                : history.incomplete ? t('Some history could not be read; results are incomplete.') : '',
          history.limited ? t('History search reached a safety limit; narrow your query.') : ''),
        history.cursor ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: history.status === 'loading', onClick: history.more }, t('Search more history')) : null) : null,
      h('div', { ref: listRef, id: 'bt-palette-list', className: 'bt-palette-list', role: 'listbox', 'aria-label': t('Results') },
        h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        rows.length === 0
          ? h('div', { className: 'bt-palette-empty' },
              h('span', { className: 'bt-palette-empty-icon', 'aria-hidden': true }, h(SearchIcon)),
              h('span', { className: 'bt-palette-empty-label' }, historyVisible && history.status === 'loading' ? t('Searching history…') : historyVisible && history.cursor ? t('More history remains to be searched') : historyVisible && (history.incomplete || history.limited) ? t('No matches in the searched portion') : emptyKind === 'none' ? t('No results') : t('Search chats and messages')),
              h('span', { className: 'bt-palette-empty-hint' },
                historyEnabled && historyVisible ? t('Enter text to search local Bot history; other chats use loaded messages.')
                  : emptyKind === 'short' ? t('Type at least two characters to search messages already loaded')
                  : emptyKind === 'none' ? t('Try a Bot name, a group name, or words from a loaded message')
                    : t('Type a Bot name, a group name, or words from a loaded message')))
          : sections.map(([title, items]) => h(Fragment, { key: title },
              h('div', { className: 'bt-palette-section', role: 'presentation', 'data-flip': `section:${title}` }, title),
              items.map((row) => {
                index += 1
                const at = index
                return h('button', {
                  key: row.key, type: 'button', role: 'option', className: 'bt-palette-row', 'aria-selected': at === active, 'data-flip': row.key,
                  onMouseMove: () => { if (cursor !== at) setCursor(at) }, onClick: () => choose(row),
                },
                h('span', { className: 'bt-palette-lead' }, row.avatar ?? h('span', { className: 'bt-palette-cmd' }, row.icon)),
                h('span', { className: 'bt-palette-text' },
                  h('span', { className: 'bt-palette-title' }, row.title),
                  row.subtitle ? h('span', { className: 'bt-palette-sub' }, row.subtitle) : null),
                row.badge ? h('span', { className: 'bt-palette-badge' }, row.badge) : null)
              }))))))
}
