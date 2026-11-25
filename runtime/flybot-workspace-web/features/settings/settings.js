// B4: per-account preferences, notification preferences (#284), onboarding
// and the Personal Agent look, executed and stored in the user's own DS-Bot.
// Ported from flybot_workspace/settings.py, notification_prefs.py (#284) and
// onboarding.py; the legacy routes keep the exact request/response contract so
// the existing /settings/ and /onboarding/ pages work unchanged when served by
// this plugin. Data lives in <DSH_HOME>/flybot-workspace/features/settings/settings.json (0600).
import { readFileSync } from 'node:fs'
import { fail, isObject, bodyOf, nowSeconds } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'

const DATA = JSON.parse(readFileSync(new URL('./onboarding-data.json', import.meta.url), 'utf8'))

export const LANGUAGES = ['en', 'fa', 'fr', 'de', 'es', 'it', 'pt-BR', 'ru', 'id', 'ms', 'hi', 'bn', 'th', 'ja', 'ko', 'zh-HK', 'zh-TW', 'zh-CN']
export const CHAT_LANGUAGES = ['en', 'fa', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'id', 'vi', 'bn', 'th', 'ar', 'ja', 'ko', 'zh-Hant', 'zh-CN']
export const CHAT_LANGUAGE_NAMES = {
  en: 'English', fa: 'Persian', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
  ru: 'Russian', id: 'Indonesian', vi: 'Vietnamese', bn: 'Bengali', th: 'Thai', ar: 'Arabic', ja: 'Japanese',
  ko: 'Korean', 'zh-Hant': 'Traditional Chinese', 'zh-CN': 'Simplified Chinese',
}
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const BOOL = [true, false]
export const FIELDS = {
  appearance: [['system', 'light', 'dark', 'auto'], 'system'],
  appearance_schedule: [['sunset_sunrise', 'custom'], 'sunset_sunrise'],
  appearance_start: ['time', '18:00'],
  appearance_end: ['time', '07:00'],
  language: [LANGUAGES, 'zh-CN'],
  chat_language: [['auto', ...CHAT_LANGUAGES], 'auto'],
  auto_translate: [BOOL, false],
  send_shortcut: [['enter', 'mod_enter'], 'enter'],
  message_folding: [['compact', 'standard', 'none'], 'standard'],
  document_cards: [BOOL, false],
  link_previews: [BOOL, true],
  task_completion_reminders: [BOOL, true],
  likes_visible: [BOOL, true],
  favorites_visible: [BOOL, true],
}

export const defaults = () => Object.fromEntries(Object.entries(FIELDS).map(([name, [, value]]) => [name, value]))

export function validValue(name, value) {
  const [allowed] = FIELDS[name]
  if (allowed === 'time') return typeof value === 'string' && TIME.test(value)
  if (allowed === BOOL) return typeof value === 'boolean'
  return typeof value === 'string' && allowed.includes(value)
}

// settings.migrate: map an older stored document onto current keys.
export function migrate(stored) {
  const result = {}
  if (!isObject(stored)) return result
  stored = { ...stored }
  if (!('message_folding' in stored) && 'fold_long_messages' in stored) {
    if (stored.fold_long_messages === true) stored.message_folding = 'standard'
    else if (stored.fold_long_messages === false) stored.message_folding = 'none'
  }
  for (const [oldName, newName] of [['likes_visibility', 'likes_visible'], ['favorites_visibility', 'favorites_visible']]) {
    if (!(newName in stored) && oldName in stored) {
      if (stored[oldName] === 'everyone') stored[newName] = true
      else if (stored[oldName] === 'private') stored[newName] = false
    }
  }
  for (const [name, value] of Object.entries(stored)) if (Object.hasOwn(FIELDS, name) && validValue(name, value)) result[name] = value
  return result
}

export function settingsView(row) {
  return { values: { ...defaults(), ...(row ? migrate(row.document) : {}) }, revision: row ? row.revision : 0 }
}

export function normalizeChanges(changes) {
  if (!isObject(changes) || Object.keys(changes).length === 0) return null
  if ('fold_long_messages' in changes && 'message_folding' in changes) return null
  const result = {}
  for (const [name, value] of Object.entries(changes)) {
    if (name === 'fold_long_messages') {
      if (typeof value !== 'boolean') return null
      result.message_folding = value ? 'standard' : 'none'
      continue
    }
    if (name === 'likes_visibility' || name === 'favorites_visibility') {
      if (value !== 'everyone' && value !== 'private') return null
      result[name === 'likes_visibility' ? 'likes_visible' : 'favorites_visible'] = value === 'everyone'
      continue
    }
    if (!Object.hasOwn(FIELDS, name) || !validValue(name, value)) return null
    result[name] = value
  }
  return result
}

const validRevision = value => Number.isInteger(value) && value >= 0 && value <= 2 ** 31
const sameValues = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

// #284 notification preferences: one boolean per category.
export const NOTIFICATION_CATEGORIES = [
  ['mentions', '@提及', '别人在会话里 @ 你'],
  ['task_completion', '任务完成', '你发起的智能体任务结束'],
  ['artifacts', '作品通知', '同会话的其他人保存了作品'],
]
const NOTIFICATION_KEYS = NOTIFICATION_CATEGORIES.map(([key]) => key)
export function notificationPrefs(row) {
  const values = Object.fromEntries(NOTIFICATION_KEYS.map(key => [key, true]))
  if (row && isObject(row.document)) for (const key of NOTIFICATION_KEYS) if (typeof row.document[key] === 'boolean') values[key] = row.document[key]
  return values
}
const notificationPayload = row => ({ prefs: notificationPrefs(row), categories: NOTIFICATION_CATEGORIES.map(([key, label, about]) => ({ key, label, about })) })

// Onboarding (onboarding.py tables copied into onboarding-data.json).
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
const chars = value => [...value].length
const validIndustry = value => value === '' || (typeof value === 'string' && chars(value.trim()) <= 40 && !CONTROL.test(value))
const validRole = value => value === '' || (typeof value === 'string' && chars(value.trim()) <= DATA.role_max && !CONTROL.test(value))
export const industriesView = () => DATA.industries.map(([name, roles]) => ({ name, roles: [...roles] }))
export function recommendedTemplateIds(role) {
  const text = role || ''
  for (const [keys, ids] of DATA.groups) if (keys.some(key => text.includes(key))) return [...ids]
  return [...DATA.default_templates]
}
export const automationRecommendations = role => recommendedTemplateIds(role)
  .filter(id => Object.hasOwn(DATA.automation_templates, id))
  .map(id => ({ template_id: id, title: DATA.automation_templates[id].title, prompt: DATA.automation_templates[id].prompt }))
const recommendations = industry => [...(DATA.by_industry[industry] ?? []), ...DATA.general]
  .map(([key, kind, title, summary]) => ({ key, kind, title, summary }))
const recommendationKeys = () => new Set([...DATA.general, ...Object.values(DATA.by_industry).flat()].map(item => item[0]))
export const LOOK_OPTIONS = DATA.look_options
export const validLook = look => isObject(look)
  && JSON.stringify(Object.keys(look).sort()) === JSON.stringify(Object.keys(LOOK_OPTIONS).sort())
  && Object.entries(LOOK_OPTIONS).every(([name, options]) => options.includes(look[name]))
const onboardingView = row => ({ industry: row.industry, role: row.role, completed: Boolean(row.completed), revision: row.revision, created: row.created, updated: row.updated })
const stepsView = (row, industry) => ({
  apps: DATA.apps.map(([key, name]) => ({ key, name, connected: false })),
  recommendations: recommendations(industry),
  look_options: Object.fromEntries(Object.entries(LOOK_OPTIONS).map(([name, options]) => [name, [...options]])),
  picks: row ? [...row.picks] : [],
  look: row && row.look ? { ...row.look } : null,
  compared: false,
})

function wizardProgress({ onboarding, onboarding_steps: steps, onboarding_progress: progress }) {
  if (progress) return progress
  if (steps?.look || (onboarding?.completed && !onboarding.industry && !onboarding.role)) {
    return { step: 4, completed: true }
  }
  if (steps) return { step: 4, completed: false }
  if (onboarding?.completed || (onboarding?.industry && onboarding.role)) return { step: 2, completed: false }
  return { step: 1, completed: false }
}

function onboardingPayload(state) {
  const { onboarding: row, onboarding_steps: steps } = state
  return {
    onboarding: row ? onboardingView(row) : null,
    industries: industriesView(),
    automation_templates: automationRecommendations(row?.role ?? ''),
    steps: stepsView(steps, row?.industry ?? ''),
    progress: wizardProgress(state),
  }
}

export function createSettingsFeature({ dir, clock = nowSeconds }) {
  const store = openJsonStore(dir, 'settings')
  const state = () => store.read()

  const getSettings = () => {
    const snapshot = state()
    const look = snapshot.onboarding_steps?.look
    return { settings: settingsView(snapshot.settings), ...(look && validLook(look) ? {personal_look: look} : {}) }
  }
  function saveSettings(raw) {
    const body = bodyOf(raw, ['revision', 'changes'])
    const { revision } = body
    if (!validRevision(revision) || !isObject(body.changes) || Object.keys(body.changes).length === 0) {
      fail(400, 'invalid', 'Provide the current revision and a non-empty changes object')
    }
    const changes = normalizeChanges(body.changes)
    if (changes === null) fail(400, 'invalid', 'Unknown setting or unsupported value')
    return store.update((draft) => {
      const current = settingsView(draft.settings)
      if (revision !== current.revision) fail(409, 'conflict', 'Settings changed elsewhere; reload and retry', current)
      const values = { ...current.values, ...changes }
      if (draft.settings && sameValues(values, current.values)) return { settings: current }
      draft.settings = { document: values, revision: current.revision + 1, updated: clock() }
      return { settings: { values, revision: current.revision + 1 } }
    })
  }

  const getNotificationPrefs = () => notificationPayload(state().notification_prefs)
  function saveNotificationPrefs(raw) {
    const { changes } = bodyOf(raw, ['changes'])
    if (!isObject(changes) || Object.keys(changes).length === 0) fail(400, 'invalid', 'Provide a non-empty changes object')
    for (const [key, value] of Object.entries(changes)) {
      if (!NOTIFICATION_KEYS.includes(key)) fail(400, 'invalid', 'Unknown notification category')
      if (typeof value !== 'boolean') fail(400, 'invalid', 'Notification categories are on or off')
    }
    return store.update((draft) => {
      draft.notification_prefs = { document: { ...notificationPrefs(draft.notification_prefs), ...changes }, updated: clock() }
      return notificationPayload(draft.notification_prefs)
    })
  }

  const getOnboarding = () => onboardingPayload(state())

  function finishOnboarding(draft) {
    draft.onboarding_progress = { step: 4, completed: true }
    const row = draft.onboarding
    if (row && !row.completed) {
      draft.onboarding = { ...row, completed: 1, revision: row.revision + 1, updated: clock() }
    }
  }

  function saveWizardProgress(raw) {
    const body = bodyOf(raw, ['step', 'completed'])
    const finish = body.completed === true && Object.keys(body).length === 1
    const advance = [3, 4].includes(body.step) && Object.keys(body).length === 1
    if (!finish && !advance) fail(400, 'invalid', 'Provide the next onboarding step or finish the wizard')
    return store.update(draft => {
      const current = wizardProgress(draft)
      if (!current.completed && advance && body.step > current.step + 1) {
        fail(409, 'conflict', 'Complete the current onboarding step first', current)
      }
      if (finish) finishOnboarding(draft)
      else draft.onboarding_progress = { ...current, step: Math.max(current.step, body.step) }
      return { progress: draft.onboarding_progress }
    })
  }

  function saveOnboarding(raw) {
    const body = bodyOf(raw, ['industry', 'role', 'completed'])
    let industry = body.industry ?? ''
    let role = body.role ?? ''
    const { completed } = body
    if (!validIndustry(industry) || !validRole(role) || typeof completed !== 'boolean') fail(400, 'invalid', 'Provide a valid industry, role and completed flag')
    industry = industry.trim()
    role = role.trim()
    const now = clock()
    return store.update((draft) => {
      const current = draft.onboarding
      const progress = wizardProgress(draft)
      const profileComplete = Number(completed || progress.completed)
      if (!current || current.industry !== industry || current.role !== role || current.completed !== profileComplete) {
        draft.onboarding = { industry, role, completed: profileComplete,
          revision: (current?.revision ?? 0) + 1, created: current?.created ?? now, updated: now }
      }
      if (completed && !industry && !role) finishOnboarding(draft)
      else if (industry && role) draft.onboarding_progress = { ...progress, step: Math.max(2, progress.step) }
      return [current ? 200 : 201, onboardingPayload(draft)]
    })
  }
  function saveStep(step, raw) {
    return store.update((draft) => {
      const current = draft.onboarding_steps
      const progress = wizardProgress(draft)
      let picks = current ? current.picks : []
      let look = current ? current.look : null
      if (step === 'picks') {
        const value = bodyOf(raw, ['picks']).picks
        const known = recommendationKeys()
        if (!Array.isArray(value) || value.length > DATA.pick_max || value.some(key => typeof key !== 'string' || !known.has(key)) || new Set(value).size !== value.length) {
          fail(400, 'invalid', 'Pick at most six known suggestions')
        }
        picks = value
        if (progress.step >= 2) draft.onboarding_progress = { ...progress, step: 4 }
      } else {
        const { look: value, finish } = bodyOf(raw, ['look', 'finish'])
        if (!validLook(value)) fail(400, 'invalid', 'Provide color, expression, headwear, glasses and hand from the options')
        if (finish !== undefined && typeof finish !== 'boolean') fail(400, 'invalid', 'Invalid finish flag')
        if (finish && progress.step < 4) fail(409, 'conflict', 'Complete the current onboarding step first', progress)
        look = Object.fromEntries(Object.keys(LOOK_OPTIONS).map(name => [name, value[name]]))
        if (finish) finishOnboarding(draft)
      }
      draft.onboarding_steps = { picks, look, updated: clock() }
      draft.onboarding_progress ??= progress
      return { steps: stepsView(draft.onboarding_steps, draft.onboarding?.industry ?? ''), progress: draft.onboarding_progress }
    })
  }
  const lookOf = () => {
    const look = state().onboarding_steps?.look
    return look && validLook(look) ? look : null
  }
  const noQuery = (query) => { if (query) fail(400, 'invalid', 'Invalid request') }

  return {
    store,
    chatLanguage: () => settingsView(state().settings).values.chat_language,
    endpoints: {
      get: async () => getSettings(),
      save: async payload => saveSettings(payload),
      notificationPrefs: async () => getNotificationPrefs(),
      saveNotificationPrefs: async payload => saveNotificationPrefs(payload),
      onboarding: async () => getOnboarding(),
      saveOnboarding: async payload => saveOnboarding(payload)[1],
      onboardingPicks: async payload => saveStep('picks', payload),
      onboardingLook: async payload => saveStep('look', payload),
      look: async () => ({ look: lookOf(), look_options: LOOK_OPTIONS }),
      chatLanguage: async () => ({ chat_language: settingsView(state().settings).values.chat_language }),
    },
    legacy: [
      { method: 'GET', path: /\/v1\/settings/, handle: async ({ query }) => { noQuery(query); return [200, getSettings()] } },
      { method: 'POST', path: /\/v1\/settings/, handle: async ({ body }) => [200, saveSettings(body)] },
      { method: 'GET', path: /\/v1\/notification-prefs/, handle: async ({ query }) => { noQuery(query); return [200, getNotificationPrefs()] } },
      { method: 'PUT', path: /\/v1\/notification-prefs/, handle: async ({ body }) => [200, saveNotificationPrefs(body)] },
      { method: 'GET', path: /\/v1\/onboarding/, handle: async ({ query }, call) => {
        noQuery(query)
        const payload = getOnboarding()
        const viewer = call?.request?.headers?.get('x-ot-owner-username')
        if (typeof viewer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(viewer)) payload.viewer_username = viewer
        return [200, payload]
      } },
      { method: 'POST', path: /\/v1\/onboarding/, handle: async ({ body }) => saveOnboarding(body) },
      { method: 'POST', path: /\/v1\/onboarding\/progress/, handle: async ({ body }) => [200, saveWizardProgress(body)] },
      { method: 'GET', path: /\/v1\/onboarding\/recommendations/, handle: async ({ query }) => { noQuery(query); return [200, { items: automationRecommendations(state().onboarding?.role ?? '') }] } },
      { method: 'POST', path: /\/v1\/onboarding\/(picks|look)/, handle: async ({ match, body }) => [200, saveStep(match[1], body)] },
    ],
  }
}

// Per-user import of legacy rows (flybot_workspace/dsbot_bundle.py 'settings').
// A legacy row wins only when this DS-Bot has nothing newer for it.
export const IMPORT_TABLES = {
  user_settings: ['user_id', 'document', 'revision', 'updated'],
  user_onboarding: ['user_id', 'industry', 'role', 'completed', 'revision', 'created', 'updated'],
  user_onboarding_steps: ['user_id', 'picks', 'look', 'updated'],
}
const parsed = (text, fallback) => { try { return JSON.parse(text) } catch { return fallback } }
export function applyImport(draft, tables) {
  const [settingsRow] = tables.user_settings ?? []
  if (settingsRow && (!draft.settings || draft.settings.revision <= settingsRow.revision)) {
    draft.settings = { document: migrate(parsed(settingsRow.document, {})), revision: Math.max(1, Number(settingsRow.revision) || 1), updated: settingsRow.updated }
  }
  const [onboardingRow] = tables.user_onboarding ?? []
  if (onboardingRow && (!draft.onboarding || draft.onboarding.revision <= onboardingRow.revision)) {
    draft.onboarding = { industry: String(onboardingRow.industry ?? ''), role: String(onboardingRow.role ?? ''), completed: onboardingRow.completed ? 1 : 0,
      revision: Math.max(1, Number(onboardingRow.revision) || 1), created: onboardingRow.created, updated: onboardingRow.updated }
  }
  const [stepsRow] = tables.user_onboarding_steps ?? []
  if (stepsRow && (!draft.onboarding_steps || (draft.onboarding_steps.updated ?? 0) <= stepsRow.updated)) {
    const picks = parsed(stepsRow.picks, [])
    const look = stepsRow.look ? parsed(stepsRow.look, null) : null
    draft.onboarding_steps = { picks: Array.isArray(picks) ? picks.filter(k => typeof k === 'string').slice(0, 6) : [], look: look && validLook(look) ? look : null, updated: stepsRow.updated }
  }
}
