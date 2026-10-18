// What went wrong in this browser, for Settings → Feedback and the report it builds.
// Calls whose failures the interface swallows (polls, previews) still land here.
import { t, language } from './i18n.js'

const MAX = 30
// The same failure again within this window bumps a count instead of a new line.
const REPEAT_MS = 5 * 60 * 1000
const entries = []
// An API failure is noted where it happens; the menu or form that shows it must not add it again.
const noted = new WeakSet()
export const markNoted = (error) => {
  if (error !== null && typeof error === 'object') noted.add(error)
  return error
}

export function noteClientError(where, error) {
  if (error !== null && typeof error === 'object') {
    if (noted.has(error)) return
    noted.add(error)
  }
  const message = String(error?.message ?? error ?? 'error').slice(0, 300)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const text = `${where}: ${message}`
  const now = Date.now()
  const last = entries.at(-1)
  if (last && last.text === text && now - last.time < REPEAT_MS) {
    last.time = now
    last.count = (last.count ?? 1) + 1
    return
  }
  entries.push({ time: now, level: 'error', text, ...(code ? { code } : {}) })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
}

// A move of the main view with no click or key behind it is the kind of jump a user cannot explain (#261):
// keep who moved it and where from, in the diagnostics and the console, so the next report says.
export function noteNavigation(how, target, from) {
  if (typeof navigator === 'undefined' || navigator.userActivation?.isActive !== false) return
  const stack = String(new Error().stack ?? '').split('\n').slice(2, 6).map(line => line.trim().replace(/\(?https?:\/\/[^/\s)]+/, '(')).join(' < ')
  const text = `navigation: ${how} to ${String(target).slice(0, 60)}${from ? ` from ${String(from).slice(0, 60)}` : ''} with no click (${stack.slice(0, 300)})`
  console.warn(`[flybot] ${text}`)
  entries.push({ time: Date.now(), level: 'warn', text })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
}

// A catch handler that keeps the failure without bothering the user.
export const quietly = where => error => noteClientError(where, error)

export const clearClientErrors = () => { entries.length = 0 }

export const clientErrors = () => entries.map(entry => (entry.count > 1 ? { ...entry, text: `${entry.text} (×${entry.count})` } : { ...entry }))

export function clientFacts() {
  return {
    surface: window.dshDesktop ? 'DSH Desktop' : 'DSH Web',
    language: language(),
    userAgent: navigator.userAgent,
  }
}

// Short words for the provider-neutral failure codes of DSH's LLM layer.
const FAILURES = {
  AUTH: 'The API key was rejected',
  QUOTA: 'The account is out of quota',
  ACCOUNT_QUOTA: 'The account is out of quota',
  RATE_LIMIT: 'Too many requests to the model',
  CONTEXT_WINDOW_EXCEEDED: 'The conversation is too long for the model',
  INVALID_REQUEST: 'The model service refused the request',
  SERVER: 'The model service failed',
  TIMEOUT: 'The model took too long to answer',
  TRANSPORT: 'Could not reach the model service',
  SESSION: 'Its group conversation could not open',
}

export function failureLabel(code, message) {
  if (FAILURES[code]) return t(FAILURES[code])
  const raw = String(message ?? '')
  if (/api key|no api key|missing (?:api )?key|not configured|no model/i.test(raw)) {
    return t('This Bot has no model set up yet.')
  }
  if (raw || code) return t('This Bot could not answer right now.')
  return t('Unknown error')
}

// GitHub refuses very long addresses; past this the diagnostics go by the clipboard.
const URL_LIMIT = 7000
export const WHAT_MAX = 2000
const PASTE_NOTE = 'FlyBot copied the diagnostics to the clipboard. Paste them here.'
const REST_NOTE = 'The recent errors do not fit in the link. FlyBot copied the diagnostics to the clipboard: paste them below this line.'

export function issueUrl(base, { what = '', diagnostics }) {
  const text = what.trim().slice(0, WHAT_MAX)
  const title = text.split('\n')[0].slice(0, 80)
  const build = body => `${base}?${new URLSearchParams({ template: 'bug.yml', ...(title ? { title } : {}), ...(text ? { what: text } : {}), diagnostics: body })}`
  const full = build(diagnostics)
  if (full.length <= URL_LIMIT) return { url: full, inline: true }
  // The versions table leads the report and stays short; only the errors make it
  // long, and a report that lost the versions is hard to act on.
  const facts = build(`${diagnostics.split('\n\n')[0]}\n\n${REST_NOTE}`)
  return { url: facts.length <= URL_LIMIT ? facts : build(PASTE_NOTE), inline: false }
}
