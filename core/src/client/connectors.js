import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { ConnectorIcon } from './icons.js'
import { SwitchRow } from './bot-settings.js'
import { ConnectorBots, usageText } from './connector-bots.js'
import { t } from './i18n.js'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'
const COMPOSIO_KEY_URL = 'https://platform.composio.dev/'
// Feishu's own page for a group's custom bot, where the webhook URL comes from.
const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot'

// Common apps, searched when Composio cannot be asked; any other app is found by the search.
const APPS = [
  ['gmail', 'Gmail'], ['googlecalendar', 'Google Calendar'], ['googledrive', 'Google Drive'], ['googledocs', 'Google Docs'],
  ['googlesheets', 'Google Sheets'], ['outlook', 'Outlook'], ['slack', 'Slack'], ['microsoft_teams', 'Microsoft Teams'],
  ['discord', 'Discord'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'], ['notion', 'Notion'], ['linear', 'Linear'],
  ['jira', 'Jira'], ['asana', 'Asana'], ['trello', 'Trello'], ['todoist', 'Todoist'], ['airtable', 'Airtable'],
  ['dropbox', 'Dropbox'], ['hubspot', 'HubSpot'], ['salesforce', 'Salesforce'], ['stripe', 'Stripe'],
  ['zoom', 'Zoom'], ['calendly', 'Calendly'], ['figma', 'Figma'], ['twitter', 'X (Twitter)'], ['youtube', 'YouTube'],
]
const appName = slug => APPS.find(([id]) => id === slug)?.[1] ?? slug

export const GitHubMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }))

// Feishu's mark: two stacked wings around a middle line, drawn here rather than copied.
export const FeishuMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M3.2 6.6c3 .1 6.4 1.5 8.6 3.9-1.9.4-3.5 1.4-4.7 2.9-1.9-.6-3.4-1.9-3.9-3.6-.2-.7-.2-1.5 0-3.2z' }),
  h('path', { d: 'M16.8 5.4c-2.9.2-5.6 1.5-7.4 3.4 1.7 1.2 3.1 2.8 3.9 4.9 2.2-1.1 3.8-3.2 4-5.6.1-.9-.1-1.9-.4-2.7z' }),
  h('path', { d: 'M8.6 12.1c.9.7 1.7 1.6 2.2 2.7-1.1.2-2.3 0-3.3-.6.2-.8.6-1.5 1.1-2.1z' }))

const MARKS = { github: GitHubMark, composio: ConnectorIcon, feishu: FeishuMark }
const ABOUT = {
  github: () => t('Repositories, issues, and pull requests'),
  composio: () => t('Gmail, Slack, Calendar, Notion and many more apps, through one Composio key'),
  feishu: () => t('Posts into one Feishu group through a custom bot webhook'),
}

function statusText(connector) {
  if (connector.state === 'connecting') return t('Connecting…')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready' && connector.kind === 'channel') {
    return connector.mode === 'app' ? t('Connected: app, over the long connection') : t('Connected: custom bot webhook')
  }
  if (connector.state === 'ready' && connector.apps?.length > 0) return t('Connected: {apps}', { apps: connector.apps.map(appName).join(', ') })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  return ABOUT[connector.id]?.() ?? ''
}

// One credential of the form (#1266): the definition says which fields a mode needs and whether a
// field is masked. A masked one is the same field the Secrets page uses, so it never comes back.
function CredentialField({ credential, value, onChange, onEnter, autoFocus }) {
  const label = t(credential.label)
  if (credential.masked) return h(MaskedInput, { value, onChange, onEnter, label, autoFocus })
  return h('label', { className: 'bt-q-field' },
    h('input', {
      className: 'bt-input', type: 'text', value, 'aria-label': label, placeholder: label, spellCheck: false, autoFocus,
      onChange: event => onChange(event.target.value),
      onKeyDown: event => { if (event.key === 'Enter') onEnter?.() },
    }))
}

// Who may talk to the Bots (#1266). Nobody until the owner allows someone: a stranger who messages
// is one line here with Allow beside it, and the open_id can be pasted before anyone has written.
function AllowedSenders({ connector, actions, run, busy }) {
  const [openId, setOpenId] = useState('')
  const allowed = connector.allowed ?? []
  const refused = connector.inbound?.refusedSenders ?? []
  const allow = id => void run(actions.connectorAllow(connector.id, id))
  return h('div', { className: 'bt-connector-allowed' },
    h('span', { className: 'bt-connector-person-title' }, t('Who may talk to the Bots')),
    allowed.length === 0 && refused.length === 0
      ? h('span', { className: 'bt-set-hint' }, t('Nobody yet. A message from anyone else starts no turn.'))
      : null,
    allowed.map(entry => h('div', { key: entry.openId, className: 'bt-connector-person' },
      h('span', { className: 'bt-connector-person-name' }, entry.name ?? entry.openId),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorBlock(connector.id, entry.openId)) }, t('Block')))),
    refused.map(entry => h('div', { key: entry.openId, className: 'bt-connector-person' },
      h('span', { className: 'bt-connector-person-name' }, entry.name ?? entry.openId),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => allow(entry.openId) }, t('Allow')))),
    h('div', { className: 'bt-connector-form-row' },
      h('input', {
        className: 'bt-input', type: 'text', value: openId, spellCheck: false, 'aria-label': t('Feishu open_id'), placeholder: t('Paste an open_id to allow'),
        onChange: event => setOpenId(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter' && openId.trim() !== '') { allow(openId.trim()); setOpenId('') } },
      }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || openId.trim() === '', onClick: () => { allow(openId.trim()); setOpenId('') } }, t('Allow'))))
}

// What a picked app needs before a Bot can use it, as Composio last answered.
const APP_STATUS = { ready: () => t('Ready'), 'sign-in': () => t('Needs sign-in') }

function AppChip({ name, status, onRemove }) {
  const label = APP_STATUS[status]?.()
  return h('button', { type: 'button', className: 'bt-state bt-app-chip', 'aria-pressed': true, 'data-status': status ?? 'unknown', title: t('Remove {app}', { app: name }), onClick: onRemove },
    name, label ? h('span', { className: 'bt-app-status' }, ` · ${label}`) : null)
}

// The picked apps (each with its status), and a search over Composio's app list to add more.
// Without a key to search with, or when the search fails, the common apps are searched instead.
export function AppPicker({ apps, onChange, search, statuses = {} }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(null)
  const [failed, setFailed] = useState(null)
  const names = useRef(new Map(APPS))
  const asked = useRef(0)
  useEffect(() => {
    const text = query.trim()
    if (text === '' || search === undefined) { setFound(null); setFailed(null); return undefined }
    const ask = ++asked.current
    const timer = setTimeout(() => {
      search(text).then(list => {
        if (ask !== asked.current) return
        for (const app of list) names.current.set(app.slug, app.name)
        setFound(list)
        setFailed(null)
      }, failure => {
        if (ask !== asked.current) return
        setFound(null)
        setFailed(failure?.message ?? String(failure))
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [query, search])
  const nameOf = slug => names.current.get(slug) ?? appName(slug)
  const picked = new Set(apps)
  const needle = query.trim().toLowerCase()
  const local = APPS.filter(([slug, name]) => needle === '' || slug.includes(needle) || name.toLowerCase().includes(needle)).map(([slug, name]) => ({ slug, name }))
  const results = (found ?? local).filter(app => !picked.has(app.slug))
  return h('div', { className: 'bt-connector-apps' },
    apps.length > 0 ? h('div', { className: 'bt-states', 'aria-label': t('Picked apps') }, apps.map(slug =>
      h(AppChip, { key: slug, name: nameOf(slug), status: statuses[slug], onRemove: () => onChange(apps.filter(app => app !== slug)) }))) : null,
    h('input', { className: 'bt-input', type: 'search', value: query, spellCheck: false, 'aria-label': t('Search apps'), placeholder: t('Search Composio apps'), onChange: event => setQuery(event.target.value) }),
    failed ? h('span', { className: 'bt-set-hint' }, t('Could not search Composio: {error}', { error: failed })) : null,
    h('div', { className: 'bt-states', 'aria-label': t('Apps to add') }, results.length === 0
      ? h('span', { className: 'bt-set-hint' }, t('No apps match'))
      : results.map(app => h('button', { key: app.slug, type: 'button', className: 'bt-state', 'aria-pressed': false, onClick: () => { names.current.set(app.slug, app.name); onChange([...apps, app.slug]) } }, app.name))))
}

// One line per picked app with whether it is ready or still needs a sign-in.
export function AppStatusList({ apps, statuses }) {
  if (apps.length === 0 || Object.keys(statuses).length === 0) return null
  return h('ul', { className: 'bt-connector-app-list', 'aria-label': t('App status') }, apps.map(slug =>
    h('li', { key: slug, className: 'bt-connector-app', 'data-status': statuses[slug] ?? 'unknown' },
      h('span', { className: 'bt-connector-app-name' }, appName(slug)),
      h('span', { className: 'bt-app-status' }, APP_STATUS[statuses[slug]]?.() ?? ''))))
}

function ConnectorRow({ connector, roster, actions }) {
  const [form, setForm] = useState(false)
  const [bots, setBots] = useState(false)
  const [token, setToken] = useState('')
  const [apps, setApps] = useState(() => connector.apps ?? [])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState('')
  const run = (task, after) => {
    setBusy(true)
    setError(null)
    return task.then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const gateway = connector.id === 'composio'
  // A sender posts through one webhook: no tools, so no per-Bot switch, and its own send field.
  const sender = connector.kind === 'sender'
  // A channel (#1266) is one row with two modes: a custom-bot webhook (outbound only, today's
  // behaviour) or a self-built app (the long connection in, answers out). The form is the mode's
  // credential list, rendered field by field.
  const channel = connector.kind === 'channel'
  const modes = connector.modes ?? []
  const [mode, setMode] = useState(() => connector.mode ?? modes[0]?.id)
  const [values, setValues] = useState({})
  const chosen = modes.find(entry => entry.id === mode) ?? modes[0]
  const field = name => values[name] ?? ''
  const setField = (name, value) => setValues(current => ({ ...current, [name]: value }))
  const filled = chosen !== undefined && chosen.credentials.every(credential => field(credential.name).trim() !== '')
  const [statuses, setStatuses] = useState({})
  const appsKey = (connector.apps ?? []).join(',')
  // Asks Composio which picked apps are signed in, when the row is ready and again when the list changes.
  useEffect(() => {
    if (!gateway || connector.state !== 'ready' || appsKey === '' || actions.connectorAppStatus === undefined) { setStatuses({}); return undefined }
    let live = true
    actions.connectorAppStatus(connector.id).then(value => { if (live) setStatuses(value ?? {}) }, () => { if (live) setStatuses({}) })
    return () => { live = false }
  }, [gateway, connector.state, appsKey, picking])
  const search = useCallback(query => actions.connectorAppSearch(connector.id, query, connector.state === 'off' ? token : undefined), [connector.id, connector.state, token])
  const connect = () => {
    if (busy) return
    if (channel) {
      if (chosen === undefined || !filled) return
      const credentials = Object.fromEntries(chosen.credentials.map(credential => [credential.name, field(credential.name)]))
      void run(actions.connectorConnect(connector.id, { mode: chosen.id, credentials }), () => { setValues({}); setForm(false) })
      return
    }
    if (token.trim() === '') return
    if (gateway && apps.length === 0) { setError(t('Pick at least one app')); return }
    void run(actions.connectorConnect(connector.id, token, gateway ? apps : undefined), () => { setToken(''); setForm(false) })
  }
  const saveApps = () => {
    if (busy) return
    if (apps.length === 0) { setError(t('Pick at least one app')); return }
    void run(actions.connectorApps(connector.id, apps), () => setPicking(false))
  }
  const on = connector.state !== 'off'
  // A channel offers Send only while its webhook mode is live: app mode answers by itself.
  const canPost = sender || (channel && connector.mode === 'webhook')
  // Choose Bots is for what gives a Bot tools or a way in. A webhook-only channel has neither, so the
  // switch would change nothing (acceptance 5, #1266).
  const perBot = !sender && (!channel || connector.mode === 'app')
  const Mark = MARKS[connector.id]
  const row = useRef(null)
  useMorph(row, `${form}:${picking}:${bots}:${error !== null}:${connector.state}:${mode}`)
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, connector.name),
        h('span', { className: 'bt-connector-status' }, statusText(connector))),
      h('span', { className: 'bt-connector-actions' },
        connector.state === 'error' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorRetry(connector.id)) }, t('Try again')) : null,
        on && gateway && !picking ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setApps(connector.apps ?? []); setPicking(true) } }, t('Choose apps')) : null,
        on && perBot ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': bots, onClick: () => setBots(value => !value) }, bots ? t('Done') : t('Choose Bots')) : null,
        on
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorDisconnect(connector.id)) }, t('Disconnect'))
          : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setForm(true) }, t('Connect')))),
    on && gateway && !picking ? h(AppStatusList, { apps: connector.apps ?? [], statuses }) : null,
    on && perBot ? h('span', { className: 'bt-connector-uses' }, usageText(roster, connector.id)) : null,
    on && bots ? h(ConnectorBots, { connector, roster, actions, run, SwitchRow }) : null,
    on && channel && connector.mode === 'app' ? h(AllowedSenders, { connector, actions, run, busy }) : null,
    on && canPost ? h('div', { className: 'bt-connector-form' },
      h('label', { className: 'bt-q-field' }, h('input', { className: 'bt-input', type: 'text', value: message, 'aria-label': t('Message to send to Feishu'), placeholder: t('Type a message for the Feishu group'), onChange: event => setMessage(event.target.value) })),
      h('div', { className: 'bt-connector-form-row' },
        h('span', { className: 'bt-connector-link' }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || message.trim() === '' || actions.connectorSend === undefined, onClick: () => void run(actions.connectorSend(connector.id, message), () => setMessage('')) }, t('Send')))) : null,
    !on && form ? h('div', { className: 'bt-connector-form' },
      channel ? h('div', { className: 'bt-states', role: 'group', 'aria-label': t('How to connect') }, modes.map(entry =>
        h('button', {
          key: entry.id, type: 'button', className: 'bt-state', 'aria-pressed': entry.id === chosen?.id,
          onClick: () => { setMode(entry.id); setValues({}); setError(null) },
        }, t(entry.label)))) : null,
      channel
        ? (chosen?.credentials ?? []).map((credential, index) => h(CredentialField, {
          key: credential.name, credential, value: field(credential.name), onChange: value => setField(credential.name, value), onEnter: connect, autoFocus: index === 0,
        }))
        : h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: token, onChange: setToken, onEnter: connect, label: gateway ? t('Composio API key') : t('GitHub token'), autoFocus: true })),
      gateway ? h(AppPicker, { apps, onChange: setApps, search: token.trim() === '' ? undefined : search }) : null,
      h('div', { className: 'bt-connector-form-row' },
        h('a', { className: 'bt-connector-link', href: channel ? (chosen?.link ?? FEISHU_WEBHOOK_URL) : gateway ? COMPOSIO_KEY_URL : TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' },
          channel ? t(chosen?.linkLabel ?? 'Get a webhook URL in Feishu') : gateway ? t('Get a Composio API key') : t('Create a token on GitHub')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setForm(false); setToken(''); setValues({}); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || (channel ? !filled : token.trim() === ''), onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
    on && gateway && picking ? h('div', { className: 'bt-connector-form' },
      h(AppPicker, { apps, onChange: setApps, search, statuses }),
      h('span', { className: 'bt-set-hint' }, t('The first time a Bot uses an app, it shows a sign-in link in the chat.')),
      h('div', { className: 'bt-connector-form-row' },
        h('span', { className: 'bt-connector-link' }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setPicking(false); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || apps.length === 0, onClick: saveApps }, busy ? t('Connecting…') : t('Save')))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

// Settings → Connectors: one row per connector.
export function ConnectorsPage({ roster, actions }) {
  const list = roster?.connectors ?? []
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors')))
      : list.map(connector => h(ConnectorRow, { key: connector.id, connector, roster, actions }))))
}
