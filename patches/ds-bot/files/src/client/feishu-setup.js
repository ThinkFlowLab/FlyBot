import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { t, hostText } from './i18n.js'
import { ownBots } from './connector-bots.js'
import { APP_ID, PRODUCTS, BASE_SCOPES, permissionJSON, setupSteps, publicAddress, scopeGranted, productAccess } from '../shared/feishu.js'

const button = (text, onClick, disabled = false, variant = '') => h('button', { type: 'button', className: `bt-soft bt-soft-sm bt-feishu-button ${variant}`, onClick, disabled }, t(text))
const hint = key => h('p', { className: 'bt-set-hint' }, t(key))
const field = (label, value, change, type = 'text', disabled = false) => h('label', { className: 'bt-feishu-field' }, h('span', {}, t(label)), h('input', { className: 'bt-input', type, value, disabled, autoComplete: type === 'password' ? 'new-password' : 'off', 'aria-label': t(label), onChange: e => change(e.target.value) }))

export function FeishuSetup({ actions, roster, onClose }) {
  const [apps, setApps] = useState([]), [members, setMembers] = useState([]), [selected, setSelected] = useState(''), [step, setStep] = useState(0)
  const [mode, setMode] = useState('socket'), [appId, setAppId] = useState(''), [secret, setSecret] = useState(''), [token, setToken] = useState(''), [url, setUrl] = useState(''), [name, setName] = useState('Feishu')
  const [botId, setBotId] = useState(''), [openId, setOpenId] = useState(''), [memberId, setMemberId] = useState(''), [extensions, setExtensions] = useState([]), [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null), [webhook, setWebhook] = useState('')
  const initial = useRef(true)
  const app = apps.find(a => a.id === selected), steps = setupSteps(mode), offset = mode === 'http' ? 1 : 0, n = step - offset
  const load = useCallback(async () => { const out = await actions.feishu({ operation: 'list' }); setApps(out.apps ?? []); setMembers(out.members ?? []); if (initial.current) { initial.current = false; const queryId = new URLSearchParams(window.location.search).get('feishu-app'); const saved = out.apps?.find(a => a.id === queryId) ?? out.apps?.[0]; if (saved) { setSelected(saved.id); setAppId(saved.id); setMode(saved.mode); setStep(saved.step ?? 0); setBotId(saved.botId ?? ''); setUrl(saved.publicUrl ?? ''); setName(saved.name ?? 'Feishu') } } }, [actions])
  useEffect(() => { void load().catch(e => setError(hostText(e.message))); const timer = setInterval(() => { void load().catch(() => {}) }, 3000); return () => clearInterval(timer) }, [load])
  const run = async fn => { setBusy(true); setError(''); try { const value = await fn(); await load(); return value } catch (e) { setError(hostText(e.message)); return undefined } finally { setBusy(false) } }
  const select = id => {
    const saved = apps.find(a => a.id === id)
    setSelected(id); setAppId(id); setMode(saved?.mode ?? 'socket'); setStep(saved?.step ?? 0); setBotId(saved?.botId ?? ''); setUrl(saved?.publicUrl ?? ''); setName(saved?.name ?? 'Feishu'); setSecret(''); setToken(''); setResult(null)
  }
  const advance = async target => {
    if (selected) await run(() => actions.feishu({ operation: 'configure', appId: selected, step: target, ...(botId ? { botId } : {}) }))
    setStep(target)
  }
  const save = () => void run(async () => {
    const out = await actions.feishu({ operation: 'save', appId, appSecret: secret, verificationToken: token, mode, publicUrl: url, name, step: offset + 2 })
    setApps(out.apps); setSelected(appId); setSecret(''); setToken(''); setResult(out.test); setStep(offset + (out.test?.credentialError ? 1 : 2))
  })
  const action = payload => void run(() => actions.feishu({ appId: selected, ...payload }))
  const copyPermissions = async event => {
    const section = event.currentTarget.closest('.bt-feishu-permissions')
    setError('')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(permissionJSON(extensions)); setCopied(true)
    } catch {
      const preview = section.querySelector('.bt-feishu-json'), textarea = preview.querySelector('textarea')
      preview.open = true; textarea.focus(); textarea.select()
      setCopied(false)
      setError(t('Clipboard is unavailable. Copy the selected JSON below.'))
    }
  }
  const permissionPicker = h('section', { className: 'bt-feishu-permissions' },
    h('div', { className: 'bt-feishu-section-head' }, h('strong', {}, t('Extended permissions (Feishu tools)')), h('span', { className: 'bt-feishu-optional' }, t('Optional tools'))),
    hint('Select the tools you need. The permission JSON updates automatically.'),
    h('div', { className: 'bt-feishu-permission-grid' }, PRODUCTS.map(p => h('label', { key: p.id, className: 'bt-feishu-permission', 'data-checked': extensions.includes(p.id) },
      h('input', { type: 'checkbox', checked: extensions.includes(p.id), onChange: e => { setExtensions(e.target.checked ? [...extensions, p.id] : extensions.filter(x => x !== p.id)); setCopied(false) } }), h('span', {}, t(p.label))))),
    h('div', { className: 'bt-feishu-permission-copy' }, button(copied ? 'Copied' : 'Copy permission JSON', copyPermissions),
      h('span', { className: 'bt-set-hint' }, t('Base permissions are always included.'))),
    h('details', { className: 'bt-feishu-json' }, h('summary', {}, t('View permission JSON')), h('textarea', { className: 'bt-input', readOnly: true, rows: 8, value: permissionJSON(extensions), 'aria-label': t('Copy permission JSON') })),
    hint('Import this JSON in Permission management → Batch import/export. Set the contact data scope to people who will use the robot.'))
  let content
  if (step === 0 && mode === 'http') content = h('div', {}, hint('Forward only the event port to a public HTTPS address. Do not expose the FlyBot console. Leave Encrypt Key empty.'), field('Public HTTPS event origin', url, setUrl))
  else if (n === 0) content = h('div', {}, hint('Create an internal app, add the Bot capability, and apply for the permissions below. Do not configure events yet.'),
    h('a', { className: 'bt-feishu-external', href: 'https://open.feishu.cn/app', target: '_blank', rel: 'noopener noreferrer' }, t('Open Feishu Open Platform'), h('span', { 'aria-hidden': true }, '↗')), permissionPicker)
  else if (n === 1) content = h('div', {}, hint('Credentials are encrypted on the platform and cannot be viewed after saving. Bots never receive them.'), hint('Leave saved credentials blank to keep them. Switching receiving methods reuses the same Feishu application and conversations.'),
    app?.mode === 'http' && mode === 'socket' ? hint('Switching to a long connection deletes the saved Verification Token.') : null,
    field('Connection name', name, setName),
    field('App ID', appId, setAppId, 'text', !!selected), field('App Secret', secret, setSecret, 'password'), mode === 'http' ? field('Verification Token', token, setToken, 'password') : null,
    appId && !APP_ID.test(appId) ? hint('App ID must be cli_ followed by 16 hexadecimal characters') : null,
    button('Save and test connection', save, busy || !APP_ID.test(appId) || !selected && !secret.trim() || mode === 'http' && (!publicAddress(url) || (!token && app?.mode !== 'http')), 'bt-feishu-primary'))
  else if (n === 2) content = h('div', {},
    mode === 'socket' ? h('div', {}, h('strong', {}, t('Connection to Feishu')), h('p', { role: 'status' }, t(app?.connection === 'ready' ? 'Connected' : app?.connection === 'error' ? 'Connection failed' : 'Connecting…')), hint('Refreshes every 3 seconds'),
      app?.connection === 'ready' ? hint('Now set Events and callbacks → Event configuration → Use long connection to receive events, then save.') : hint('Wait until connected: Feishu only allows saving the long connection subscription after FlyBot connects. Check credentials and network if it keeps waiting.'),
      hint('In Callback configuration, use the long connection and add Card action trigger (card.action.trigger).')) : h('div', {}, hint('In both Event configuration and Callback configuration, select Send to developer server, use the same address below, and save.'), h('code', {}, `${url.replace(/\/$/, '')}/api/feishu/events/${selected}`), hint(app?.verifiedAt ? 'Address verified' : 'Waiting for address verification')),
    hint('Add Receive message v2.0 (im.message.receive_v1).'), hint('Without card.action.trigger, cards can display but buttons and forms do not respond. Neither test connection nor connected status checks callback subscriptions.'), hint('Connect each Feishu app to only one FlyBot instance; multiple instances split incoming messages.'), hint(app?.lastEventAt ? 'Received an event' : 'No event received yet'))
  else if (n === 3) content = h('div', {}, hint('Create and publish a version in Version management and release. Include the required members or departments. Wait for enterprise approval if required.'), hint('Permissions, Bot capability, events and callbacks take effect after publishing. Publish again after any change.'), button('Test connection', () => void run(async () => { const out = await actions.feishu({ operation: 'test', appId: selected }); setResult(out) }), busy))
  else if (n === 4) content = h('div', {}, hint('One Feishu application represents one Bot. Group mentions and private messages go to the selected local Bot.'), h('select', { className: 'bt-input', 'aria-label': t('Choose a Bot'), value: botId, onChange: e => setBotId(e.target.value) }, h('option', { value: '' }, t('Choose a Bot')), ownBots(roster).filter(b => !b.projectAgent && !b.ephemeral).map(b => h('option', { key: b.id, value: b.id }, b.name))))
  else content = h('div', {}, hint('Add the application under Group settings → Group robots. Mention it in the group, or send a private message.'), hint('Ask the Bot to send a card with a submit button. Click it and confirm Submitted. Ordinary chat success does not verify card callbacks.'), hint('Each group or private chat keeps one FlyBot conversation; thread replies return to the original thread.'), h('ul', {}, (app?.recent ?? []).map(e => h('li', { key: e.id }, `${e.text ?? ''} · ${e.status}`))))
  const identity = h('details', {}, h('summary', {}, t('Identity linking')), hint('Link to an existing signed-in platform member. No external members or new login accounts are created. Unlinked card submissions and meeting bookings are refused.'), field('Feishu open_id', openId, setOpenId), h('select', { className: 'bt-input', value: memberId, 'aria-label': t('Platform member'), onChange: e => setMemberId(e.target.value) }, h('option', { value: '' }, t('Platform member')), members.map(m => h('option', { key: m.id, value: m.id }, m.name))), button('Link identity', () => action({ operation: 'identity', openId, ...(memberId ? { memberId } : {}) }), busy || !openId), h('ul', {}, (app?.identities ?? []).map(i => h('li', { key: i.openId }, `${i.openId} → ${i.memberId}`))))
  return h('section', { className: 'bt-feishu-setup', 'aria-label': t('Connect Feishu') },
    h('header', { className: 'bt-feishu-header' }, h('div', {}, h('h3', {}, t('Connect Feishu')), hint('Only Feishu (open.feishu.cn) is supported; Lark is not supported.')),
      apps.length ? h('select', { className: 'bt-input', value: selected, onChange: e => select(e.target.value), 'aria-label': t('Connect Feishu') }, h('option', { value: '' }, t('New connection')), apps.map(a => h('option', { key: a.id, value: a.id }, `${a.name} (${a.id})`))) : null),
    app?.linkOnly ? h('div', { className: 'bt-feishu-body' }, identity, button('Later', onClose, false, 'bt-feishu-quiet')) : h('div', { className: 'bt-feishu-body' },
      h('div', { className: 'bt-feishu-modes', role: 'group', 'aria-label': t('How to connect') }, ['socket', 'http'].map(m => h('button', {
        key: m, type: 'button', 'aria-pressed': mode === m, 'aria-label': t(m === 'socket' ? 'Long connection (recommended, no public address)' : 'Event address (HTTP, needs a public address)'),
        onClick: () => { setMode(m); setStep(m === 'http' ? 0 : selected ? 1 : 0) },
      }, h('strong', {}, t(m === 'socket' ? 'Long connection' : 'Event address')), h('small', {}, t(m === 'socket' ? 'Recommended · no public address' : 'Requires a public HTTPS address'))))),
      h('div', { className: 'bt-feishu-layout' },
        h('nav', { className: 'bt-feishu-progress', 'aria-label': t('Connection steps') }, h('ol', {}, steps.map((title, i) => h('li', { key: title }, h('button', {
          type: 'button', 'aria-label': t(title), 'aria-current': step === i ? 'step' : undefined, 'data-done': i < step, disabled: i > offset + 1 && !selected, onClick: () => setStep(i),
        }, h('span', { className: 'bt-feishu-step-number', 'aria-hidden': true }, i < step ? '✓' : i + 1), h('span', { className: 'bt-feishu-step-label' }, t(title))))))),
        h('div', { className: 'bt-feishu-step' }, h('div', { className: 'bt-feishu-step-heading' }, h('span', { className: 'bt-feishu-eyebrow' }, t('Step {current} of {total}', { current: step + 1, total: steps.length })), h('h4', {}, t(steps[step]))),
          h('div', { className: 'bt-feishu-step-content' }, content),
          result ? h('p', { className: 'bt-feishu-result', role: 'status', 'data-success': result.ok }, result.ok ? `${t('Connected')} ${result.bot ?? ''}` : hostText(result.error)) : null,
          h('footer', { className: 'bt-feishu-footer' }, button('Previous step', () => setStep(Math.max(0, step - 1)), step === 0 || busy),
            h('div', {}, button('Later', onClose, false, 'bt-feishu-quiet'), step < steps.length - 1 ? button('Next', () => void advance(step + 1), busy || n === 3 && !result?.ok || n === 1 && (!selected || app?.mode !== mode) || n === 4 && !botId || mode === 'http' && step === 0 && !publicAddress(url) || n > 1 && !selected, 'bt-feishu-primary') : button('Finish', onClose, false, 'bt-feishu-primary'))))),
      app ? h('div', { className: 'bt-feishu-management' }, h('details', {}, h('summary', {}, t('Who may send messages')), hint('Allowed senders can send messages; this does not grant platform identity or approval authority.'), h('label', { className: 'bt-feishu-check' }, h('input', { type: 'checkbox', checked: app.allowBots === true, onChange: e => action({ operation: 'configure', allowBots: e.target.checked }) }), t('Also process other robots that mention this robot (up to 8 consecutive requests)')), field('Allow an open_id', openId, setOpenId), button('Allow', () => action({ operation: 'allow', openId }), busy || !openId), (app.allowed ?? []).map(id => h('p', { key: id }, id, button('Block', () => action({ operation: 'allow', openId: id, enabled: false }), busy)))), identity,
        h('details', {}, h('summary', {}, t('Conversation handlers')), [...new Set((app.recent ?? []).map(e => e.chatId).filter(Boolean))].map(chatId => h('label', { key: chatId, className: 'bt-q-field' }, chatId, h('select', { className: 'bt-input', value: app.chatBots?.[chatId] ?? '', 'aria-label': `${t('Conversation handler')} ${chatId}`, onChange: e => action({ operation: 'configure', chatId, botId: e.target.value || null }) }, h('option', { value: '' }, t('Follow the default Bot')), ownBots(roster).filter(b => !b.projectAgent && !b.ephemeral).map(b => h('option', { key: b.id, value: b.id }, b.name)))))),
        h('details', {}, h('summary', {}, t('Permissions of the Feishu application')), permissionPicker, button('Check permissions again', () => action({ operation: 'scopes' }), busy), h('ul', {}, BASE_SCOPES.filter(s => !scopeGranted(s, app.scopes)).map(s => h('li', { key: s }, s)))),
        h('details', {}, h('summary', {}, t('Feishu tools')), ownBots(roster).filter(b => !b.projectAgent && !b.ephemeral).map(b => h('fieldset', { key: b.id }, h('legend', {}, b.name), PRODUCTS.map(p => h('label', { key: p.id, className: 'bt-q-field' }, t(p.label), productAccess(p, app.scopes) !== 'write' ? h('small', {}, t(productAccess(p, app.scopes) === 'read' ? 'App has read-only permission' : 'App permission not granted')) : null,
          h('select', { className: 'bt-input', 'aria-label': `${b.name} ${t(p.label)}`, value: app.grants?.[b.id]?.[p.id] ?? 'disabled', onChange: e => action({ operation: 'grant', botId: b.id, product: p.id, mode: e.target.value }) }, [['disabled', 'Disabled'], ['read', 'Read only'], ['ask', 'Read/write, ask before writes'], ['write', 'Read/write']].map(([v, label]) => h('option', { key: v, value: v }, t(label))))))))),
        h('details', {}, h('summary', {}, t('Diagnostics')), h('ul', {}, (app.diagnostics ?? []).map((d, i) => h('li', { key: i }, `${d.kind}: ${hostText(d.message)} ${d.code ?? ''} ${d.detail ?? ''}`)))),
        h('details', {}, h('summary', {}, t('Delivery records')), (app.outbox ?? []).map(o => h('p', { key: o.id }, `${o.id}: ${o.status}`, o.status === 'failed' ? button('Try again', () => action({ operation: 'retry', outboxId: o.id })) : null))),
        h('details', {}, h('summary', {}, t('Files')), (app.files ?? []).map(file => button(file.name, () => void run(async () => { const value = await actions.feishu({ operation: 'attachment', appId: app.id, attachmentId: file.id }); const bytes = Uint8Array.from(atob(value.content_base64), c => c.charCodeAt(0)); const href = URL.createObjectURL(new Blob([bytes])); const a = Object.assign(document.createElement('a'), { href, download: value.name ?? file.name }); a.click(); setTimeout(() => URL.revokeObjectURL(href), 10000) })))),
        h('details', {}, h('summary', {}, t('Cards')), (app.cards ?? []).map(c => h(CardPanel, { key: c.id, card: c, action }))),
        button('Delete connection', () => void run(async () => { await actions.feishu({ operation: 'delete', appId: selected }); select('') }), busy)) : null),
    !app ? h('details', { className: 'bt-feishu-webhook' }, h('summary', {}, t('Custom bot webhook')), field('Webhook URL', webhook, setWebhook, 'password'), button('Connect', () => void run(() => actions.connectorConnect('feishu', { mode: 'webhook', credentials: { webhook } })), busy || !webhook)) : null,
    error ? h('p', { className: 'bt-feishu-error', role: 'alert' }, error) : null)
}

function CardPanel({ card, action }) {
  const [fields, setFields] = useState({})
  return h('article', {}, h('strong', {}, card.card.title ?? 'FlyBot'), (card.card.blocks ?? []).map((b, i) => b.type === 'input' ? field(b.label ?? b.name, fields[b.name] ?? '', value => setFields({ ...fields, [b.name]: value })) : h('pre', { key: i }, b.text ?? JSON.stringify(b))),
    (card.card.actions ?? []).map(a => button(a.label ?? a.id, () => action({ operation: 'card-action', cardId: card.id, action: a.id, fields }), card.closed)))
}
