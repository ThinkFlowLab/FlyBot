import { createElement as h, useEffect, useState } from 'react'
import { isMainOf } from './sources.js'
import { PlusIcon, ChevronRightIcon } from './icons.js'
import { AdminStar, BotAvatar, BotMark, PersonMark, RoomAvatar, lookBotForRemote } from './mark.js'
import { Card, Row, InlineText, SwitchRow } from './bot-settings.js'
import { Segmented } from './motion.js'
import { FolderMenu } from './folder-menu.js'
import { t } from './i18n.js'
import { StandingApprovalsCard } from './standing-approvals.js'
import { remoteBotTitle } from '../shared/remote-label.js'

export const ROOM_MODES = [
  ['admin', 'Admin leads', 'Plain messages go to the admin, who calls others with @Name.'],
  ['everyone', 'Everyone', 'Every member answers in turn, admin first.'],
]

// Without an admin the host answers as everyone, whatever the stored mode says.
export const shownMode = (room, roster) => (roster.byId[room.admin] ? room.mode : 'everyone')

// faceSeats, faceSeatLabel and facePeople live in face-seats.js so the chat bubble can name a mention the same way.
import { faceSeats, faceSeatLabel, facePeople, facePersonLabel } from './face-seats.js'

export { faceSeats, faceSeatLabel, facePeople }

// A face room says what it counts, people and Bots, not an ambiguous "2 members" (#306).
export function faceRoomCount(room, roster) {
  const people = facePeople(room, roster).length
  const seats = faceSeats(room, roster).length
  const persons = people === 1 ? t('1 person') : t('{count} people', { count: people })
  const bots = seats === 1 ? t('1 Bot') : t('{count} Bots', { count: seats })
  return `${persons} · ${bots}`
}

// The seat of a face room's lead (#476), by handle.
const handleKey = handle => String(handle ?? '').trim().replace(/^@+/, '').toLowerCase()
export const isLeadSeat = (seat, lead) => Boolean(handleKey(lead) && handleKey(seat.record?.handle) === handleKey(lead))

// One row per person (#457): "Ann (you) · Chief, Researcher", my own Bots each opening its chat.
// `lead`: the room lead's handle (#476), marked on its Bot.
export function FacePersonRow({ person, onOpenBot, lead, className = 'bt-set-row bt-bs-row bt-gs-member', size = 26 }) {
  const bots = person.seats.flatMap((seat, index) => {
    const name = seat.local && onOpenBot
      ? h('button', { key: seat.key, type: 'button', className: 'bt-face-bot', title: t("Open {name}'s chat", { name: seat.bot }), onClick: () => onOpenBot(seat.local.id) }, seat.bot)
      : h('span', { key: seat.key, className: 'bt-face-bot', title: seat.record?.handle || undefined }, seat.bot)
    const marked = isLeadSeat(seat, lead) ? [name, h('span', { key: `${seat.key}-lead`, className: 'bt-tag', 'data-flybot': 'face-lead-tag' }, t('Lead'))] : [name]
    return index === 0 ? marked : [h('span', { key: `${seat.key}-sep` }, t(', ')), ...marked]
  })
  return h('div', { className, role: 'listitem', 'data-flybot': 'face-person', 'data-mine': person.mine || undefined },
    h('span', { className: 'bt-gs-who bt-face-person' },
      h(PersonMark, { size, name: person.name }),
      h('span', { className: 'bt-face-person-text' },
        h('span', { className: 'bt-row-title' }, facePersonLabel(person)),
        h('span', { className: 'bt-face-bots' }, bots))))
}

// A face room's lead (总负责人, #476): the one Bot, from any home, that writes the plan and gives out the
// parts. The room creator changes it here, with a button; everyone else sees it read-only. Until the
// creator picks, it is the first Bot of the creator's home that joined.
export function FaceLead({ room, roster, pick }) {
  const lead = room.face?.lead
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seats = faceSeats(room, roster)
  const current = seats.find(seat => isLeadSeat(seat, lead?.handle))
  if (!current) return null
  const canPick = lead.canPick === true && typeof pick === 'function'
  const choose = async (handle) => {
    setBusy(true)
    setError('')
    try {
      await pick(handle)
      setOpen(false)
    } catch (err) {
      setError(err?.message || t('Could not change the room lead.'))
    } finally { setBusy(false) }
  }
  return h('div', { className: 'bt-face-lead', 'data-flybot': 'face-lead' },
    h('div', { className: 'bt-section-title' }, t('Room lead')),
    h('div', { className: 'bt-set-row' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-row-title' }, faceSeatLabel(current)),
        h('span', { className: 'bt-set-hint' }, lead.picked ? t('Writes the plan and gives each Bot its part.') : t('Default: the first Bot of the room creator that joined.'))),
      canPick ? h('button', { type: 'button', className: 'bt-mini', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? t('Done') : t('Change')) : null),
    open && canPick ? seats.map(seat => h('div', { key: seat.key, className: 'bt-set-row' },
      h('span', { className: 'bt-set-copy' }, faceSeatLabel(seat)),
      seat === current
        ? h('span', { className: 'bt-tag' }, t('Lead'))
        : h('button', { type: 'button', className: 'bt-mini', disabled: busy, onClick: () => void choose(seat.record?.handle) }, t('Make lead')))) : null,
    open && canPick && lead.picked ? h('button', { type: 'button', className: 'bt-more', disabled: busy, onClick: () => void choose(null) }, t('Use the default lead')) : null,
    canPick || !lead.supported ? null : h('div', { className: 'bt-set-hint' }, t('Only the person who created this room can change it.')),
    error ? h('div', { className: 'bt-set-hint', role: 'alert' }, error) : null)
}

export function roomSubtitle(room, roster) {
  if (room.origin === 'face-to-face') return faceRoomCount(room, roster)
  const admin = roster.byId[room.admin]
  return [t('{count} members', { count: room.members.length }), admin ? t('Admin {name}', { name: admin.name }) : t('No admin')].join(' · ')
}

// A group chat's settings as grouped cards: its name and notice, who answers, its
// members and admin, its sidebar place, and deleting it. The user may change all of
// it; the host enforces what Bots may change.
export function GroupSettingsForm({ room, roster, actions, run, onDeleted }) {
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const live = room.presentedParticipants ?? room.participants ?? []
  const humans = live.filter(p => p.kind === 'human' && p.leftSeq === undefined)
  const remotes = live.filter(p => p.remote && p.leftSeq === undefined)
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const face = room.origin === 'face-to-face'
  const people = face ? facePeople(room, roster) : []
  const shared = humans.length > 1
  const chiefs = new Set((roster.humans ?? []).map(person => person.designatedChiefId).filter(Boolean))
  const outside = roster.bots.filter((bot) => {
    if (bot.remote) return false
    if (room.members.includes(bot.id)) return false
    if (shared) return chiefs.has(bot.id)
    return true
  })
  const outsidePeople = (roster.humans ?? []).filter(person => !humans.some(p => p.id === person.id))
  const outsideRemotes = (roster.remoteBots ?? []).filter(bot => !remotes.some(p => p.handle === bot.handle))
  const admin = roster.byId[room.admin]
  const mode = shownMode(room, roster)
  const modeHint = ROOM_MODES.find(([id]) => id === mode)?.[2] ?? ''
  const update = patch => run(actions.updateRoom(room.id, patch))
  const openBot = (id) => { actions.closeSettings(); actions.openSession(id) }
  const remove = () => {
    if (!confirming) { setConfirming(true); return }
    void Promise.resolve(run(actions.deleteRoom(room.id))).then((done) => { if (done) onDeleted?.() })
  }
  return h('div', { className: 'bt-bs' },
    h('div', { className: 'bt-bs-hero' },
      h(RoomAvatar, { room, roster, size: 64 }),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-bs-name' }, room.name),
        h('span', { className: 'bt-bs-sub' }, roomSubtitle(room, roster)))),
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name'), hint: t('Leave it empty to name the group after its members.') },
        h(InlineText, { label: t('Group name'), value: room.named ? room.name : '', placeholder: t('Name after members'), maxLength: 60, onSave: name => update({ name }) })),
      h(Row, { label: t('Notice'), hint: t('Every member reads it before speaking in this group.'), stack: true },
        h(InlineText, { label: t('Group notice'), value: room.notice, multiline: true, maxLength: 2000, placeholder: t('Shared instructions every member reads before speaking…'), onSave: notice => update({ notice }) }))),
    h(Card, { title: t('Who answers') },
      h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h(Segmented, { label: t('Who answers'), value: mode }, ROOM_MODES.map(([id, label]) => h('button', {
          key: id, type: 'button', 'aria-pressed': mode === id, disabled: id === 'admin' && !admin,
          title: id === 'admin' && !admin ? t('Choose an admin first') : undefined,
          onClick: () => { if (mode !== id) void update({ mode: id }) },
        }, t(label)))),
        h('span', { key: mode, className: 'bt-set-hint bt-veil' }, `${t(modeHint)} ${t('@mentions always pick who answers.')}`))),
    h(Card, { title: t('Working folder') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Folder'))),
        h(FolderMenu, { value: room.workDir, group: true, actions, run, onPick: workDir => update({ workDir }) }))),
    face ? h(Card, { title: t('Members · {count}', { count: people.length }) },
      people.map(person => h(FacePersonRow, { key: person.key, person, onOpenBot: openBot, lead: room.face?.lead?.handle }))) : null,
    face ? null : h(Card, { title: t('Members · {count}', { count: members.length + humans.length + remotes.length }) },
      humans.map((person) => h('div', { key: person.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
        h('span', { className: 'bt-gs-who' },
          h('span', { className: 'bt-row-title' }, person.displayName || person.id),
          h('span', { className: 'bt-tag' }, t('Human')),
          person.role === 'admin' ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
        humans.length + members.length + remotes.length > 2 && person.id !== roster.self?.memberId
          ? h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Remove {name} from the group', { name: person.displayName || person.id }), title: t('Remove from group'), onClick: () => update({ removeParticipants: [{ kind: 'human', id: person.id }] }) }, '×')
          : null)),
      members.map((member) => {
        const leads = room.admin === member.id
        return h('div', { key: member.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
          h('button', { type: 'button', className: 'bt-gs-who', title: t("Open {name}'s chat", { name: member.name }), onClick: () => openBot(member.id) },
            h(BotAvatar, { bot: member, size: 26, main: isMainOf(roster, member.id), admin: leads, live: false }),
            h('span', { className: 'bt-row-title' }, member.name),
            leads ? h('span', { className: 'bt-tag' }, t('Admin')) : null,
            (roster.humans ?? []).some(person => person.designatedChiefId === member.id) ? h('span', { className: 'bt-tag' }, t('Chief')) : null),
          leads
            ? h('button', { type: 'button', className: 'bt-mini', title: t('Leave the group without an admin'), onClick: () => update({ admin: null }) }, t('Unset'))
            : h('button', { type: 'button', className: 'bt-mini', onClick: () => update({ admin: member.id }) }, t('Make admin')),
          members.length > 2 ? h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Remove {name} from the group', { name: member.name }), title: t('Remove from group'), onClick: () => update({ remove: [member.id] }) }, '×') : null)
      }),
      remotes.map((person) => h('div', { key: person.handle || person.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
        h('span', { className: 'bt-gs-who' },
          h(BotAvatar, { bot: lookBotForRemote(person, roster), size: 26, badge: false, live: false }),
          h('span', { className: 'bt-row-title', title: person.handle || undefined }, person.label || remoteBotTitle(person)),
          room.origin === 'face-to-face' ? null : h('span', { className: 'bt-tag' }, t('Friend\'s Bot'))),
        room.origin === 'face-to-face' || members.length + remotes.length <= 2
          ? null
          : h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Remove {name} from the group', { name: remoteBotTitle(person) }), title: t('Remove from group'), onClick: () => update({ removeParticipants: [{ kind: 'bot', id: person.handle || person.id, remote: true }] }) }, '×'))),
      room.origin === 'face-to-face' ? null : adding
        ? [...outsidePeople.map(person => h('button', { key: person.id, type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', onClick: () => { setAdding(false); void update({ addParticipants: [{ kind: 'human', id: person.id, displayName: person.displayName }] }) } },
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, person.displayName || person.id)),
            h('span', { className: 'bt-set-hint' }, t('Add person')))),
          ...outside.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', onClick: () => { setAdding(false); void update({ add: [bot.id] }) } },
            h(BotMark, { bot, size: 22 }),
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, bot.name)),
            h('span', { className: 'bt-set-hint' }, t('Add')))),
          ...outsideRemotes.map(bot => h('button', { key: bot.handle, type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', onClick: () => { setAdding(false); void update({ addParticipants: [{ kind: 'bot', remote: true, handle: bot.handle }] }) } },
            h(BotAvatar, { bot: lookBotForRemote({ handle: bot.handle, displayName: bot.name, avatar: bot.avatar, color: bot.color }, roster), size: 22, badge: false, live: false }),
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, remoteBotTitle({ displayName: bot.name, ownerName: bot.homeName || bot.owner, handle: bot.handle, isChief: bot.isChief }))),
            h('span', { className: 'bt-set-hint' }, t('Add friend\'s Bot')))),
          h('button', { key: 'cancel', type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => setAdding(false) }, t('Cancel'))]
        : outside.length + outsidePeople.length + outsideRemotes.length > 0
          ? h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => setAdding(true) }, h(PlusIcon), t('Add member'))
          : null,
      h('div', { className: 'bt-set-row bt-gs-note' }, h('span', { className: 'bt-set-hint' },
        // The host checks for two members on every change, even a rename.
        members.length < 2 ? t('Add a Bot first: a group chat needs at least two.')
          : admin ? t('{name} leads this group: it can call members with @Name, change the group, and post here.', { name: admin.name })
            : t('No admin yet. An admin can call members with @Name, change the group, and post here.')))),
    h(StandingApprovalsCard, { scope: 'room', target: room, roster, actions, run, Card }),
    h(Card, { title: t('Sidebar') },
      h(SwitchRow, { label: t('Pin'), hint: t('Kept above the other chats.'), on: room.pinned === true, onChange: pinned => run(actions.setFlags(room.id, { pinned })) }),
      h(SwitchRow, { label: t('Hide from sidebar'), hint: t('Search still finds it.'), on: room.hidden === true, onChange: hidden => run(actions.setFlags(room.id, { hidden })) })),
    h(Card, { title: t('More') },
      h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', 'data-confirm': confirming || undefined, onClick: remove },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, confirming ? t('Delete {name}?', { name: room.name }) : t('Delete group')),
          h('span', { className: 'bt-set-hint' }, confirming ? t('Click again to delete. Its history is archived.') : t('Removes the group chat. Its members stay on the team.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}

// A new group chat from Settings: its admin first, then the other members, then a name
// if the member names will not do.
export function NewGroupForm({ roster, actions, run, onCreated, onCancel }) {
  const [admin, setAdmin] = useState(null)
  const [members, setMembers] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const toggle = id => setMembers(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const pickAdmin = (id) => { setAdmin(id); setMembers(list => list.filter(item => item !== id)) }
  const create = async () => {
    if (busy || admin === null || members.length === 0) return
    setBusy(true)
    let room
    const done = await run(actions.createRoom([admin, ...members], { admin, ...(name.trim() ? { name: name.trim() } : {}) }).then((value) => { room = value }))
    if (done && room) onCreated(room)
    else setBusy(false)
  }
  const chip = (bot, on, onClick, role) => h('button', {
    key: bot.id, type: 'button', role, className: 'bt-ng-chip', 'aria-checked': on, onClick,
  }, h(BotAvatar, { bot, size: 22, badge: false, live: false }), h('span', { className: 'bt-ng-name' }, bot.name), on && role === 'radio' ? h(AdminStar) : null)
  return h('div', { className: 'bt-set-card bt-ng' },
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label bt-ng-label' }, h(AdminStar), t('Choose the group admin'))),
      h('div', { className: 'bt-ng-picks', role: 'radiogroup', 'aria-label': t('Group admin') },
        roster.bots.map(bot => chip(bot, admin === bot.id, () => pickAdmin(bot.id), 'radio')))),
    admin === null ? null : h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-ng-step' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Who to chat with…'))),
      h('div', { className: 'bt-ng-picks', role: 'group', 'aria-label': t('Members') },
        roster.bots.filter(bot => bot.id !== admin).map(bot => chip(bot, members.includes(bot.id), () => toggle(bot.id), 'checkbox')))),
    admin === null || members.length === 0 ? null : h('label', { className: 'bt-set-row bt-bs-row bt-ng-step' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
      h('input', { className: 'bt-bs-input', value: name, maxLength: 60, placeholder: t('Name after members'), onChange: event => setName(event.target.value) })),
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || admin === null || members.length === 0, onClick: () => void create() }, t('Create group chat'))))
}

export const GROUP_SETTINGS_CSS = `
.bt-ng{animation:bt-q-in .4s cubic-bezier(.22,1,.36,1),bt-veil-in .2s ease-out}
.bt-ng-step{animation:bt-veil-in .22s ease-out}
.bt-ng-label{display:inline-flex;align-items:center;gap:6px}
.bt-ng-picks{display:flex;flex-wrap:wrap;gap:6px}
.bt-ng-chip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 5px;border-radius:999px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease,scale .3s cubic-bezier(.34,1.56,.64,1)}
.bt-ng-chip:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ng-chip:active{scale:.96}
.bt-ng-chip[aria-checked=true]{background:var(--bt-active);border-color:var(--bt-line-2);color:var(--bt-ink)}
.bt-ng-chip .bt-admin-star{animation:bt-check-pop .4s cubic-bezier(.34,1.56,.64,1)}
.bt-ng-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.bt-ng,.bt-ng-step,.bt-ng-chip .bt-admin-star{animation:none}}
.bt-gs-member{gap:8px}
.bt-gs-who{flex:1;display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-gs-who .bt-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-gs-who:hover .bt-row-title{text-decoration:underline;text-underline-offset:2px}
.bt-gs-add{gap:8px;color:var(--bt-ink-2)}
.bt-face-person{cursor:default}
.bt-face-person:hover .bt-row-title{text-decoration:none}
.bt-face-person-text{display:flex;flex-direction:column;min-width:0}
.bt-face-bots{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-face-bot{padding:0;border:0;background:none;color:inherit;font:inherit}
button.bt-face-bot{cursor:pointer}
button.bt-face-bot:hover{color:var(--bt-ink);text-decoration:underline;text-underline-offset:2px}
.bt-gs-pick{gap:10px;animation:bt-rise .16s ease-out}
.bt-bs-stack .bt-seg{align-self:stretch}
@media (prefers-reduced-motion:reduce){.bt-gs-pick{animation:none}}
`
