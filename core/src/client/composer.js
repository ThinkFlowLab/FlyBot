import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, MicIcon, PaperclipIcon, PeopleIcon, PlusIcon, WaveIcon } from './icons.js'
import { BotMark, markBotForMention } from './mark.js'
import { useLinger } from './motion.js'
import { t } from './i18n.js'
import { lockedWindow } from './schedules.js'

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()

// -------------------------------------------------------------------------
// Which key sends. The shell sends on Enter and keeps Shift+Enter for a new line;
// General → Shortcuts can flip that pair for this window. The choice is local
// (localStorage): the host stores no send-key field, so nothing here writes it.

export const SEND_KEYS = ['enter', 'shift-enter']
export const DEFAULT_SEND_KEY = 'enter'
export const SEND_KEY_STORAGE = 'flybot-send-key'

export function normalizeSendKey(value) {
  return SEND_KEYS.includes(value) ? value : DEFAULT_SEND_KEY
}

export function readSendKey(storage = globalThis.localStorage) {
  try { return normalizeSendKey(storage?.getItem(SEND_KEY_STORAGE)) } catch { return DEFAULT_SEND_KEY }
}

export function writeSendKey(value, storage = globalThis.localStorage) {
  const key = normalizeSendKey(value)
  try { storage?.setItem(SEND_KEY_STORAGE, key) } catch { /* storage unavailable */ }
  return key
}

// A plain Enter is the only key in play: modifiers stay the shell's, and an IME's
// Enter (composition, or the legacy keyCode 229) never sends or breaks a line.
const plainEnter = (event) => {
  if (event?.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return false
  return !(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.which === 229)
}

export function shouldSendOnKey(event, sendKey) {
  if (!plainEnter(event)) return false
  return normalizeSendKey(sendKey) === 'shift-enter' ? event.shiftKey === true : event.shiftKey !== true
}

export function shouldBreakOnKey(event, sendKey) {
  if (!plainEnter(event)) return false
  return normalizeSendKey(sendKey) === 'shift-enter' ? event.shiftKey !== true : event.shiftKey === true
}

export function composerFieldOf(target) {
  const field = target?.closest?.('[data-composer-input], textarea, [contenteditable="true"]')
  return field ?? null
}

export function composerCardOf(field) {
  return field?.closest?.('[data-composer-card]') ?? null
}

// The shell's own Send button: the component leaves it without a marker, so its label is
// the only handle. Dictation, the voice button and "+" are not sends.
const NOT_SEND = /dictate|mic|voice|add|plus|stop|录音|听写|添加|停止/i
export function findSendButton(card) {
  const named = card?.querySelector?.('button[type=submit], button[data-send], [data-composer-send]')
  if (named) return named
  const buttons = card?.querySelectorAll?.('button') ?? []
  for (const button of buttons) {
    const label = [button.getAttribute?.('aria-label'), button.getAttribute?.('title'), button.textContent].filter(Boolean).join(' ')
    if (/send|发送/i.test(label) && !NOT_SEND.test(label)) return button
  }
  return null
}

// Enter starts a new line when Shift+Enter sends. A value field splices one in; the
// shell's Lexical field takes the editing command the browser uses for a line break.
export function insertComposerNewline(field) {
  if (!field) return false
  if (typeof field.value === 'string' && typeof field.selectionStart === 'number') {
    const start = field.selectionStart
    const end = field.selectionEnd ?? start
    field.value = `${field.value.slice(0, start)}\n${field.value.slice(end)}`
    field.selectionStart = field.selectionEnd = start + 1
    field.dispatchEvent?.(new Event('input', { bubbles: true }))
    return true
  }
  if (field.isContentEditable !== true && field.getAttribute?.('contenteditable') !== 'true') return false
  const doc = field.ownerDocument ?? globalThis.document
  if (typeof doc?.execCommand !== 'function') return false
  return doc.execCommand('insertLineBreak') === true
    || doc.execCommand('insertParagraph') === true
    || doc.execCommand('insertText', false, '\n') === true
}

// A capture-phase listener, so a line the shell would have sent is stopped before the
// Lexical editor sees it. A window that has no Send to press (a running turn's button
// reads Stop, or is disabled) falls through and keeps the shell's own Enter-to-send.
export function installSendShortcut({ doc = globalThis.document } = {}) {
  const view = doc?.defaultView
  if (!view?.addEventListener) return () => {}
  const onKey = (event) => {
    if (event.defaultPrevented) return
    const field = composerFieldOf(event.target)
    if (!field || field.disabled || field.readOnly || field.getAttribute?.('aria-readonly') === 'true') return
    const card = composerCardOf(field)
    if (!card) return
    const sendKey = readSendKey(view.localStorage)
    if (sendKey === DEFAULT_SEND_KEY) return
    if (shouldSendOnKey(event, sendKey)) {
      const button = findSendButton(card)
      if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return
      event.preventDefault()
      event.stopPropagation()
      button.click?.()
      return
    }
    if (shouldBreakOnKey(event, sendKey)) {
      event.preventDefault()
      event.stopPropagation()
      insertComposerNewline(field)
    }
  }
  view.addEventListener('keydown', onKey, true)
  return () => view.removeEventListener('keydown', onKey, true)
}

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => recognition.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = ({ continuous = true, onEnd } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    engine.lang = navigator.language || 'zh-CN'
    engine.interimResults = true
    engine.continuous = continuous
    engine.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
    }
    engine.onend = () => { setListening(false); recognition.current = null; onEnd?.() }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  return { listening, note, start, stop }
}

export function ComposerIdentity({ sessionId, useRoster }) {
  const roster = useRoster(value => value)
  const room = roster.roomsById?.[sessionId]
  const self = roster.self
  const humans = (room?.participants ?? []).filter(p => p.kind === 'human' && p.leftSeq === undefined)
  if (room?.viewerRole === 'invited-owner') {
    return h('span', { className: 'bt-composer-as', title: t('You can remove your Bot from this room') },
      t('Shared room from {name}', { name: room.sharedFrom?.inviterName || t('a friend') }))
  }
  if (!self || !room || humans.length < 2) return null
  return h('span', { className: 'bt-composer-as', title: t('Messages in this room are attributed to you') },
    t('Sending as {name}', { name: self.displayName || self.memberId }))
}

export function ComposerVoice({ sessionId, inputActions, actions, useUi }) {
  const dictation = useDictation((text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  // Reply from a message's hover toolbar quotes it into this composer.
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  useEffect(() => {
    if (!quote || !inputActions) return
    actions.clearQuote(quote.token)
    const excerpt = quote.text.replace(/\s+/g, ' ').trim()
    const line = `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
    inputActions.insertText(line, inputActions.captureInsertion())
    const box = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true]')
    if (box instanceof HTMLElement) {
      box.focus()
      const selection = window.getSelection()
      selection?.selectAllChildren(box)
      selection?.collapseToEnd()
    }
  }, [quote?.token])
  // One capture listener per mounted chat; the preference is read at each key press.
  useEffect(() => installSendShortcut(), [])
  if (sessionId === undefined) return null
  // With the Voice Input plugin on, its own microphone sits in this composer.
  const pluginMic = actions.speech() !== undefined
  return h(Fragment, null,
    pluginMic ? null : h('button', {
      type: 'button', className: 'bt-mic', 'aria-label': dictation.listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': dictation.listening, title: dictation.listening ? t('Stop dictation') : t('Dictate'),
      onMouseDown: keepComposerFocus, onClick: () => (dictation.listening ? dictation.stop() : dictation.start()),
    }, h(MicIcon)),
    h('button', {
      type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      onMouseDown: keepComposerFocus, onClick: () => actions.openVoice(sessionId),
    }, h(WaveIcon, { size: 18 })),
    dictation.note ? h('span', { className: 'bt-mic-note', role: 'status' }, dictation.note) : null)
}

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu
// does not remount its mark on every keystroke.
export function menuIcons(roster) {
  const marks = new Map()
  return (row) => {
    if (!row.bot) return PeopleIcon
    const id = row.bot.id
    if (!marks.has(id)) marks.set(id, ({ size = 14 }) => h(BotMark, { bot: markBotForMention(row.bot, roster.getSnapshot()), size }))
    return marks.get(id)
  }
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another
// chat, or set a scheduled task for this chat. It stands in for the shell's command
// menu, whose plan, permission, model and compact rows reach past what DS Bot keeps
// for its Bots; "/" still opens that menu. Files go through the shell's own file
// input beside it.
export function ComposerPlus({ sessionId, inputActions, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(null) }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(null) } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id
  if (sessionId === undefined || target === undefined) return null
  // A locked window draws no create entry: "Scheduled task" opened the settings list with this
  // chat's id, which asks for the create form, and a locked page draws no form (#2232, P-457).
  const locked = lockedWindow(roster)
  const toggle = () => {
    if (open) { setOpen(null); return }
    const rect = button.current.getBoundingClientRect()
    setOpen({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
  }
  const attach = () => {
    setOpen(null)
    button.current?.closest('[data-composer-card]')?.querySelector('input[type=file]')?.click()
  }
  // The chats open in the shell's "@" menu at the caret, so the pick lands where the
  // user was typing.
  const reference = () => {
    setOpen(null)
    actions.referenceChat(sessionId, inputActions?.captureInsertion?.())
  }
  const canReference = typeof inputActions?.captureInsertion === 'function' && actions.canReferenceChat()
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(open), onMouseDown: keepComposerFocus, onClick: toggle,
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-menu-up bt-plus-menu', role: 'menu', 'aria-label': t('Add'),
      style: { left: shown.left, bottom: shown.bottom }, 'data-leaving': leaving || undefined,
    },
    h('button', { type: 'button', role: 'menuitem', onClick: attach }, h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))),
    canReference ? h('button', { type: 'button', role: 'menuitem', onMouseDown: keepComposerFocus, onClick: reference }, h(ChatsIcon), h('span', { className: 'bt-menu-label' }, t('Reference a chat'))) : null,
    locked ? null : h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(null); actions.openSettings('schedules', target) } }, h(ClockIcon), h('span', { className: 'bt-menu-label' }, t('Scheduled task')))), document.body) : null)
}
