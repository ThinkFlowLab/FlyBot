import { FeishuSetup } from '../feishu-setup.js'
import { installBrowserLocale } from '../i18n.js'
import { fileSize } from '../flybot-slots.js'
import { PendingQuestion } from '../questions.js'
import { ApprovalCard, MemberWork, MEMBER_CSS } from '../member-status.js'
import { ScopedComposer } from '../composer.js'
import { createElement as h, useSyncExternalStore, useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantCell, PersonMessage, workText } from '../cells.js'
import { BotMark, PersonMark } from '../mark.js'
import { ScopedChatList, SIDEBAR_CSS } from '../sidebar.js'
import { SHELL_CSS, CONVERSATION_CSS } from '../styles.js'

// Reuse the original reply component without installing the owner-shell plugin.
// Its data and navigation capabilities come only from this scoped projection.
function Conversation({ source, roster, openBot, onQuote }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const [failure, setFailure] = useState('')
  const chat = source.chat()
  const control = operation => Promise.resolve().then(operation).catch(error => { setFailure(error.message); throw error })
  const ui = { reactions: {} }
  const reply = (row, key, streaming = false) => {
    const bot = roster.bots.find(bot => bot.id === row.botId || bot.role === row.speaker)
    return h('article', { key, 'data-native-message': row.kind ?? 'assistant', ...(row.feishu?.messageId ? { id: `feishu-message-${row.feishu.messageId}` } : {}) },
      row.feishu?.rootId ? h('button', { type: 'button', onClick: () => document.getElementById(`feishu-message-${row.feishu.rootId}`)?.scrollIntoView?.({ block: 'center' }) }, '↪ Reply in thread') : null,
      h('header', null, bot ? h(BotMark, { bot, size: 28 }) : h(PersonMark, { name: row.speaker }), row.speaker ?? (row.kind === 'human' ? 'You' : 'Bot')),
      row.kind === 'human'
        ? h(PersonMessage, { name: row.speaker ?? 'You', texts: [String(row.text ?? '')], roster, selfId: bot?.id, useUi: select => select(ui), actions: { quote: (_id, text) => onQuote?.(text), openSession: id => { if (roster.byId[id]) openBot?.(id) } } })
        : h(AssistantCell, {
          node: { key: key, data: { turn: 0, step: 0, status: streaming ? 'running' : 'done', blocks: [{ kind: 'text', text: String(row.text ?? '') }] } },
          sessionId: bot?.id,
          useRoster: select => select(roster), useUi: select => select(ui), useTurnSteps: () => [], useTurnContext: () => [],
          actions: { noteLive() {}, quote: (_id, text) => { onQuote?.(text) },
            openSession: id => { if (roster.bots.some(bot => bot.id === id)) openBot?.(id) } },
        }),
      h(ScopedAttachments, { files: row.attachments ?? (row.attachmentIds ?? []).map(id => snapshot.attachments?.find(file => file.id === id)).filter(Boolean), read: file => chat.readAttachment(file) }))
  }
  return h('div', { className: 'bt-native-conversation', role: 'log' },
    snapshot.messages.map((row, index) => reply(row, row.id ?? index)),
    (snapshot.tools ?? []).map(tool => h('details', { key: `process:${tool.id}`, 'data-native-process': '' },
      h('summary', null, `${workText(tool.tool)} · ${tool.status}`),
      tool.text ? reply({ text: tool.text, speaker: 'Tool output' }, `result:${tool.id}`) : null)),
    (snapshot.groupWork ?? []).map(entry => h('section', { key: entry.botId }, h('header', null, entry.name ?? 'Bot'), h(MemberWork, { entry: { state: 'work', doing: entry, here: entry.canStop },
      bot: roster.byId[entry.botId] ?? { id: entry.botId }, room: { id: snapshot.binding?.personalId }, now: Date.now(),
      actions: { stopMemberWork: (_room, botId) => chat.stopMember(botId), reportError: error => setFailure(error.message) } }))),
    snapshot.question ? h(PendingQuestion, { sessionId: snapshot.binding?.personalId, question: snapshot.question, inline: true,
      actions: { answerQuestion: (_session, id, answer) => control(() => chat.answerQuestion(id, answer)),
        dismissQuestion: () => { void control(() => chat.dismissQuestion(snapshot.question.id)).catch(() => {}) } } }) : null,
    (snapshot.approvals ?? []).map(approval => h(ApprovalCard, { key: approval.id, approval, standing: false,
      bot: roster.byId[snapshot.binding?.personalId] ?? { id: snapshot.binding?.personalId, name: 'Bot' },
      actions: { answerApproval: (id, choice) => chat.answerApproval(id, choice), reportError: error => setFailure(error.message) } })),
    snapshot.binding?.personalId && !snapshot.binding.personalPart && !snapshot.groupWork ? h('div', { className: 'bt-scoped-controls' },
      h('button', { type: 'button', onClick: () => { void control(() => snapshot.busy ? chat.stop() : chat.send('Continue.')).catch(() => {}) } }, snapshot.busy ? 'Stop reply' : 'Continue')) : null,
    failure ? h('p', { role: 'alert' }, failure) : null,
    snapshot.live?.tool ? h('p', { role: 'status', 'data-native-tool': '' }, workText(snapshot.live.tool)) : null,
    (snapshot.sessions ?? []).filter(session => session.live?.tool).map(session => h('p', { key: `tool:${session.role}`, role: 'status', 'data-native-tool': '' }, `${session.role}: ${workText(session.live.tool)}`)),
    snapshot.live?.text ? reply({ ...snapshot.live, speaker: snapshot.live.speaker ?? 'Bot' }, 'live', true) : null,
    (snapshot.sessions ?? []).filter(session => session.live?.text).map(session =>
      reply({ ...session.live, speaker: session.role }, `live:${session.role}`, true)))
}

function mountRoot(node, options, render) {
  const root = createRoot(node)
  const update = next => root.render(render(next))
  update(options)
  const unmount = () => root.unmount()
  unmount.update = update
  return unmount
}

export function mountNativeConversation(node, options) {
  return mountRoot(node, options, ({ source, bots = [], openBot, onQuote }) => {
    // Only explicit member-visible identities enter the original components.
    const scopedBots = bots.map(({ id, name, role }) => ({ id, name, role }))
    const roster = { roomsById: {}, exchangeTurns: {}, remoteTypedTurns: {}, bots: scopedBots, byId: Object.fromEntries(scopedBots.map(bot => [bot.id, bot])) }
    return h(Conversation, { source, roster, openBot, onQuote })
  })
}
export const nativeConversationCss = SHELL_CSS + CONVERSATION_CSS + SIDEBAR_CSS + MEMBER_CSS

export function mountNativeChatList(node, options) {
  return mountRoot(node, options, ({ bots = [], rooms = [], mainBotIds = [], selectedId, openSession, openDetails }) => {
    bots = bots.map(bot => ({ ...bot, sessionId: bot.sessionId ?? bot.id }))
    const roster = { bots, rooms, mainBotIds, mainBotId: mainBotIds[0],
      byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), roomsById: Object.fromEntries(rooms.map(room => [room.id, room])),
      exchangeTurns: {}, remoteTypedTurns: {}, questions: {} }
    return h(ScopedChatList, { roster, selectedId, openSession, openDetails })
  })
}

export function mountNativeComposer(node, options) {
  return mountRoot(node, options, props => h(ScopedComposer, props))
}

function RuntimeInput({ worker, answer }) {
  const [failure, setFailure] = useState('')
  const pending = worker.pending
  if (pending.kind !== 'permission') return h(ScopedComposer, { chat: { send: text => answer({ text }) }, onError: error => setFailure(error.message) })
  return h('div', null,
    h(ApprovalCard, { approval: { id: pending.id, tool: pending.request?.name ?? 'Runtime action', reason: pending.request?.description ?? '', answerable: true },
      bot: { id: worker.id, name: worker.role }, standing: false,
      actions: { answerApproval: (id, choice) => answer({ requestId: id, allow: choice === 'allow' }), reportError: error => setFailure(error.message) } }),
    failure ? h('p', { role: 'alert' }, failure) : null)
}

export function mountNativeRuntimeInput(node, options) {
  return mountRoot(node, options, props => h(RuntimeInput, props))
}

function ScopedAttachments({ files, read }) {
  const [opened, setOpened] = useState({}), [failure, setFailure] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const open = async file => {
    try {
      const value = await read(file)
      if (alive.current) setOpened(previous => ({ ...previous, [file.id]: value }))
    } catch (error) { if (alive.current) setFailure(error.message) }
  }
  return h('div', { className: 'bt-scoped-attachments' }, files.map(file => {
    const value = opened[file.id]
    const image = value?.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)
    const href = value?.data ? `data:${image ? value.mediaType : 'application/octet-stream'};base64,${value.data}` : null
    return h('div', { key: file.id }, h('button', { type: 'button', onClick: () => { void open(file) } }, `${file.name ?? 'Attachment'}${Number.isFinite(file.bytes) ? ' · ' + fileSize(file.bytes) : ''}`),
      image && href ? h('img', { src: href, alt: file.name ?? 'Attachment', width: 240 }) : null,
      href ? h('a', { href, download: value.name ?? file.name }, 'Download') : null,
      typeof value?.text === 'string' ? h('pre', null, value.text) : null)
  }), failure ? h('p', { role: 'alert' }, failure) : null)
}

export function mountNativeFeishu(node, options) {
  const off = installBrowserLocale(options.language ?? navigator.language)
  const unmount = mountRoot(node, options, props => h(FeishuSetup, props))
  const dispose = () => { unmount(); off() }
  dispose.update = unmount.update
  return dispose
}
