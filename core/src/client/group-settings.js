import { createElement as h, useEffect, useState } from 'react'
import { isMainOf } from './sources.js'
import { PlusIcon, ChevronRightIcon, SearchIcon } from './icons.js'
import { AdminStar, BotAvatar, BotMark, PersonMark, RoomAvatar, lookAvoidingLocals, lookBotForRemote, lookKey, lookOf } from './mark.js'
import { setLocalBots } from './characters.js'
import { Card, Row, InlineText, SwitchRow } from './bot-settings.js'
import { Segmented } from './motion.js'
import { lockedWindow } from './schedules.js'
import { FolderMenu } from './folder-menu.js'
import { hostText, t } from './i18n.js'
import { StandingApprovalsCard } from './standing-approvals.js'
import { FlyBotRoomMembers } from './flybot-slots.js'
import { listedChatBots, pickerBotLabel, remoteBotName, remoteBotTitle, splitRoomPicks } from '../shared/remote-label.js'
import { canCreateGroup, groupMemberMatches } from '../shared/group-create.js'

export const ROOM_MODES = [
  ['admin', 'Admin leads', 'Plain messages go to the admin, who calls others with @Name.'],
  ['everyone', 'Everyone', 'Every member answers in turn, admin first.'],
]

// Without an admin the host answers as everyone, whatever the stored mode says.
export const shownMode = (room, roster) => (roster.byId[room.admin] ? room.mode : 'everyone')

// faceSeats, faceSeatLabel and facePeople live in face-seats.js so the chat bubble can name a mention the same way.
import { faceSeats, faceSeatLabel, facePeople, facePersonLabel } from './face-seats.js'

export { faceSeats, faceSeatLabel, facePeople }
export { setLocalBots, lookKey }

// The Bot a member row draws. A local seat is the roster record the sidebar uses. A friend's
// seat is the chat record, with the face-room look winning, the same way a transcript mark is
// chosen. Two homes named SelfA… and SelfB… share an initial; the row must not.
export function faceSeatBot(seat, roster) {
  if (!seat) return undefined
  const record = seat.record && typeof seat.record === 'object' ? seat.record : {}
  const extra = {}
  if (typeof record.color === 'string' && record.color) extra.color = record.color
  if (record.avatar && typeof record.avatar === 'object') extra.avatar = record.avatar
  if (seat.local && !seat.local.remote) return Object.keys(extra).length ? { ...seat.local, ...extra } : seat.local
  const handle = typeof record.handle === 'string' && record.handle.trim()
    ? record.handle
    : (typeof seat.key === 'string' && seat.key.startsWith('@') ? seat.key : '')
  return lookBotForRemote({
    handle,
    displayName: record.displayName || seat.bot,
    name: seat.bot,
    label: record.label,
    id: record.id || seat.key,
    ...extra,
  }, roster)
}

// The picture BotMark paints for that Bot: a friend's look steps off a same-named local Bot.
export function faceMemberLook(bot) {
  if (!bot) return undefined
  return bot.remote ? lookAvoidingLocals(bot) : lookOf(bot)
}

function faceMarks(person, roster, size) {
  const marks = []
  for (const seat of person?.seats ?? []) {
    const bot = faceSeatBot(seat, roster)
    if (!bot) continue
    marks.push(h(BotMark, { key: seat.key, bot, size, live: false }))
  }
  // No seat to draw is the silhouette, never an empty disc (#1089).
  if (marks.length === 0) return [h(PersonMark, { key: 'person', size, name: person?.name })]
  return marks
}

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
export function FacePersonRow({ person, onOpenBot, lead, roster, className = 'bt-set-row bt-bs-row bt-gs-member', size = 26 }) {
  const bots = person.seats.flatMap((seat, index) => {
    const name = seat.local && onOpenBot
      ? h('button', { key: seat.key, type: 'button', className: 'bt-face-bot', title: t("Open {name}'s chat", { name: seat.bot }), onClick: () => onOpenBot(seat.local.id) }, seat.bot)
      : h('span', { key: seat.key, className: 'bt-face-bot', title: seat.record?.handle || undefined }, seat.bot)
    const marked = isLeadSeat(seat, lead) ? [name, h('span', { key: `${seat.key}-lead`, className: 'bt-tag', 'data-flybot': 'face-lead-tag' }, t('Lead'))] : [name]
    return index === 0 ? marked : [h('span', { key: `${seat.key}-sep` }, t(', ')), ...marked]
  })
  return h('div', { className, role: 'listitem', 'data-flybot': 'face-person', 'data-mine': person.mine || undefined },
    h('span', { className: 'bt-gs-who bt-face-person' },
      h('span', { className: 'bt-face-marks', 'data-flybot': 'face-person-avatars' }, faceMarks(person, roster, size)),
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
  // `social/face-lead` is not registered `{ read: true }` (`plugins/social/src/social.js`), so a
  // read-only window refuses it — and the room's creator still arrives with `canPick: true`, because
  // the host knows who created the room, not that this window cannot write. The card reads the window
  // too: the lead's name and its sentence stay, the button and its picker go, and so does the
  // "only the person who created this room" hint, since nobody in this window can change the lead.
  const locked = lockedWindow(roster)
  const canPick = !locked && lead.canPick === true && typeof pick === 'function'
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
    canPick || locked || !lead.supported ? null : h('div', { className: 'bt-set-hint' }, t('Only the person who created this room can change it.')),
    error ? h('div', { className: 'bt-set-hint', role: 'alert' }, error) : null)
}

// Humans, this home's Bots, and remote Bots still seated. The same people the Members card lists.
export function seatedCount(room) {
  const live = room?.presentedParticipants ?? room?.participants ?? []
  const humans = live.filter(p => p.kind === 'human' && p.leftSeq === undefined).length
  const remotes = live.filter(p => p.remote && p.leftSeq === undefined).length
  return humans + remotes + (room?.members?.length ?? 0)
}

export function roomSubtitle(room, roster) {
  if (room.origin === 'face-to-face') return faceRoomCount(room, roster)
  const admin = roster.byId[room.admin]
  const count = seatedCount(room)
  return [t(count === 1 ? '{count} member' : '{count} members', { count }), admin ? t('Admin {name}', { name: admin.name }) : t('No admin')].join(' · ')
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
  const modeLabel = ROOM_MODES.find(([id]) => id === mode)?.[1] ?? 'Everyone'
  // Every control here writes `update-room` or `delete-room`, which the host refuses in a
  // read-only window; the form then keeps the group's facts as text (#2474).
  if (lockedWindow(roster)) {
    return h('div', { className: 'bt-bs' },
      h('div', { className: 'bt-bs-hero' },
        h(RoomAvatar, { room, roster, size: 64 }),
        h('div', { className: 'bt-bs-who' },
          h('span', { className: 'bt-bs-name' }, room.name),
          h('span', { className: 'bt-bs-sub' }, roomSubtitle(room, roster)))),
      h(Card, { title: t('Members · {count}', { count: face ? people.length : members.length + humans.length + remotes.length }) },
        face
          // A face-to-face room names each person's Bots under them, the way the writable
          // window does; without `onOpenBot` the row is text and offers no control (#2492).
          ? people.map(person => h(FacePersonRow, { key: person.key, person, roster, lead: room.face?.lead?.handle }))
          : [
              // The stored name, cleaned by the same reader the friend's-Bot rows use (#2474).
              humans.map(person => h(Row, { key: person.id, label: remoteBotName(person, person.id), hint: t('Human') })),
              members.map(member => h(Row, {
                key: member.id,
                label: member.name,
                hint: [room.admin === member.id ? t('Admin') : '', room.taskLead === member.id ? t('Task lead') : ''].filter(Boolean).join(' · ') || t('Bot'),
              })),
              remotes.map(person => h(Row, { key: person.handle || person.id, label: person.label || remoteBotTitle(person), hint: t("Friend's Bot") })),
            ]),
      // Both facts are reads (`shownMode` and `room.workDir`), so a locked page keeps them as
      // text for every group, the way a face-to-face room already did (#2492).
      h(Card, { title: t('Who answers') }, h(Row, { label: t(modeLabel), hint: t(modeHint) })),
      h(Card, { title: t('Working folder') }, h(Row, { label: t('Folder'), hint: room.workDir || t('Not set') })),
      room.notice ? h(Card, { title: t('Notice') }, h(Row, { label: t('Group notice'), hint: room.notice, stack: true })) : null)
  }
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
      people.map(person => h(FacePersonRow, { key: person.key, person, roster, onOpenBot: openBot, lead: room.face?.lead?.handle }))) : null,
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
        const boardHere = room.origin !== 'face-to-face' && room.origin !== 'inbound-share'
        const taskLead = room.taskLead === member.id
        return h('div', { key: member.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
          h('button', { type: 'button', className: 'bt-gs-who', title: t("Open {name}'s chat", { name: member.name }), onClick: () => openBot(member.id) },
            h(BotAvatar, { bot: member, size: 26, main: isMainOf(roster, member.id), admin: leads, live: false }),
            h('span', { className: 'bt-row-title' }, member.name),
            leads ? h('span', { className: 'bt-tag' }, t('Admin')) : null,
            taskLead ? h('span', { className: 'bt-tag' }, t('Task lead')) : null,
            (roster.humans ?? []).some(person => person.designatedChiefId === member.id) ? h('span', { className: 'bt-tag' }, t('Chief')) : null),
          leads
            ? h('button', { type: 'button', className: 'bt-mini', title: t('Leave the group without an admin'), onClick: () => update({ admin: null }) }, t('Unset'))
            : h('button', { type: 'button', className: 'bt-mini', onClick: () => update({ admin: member.id }) }, t('Make admin')),
          boardHere ? (taskLead
            ? h('button', { type: 'button', className: 'bt-mini', onClick: () => update({ taskLead: null }) }, t('Use the admin'))
            : h('button', { type: 'button', className: 'bt-mini', onClick: () => update({ taskLead: member.id }) }, t('Make task lead'))) : null,
          members.length > 2 ? h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Remove {name} from the group', { name: member.name }), title: t('Remove from group'), onClick: () => update({ remove: [member.id] }) }, '×') : null)
      }),
      remotes.map((person) => h('div', { key: person.handle || person.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
        h('span', { className: 'bt-gs-who' },
          h(BotAvatar, { bot: lookBotForRemote(person, roster), size: 26, badge: false, live: false }),
          h('span', { className: 'bt-row-title', title: person.handle || undefined }, person.label || remoteBotTitle(person)),
          // #904: a host's roster entry is not a friend's Bot, and one this home cannot confirm is
          // labelled as such; a Bot with no Bot Social identity can never be written to at all.
          room.origin === 'face-to-face' ? null
            : h('span', { className: 'bt-tag' }, person.unconnected ? t('Not connected')
              : room.origin === 'inbound-share' && person.verified === false ? t('Unconfirmed')
                : t('Friend\'s Bot'))),
        // A guest's mirror is not theirs to edit: the host's membership is changed on the host side.
        room.origin === 'face-to-face' || room.origin === 'inbound-share' || members.length + remotes.length <= 2
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
        // The host's two-Bot floor guards membership changes; this hint warns before one.
        members.length + humans.length + remotes.length < 2 ? t('Add a Bot first: a group chat needs at least two.')
          : `${admin ? t('{name} leads this group: it can call members with @Name, change the group, and post here.', { name: admin.name })
            : t('No admin yet. An admin can call members with @Name, change the group, and post here.')}${room.origin === 'face-to-face' || room.origin === 'inbound-share' ? '' : ` ${t('The task lead divides the board. When unset, the admin does.')}`}`)),
      // #876: a plugin's rows for this room (Invite by link), only in a group that lives here. Last, after
      // the note on who leads, so that note stays with the members it is about (#892).
      room.origin === 'face-to-face' || room.origin === 'inbound-share' ? null : h(FlyBotRoomMembers, { room, roster, actions })),
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

// A new group chat from Settings: optional name, searchable member list, selected pane,
// and Create disabled until a local admin and one more member are picked.
export function NewGroupForm({ roster, actions, run, onCreated, onCancel }) {
  const [admin, setAdmin] = useState(null)
  const [members, setMembers] = useState([])
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  // A read-only window keeps the pickers as a preview and offers no create: the host could only
  // answer `bot/read-only` after the press (#2307's form, P-570).
  const locked = lockedWindow(roster)
  const bots = listedChatBots(roster)
  const selectedIds = admin === null ? members : [admin, ...members]
  const selected = selectedIds.map(id => roster.byId[id]).filter(Boolean)
  const available = bots.filter(bot => !selectedIds.includes(bot.id) && groupMemberMatches(bot, query))
  const ready = canCreateGroup(admin, members)
  const add = (bot) => {
    if (admin === null && !bot.remote) { setAdmin(bot.id); return }
    setMembers(list => list.includes(bot.id) ? list : [...list, bot.id])
  }
  const remove = (id) => {
    if (id === admin) {
      const nextAdmin = members.find(other => !roster.byId[other]?.remote) ?? null
      setAdmin(nextAdmin)
      setMembers(list => list.filter(item => item !== nextAdmin))
      return
    }
    setMembers(list => list.filter(item => item !== id))
  }
  const pickAdmin = (id) => {
    if (id === admin || roster.byId[id]?.remote) return
    setMembers(list => {
      const without = list.filter(item => item !== id)
      return admin === null ? without : [...without, admin]
    })
    setAdmin(id)
  }
  const create = async () => {
    if (locked || busy || !ready) return
    setBusy(true)
    let room
    const { members: localIds, remotes } = splitRoomPicks(roster, [admin, ...members])
    const participants = remotes.length === 0 ? undefined : [
      ...localIds.map(id => ({ kind: 'bot', id, role: id === admin ? 'admin' : 'member' })),
      ...remotes,
    ]
    const done = await run(actions.createRoom(localIds, {
      admin,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(participants ? { participants } : {}),
    }).then((value) => { room = value }))
    if (done && room) onCreated(room)
    else setBusy(false)
  }
  const pickRow = (bot, selectedRow) => h('button', {
    key: bot.id, type: 'button', className: selectedRow ? 'bt-ng-pick bt-ng-pick-on' : 'bt-ng-pick',
    'data-bot-id': bot.id,
    role: selectedRow ? (bot.id === admin ? 'radio' : 'checkbox') : 'option',
    'aria-checked': selectedRow ? true : undefined,
    onClick: () => { selectedRow ? remove(bot.id) : add(bot) },
  },
    h(BotAvatar, { bot, size: 22, badge: false, live: false }),
    h('span', { className: 'bt-ng-name' }, pickerBotLabel(bot)),
    selectedRow && bot.id === admin ? h(AdminStar) : null,
    selectedRow && bot.id !== admin && !bot.remote
      ? h('span', {
          className: 'bt-ng-make-admin', role: 'button', tabIndex: 0,
          'aria-label': t('Make admin'),
          onClick: (event) => { event.preventDefault(); event.stopPropagation(); pickAdmin(bot.id) },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); pickAdmin(bot.id) }
          },
        }, h(AdminStar))
      : null)
  const availHint = bots.every(bot => selectedIds.includes(bot.id))
    ? t('No more Bots to add')
    : t('No Bots match')
  return h('div', { className: 'bt-set-card bt-ng' },
    h('p', { className: 'bt-ng-intro' }, t('Add a name, then pick Bots to chat with.')),
    h('label', { className: 'bt-ng-name-row' },
      h('span', { className: 'bt-ng-name-label' }, t('Group name')),
      h('input', {
        className: 'bt-ng-name-input', value: name, maxLength: 60,
        placeholder: t('Group name (optional)'),
        'aria-label': t('Group name'),
        onChange: event => setName(event.target.value),
      })),
    h('div', { className: 'bt-ng-split' },
      h('div', { className: 'bt-ng-col' },
        h('label', { className: 'bt-ng-search' },
          h(SearchIcon),
          h('input', {
            className: 'bt-ng-search-input', type: 'search', value: query,
            placeholder: t('Search'), 'aria-label': t('Search members'),
            onChange: event => setQuery(event.target.value),
          })),
        available.length === 0
          ? h('div', { className: 'bt-ng-empty' }, availHint)
          : h('div', { className: 'bt-ng-list', role: 'listbox', 'aria-label': t('Members') },
              available.map(bot => pickRow(bot, false)))),
      h('div', { className: 'bt-ng-col' },
        h('div', { className: 'bt-ng-sel-head' }, t('Selected {count}', { count: selected.length })),
        selected.length === 0
          ? h('div', { className: 'bt-ng-empty' }, t('No members selected'))
          : h('div', { className: 'bt-ng-list', role: 'group', 'aria-label': t('Selected members') },
              selected.map(bot => pickRow(bot, true))))),
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      locked
        ? h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly))
        : h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || !ready, onClick: () => void create() }, t('Create group chat'))))
}

export const GROUP_SETTINGS_CSS = `
.bt-ng{padding:16px 16px 8px;animation:bt-q-in .4s cubic-bezier(.22,1,.36,1),bt-veil-in .2s ease-out}
.bt-ng-intro{margin:0 0 14px;color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-ng-name-row{display:flex;align-items:center;gap:12px;margin:0 0 12px}
.bt-ng-name-label{flex:none;min-width:4.5em;font-size:13px;color:var(--bt-ink)}
.bt-ng-name-input{flex:1;min-width:0;height:36px;box-sizing:border-box;padding:0 12px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;outline:none}
.bt-ng-name-input::placeholder{color:var(--bt-ink-3)}
.bt-ng-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;min-height:220px;margin:0 0 8px}
.bt-ng-col{display:flex;flex-direction:column;min-width:0;min-height:220px;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-main);overflow:hidden}
.bt-ng-search{display:flex;align-items:center;gap:8px;margin:8px;padding:0 10px;height:32px;border-radius:999px;background:var(--bt-card);border:.5px solid var(--bt-line-2);color:var(--bt-ink-2)}
.bt-ng-search svg{flex:none;width:14px;height:14px}
.bt-ng-search-input{flex:1;min-width:0;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:13px;outline:none}
.bt-ng-sel-head{display:flex;align-items:center;min-height:32px;margin:8px 12px 0;color:var(--bt-ink-2);font-size:13px}
.bt-ng-list{flex:1;overflow:auto;padding:4px 8px 8px;display:flex;flex-direction:column;gap:2px}
.bt-ng-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:16px;color:var(--bt-ink-3);font-size:13px;text-align:center}
.bt-ng-pick{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;color:inherit;font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;cursor:pointer;text-align:left}
.bt-ng-pick:hover{background:var(--bt-hover)}
.bt-ng-pick-on{background:var(--bt-card)}
.bt-ng-make-admin{display:inline-flex;margin-left:auto;padding:2px;border-radius:999px;color:var(--bt-ink-3)}
.bt-ng-make-admin:hover{color:var(--bt-ink);background:var(--bt-hover)}
.bt-ng-pick-on>.bt-admin-star{margin-left:auto}
.bt-ng-name{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ng-label{display:inline-flex;align-items:center;gap:6px}
.bt-ng-picks{display:flex;flex-wrap:wrap;gap:6px}
.bt-ng-chip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 5px;border-radius:999px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease,scale .3s cubic-bezier(.34,1.56,.64,1)}
.bt-ng-chip:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ng-chip:active{scale:.96}
.bt-ng-chip[aria-checked=true]{background:var(--bt-active);border-color:var(--bt-line-2);color:var(--bt-ink)}
.bt-ng-chip .bt-admin-star{animation:bt-check-pop .4s cubic-bezier(.34,1.56,.64,1)}
@media (prefers-reduced-motion:reduce){.bt-ng,.bt-ng-chip .bt-admin-star{animation:none}}
.bt-gs-member{gap:8px}
.bt-gs-who{flex:1;display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-gs-who .bt-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-gs-who:hover .bt-row-title{text-decoration:underline;text-underline-offset:2px}
.bt-gs-add{gap:8px;color:var(--bt-ink-2)}
.bt-face-marks{display:inline-flex;flex:none;align-items:center;gap:2px}
.bt-face-marks>.bt-mark{flex:none}
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
