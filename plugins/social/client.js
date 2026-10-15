// flybot-social browser half: plain JS, loaded by DSH as a classic script. Registers
// into the FlyBot slot registry that ds-bot's client renders (src/client/flybot-slots.js).
window.__ModuleLoader__.load({
  id: '@flybot/social',
  factory(require) {
    const { createElement: h, useEffect, useState, useRef } = require('react')
    const slots = () => {
      // Same bootstrap as ds-bot's flybot-registry.js: whichever bundle loads first creates it.
      if (globalThis.__flybot__ === undefined) throw new Error('flybot-social needs ds-bot with FlyBot slots')
      return globalThis.__flybot__.slots
    }
    const call = (endpoint, payload) => globalThis.__flybot__.call(endpoint, payload)

    // Errors in English. ds-bot's api.js may localize transport errors ("HTTP 404" becomes
    // Chinese in a zh UI), so the panel words them from the error code instead.
    const isSocialMissing = (e) => {
      const code = String(e?.code ?? '')
      const message = String(e?.message ?? e ?? '')
      return code === 'bot/not-found' || /Unknown FlyBot endpoint social\//i.test(message)
    }
    const errorText = (e) => {
      const code = String(e?.code ?? '')
      const http = code.match(/^HTTP_(\d+)$/)
      if (http) return `The FlyBot host did not answer (HTTP ${http[1]}). Reload the page; if this keeps happening, restart FlyBot web.`
      if (code === 'NETWORK') return 'Could not reach FlyBot. Check that it is still running.'
      if (isSocialMissing(e)) {
        return 'Social is not running: the plugin did not start. If a home handle was taken, change displayName in the flybot-social config and restart. Otherwise see Settings → Feedback.'
      }
      return String(e?.message ?? e)
    }

    // Styles reuse ds-bot's sidebar tokens (--bt-ink, --bt-ink-2, --bt-ink-3, --bt-hover, --bt-line,
    // --bt-line-2, --bt-card, --bt-accent, --bt-tag-bg/-ink), like @flybot/tree, so both themes follow the app.
    const CSS = `
.fs{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--bt-ink,#141414);padding:0 4px 6px;overflow:hidden;box-sizing:border-box;max-width:100%}
.fs *,.fs *::before,.fs *::after{box-sizing:border-box}
.fs-head{display:flex;align-items:center;gap:4px;padding:0 0 0 0}
.fs-head-main{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;line-height:16px;font-weight:500;text-align:left;cursor:pointer;transition:background-color .12s ease}
.fs-head-main:hover,.fs-icon:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-chev{display:inline-flex;width:12px;justify-content:center;color:var(--bt-ink-3,rgba(20,20,20,.36));transition:transform .12s ease}
.fs-head-main[aria-expanded=false] .fs-chev{transform:rotate(-90deg)}
.fs-title{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-count,.fs-tag{flex:none;font-size:11px;line-height:14px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.56));font-weight:500}
.fs-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.fs-icon[aria-expanded=true]{background:var(--bt-active,rgba(119,119,119,.17));color:var(--bt-ink,#141414)}
.fs-body{display:flex;flex-direction:column;gap:2px;padding:2px 0 0}
.fs-empty,.fs-hint{padding:4px 10px;font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:anywhere}
.fs-empty{padding:6px 10px 8px;font-size:13px;line-height:18px}
.fs-label{padding:8px 10px 2px;font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-3,rgba(20,20,20,.36));display:flex;align-items:center;gap:6px}
.fs-home-head{display:flex;align-items:center;gap:4px;min-width:0;padding:2px 4px 0 0}
.fs-home{display:flex;align-items:baseline;gap:6px;flex:1 1 auto;min-width:0;padding:4px 8px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:left;cursor:pointer}
.fs-home:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-home .fs-chev[data-closed]{transform:rotate(-90deg)}
.fs-home-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-home-handle{font-weight:400;color:var(--bt-ink-3,rgba(20,20,20,.36));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-auto{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));cursor:pointer;white-space:nowrap}
.fs-auto input{margin:0;accent-color:var(--bt-accent,#4d6bfe)}
.bt-social-rows{display:flex;flex-direction:column}
.fs-row{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 8px 5px 10px;border-radius:8px;transition:background-color .12s ease}
.fs-row:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;font-weight:600;overflow:hidden}
.fs-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.fs-face-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px}
.fs-face-mark .bt-mark{width:24px;height:24px}
.fs-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
.fs-name{font-size:14px;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-sub{font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-msg{white-space:normal;overflow-wrap:anywhere}
.fs-actions{flex:none;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
.fs-card{margin:4px 4px 2px;padding:10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:8px}
.fs-card .fs-hint{padding:0}
.fs-line{display:flex;gap:6px;min-width:0;align-items:center}
.fs-input{flex:1 1 auto;min-width:0;width:0;height:30px;padding:0 9px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;outline:none;text-overflow:ellipsis}
.fs-input:focus{border-color:var(--bt-accent,#4d6bfe)}
.fs-input[readonly]{background:var(--bt-tag-bg,rgba(20,20,20,.06));border-color:transparent}
.fs-btn{flex:none;height:30px;padding:0 12px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:var(--bt-ink,#141414);font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease}
.fs-btn:hover:not(:disabled){background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-btn:disabled{opacity:.45;cursor:default}
.fs-btn-primary{border-color:transparent;background:var(--bt-accent,#4d6bfe);color:#fff;width:100%}
.fs-btn-primary:hover:not(:disabled){background:var(--bt-accent,#4d6bfe);filter:brightness(1.08)}
.fs-btn-sm{height:26px;padding:0 9px;font-size:12px}
.fs-link{padding:0;border:0;background:none;color:var(--bt-accent,#4d6bfe);font:inherit;font-size:12px;cursor:pointer}
.fs-link:hover{text-decoration:underline}
.fs-status{padding:0;font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:anywhere}
.fs-status[data-tone=error]{color:#e5484d}
.fs-pending-tag{background:var(--bt-accent,#4d6bfe);color:#fff}
.fs-refresh{flex:none;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-weight:400}
.fs-pending{margin:4px 4px 6px;padding:8px 10px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:6px}
.fs-pending .fs-label{padding:0}
.fs-draft{font-size:13px;line-height:18px;color:var(--bt-ink,#141414);white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto}
.fs-digits{flex:1 1 auto;min-width:0;width:0;height:30px;padding:0 9px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:16px;letter-spacing:.24em;font-variant-numeric:tabular-nums;outline:none;text-align:center}
.fs-digits:focus{border-color:var(--bt-accent,#4d6bfe)}
.fs-face{margin:4px 4px 6px;padding:8px 10px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:6px}
.fs-face-members{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.fs-face-members li{font-size:13px;line-height:18px;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-face-actions{display:flex;gap:6px;flex-wrap:wrap}
.fs-face-auto-wrap{display:flex;flex-direction:column;gap:2px;padding:2px 0}
.fs-face-auto{white-space:normal;font-size:13px;line-height:18px;color:var(--bt-ink,#141414);align-items:flex-start}
.fs-face-auto input{margin-top:2px}
.fs-face-note{padding:0}
.fs-row-wrap{position:relative;display:flex;align-items:center;gap:2px;min-width:0}
.fs-row-wrap .fs-row,.fs-row-wrap > :first-child{flex:1 1 auto;min-width:0}
.fs-remove{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3,rgba(20,20,20,.36));font:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:0}
.fs-row-wrap:hover .fs-remove,.fs-row-wrap:focus-within .fs-remove,.fs-remove:focus-visible,.fs-remove:disabled{opacity:1}
.fs-remove:hover:not(:disabled),.fs-remove:focus-visible{background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414)}
.fs-remove:disabled{cursor:default;opacity:.55}
.fs-menu{position:absolute;right:4px;top:100%;z-index:5;min-width:160px;padding:4px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:var(--bt-card,#fff);box-shadow:0 4px 16px rgba(0,0,0,.12)}
.fs-menu button{display:block;width:100%;text-align:left;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.fs-menu button:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-chat-approval{margin:4px 0 8px}
.fs-dialog-back{position:fixed;inset:0;z-index:40;background:rgba(20,20,20,.4);display:flex;align-items:center;justify-content:center;padding:12px}
.fs-dialog{width:min(420px,100%);max-height:min(640px,92vh);overflow:auto;margin:0;padding:14px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:14px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.fs-dialog-head{display:flex;align-items:center;gap:8px}
.fs-dialog-head .fs-name{flex:1 1 auto}
.fs-pick{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}
.fs-pick li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}
.fs-pick li:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-pick label{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;cursor:pointer;font:inherit}
.fs-wait-roster{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto}
.fs-wait-roster li{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:8px}
.fs-fail{padding:0}
`
    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById('flybot-social-css')) return
        const style = document.createElement('style')
        style.id = 'flybot-social-css'
        style.textContent = CSS
        document.head.appendChild(style)
      }, [])
    }
    const initial = name => (String(name ?? '?').replace(/^@/, '').trim()[0] ?? '?').toUpperCase()

    // Same FNV-1a as core lookOf, so a missing host BotMark still paints a stable per-Bot
    // color (never the shared gray letter badge) and two ids do not collide.
    const FACE_INKS = ['#e5484d', '#e54666', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#5b5bd6', '#8e4ec6']
    function inkOf(seed) {
      const text = String(seed ?? '')
      let value = 2166136261
      for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
      return FACE_INKS[(value >>> 0) % FACE_INKS.length]
    }
    function faceSeed(bot) {
      const handle = typeof bot?.remote?.handle === 'string' && bot.remote.handle.trim()
        ? bot.remote.handle
        : typeof bot?.handle === 'string' && bot.handle.trim() && bot.remote
          ? bot.handle
          : ''
      if (handle) return `remote:${handle.trim().replace(/^@+/, '').toLowerCase()}`
      if (bot?.id !== undefined) return String(bot.id)
      if (typeof bot?.handle === 'string' && bot.handle.trim()) return `remote:${bot.handle.trim().replace(/^@+/, '').toLowerCase()}`
      return String(bot?.name ?? '')
    }
    function rosterBot(roster, id) {
      if (!id) return undefined
      return roster?.byId?.[id] ?? (roster?.bots ?? []).find(bot => bot.id === id)
    }
    function chatByHandle(remoteChats, handle) {
      if (!handle) return undefined
      return (remoteChats ?? []).find(chat => chat.remote?.handle === handle)
    }
    // Local picker rows use the team roster record (configured image / shape / color).
    // Waiting-room "mine" matches the same local Bot; a friend's Bot uses its chat
    // record or a handle-seeded remote look, plus any avatar the member payload carries.
    function faceLook({ roster, remoteChats, bots, local, member } = {}) {
      if (local) {
        const full = rosterBot(roster, local.id)
        return full ? { ...local, ...full } : local
      }
      if (!member) return undefined
      const mine = (bots ?? []).find(bot => bot.handle && bot.handle === member.handle)
      if (mine) return faceLook({ roster, bots, local: mine })
      const extra = {}
      if (member.color) extra.color = member.color
      if (member.avatar) extra.avatar = member.avatar
      const chat = chatByHandle(remoteChats, member.handle)
      if (chat) {
        return {
          ...chat,
          name: member.displayName || chat.name,
          remote: chat.remote ?? { handle: member.handle },
          ...extra,
        }
      }
      return {
        id: member.botId || member.handle,
        name: member.displayName || member.label || member.handle,
        handle: member.handle,
        remote: member.handle ? { handle: member.handle } : undefined,
        ...extra,
      }
    }
    function FaceAvatar({ bot, size = 24 } = {}) {
      const Avatar = globalThis.__flybot__?.BotAvatar
      const Mark = globalThis.__flybot__?.BotMark
      const seed = faceSeed(bot)
      const color = typeof bot?.color === 'string' && bot.color.startsWith('#') ? bot.color : inkOf(seed)
      let inner
      if (typeof Avatar === 'function' && bot) inner = h(Avatar, { bot, size, badge: false, live: false })
      else if (typeof Mark === 'function' && bot) inner = h(Mark, { bot, size })
      else {
        const image = bot?.avatar?.image
        const emoji = bot?.avatar?.emoji
        inner = h('span', {
          className: 'fs-avatar',
          'data-color': color,
          style: image ? undefined : { background: color, color: '#fff' },
        }, image ? h('img', { src: image, alt: '' }) : (emoji || initial(bot?.name)))
      }
      return h('span', {
        className: 'fs-face-mark',
        'data-flybot': 'face-avatar',
        'data-bot-id': bot?.id,
        'data-handle': bot?.remote?.handle || bot?.handle,
        'data-color': color,
        'aria-hidden': true,
      }, inner)
    }

    const AUTO_SEND_NOTE = 'When this is on, your Bots post in face-to-face rooms without asking each time.'

    function FaceAutoSend({ on, busy, onChange, error } = {}) {
      return h('div', { className: 'fs-face-auto-wrap', 'data-flybot': 'face-auto-send' },
        h('label', { className: 'fs-auto fs-face-auto', title: AUTO_SEND_NOTE },
          h('input', {
            type: 'checkbox',
            checked: on === true,
            disabled: !!busy,
            'aria-label': "Auto-send my Bot's room messages",
            onChange: e => onChange?.(e.target.checked),
          }),
          "Auto-send my Bot's room messages"),
        h('div', { className: 'fs-hint fs-face-note' }, AUTO_SEND_NOTE),
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function FaceAutoSendControl() {
      const [on, setOn] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => {
        call('social/status', {}).then(value => setOn(value?.autoApproveFaceRooms === true), () => {})
      }, [])
      const toggle = async (next) => {
        setBusy(true)
        setError('')
        try {
          const result = await call('social/face-auto', { on: next })
          setOn(result?.autoApproveFaceRooms === true)
        } catch (e) { setError(errorText(e)) }
        finally { setBusy(false) }
      }
      return h(FaceAutoSend, { on, busy, onChange: toggle, error })
    }

    // Outbound drafts Bot Social is holding: badge + Approve / Reject. Inbound does not wait.
    function PendingApprovals({ items, busy, onDecide }) {
      const hasFace = items?.some(item => item.kind === 'face_room_message')
      const [autoSend, setAutoSend] = useState(false)
      const [autoBusy, setAutoBusy] = useState(false)
      const [autoError, setAutoError] = useState('')
      useEffect(() => {
        if (!hasFace) return undefined
        call('social/status', {}).then(value => setAutoSend(value?.autoApproveFaceRooms === true), () => {})
        return undefined
      }, [hasFace])
      if (!items?.length) return null
      const setAuto = async (next) => {
        setAutoBusy(true)
        setAutoError('')
        try {
          const result = await call('social/face-auto', { on: next })
          const on = result?.autoApproveFaceRooms === true
          setAutoSend(on)
          return on
        } catch (e) {
          setAutoError(errorText(e))
          return autoSend
        } finally { setAutoBusy(false) }
      }
      const locked = !!busy || autoBusy
      return h('div', { className: 'fs-pending', 'data-flybot': 'pending-approvals', role: 'region', 'aria-label': 'Messages waiting for your approval' },
        h('div', { className: 'fs-label' }, 'Waiting for your approval', h('span', { className: 'fs-count' }, String(items.length))),
        h('div', { className: 'fs-hint' }, hasFace
          ? (autoSend
            ? 'Auto-send is on: new room messages go out without asking. Drafts already here still need Approve or Reject.'
            : 'These room messages stay here until you Approve or Reject them. They are not sent until you approve.')
          : 'A friend already sees their own message. These replies stay here until you Approve or Reject them. Turn on Auto-accept for that friend to skip the hold next time.'),
        hasFace ? h(FaceAutoSend, { on: autoSend, busy: locked, onChange: setAuto, error: autoError }) : null,
        hasFace && !autoSend ? h('div', { className: 'fs-face-actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', 'data-flybot': 'face-auto-send-on', disabled: locked, onClick: () => setAuto(true) }, 'Turn on auto-send')) : null,
        items.map(item => h('div', { key: item.id, className: 'fs-row', 'data-flybot': 'pending-item' },
          h('span', { className: 'fs-avatar', 'aria-hidden': true }, initial(item.from ?? item.toName ?? item.to)),
          h('span', { className: 'fs-text' },
            h('span', { className: 'fs-name' }, item.from ? `${item.from} → ${item.toName || item.to || 'friend'}` : (item.toName || item.to || 'Outbound reply')),
            item.text ? h('span', { className: 'fs-draft' }, item.text) : (item.summary ? h('span', { className: 'fs-sub fs-msg' }, item.summary) : null),
            item.attachments?.length ? h('span', { className: 'fs-sub' }, item.attachments.map(file => file.name).join(', ')) : null),
          h('span', { className: 'fs-actions' },
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy === item.id || autoBusy, onClick: () => onDecide(item, 'approve') }, 'Approve'),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy === item.id || autoBusy, onClick: () => onDecide(item, 'reject') }, 'Reject'),
            hasFace && item.kind === 'face_room_message' && !autoSend
              ? h('button', {
                type: 'button',
                className: 'fs-btn fs-btn-sm',
                'data-flybot': 'face-approve-auto',
                disabled: busy === item.id || autoBusy,
                onClick: async () => { await setAuto(true); onDecide(item, 'approve') },
              }, 'Approve and always auto-send in this room')
              : null))))
    }

    const STOP_JOIN = /6-digit|no longer valid|Too many (failed )?attempts|signed you out/i
    function shouldStopJoin(e) {
      const code = String(e?.code ?? '')
      if (['invalid_code', 'code_void', 'locked_out', 'unauthorized', 'rate_limited'].includes(code)) return true
      return STOP_JOIN.test(String(e?.message ?? e ?? ''))
    }
    function memberIsMine(member, bots, room) {
      if (member?.remote === false) return true
      const handle = String(member?.handle ?? '')
      if (!handle) return false
      if ((room?.mineHandles ?? []).includes(handle)) return true
      return (bots ?? []).some(bot => bot.handle === handle)
    }

    // Separate Face-to-face group screen (#92): pick Bots, join by number, live waiting room.
    function FaceToFaceGroup({ actions, onClose, roster, remoteChats } = {}) {
      const [step, setStep] = useState('setup')
      const [bots, setBots] = useState([])
      const [selected, setSelected] = useState([])
      const [code, setCode] = useState('')
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)
      const [failures, setFailures] = useState([])
      const [room, setRoom] = useState(null)
      const [tick, setTick] = useState(0)
      const opened = useRef(false)
      useEffect(() => {
        call('social/status', {}).then(value => {
          const list = value?.bots ?? []
          setBots(list)
          setSelected(current => {
            if (current.length) return current
            const main = list.find(bot => bot.isMain) ?? list[0]
            return main ? [main.id] : []
          })
        }, () => {})
      }, [])
      useEffect(() => {
        if (step !== 'waiting' || !(room?.faceRoomId || room?.roomId)) return undefined
        const faceId = room.faceRoomId
        const localId = room.roomId
        const load = () => call('social/face-rooms', { poll: true }).then(value => {
          const list = Array.isArray(value?.rooms) ? value.rooms : []
          const next = list.find(item => (faceId && item.faceRoomId === faceId) || (localId && item.roomId === localId))
          if (next) setRoom(current => current ? { ...current, ...next } : next)
        }, () => {})
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 2000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [step, room?.faceRoomId, room?.roomId])
      useEffect(() => {
        if (step !== 'waiting' || room?.status !== 'candidate' || !room?.expiresAt) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => setTick(n => n + 1), 1000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [step, room?.status, room?.expiresAt])
      useEffect(() => {
        if (step !== 'waiting' || room?.status !== 'open' || opened.current) return undefined
        const id = room.roomId
        if (!id || typeof actions?.openSession !== 'function') return undefined
        opened.current = true
        actions.openSession(id)
        onClose?.()
        return undefined
      }, [step, room?.status, room?.roomId])
      const join = async (event) => {
        event?.preventDefault?.()
        const digits = String(code).replace(/\D/g, '').slice(0, 6)
        if (digits.length !== 6) {
          setStatus({ tone: 'error', text: 'Enter a 6-digit number.' })
          return
        }
        if (!selected.length) {
          setStatus({ tone: 'error', text: 'Choose which of your Bots join.' })
          return
        }
        setBusy(true)
        setStatus(null)
        setFailures([])
        const mine = []
        const failed = []
        let last
        for (const botId of selected) {
          const bot = bots.find(item => item.id === botId)
          try {
            const result = await call('social/face-join', { code: digits, botId })
            last = result
            if (result?.joinedAs?.handle) mine.push(result.joinedAs.handle)
          } catch (e) {
            failed.push({ botId, name: bot?.name || 'Bot', text: errorText(e) })
            if (shouldStopJoin(e) && !last) {
              setStatus({ tone: 'error', text: errorText(e) })
              setFailures(failed)
              setBusy(false)
              return
            }
            if (shouldStopJoin(e)) break
          }
        }
        setFailures(failed)
        if (!last) {
          setStatus({ tone: 'error', text: failed[0]?.text || 'Could not join that room. Try another number.' })
          setBusy(false)
          return
        }
        setRoom({ ...last, mineHandles: mine })
        setStep('waiting')
        setBusy(false)
      }
      const enter = async () => {
        if (!room || opened.current) return
        setBusy(true)
        setStatus(null)
        try {
          let next = room
          if (room.status === 'candidate') {
            next = await call('social/face-start', { roomId: room.roomId, faceRoomId: room.faceRoomId })
            setRoom(current => current ? { ...current, ...next, status: 'open' } : { ...next, status: 'open' })
          }
          const id = next?.roomId || room.roomId
          opened.current = true
          if (id && typeof actions?.openSession === 'function') actions.openSession(id)
          onClose?.()
        } catch (e) {
          setStatus({ tone: 'error', text: errorText(e) })
        } finally { setBusy(false) }
      }
      const leave = async () => {
        setBusy(true)
        setStatus(null)
        try {
          if (room?.faceRoomId || room?.roomId) {
            await call('social/face-leave', { roomId: room.roomId, faceRoomId: room.faceRoomId })
          }
          onClose?.()
        } catch (e) {
          setStatus({ tone: 'error', text: errorText(e) })
        } finally { setBusy(false) }
      }
      const toggle = (id) => {
        setSelected(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id])
      }
      const members = room?.members ?? []
      const candidate = room?.status === 'candidate'
      const waiting = step === 'waiting' && room
      return h('div', { className: 'fs-dialog-back', 'data-flybot': 'face-group', role: 'dialog', 'aria-label': 'Face-to-face group' },
        h('div', { className: 'fs-dialog' },
          h('div', { className: 'fs-dialog-head' },
            h('div', { className: 'fs-name' }, 'Face-to-face group'),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', onClick: () => onClose?.() }, 'Close')),
          waiting ? h('div', { 'data-flybot': 'face-wait' },
            h('div', { className: 'fs-hint', 'data-tick': tick }, candidate
              ? (room.expiresAt ? countdown(room.expiresAt) : 'Matching window open. Anyone with the number can still join.')
              : 'The room is open. The number is no longer valid.'),
            h('ul', { className: 'fs-wait-roster', 'aria-label': 'Who has joined' },
              members.map(member => {
                const mine = memberIsMine(member, bots, room)
                return h('li', { key: member.handle || member.id, 'data-flybot': 'face-member', 'data-mine': mine || undefined, 'data-handle': member.handle },
                  h(FaceAvatar, { bot: faceLook({ roster, remoteChats, bots, member }) }),
                  h('span', { className: 'fs-text' },
                    h('span', { className: 'fs-name' }, member.displayName || member.label || member.handle),
                    member.ownerName ? h('span', { className: 'fs-sub' }, member.ownerName) : null),
                  mine ? h('span', { className: 'fs-tag', 'data-flybot': 'face-mine' }, 'mine') : null)
              })),
            members.length === 0 ? h('div', { className: 'fs-hint' }, 'Waiting for others to join…') : null,
            failures.length ? h('div', { className: 'fs-status', 'data-tone': 'error', 'data-flybot': 'face-join-fail', role: 'status' },
              failures.map(item => `${item.name}: ${item.text}`).join(' ')) : null,
            status ? h('div', { className: 'fs-status', 'data-tone': status.tone, role: 'status' }, status.text) : null,
            h('div', { className: 'fs-face-actions' },
              h('button', {
                type: 'button', className: 'fs-btn fs-btn-primary', 'data-flybot': 'face-enter',
                disabled: !!busy || !room.roomId, onClick: enter,
              }, 'Enter chat'),
              h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'face-leave', disabled: !!busy, onClick: leave }, 'Leave'))) : h('form', { onSubmit: join, 'data-flybot': 'face-join' },
            h('div', { className: 'fs-hint' }, 'Choose which of your Bots to bring, then type the same 6-digit number as the people next to you. You join at once — there is no preview.'),
            h('ul', { className: 'fs-pick', 'data-flybot': 'face-pick', 'aria-label': 'Your Bots' },
              bots.map(bot => h('li', { key: bot.id },
                h('label', null,
                  h('input', {
                    type: 'checkbox', checked: selected.includes(bot.id),
                    'aria-label': bot.name,
                    onChange: () => toggle(bot.id),
                  }),
                  h(FaceAvatar, { bot: faceLook({ roster, local: bot }) }),
                  h('span', { className: 'fs-text' },
                    h('span', { className: 'fs-name' }, bot.name),
                    bot.isMain ? h('span', { className: 'fs-sub' }, 'Main Bot') : null))))),
            bots.length === 0 ? h('div', { className: 'fs-hint' }, 'Loading your Bots…') : null,
            h('div', { className: 'fs-hint', 'data-flybot': 'face-join-room' },
              'Available to this room only. Friends cannot see these Bots unless you invite them.'),
            h('div', { className: 'fs-line' },
              h('input', {
                className: 'fs-digits', value: code, inputMode: 'numeric', autoComplete: 'off', maxLength: 6,
                placeholder: '000000', 'aria-label': '6-digit room number',
                onChange: e => setCode(String(e.target.value).replace(/\D/g, '').slice(0, 6)),
              }),
              h('button', {
                type: 'submit', className: 'fs-btn',
                disabled: busy || String(code).replace(/\D/g, '').length !== 6 || !selected.length,
              }, 'Join')),
            failures.length ? h('div', { className: 'fs-status fs-fail', 'data-tone': 'error', 'data-flybot': 'face-join-fail', role: 'status' },
              failures.map(item => `${item.name}: ${item.text}`).join(' ')) : null,
            status ? h('div', { className: 'fs-status', role: 'status', 'data-tone': status.tone }, status.text) : null)))
    }

    function FaceRoomCard({ room, actions, onChange, autoSend, autoBusy, autoError, onAutoSend }) {
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const run = async (label, fn) => {
        setBusy(label)
        setNote(null)
        try {
          await fn()
          onChange?.()
        } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      const members = room.members ?? []
      const candidate = room.status === 'candidate'
      return h('div', { className: 'fs-face', 'data-flybot': 'face-room', 'data-status': room.status },
        h('div', { className: 'fs-name' }, room.name || 'Face-to-face room'),
        candidate && room.expiresAt ? h('div', { className: 'fs-sub' }, countdown(room.expiresAt)) : h('div', { className: 'fs-sub' }, 'The number is no longer valid.'),
        h('ul', { className: 'fs-face-members', 'aria-label': 'Members' },
          members.map(m => h('li', { key: m.handle || m.id }, m.label || m.displayName || m.handle))),
        h(FaceAutoSend, { on: autoSend, busy: autoBusy, onChange: onAutoSend, error: autoError }),
        h('div', { className: 'fs-face-actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => { if (room.roomId) actions?.openSession?.(room.roomId) } }, 'Open'),
          candidate ? h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => run('start', () => call('social/face-start', { roomId: room.roomId, faceRoomId: room.faceRoomId })) }, 'Start chat') : null,
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => run('leave', () => call('social/face-leave', { roomId: room.roomId, faceRoomId: room.faceRoomId })) }, 'Leave')),
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    const WAITING_OWNER = 'Waiting for approval'
    const WAITING_OTHERS = "Waiting for the owner's approval"

    function ChatApproval({ item, canDecide = true, busy, onDecide, autoSend, onAutoSend, autoBusy, autoError } = {}) {
      if (!item) return null
      if (canDecide !== true) {
        return h('div', { className: 'fs-pending fs-chat-approval', 'data-flybot': 'chat-approval', 'data-role': 'other', role: 'status' },
          h('div', { className: 'fs-name' }, WAITING_OTHERS))
      }
      const locked = !!busy || autoBusy
      return h('div', { className: 'fs-pending fs-chat-approval', 'data-flybot': 'chat-approval', 'data-role': 'owner', role: 'region', 'aria-label': WAITING_OWNER },
        h('div', { className: 'fs-label' }, WAITING_OWNER),
        item.from ? h('div', { className: 'fs-sub' }, `${item.from} → ${item.toName || item.to || 'friend'}`) : null,
        item.text ? h('div', { className: 'fs-draft' }, item.text) : (item.summary ? h('div', { className: 'fs-sub fs-msg' }, item.summary) : null),
        h('label', { className: 'fs-auto', title: 'Skip the hold on later messages from this Bot.', 'data-flybot': 'chat-auto-send' },
          h('input', {
            type: 'checkbox',
            checked: autoSend === true,
            disabled: locked,
            'aria-label': 'Auto-send',
            onChange: e => onAutoSend?.(e.target.checked),
          }),
          'Auto-send'),
        autoError ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, autoError) : null,
        h('div', { className: 'fs-actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: locked, onClick: () => onDecide?.(item, 'approve') }, 'Approve'),
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: locked, onClick: () => onDecide?.(item, 'reject') }, 'Reject')))
    }

    function approvalsForOpenChat(items, { sessionId, room, bot } = {}) {
      const list = Array.isArray(items) ? items : []
      const handle = bot?.remote?.handle
      const faceId = room?.face?.roomId
      const handles = new Set((room?.participants ?? []).map(p => p.handle).filter(Boolean))
      if (handle) handles.add(handle)
      return list.filter(item => {
        if (faceId && item.roomId === faceId) return true
        if (room?.id && item.roomId === room.id) return true
        if (item.to && handles.has(item.to)) return true
        if (sessionId && item.sessionId === sessionId) return true
        return false
      })
    }

    function ChatApprovalDock({ sessionId, roster, room, bot } = {}) {
      useStyles()
      const [items, setItems] = useState([])
      const [busy, setBusy] = useState('')
      const [autoSend, setAutoSend] = useState(false)
      const [autoBusy, setAutoBusy] = useState(false)
      const [autoError, setAutoError] = useState('')
      const load = () => call('social/status', {}).then(value => {
        setItems(Array.isArray(value?.approvals) ? value.approvals : [])
        if (typeof value?.autoApproveFaceRooms === 'boolean') setAutoSend(value.autoApproveFaceRooms)
      }, () => {})
      useEffect(() => {
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 5000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [])
      const mine = approvalsForOpenChat(items, { sessionId, roster, room, bot })
      if (!mine.length) return null
      const decide = async (item, decision) => {
        setBusy(item.id)
        try {
          await call('social/decide-approval', { approvalId: item.id, decision })
          await load()
        } finally { setBusy('') }
      }
      const toggle = async (next) => {
        setAutoBusy(true)
        setAutoError('')
        try {
          const first = mine[0]
          if (first?.kind === 'face_room_message') {
            const result = await call('social/face-auto', { on: next })
            setAutoSend(result?.autoApproveFaceRooms === true)
          } else if (first?.to) {
            const home = String(first.to).replace(/^@[^.]+\./, '@')
            await call('social/auto-accept', { home, on: next })
            setAutoSend(next === true)
          }
        } catch (e) { setAutoError(errorText(e)) }
        finally { setAutoBusy(false) }
      }
      return h('div', { 'data-flybot': 'chat-approvals' },
        mine.map(item => h(ChatApproval, {
          key: item.id, item, canDecide: true, busy: busy === item.id, onDecide: decide,
          autoSend, onAutoSend: toggle, autoBusy, autoError,
        })))
    }

    function FriendBotRow({ bot, chat, renderBot, busy, onRemove }) {
      const [menu, setMenu] = useState(false)
      const label = busy ? 'Removing…' : 'Remove this Bot'
      return h('div', {
        className: 'fs-row-wrap',
        'data-flybot': 'friend-bot',
        'data-handle': bot.handle,
        onContextMenu: (event) => { event?.preventDefault?.(); setMenu(true) },
      },
        chat && typeof renderBot === 'function'
          ? renderBot(chat)
          : h('div', { className: 'fs-hint', title: bot.handle }, `${bot.name} · opening its chat…`),
        h('button', {
          type: 'button',
          className: 'fs-remove',
          'data-flybot': 'remove-friend-bot',
          title: 'Remove this Bot from Friends\' Bots and from your groups. This does not unfriend the owner.',
          'aria-label': label,
          'aria-busy': busy || undefined,
          disabled: !!busy,
          onClick: (event) => { event?.stopPropagation?.(); onRemove?.(bot) },
        }, busy ? '…' : '×'),
        menu ? h('div', { className: 'fs-menu', role: 'menu', 'data-flybot': 'friend-bot-menu' },
          h('button', { type: 'button', role: 'menuitem', onClick: () => { setMenu(false); onRemove?.(bot) } }, 'Remove this Bot')) : null)
    }

    function countdown(expiresAt) {
      const at = Date.parse(expiresAt)
      if (!Number.isFinite(at)) return 'Matching window open'
      const left = Math.max(0, at - Date.now())
      if (left <= 0) return 'The matching window has ended'
      const minutes = Math.ceil(left / 60_000)
      if (minutes >= 2) return `${minutes} minutes left to join`
      const seconds = Math.max(1, Math.ceil(left / 1000))
      return seconds === 1 ? '1 second left to join' : `${seconds} seconds left to join`
    }

    function FaceRooms({ actions, enabled = true } = {}) {
      const [rooms, setRooms] = useState([])
      const [autoSend, setAutoSend] = useState(false)
      const [autoBusy, setAutoBusy] = useState(false)
      const [autoError, setAutoError] = useState('')
      const candidate = rooms.some(room => room.status === 'candidate')
      const load = (poll) => call('social/face-rooms', { poll }).then(value => {
        setRooms(Array.isArray(value?.rooms) ? value.rooms : [])
        if (typeof value?.autoApproveFaceRooms === 'boolean') setAutoSend(value.autoApproveFaceRooms)
      }, () => {})
      useEffect(() => {
        if (!enabled) return undefined
        load(false)
        if (typeof setInterval !== 'function') return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          load(candidate)
        }
        const timer = setInterval(tick, candidate ? 5000 : 30_000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [enabled, candidate])
      const toggle = async (next) => {
        setAutoBusy(true)
        setAutoError('')
        try {
          const result = await call('social/face-auto', { on: next })
          setAutoSend(result?.autoApproveFaceRooms === true)
        } catch (e) { setAutoError(errorText(e)) }
        finally { setAutoBusy(false) }
      }
      if (!rooms.length) return null
      return h('div', { 'data-flybot': 'face-rooms' },
        h('div', { className: 'fs-label' }, 'Face-to-face rooms'),
        rooms.map(room => h(FaceRoomCard, {
          key: room.faceRoomId || room.roomId, room, actions, onChange: load,
          autoSend, autoBusy, autoError, onAutoSend: toggle,
        })))
    }

    function FaceRoomOverview({ room } = {}) {
      useStyles()
      const face = room?.origin === 'face-to-face' ? room.face : undefined
      if (room?.origin !== 'face-to-face') return null
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const [tick, setTick] = useState(0)
      useEffect(() => {
        if (face?.status !== 'candidate' || !face?.expiresAt) return undefined
        const timer = setInterval(() => setTick(n => n + 1), 1000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [face?.status, face?.expiresAt])
      const run = async (label, fn) => {
        setBusy(label)
        setNote(null)
        try { await fn() } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      const candidate = face?.status === 'candidate'
      return h('div', { className: 'fs-face', 'data-flybot': 'face-overview' },
        h('div', { className: 'fs-hint', 'data-tick': tick }, candidate
          ? (face?.expiresAt ? countdown(face.expiresAt) : 'Matching window open. Anyone with the number can still join.')
          : 'This room is open. The number is no longer valid.'),
        h(FaceAutoSendControl),
        h('div', { className: 'fs-face-actions' },
          candidate ? h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => run('start', () => call('social/face-start', { roomId: room.id, faceRoomId: face?.roomId })) }, 'Start chat') : null,
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => run('leave', () => call('social/face-leave', { roomId: room.id, faceRoomId: face?.roomId })) }, 'Leave')),
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    const ROSTER_CACHE_KEY = 'flybot-social-remote-bots'
    function readCachedRoster() {
      try {
        const raw = globalThis.sessionStorage?.getItem?.(ROSTER_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && Array.isArray(parsed.homes) ? parsed : null
      } catch { return null }
    }
    function writeCachedRoster(value) {
      try { globalThis.sessionStorage?.setItem?.(ROSTER_CACHE_KEY, JSON.stringify({ homes: value?.homes ?? [] })) } catch {}
    }

    let faceOpenHandler = null
    let pendingFaceOpen = false
    function openFaceToFace() {
      if (faceOpenHandler) faceOpenHandler()
      else pendingFaceOpen = true
    }
    function bindFaceOpen(fn) {
      faceOpenHandler = fn
      if (pendingFaceOpen) { pendingFaceOpen = false; fn() }
      return () => { if (faceOpenHandler === fn) faceOpenHandler = null }
    }

    function FriendsBots({ renderBot, remoteChats, actions, roster } = {}) {
      useStyles()
      const [data, setData] = useState(() => readCachedRoster())
      const [error, setError] = useState('')
      const [open, setOpen] = useState(true)
      const [adding, setAdding] = useState(false)
      const [closed, setClosed] = useState({})
      const [auto, setAuto] = useState({})
      const [saving, setSaving] = useState('')
      const [pending, setPending] = useState([])
      const [hiding, setHiding] = useState(() => new Set())
      const [faceOpen, setFaceOpen] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const openRef = useRef(open)
      openRef.current = open
      const load = () => call('social/remote-bots', { fresh: true }).then(value => {
        setData(value)
        writeCachedRoster(value)
        setError('')
      }, e => setError(errorText(e)))
      const loadSettings = () => call('social/settings', {}).then(value => setAuto(value?.autoAccept ?? {}), () => {})
      const loadApprovals = () => call('social/status', {}).then(value => {
        const items = Array.isArray(value?.approvals) ? value.approvals : []
        setPending(items)
        if (items.length) setOpen(true)
      }, () => {})
      const loadAll = () => {
        setRefreshing(true)
        return Promise.all([load(), loadSettings(), loadApprovals()]).finally(() => setRefreshing(false))
      }
      useEffect(() => {
        loadAll()
        if (typeof setInterval !== 'function') return undefined
        const tick = () => {
          if (!openRef.current) return
          if (typeof document !== 'undefined' && document.hidden) return
          loadApprovals()
        }
        const timer = setInterval(tick, 15_000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [])
      useEffect(() => bindFaceOpen(() => { setFaceOpen(true); setOpen(true) }), [])
      const homes = data?.homes ?? []
      const count = homes.reduce((n, entry) => n + entry.bots.length, 0)
      const chats = remoteChats ?? []
      const unavailable = error.startsWith('Social is not running:')
      const toggleAuto = async (home, on) => {
        setSaving(home)
        try { const r = await call('social/auto-accept', { home, on }); setAuto(value => ({ ...value, [home]: r.autoAccept })) } catch (e) { setError(errorText(e)) } finally { setSaving('') }
      }
      const decide = async (item, decision) => {
        setSaving(item.id)
        try {
          await call('social/decide-approval', { approvalId: item.id, decision })
          await loadApprovals()
        } catch (e) { setError(errorText(e)) } finally { setSaving('') }
      }
      const markHiding = (handle, on) => {
        setHiding(current => {
          const next = new Set(current)
          if (on) next.add(handle)
          else next.delete(handle)
          return next
        })
      }
      const removeBot = async (bot) => {
        markHiding(bot.handle, true)
        try {
          const result = await call('social/hide-remote', { handle: bot.handle })
          if (result?.homes) setData(result)
          if (typeof actions?.updateRoom === 'function') {
            void Promise.all((actions.roster?.rooms ?? []).flatMap(room => {
              const hit = (room.participants ?? []).find(p => p.remote && p.handle === bot.handle && p.leftSeq === undefined)
              return hit ? [actions.updateRoom(room.id, { removeParticipants: [{ kind: 'bot', id: hit.handle || hit.id, remote: true }] })] : []
            })).catch(e => setError(errorText(e)))
          }
        } catch (e) { setError(errorText(e)) } finally { markHiding(bot.handle, false) }
      }
      const openPending = () => {
        const first = pending[0]
        if (!first) return
        const chat = chats.find(entry => entry.remote?.handle === first.to)
        if (chat && typeof actions?.openSession === 'function') actions.openSession(chat.sessionId || chat.id)
        else if (first.roomId && typeof actions?.openSession === 'function') actions.openSession(first.roomId)
        setOpen(true)
      }
      return h('section', { className: 'fs bt-social', 'aria-label': 'Friends\' Bots' },
        h('div', { className: 'fs-head' },
          h('button', { type: 'button', className: 'fs-head-main', 'aria-expanded': open, onClick: () => setOpen(!open) },
            h('span', { className: 'fs-chev', 'aria-hidden': true }, '▾'),
            h('span', { className: 'fs-title' }, 'Friends\' Bots'),
            data ? h('span', { className: 'fs-count', title: `${count} ${count === 1 ? 'Bot' : 'Bots'}` }, String(count)) : null),
          pending.length ? h('button', { type: 'button', className: 'fs-tag fs-pending-tag', 'data-flybot': 'pending-badge', title: `${pending.length} outbound ${pending.length === 1 ? 'reply' : 'replies'} waiting for your approval. Opens that chat.`, onClick: openPending }, `${pending.length} to approve`) : null,
          refreshing ? h('span', { className: 'fs-refresh', 'data-flybot': 'roster-refreshing' }, 'Refreshing…') : null,
          unavailable ? null : h('button', { type: 'button', className: 'fs-icon', 'aria-expanded': adding, title: 'Add a friend', onClick: () => { setAdding(!adding); setOpen(true) } }, adding ? 'Done' : '+ Add')),
        open ? h('div', { className: 'fs-body' },
          h(PendingApprovals, { items: pending, busy: saving, onDecide: decide }),
          unavailable ? null : h(FaceRooms, { actions, enabled: open }),
          adding && !unavailable ? h('div', { className: 'fs-card', 'data-flybot': 'face-group-entry' },
            h('button', { type: 'button', className: 'fs-btn fs-btn-primary', 'data-flybot': 'face-group-open', onClick: () => setFaceOpen(true) }, 'Face-to-face group'),
            h('div', { className: 'fs-hint' }, 'Meet the people next to you. Pick your Bots and type the same 6-digit number.')) : null,
          adding && !unavailable ? h(AddFriend, { onChange: () => load().then(loadSettings) }) : null,
          faceOpen && !unavailable ? h(FaceToFaceGroup, { actions, roster, remoteChats, onClose: () => setFaceOpen(false) }) : null,
          unavailable ? h('div', { className: 'fs-empty', 'data-flybot': 'social-unavailable' }, error) : error ? h('div', { className: 'fs-status', 'data-tone': 'error', style: { padding: '4px 10px' } }, error) : null,
          homes.map(entry => {
            const shut = closed[entry.home] === true
            const rows = entry.bots.map(bot => ({ bot, chat: chats.find(chat => chat.remote?.handle === bot.handle) }))
            return h('div', { key: entry.home, className: 'bt-social-home', 'data-home': entry.home },
              h('div', { className: 'fs-home-head' },
                h('button', { type: 'button', className: 'fs-home', 'aria-expanded': !shut, title: entry.owner ? `${entry.home} · owned by ${entry.owner}` : entry.home, onClick: () => setClosed(value => ({ ...value, [entry.home]: !shut })) },
                  h('span', { className: 'fs-chev', 'aria-hidden': true, 'data-closed': shut || undefined }, '▾'),
                  h('span', { className: 'fs-home-name' }, entry.name ?? entry.home),
                  entry.name ? h('span', { className: 'fs-home-handle' }, entry.home) : null),
                h('label', { className: 'fs-auto', title: 'Auto-accept: messages with this friend go through without your approval. Off: what your Bots send on their own waits for you.' },
                  h('input', { type: 'checkbox', checked: auto[entry.home] !== false, disabled: saving === entry.home, onChange: e => toggleAuto(entry.home, e.target.checked) }),
                  'Auto-accept')),
              shut ? null : entry.bots.length === 0 ? h('div', { className: 'fs-hint' }, 'No Bots shared yet') : null,
              shut ? null : h('div', { className: 'bt-social-rows' }, rows.map(({ bot, chat }) => h(FriendBotRow, {
                key: bot.handle, bot, chat, renderBot, busy: hiding instanceof Set ? hiding.has(bot.handle) : hiding === bot.handle, onRemove: removeBot,
              }))))
          }),
          data && homes.length === 0 && !adding
            ? h('div', { className: 'fs-empty' }, 'No friends yet. Right-click one of your Bots and choose ', h('b', null, 'Copy invite link'), ' (or ', h('b', null, 'Copy invite with instructions'), '), or use ', h('b', null, '+ Add'), ' to join a friend\'s invite.')
            : null) : null)
    }

    // Add friend: join a friend's link and answer requests (invites are made from a Bot's right-click menu).
    function AddFriend({ onChange }) {
      const [overview, setOverview] = useState(null)
      const [code, setCode] = useState('')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      // Which of my Bots joins: the friend sees and reaches only that one (default: the Main Bot).
      const [mine, setMine] = useState([])
      const [joiner, setJoiner] = useState('')
      const refresh = () => call('social/overview', {}).then(setOverview, e => setStatus({ tone: 'error', text: errorText(e) }))
      useEffect(() => {
        refresh()
        call('social/status', {}).then(value => {
          const bots = value?.bots ?? []
          setMine(bots)
          setJoiner(current => current || (bots.find(bot => bot.isMain) ?? bots[0])?.id || '')
        }, () => {})
      }, [])
      const run = async (label, fn) => {
        setBusy(true)
        setStatus(null)
        try {
          const message = await fn()
          if (message) setStatus({ tone: 'ok', text: message })
          await refresh()
          onChange?.()
        } catch (e) {
          setStatus({ tone: 'error', text: `${label} failed: ${errorText(e)}` })
        } finally {
          setBusy(false)
        }
      }
      const join = e => {
        e.preventDefault()
        return run('Joining', async () => {
          const r = await call('social/join-invite', { code, ...(joiner ? { botId: joiner } : {}) })
          setCode('')
          const as = r.joinedAs ? ` as ${r.joinedAs.botName}` : ''
          return r.status === 'active' ? `You are now friends with ${r.inviterName ?? r.inviter}${as}.` : `Request sent to ${r.inviterName ?? r.inviter}${as}. They show up here once they accept.`
        })
      }
      const respond = (item, decision) => run(decision === 'accept' ? 'Accepting' : 'Declining', async () => {
        await call('social/respond', { relationshipId: item.relationshipId, decision })
        return decision === 'accept' ? `${item.name ?? item.handle} is now a friend.` : `Declined ${item.name ?? item.handle}.`
      })
      const incoming = overview?.incoming ?? []
      const outgoing = overview?.outgoing ?? []
      return h('div', { className: 'bt-social-add', 'data-flybot': 'add-friend' },
        h('div', { className: 'fs-hint', 'data-flybot': 'invite-hint' }, 'To invite a friend to one of your Bots, right-click it in the Bot list and choose ', h('b', null, 'Copy invite link'), ' for the bare link, or ', h('b', null, 'Copy invite with instructions'), ' for the link with how to join.'),
        h('form', { onSubmit: join, className: 'fs-card bt-social-join' },
          h('div', { className: 'fs-hint' }, 'Got a link from a friend?'),
          h('div', { className: 'fs-line' },
            h('input', { className: 'fs-input', value: code, placeholder: 'Paste invite link or code', 'aria-label': 'Invite link or code', onChange: e => setCode(e.target.value) }),
            h('button', { type: 'submit', className: 'fs-btn', disabled: busy || !code.trim() }, 'Join')),
          mine.length > 1 ? h('label', { className: 'fs-line fs-hint', 'data-flybot': 'join-as' }, 'Join as ',
            h('select', { className: 'fs-input', value: joiner, 'aria-label': 'Which of your Bots joins', onChange: e => setJoiner(e.target.value) },
              mine.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
            ' (your friend sees only this Bot)') : null),
        status ? h('div', { className: 'fs-status', role: 'status', 'data-tone': status.tone, style: { padding: '2px 10px' } }, status.text) : null,
        incoming.length ? h('div', { className: 'bt-social-requests' },
          h('div', { className: 'fs-label' }, 'Friend requests', h('span', { className: 'fs-count' }, String(incoming.length))),
          incoming.map(item => h('div', { key: item.relationshipId, className: 'fs-row bt-social-row' },
            h('span', { className: 'fs-avatar', 'aria-hidden': true }, initial(item.name ?? item.handle)),
            h('span', { className: 'fs-text' },
              h('span', { className: 'fs-name' }, item.name ?? item.handle),
              h('span', { className: 'fs-sub' }, item.handle),
              item.message ? h('span', { className: 'fs-sub fs-msg' }, item.message) : null),
            h('span', { className: 'fs-actions' },
              h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy, onClick: () => respond(item, 'accept') }, 'Accept'),
              h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy, onClick: () => respond(item, 'decline') }, 'Decline'))))) : null,
        outgoing.length ? h('div', { className: 'bt-social-outgoing' },
          h('div', { className: 'fs-label' }, 'Waiting for them to accept'),
          outgoing.map(item => h('div', { key: item.relationshipId ?? item.handle, className: 'fs-row' },
            h('span', { className: 'fs-avatar', 'aria-hidden': true }, initial(item.name ?? item.handle)),
            h('span', { className: 'fs-text' },
              h('span', { className: 'fs-name' }, item.name ?? item.handle),
              item.name ? h('span', { className: 'fs-sub' }, item.handle) : null),
            h('span', { className: 'fs-tag' }, 'pending')))) : null)
    }

    // Which local Bots can be invited to (social/status), cached for the synchronous canInvite.
    let status = { at: 0, value: null }
    let statusTask
    const statusListeners = new Set()
    const loadStatus = () => {
      statusTask ??= call('social/status', {}).then(value => {
        const changed = JSON.stringify(value) !== JSON.stringify(status.value)
        status = { at: Date.now(), value }
        if (changed) for (const fn of [...statusListeners]) { try { fn() } catch (error) { console.error('flybot-social: status listener failed', error) } }
        return value
      }).finally(() => { statusTask = undefined })
      return statusTask
    }
    // Fires when what canInvite answers may have changed (first status, connect/disconnect, Bots added).
    const onStatusChange = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn) }
    // Sync: true when Bot Social is connected and botId is one of this team's Bots. Until the first
    // status answer it is false (and starts loading); the cache refreshes every 30 s.
    function canInvite(botId) {
      if (Date.now() - status.at > 30_000) void loadStatus().catch(() => {})
      return Boolean(status.value?.connected && status.value.bots.some(bot => bot.id === botId))
    }

    const ACCESS_NOTE = 'Each grant is this Bot to one person. Accepting Invite to this Bot creates a grant. Revoke one person without touching the others. Default: nobody, including for the Chief.'
    function ManageAccess({ bot }) {
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const load = async () => {
        if (!bot?.id) return
        try {
          setView(await call('social/access', { botId: bot.id }))
          setError('')
        } catch (e) { setError(errorText(e)) }
      }
      useEffect(() => { void load() }, [bot?.id])
      if (!bot?.id) return null
      const revoke = async (grant) => {
        setBusy(grant.id)
        setError('')
        try {
          setView(await call('social/revoke-grant', { botId: bot.id, grantId: grant.id, relationshipId: grant.relationshipId, grantee: grant.grantee }))
          const next = await call('social/access', { botId: bot.id })
          setView(next)
        } catch (e) { setError(errorText(e)) }
        finally { setBusy('') }
      }
      const grants = view?.grants ?? []
      return h('div', { className: 'fs fs-card', 'data-flybot': 'manage-access' },
        h('div', { className: 'fs-name' }, 'Manage access'),
        h('div', { className: 'fs-hint fs-face-note' }, ACCESS_NOTE),
        grants.length === 0 ? h('div', { className: 'fs-hint' }, 'Nobody has this Bot yet. Invite a friend to grant it.') : null,
        grants.map(grant => h('div', { key: grant.id || grant.grantee, className: 'fs-line', 'data-flybot': 'access-grant' },
          h('div', { className: 'fs-col' },
            h('span', { className: 'fs-name' }, grant.name || grant.grantee),
            h('span', { className: 'fs-sub' }, grant.grantee),
            (grant.rooms ?? []).length ? h('span', { className: 'fs-hint' }, `In use: ${(grant.rooms ?? []).map(room => room.name || room.id).join(', ')}`) : null),
          h('button', {
            type: 'button', className: 'fs-btn', disabled: Boolean(busy),
            'data-flybot': 'revoke-grant', 'aria-label': `Revoke ${grant.name || grant.grantee}`,
            onClick: () => revoke(grant),
          }, busy === grant.id ? 'Revoking…' : 'Revoke'))),
        (view?.rooms ?? []).filter(room => room.origin === 'face-to-face').length
          ? h('div', { className: 'fs-hint' }, `This room only: ${(view.rooms ?? []).filter(room => room.origin === 'face-to-face').map(room => room.name || room.id).join(', ')}`)
          : null,
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function BotSocialDetails({ bot }) {
      useStyles()
      return h('div', { 'data-flybot': 'bot-social-details' },
        h(InviteToBot, { bot }),
        h(ManageAccess, { bot }))
    }

    // In a Bot's settings: invite a friend to this Bot.
    function InviteToBot({ bot }) {
      useStyles()
      const [invite, setInvite] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      if (!bot?.id) return null
      const create = async () => {
        setBusy(true); setNote(null)
        try { setInvite(await call('social/create-invite', { botId: bot.id })) } catch (e) { setNote({ tone: 'error', text: errorText(e) }) } finally { setBusy(false) }
      }
      // Called straight from the click, so the clipboard write keeps its permission.
      const copy = text => {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip?.writeText) clip.writeText(text).then(() => setNote({ tone: 'ok', text: 'Copied.' }), () => setNote({ tone: 'error', text: 'Could not copy. Select the link and copy it by hand.' }))
      }
      return h('div', { className: 'fs fs-card', 'data-flybot': 'invite-to-bot' },
        h('div', { className: 'fs-hint' }, `Invite a friend to ${bot.name}. Accepting the invite grants them ${bot.name} only. You can revoke that grant later.`),
        h('button', { type: 'button', className: 'fs-btn', disabled: busy, onClick: create }, invite ? 'Create another invite link' : 'Invite to this Bot'),
        invite ? h('div', { className: 'fs-line' },
          h('input', { className: 'fs-input', readOnly: true, value: invite.link, 'aria-label': 'Invite link', onFocus: e => e.target.select() }),
          h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'copy-link', onClick: () => copy(invite.link) }, 'Copy link'),
          h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'copy-invite-text', onClick: () => copy(invite.text) }, 'Copy invite with instructions')) : null,
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    let cache = { at: 0, list: [] }
    const friendRows = async (query) => {
      if (Date.now() - cache.at > 30_000) cache = { at: Date.now(), list: await call('social/friends', {}) }
      const needle = query.trim().toLowerCase().replace(/^@/, '')
      return cache.list
        .filter(friend => friend.handle.includes(needle) || String(friend.name).toLowerCase().includes(needle))
        // The inserted text asks the Bot to use message_friend_bot; the send is held for approval.
        .map(friend => ({ name: `${friend.name} · remote`, description: `${friend.handle} · ${friend.home}`, section: 'Friends\' Bots', value: `${friend.handle} ` }))
    }

    return {
      name: 'flybot-social',
      inject: [],
      errorText,
      canInvite,
      InviteToBot,
      ManageAccess,
      BotSocialDetails,
      PendingApprovals,
      ChatApproval,
      ChatApprovalDock,
      FriendBotRow,
      FaceToFaceGroup,
      FaceAvatar,
      FaceRoomOverview,
      FaceAutoSend,
      apply(ctx) {
        let offs = []
        let tries = 0
        // ds-bot's client creates the registry in its apply; wait for it if this loads first.
        const attach = () => {
          if (globalThis.__flybot__ === undefined) {
            if (++tries < 100) timer = setTimeout(attach, 100)
            else console.error('flybot-social: ds-bot FlyBot slots not found')
            return
          }
          offs = [
            slots().register('flybot.sidebar.section', { id: 'social', order: 100, component: FriendsBots }),
            slots().register('flybot.new-chat.action', {
              id: 'social-face-group',
              order: 15,
              label: 'Face-to-face group',
              hint: 'Meet the people next to you. Pick your Bots and type the same 6-digit number.',
              run: ({ close } = {}) => { openFaceToFace(); close?.() },
            }),
            slots().register('flybot.composer.mention', { id: 'social', order: 100, candidates: friendRows }),
            slots().register('flybot.bot.details', { id: 'social-invite', order: 100, component: BotSocialDetails }),
            slots().register('flybot.room.overview', { id: 'social-face', order: 50, component: FaceRoomOverview }),
            slots().register('flybot.session.dock', { id: 'social-approval', order: 50, component: ChatApprovalDock }),
          ]
          // For other plugins (the tree's per-node "Copy invite link"): ctx.flybot.social.canInvite(botId)
          // is synchronous; flybot.call('social.createInvite', { botId }) returns { link, text, ... }.
          const social = { canInvite, onChange: onStatusChange, createInvite: botId => call('social.createInvite', { botId }), openFaceToFace }
          globalThis.__flybot__.social = social
          if (globalThis.__flybot__.api) globalThis.__flybot__.api.social = social
          offs.push(() => {
            if (globalThis.__flybot__?.social === social) delete globalThis.__flybot__.social
            if (globalThis.__flybot__?.api?.social === social) delete globalThis.__flybot__.api.social
          })
          void loadStatus().catch(() => {})
          // Keep canInvite current (and onChange firing) without callers polling.
          if (typeof setInterval === 'function') {
            const statusTimer = setInterval(() => { void loadStatus().catch(() => {}) }, 30_000)
            statusTimer?.unref?.() // node tests: never keeps the process alive
            offs.push(() => clearInterval(statusTimer))
          }
        }
        let timer
        attach()
        const dispose = () => {
          clearTimeout(timer)
          for (const off of offs.splice(0)) off()
        }
        ctx?.effect?.(() => dispose, 'flybot-social: slots')
        return dispose
      },
    }
  },
})
