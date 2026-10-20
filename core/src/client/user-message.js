import { createElement as h, Fragment, useState } from 'react'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { mentionSpans } from '../shared/mentions.js'
import { BotMark, PersonMark } from './mark.js'
import { CheckIcon, CopyIcon } from './icons.js'
import { dateLocale, t } from './i18n.js'
import { cleanPeerName, faceAliases, remoteBotTitle } from '../shared/remote-label.js'
import { facePeople, faceSeatLabel, faceSeats } from './face-seats.js'

// -------------------------------------------------------------------------
// The user's own messages. DSH draws every "@word" in them as a file reference, and
// cuts it at the first space, so "@新 Bot" showed as a file "新". Here the Bot mentions
// are cut out first, by the rule the group host calls them with; DSH's own drawing
// keeps everything else (files, conversation references, skills).

// DSH releases without the text projection keep their own bubble.
export const canDrawUserMessages = () => typeof ui.projectUserText === 'function'

export function contentParts(content) {
  const texts = []
  const attachments = []
  const rest = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if ((block?.type === 'image' || block?.type === 'file') && block.attachment !== undefined) attachments.push(block)
    else rest.push(block)
  }
  // Joined as the group host joins them, so a mention never spans two blocks here only.
  return { text: texts.join('\n'), attachments, rest }
}

// In a group only its members are called; elsewhere a mention opens that Bot's chat.
// A friend's remote Bot is also called by its handle — the @ menu inserts "@<handle>"
// and the host delivers on it — so the handle joins as a second name of the same Bot,
// and the chip reads the display name (mentionLabel) from the roster.
export function mentionableBots(roster, sessionId, { fromFriend = false } = {}) {
  const room = roster.roomsById[sessionId]
  if (room?.origin === 'face-to-face') return faceMentionables(room, roster, fromFriend)
  const bots = room ? room.members.map(id => roster.byId[id]).filter(Boolean)
    : roster.byId[sessionId] ? roster.bots : []
  const humans = (room?.participants ?? []).filter(p => p.kind === 'human' && p.leftSeq === undefined)
    .map(p => ({ id: p.id, name: p.displayName || p.id, kind: 'human', role: p.role }))
  const remotes = (room?.participants ?? []).filter(p => p.remote && p.leftSeq === undefined)
    .map(p => ({ id: p.handle || p.id, name: remoteBotTitle(p), kind: 'bot', remote: p, mentionLabel: remoteBotTitle(p) }))
  return bots.concat(humans, remotes, bots.filter(bot => typeof bot?.remote?.handle === 'string')
    .map(bot => ({ ...bot, name: bot.remote.handle.replace(/^@+/, ''), mentionLabel: remoteBotTitle({ displayName: bot.name, ownerName: bot.remote.homeName || bot.remote.owner, handle: bot.remote.handle, isChief: bot.remote.isChief }) })))
}

// A face-to-face line was typed on either home, so a Bot is matched by every name the room
// host routes on (faceAliases: "SelfA's Chief" typed on B is A's own Chief on A) and the chip
// reads as the Members panel names it, "SelfA · Chief", the same on both homes (#305).
// A bare "@Chief" means the writer's own Chief: my line tries my Bots first (as the host does,
// whatever order the room lists its seats in), a friend's line the friend's Bots.
function faceMentionables(room, roster, fromFriend) {
  const humans = (room.participants ?? []).filter(p => p.kind === 'human' && p.leftSeq === undefined)
    .map(p => ({ id: p.id, name: p.displayName || p.id, kind: 'human', role: p.role }))
  // The seats of people who left come last: a line sent before the leave still names the Bot it
  // named, "@Chief (Bob)" stays Bob's Chief and never turns into mine (#457).
  const all = faceSeats(room, roster, { left: true })
  const seats = all.filter(seat => !seat.left)
  const ordered = [...seats.filter(seat => seat.mine !== fromFriend), ...seats.filter(seat => seat.mine === fromFriend), ...all.filter(seat => seat.left)]
  const bots = ordered.flatMap((seat) => {
    const target = seat.local ?? { id: seat.key, name: seat.bot, kind: 'bot', remote: seat.record }
    const record = { ...seat.record, ownerName: seat.record.ownerName || seat.person }
    const mentionLabel = faceSeatLabel(seat)
    return faceAliases(record, seat.bot).map(name => ({ ...target, name, mentionLabel }))
  })
  return bots.concat(humans)
}

export function messageAuthor(data, roster, sessionId) {
  const source = data?.source ?? {}
  const authorId = source.authorId
  if (!authorId) return null
  const room = sessionId ? roster?.roomsById?.[sessionId] : undefined
  const remote = (room?.participants ?? []).find(p => p.remote && (p.handle === authorId || p.id === authorId))
  const name = remote ? remoteBotTitle(remote) : (source.authorName || source.authorId)
  return {
    authorId,
    authorKind: source.authorKind || 'human',
    name,
    ownerName: remote?.ownerName,
    mine: roster?.self?.memberId === authorId,
  }
}

// Runs of plain text and Bot mentions, in order.
export function userTextParts(text, bots, referenceLabels = []) {
  const parts = []
  let cursor = 0
  for (const span of mentionSpans(text, bots, { references: referenceLabels })) {
    if (!span.bot) continue
    if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start) })
    parts.push({ bot: span.bot, label: text.slice(span.start + 1, span.end) })
    cursor = span.end
    // The @ menu inserts "@Name " with its space, so a typed space after it makes two; the chip
    // is followed by one (#305).
    if (text.startsWith('  ', cursor)) cursor += 1
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}

function UserText({ text, bots, referenceLabels, skillNames, references, actions }) {
  return userTextParts(text, bots, referenceLabels).map((part, index) => (part.bot
    ? h('button', { key: index, type: 'button', className: 'bt-umention', title: `@${part.bot.name}`, onClick: () => actions.openSession(part.bot.id) },
      h(BotMark, { bot: part.bot, size: 16 }), `@${part.bot.mentionLabel ?? part.label}`)
    : h(Fragment, { key: index }, ui.projectUserText(part.text, referenceLabels, skillNames, 'skill', references))))
}

function Attachments({ attachments, renderMessageImages }) {
  const compact = attachments.length > 1
  return h('div', { className: 'bt-uattach' }, attachments.map((block, index) => {
    if (block.type === 'image') {
      return renderMessageImages ? h(Fragment, { key: index }, renderMessageImages({ images: [{ attachment: block.attachment }], align: 'end', compact })) : null
    }
    const file = block.attachment
    const meta = [ui.fileExtension?.(file.name)?.toUpperCase().slice(0, 8), ui.fileSizeText?.(file.bytes)].filter(Boolean).join(' · ')
    return h('span', { key: index, className: 'bt-ufile', title: file.name },
      ui.FileTypeIcon ? h(ui.FileTypeIcon, { path: file.name, className: 'bt-ufile-icon' }) : null,
      h('span', { className: 'bt-ufile-text' }, h('span', { className: 'bt-ufile-name' }, file.name), meta ? h('span', { className: 'bt-ufile-meta' }, meta) : null))
  }))
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) })
  }
  return h('button', { type: 'button', className: 'bt-tool', 'aria-label': copied ? t('Copied') : t('Copy'), title: copied ? t('Copied') : t('Copy'), onClick: copy }, copied ? h(CheckIcon) : h(CopyIcon))
}

const clock = time => (typeof time === 'number' ? new Date(time).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' }) : undefined)

// A sent message, or one that joined a running turn ("steering").
export function UserMessageCell({ node, sessionId, useRoster, actions, renderMessageImages, openFile, openSkill }) {
  const roster = useRoster(value => value)
  const data = node.data ?? {}
  const { text, attachments, rest } = contentParts(data.content)
  const referenceLabels = data.referenceLabels ?? []
  const references = openFile && openSkill ? { openFile, openSkill } : undefined
  const steering = node.kind === 'steering'
  const author = messageAuthor(data, roster, sessionId)
  const room = roster.roomsById?.[sessionId]
  const multiHuman = (room?.participants ?? []).filter(p => p.kind === 'human' && p.leftSeq === undefined).length > 1
  const incoming = author && !author.mine
  // A person in this home (the host stamps the signed-in member as the author); a friend's Bot
  // keeps its own label, so the person mark is never drawn from message text (#229).
  const person = incoming && author.authorKind === 'human' && !author.ownerName
  // In a face-to-face room my own line is a person's line like everyone else's: my name and my
  // person mark beside it, in the sent colour always. Typing it is the approval (#179), so it is
  // never drawn as held, whatever else in the room waits for approval (#457).
  const faceMine = Boolean(room?.origin === 'face-to-face' && !incoming)
  const myName = faceMine ? (facePeople(room, roster).find(entry => entry.mine)?.name || cleanPeerName(roster.self?.displayName, '') || author?.name || '') : ''
  return h('div', {
    className: incoming ? 'bt-umsg bt-umsg-other' : 'bt-umsg',
    'data-steering': steering || undefined,
    'data-face-mine': faceMine || undefined,
    'data-author': author?.authorId,
    'data-author-kind': author?.authorKind,
    'data-author-name': author?.name,
  },
    person ? h('span', { className: 'bt-lead', title: author.name }, h(PersonMark, { name: author.name })) : null,
    faceMine ? h('span', { className: 'bt-lead', title: myName || undefined }, h(PersonMark, { name: myName || undefined })) : null,
    h('div', { className: 'bt-ustack' },
      faceMine && myName ? h('span', { className: 'bt-uauthor' }, myName)
        : author && (incoming || multiHuman) ? h('span', { className: 'bt-uauthor' }, author.name, author.ownerName ? h('span', { className: 'bt-chip' }, t('Friend\'s Bot')) : null) : null,
      attachments.length > 0 ? h(Attachments, { attachments, renderMessageImages }) : null,
      text !== '' || rest.length > 0 ? h('div', { className: 'bt-ubody', title: clock(data.time) },
        h(UserText, { text, bots: mentionableBots(roster, sessionId, { fromFriend: Boolean(incoming && author.ownerName) }), referenceLabels, skillNames: data.skillNames ?? [], references, actions }),
        rest.map((block, index) => (ui.JsonBlock ? h(ui.JsonBlock, { key: index, label: t('Content'), payload: block }) : null))) : null,
      referenceLabels.length > 0 ? h('div', { className: 'bt-urefs' }, t('Referenced {labels}', { labels: referenceLabels.join(t(', ')) })) : null),
    text === '' ? null : h('div', { className: 'bt-utools' }, h(CopyButton, { text })))
}

export const USER_MESSAGE_CSS = `
.bt-umsg{display:flex;flex-direction:row-reverse;align-items:center;justify-content:flex-start;gap:4px}
.bt-umsg-other{flex-direction:row}
.bt-umsg-other .bt-ustack{align-items:flex-start}
.bt-umsg-other>.bt-lead{align-self:flex-end;margin-right:4px}
.bt-umsg-other .bt-ubody{background:var(--bt-bubble);color:var(--bt-ink)}
.bt-uauthor{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-weight:600}
.bt-composer-as{font-size:12px;line-height:16px;color:var(--bt-ink-3);padding:0 8px;align-self:center;white-space:nowrap}
.bt-ustack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.bt-ubody{max-width:100%;box-sizing:border-box;background:var(--bt-user);color:var(--bt-user-ink);border-radius:18px;padding:7px 12px;font-size:var(--dsh-content-font-size,14px);line-height:calc(var(--dsh-content-font-size,14px) + 8px);white-space:pre-wrap;word-break:break-word}
.bt-umsg[data-face-mine]>.bt-lead{align-self:flex-end;margin-left:4px}
.bt-ubody a{color:inherit}
.bt-umention{display:inline-flex;align-items:center;gap:3px;vertical-align:-3px;max-width:100%;padding:0 1px;border:0;background:none;color:inherit;font:inherit;font-weight:600;line-height:inherit;cursor:pointer;border-radius:6px;white-space:nowrap}
.bt-umention:hover{text-decoration:underline;text-underline-offset:2px}
.bt-umention>:first-child{flex:none}
.bt-uattach{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}
.bt-ufile{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;width:240px;min-height:64px;padding:8px 12px;border-radius:18px;border:.5px solid var(--bt-line-2);background:var(--bt-card)}
.bt-ufile-icon{flex:none;width:28px;height:28px}
.bt-ufile-text{display:flex;flex-direction:column;min-width:0}
.bt-ufile-name{font-size:14px;line-height:22px;font-weight:500;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ufile-meta{font-size:12px;line-height:15px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-urefs{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-utools{display:flex;flex:none;gap:2px;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s}
.bt-umsg:hover .bt-utools,.bt-umsg:focus-within .bt-utools{opacity:1;visibility:visible}
`
