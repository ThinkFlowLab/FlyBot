// Localized notification template catalog, ported from the unwired central
// module flybot-workspace/notification_templates.py (#491). It stores versioned
// subject/body text per notification kind and locale, resolves a zh-CN → zh → en
// fallback chain, enforces required variables and interpolates plain text.
//
// It does not send notifications, schedule work, translate text or parse HTML.
// Values are HTML-escaped before substitution so a value can never inject markup
// into a rendered notification. The built-in catalog covers exactly the kinds
// Bot Social emits today; a kind with no template falls back to the caller's
// text (or is refused when the caller gives none), never to invented copy.
import { randomUUID } from 'node:crypto'
import { fail } from '../../src/store.js'

export const MAX_SUBJECT = 500
export const MAX_BODY = 10000
export const MAX_VARIABLES = 32
export const MAX_VARIABLE_NAME = 64
export const MAX_VALUE = 4000
export const MAX_VERSION = 1000000
export const MAX_KIND = 64
export const MAX_LOCALE = 35

const KIND = /^[a-z][a-z0-9_.-]{0,63}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS notification_templates (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 locale TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version >= 1),
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 variables TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created INTEGER NOT NULL,
 UNIQUE(owner_id, kind, locale, version));
CREATE INDEX IF NOT EXISTS notification_template_lookup
 ON notification_templates(owner_id, kind, locale, enabled, version);
CREATE INDEX IF NOT EXISTS notification_template_catalog
 ON notification_templates(owner_id, kind, locale, version);
`

// The kinds Bot Social emits today (services/bot-social/src/flybot-workspace/*.ts),
// each with the flat fields its notify() payload carries. Nested profile objects
// (by/creator/follower/organizer) are deliberately not interpolated: the caller
// passes a display name under the declared variable when it wants one.
export const BUILTIN = {
  'artifact.shared': {
    en: { subject: 'A work was shared with you', body: '{actor_username} shared the work "{title}".', variables: ['actor_username', 'title'] },
    zh: { subject: '有作品分享给你', body: '{actor_username} 分享了作品「{title}」。', variables: ['actor_username', 'title'] },
  },
  'discover.conversation_started': {
    en: { subject: 'New conversation from your listing', body: 'Someone started a conversation from your public listing.', variables: [] },
    zh: { subject: '你的作品带来了新对话', body: '有人从你的公开作品开始了一段对话。', variables: [] },
  },
  'discover.published': {
    en: { subject: 'New on Discover', body: 'A creator you follow published "{title}".', variables: ['title'] },
    zh: { subject: '发现页有更新', body: '你关注的作者发布了「{title}」。', variables: ['title'] },
  },
  'follow.new': {
    en: { subject: 'You have a new follower', body: 'Someone started following you.', variables: [] },
    zh: { subject: '你有了一位新关注者', body: '有人开始关注你了。', variables: [] },
  },
  'meeting.shared': {
    en: { subject: 'A meeting was shared with you', body: 'A meeting was shared: "{title}".', variables: ['title'] },
    zh: { subject: '有会议分享给你', body: '有会议分享给你：「{title}」。', variables: ['title'] },
  },
  'messenger.added': {
    en: { subject: 'You were added to a conversation', body: 'You were added to "{title}".', variables: ['title'] },
    zh: { subject: '你被加入了一段对话', body: '你被加入了「{title}」。', variables: ['title'] },
  },
  'messenger.call': {
    en: { subject: 'Incoming call', body: 'An incoming call started in "{title}".', variables: ['title'] },
    zh: { subject: '有来电', body: '「{title}」中有一通来电。', variables: ['title'] },
  },
  'messenger.mention': {
    en: { subject: 'You were mentioned', body: 'Someone mentioned you in a conversation.', variables: [] },
    zh: { subject: '有人提到了你', body: '有人在一段对话里提到了你。', variables: [] },
  },
  'team.join_decided': {
    en: { subject: 'Your join request was decided', body: 'Your request to join "{team_name}" was {decision}.', variables: ['team_name', 'decision'] },
    zh: { subject: '你的加入申请有结果了', body: '你加入「{team_name}」的申请结果：{decision}。', variables: ['team_name', 'decision'] },
  },
  'team.join_request': {
    en: { subject: 'Someone asked to join your team', body: 'Someone asked to join "{team_name}".', variables: ['team_name'] },
    zh: { subject: '有人申请加入你的团队', body: '有人申请加入「{team_name}」。', variables: ['team_name'] },
  },
  'team.member_joined': {
    en: { subject: 'A new team member joined', body: 'A new member joined "{team_name}".', variables: ['team_name'] },
    zh: { subject: '团队有新成员', body: '有新成员加入了「{team_name}」。', variables: ['team_name'] },
  },
  'team.membership_changed': {
    en: { subject: 'Your team membership changed', body: 'Your role in "{team_name}" changed.', variables: ['team_name'] },
    zh: { subject: '你的团队成员身份变了', body: '你在「{team_name}」中的角色已变更。', variables: ['team_name'] },
  },
  'team.owner_transferred': {
    en: { subject: 'You now own a team', body: 'You are now the owner of "{team_name}".', variables: ['team_name'] },
    zh: { subject: '你已成为团队所有者', body: '你已成为「{team_name}」的所有者。', variables: ['team_name'] },
  },
  'team.removed': {
    en: { subject: 'You were removed from a team', body: 'You were removed from a team.', variables: [] },
    zh: { subject: '你已被移出团队', body: '你已被移出一个团队。', variables: [] },
  },
  'team.run_shared': {
    en: { subject: 'A team run was shared', body: '"{title}" was shared with you in "{team_name}".', variables: ['title', 'team_name'] },
    zh: { subject: '有团队运行分享给你', body: '「{team_name}」把「{title}」分享给了你。', variables: ['title', 'team_name'] },
  },
}

export const KINDS = Object.keys(BUILTIN).sort()

const normalizeLocale = (locale) => {
  const [first, ...rest] = locale.split('-')
  return [first.toLowerCase(), ...rest.map((part) => (part.length === 2 && /^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : part))].join('-')
}

// zh-CN → zh → en, zh-Hant-TW → zh-Hant → zh → en, fr-FR → fr → en: the first
// tag that has a template wins, and en is the last link so a known kind always
// renders something. A kind with no template in any link falls to the caller.
export const localeChain = (locale) => {
  const normalized = normalizeLocale(locale)
  const parts = normalized.split('-')
  const chain = []
  for (let length = parts.length; length >= 1; length -= 1) chain.push(parts.slice(0, length).join('-'))
  if (!chain.includes('en')) chain.push('en')
  return chain
}

export const escapeValue = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const checkKind = (kind) => {
  if (typeof kind !== 'string' || !KIND.test(kind)) fail('notifications/invalid', 'Invalid notification template kind')
  return kind
}

const checkLocale = (locale) => {
  if (typeof locale !== 'string' || locale.length > MAX_LOCALE || !LOCALE.test(locale)) fail('notifications/invalid', 'Invalid notification template locale')
  return normalizeLocale(locale)
}

const checkVersion = (version) => {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) fail('notifications/invalid', 'Invalid notification template version')
  return version
}

const checkText = (name, value, limit) => {
  if (typeof value !== 'string') fail('notifications/invalid', `Template ${name} must be text`)
  if (value.length > limit) fail('notifications/invalid', `Template ${name} is too large`)
  return value
}

const checkEnabled = (enabled) => {
  if (typeof enabled !== 'boolean') fail('notifications/invalid', 'Template enabled must be a boolean')
  return enabled
}

// Placeholder names in first-seen order; any other brace is a malformed template.
const placeholders = (subject, body) => {
  const found = []
  for (const text of [subject, body]) {
    const remainder = text.replaceAll(PLACEHOLDER, '')
    if (remainder.includes('{') || remainder.includes('}')) fail('notifications/invalid', 'Malformed template placeholder')
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!found.includes(match[1])) found.push(match[1])
    }
  }
  if (found.length > MAX_VARIABLES) fail('notifications/invalid', 'Too many template variables')
  return found
}

const normalizeVariables = (variables) => {
  if (variables === undefined || variables === null) return null
  if (!Array.isArray(variables)) fail('notifications/invalid', 'Template variables must be a sequence of names')
  if (variables.length > MAX_VARIABLES) fail('notifications/invalid', 'Too many template variables')
  const result = []
  for (const name of variables) {
    if (typeof name !== 'string' || !VARIABLE.test(name)) fail('notifications/invalid', 'Invalid template variable name')
    if (!result.includes(name)) result.push(name)
  }
  return result
}

const decodeVariables = (raw) => {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : []
  } catch {
    return []
  }
}

export function templateView(row) {
  return {
    id: row.id, owner_id: row.owner_id, kind: row.kind, locale: row.locale, version: row.version,
    subject: row.subject, body: row.body, variables: decodeVariables(row.variables),
    enabled: row.enabled === 1, created: row.created,
  }
}

// Store one immutable version. Re-registering identical content is idempotent;
// changing any of it under the same version is refused so history stays honest.
export function registerTemplate(store, owner, input, now) {
  const kind = checkKind(input.kind)
  const locale = checkLocale(input.locale)
  const version = checkVersion(input.version)
  const subject = checkText('subject', input.subject, MAX_SUBJECT)
  const body = checkText('body', input.body, MAX_BODY)
  const enabled = checkEnabled(input.enabled === undefined ? true : input.enabled)
  const found = placeholders(subject, body)
  const declared = normalizeVariables(input.variables)
  const variables = declared === null ? found : declared
  for (const name of found) {
    if (!variables.includes(name)) fail('notifications/invalid', `Placeholder not declared as a variable: ${name}`)
  }
  const encoded = JSON.stringify(variables)
  return store.transaction(() => {
    const existing = store.get('SELECT * FROM notification_templates WHERE owner_id=? AND kind=? AND locale=? AND version=?', owner, kind, locale, version)
    if (existing) {
      const identical = existing.subject === subject && existing.body === body
        && JSON.stringify(decodeVariables(existing.variables)) === encoded
        && existing.enabled === (enabled ? 1 : 0)
      if (identical) return templateView(existing)
      fail('notifications/invalid', 'Notification template version is immutable')
    }
    const id = randomUUID().replaceAll('-', '')
    store.run('INSERT INTO notification_templates (id,owner_id,kind,locale,version,subject,body,variables,enabled,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, owner, kind, locale, version, subject, body, encoded, enabled ? 1 : 0, now)
    return templateView(store.get('SELECT * FROM notification_templates WHERE id=?', id))
  })
}

// Stored versions, newest first per kind/locale; disabled rows remain visible.
export function listTemplates(store, owner, kind, locale) {
  const clauses = ['owner_id=?']
  const args = [owner]
  if (kind !== undefined && kind !== null) { clauses.push('kind=?'); args.push(checkKind(kind)) }
  if (locale !== undefined && locale !== null) { clauses.push('locale=?'); args.push(checkLocale(locale)) }
  return store.all(`SELECT * FROM notification_templates WHERE ${clauses.join(' AND ')} ORDER BY kind, locale, version DESC, id`, ...args).map(templateView)
}

// Disable one version, or the newest enabled one when version is omitted.
export function disableTemplate(store, owner, kind, locale, version) {
  const checkedKind = checkKind(kind)
  const checkedLocale = checkLocale(locale)
  let target = version
  if (target === undefined || target === null) {
    const row = store.get('SELECT version FROM notification_templates WHERE owner_id=? AND kind=? AND locale=? AND enabled=1 ORDER BY version DESC LIMIT 1', owner, checkedKind, checkedLocale)
    if (!row) return false
    target = row.version
  } else {
    target = checkVersion(target)
  }
  return store.run('UPDATE notification_templates SET enabled=0 WHERE owner_id=? AND kind=? AND locale=? AND version=? AND enabled=1',
    owner, checkedKind, checkedLocale, target).changes > 0
}

const builtinFor = (kind, locale) => BUILTIN[kind]?.[locale] ?? null

const dbFor = (store, owner, kind, locale) => {
  const row = store.get('SELECT * FROM notification_templates WHERE owner_id=? AND kind=? AND locale=? AND enabled=1 ORDER BY version DESC LIMIT 1', owner, kind, locale)
  return row ? templateView(row) : null
}

const coerceValues = (values) => {
  if (values === undefined || values === null) return {}
  if (typeof values !== 'object' || Array.isArray(values)) fail('notifications/invalid', 'Template values must be an object')
  const supplied = Object.create(null)
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') supplied[name] = value
    else if (typeof value === 'number' && Number.isFinite(value)) supplied[name] = String(value)
    else if (typeof value === 'boolean') supplied[name] = String(value)
    else fail('notifications/invalid', 'Template values must be text or scalar numbers')
    if (supplied[name].length > MAX_VALUE) fail('notifications/invalid', 'Template value is too large')
  }
  return supplied
}

const renderTemplate = (template, supplied) => {
  const missing = template.variables.filter((name) => !Object.hasOwn(supplied, name))
  if (missing.length > 0) fail('notifications/invalid', `Missing template values: ${missing.join(', ')}`)
  const substitute = (text) => text.replaceAll(PLACEHOLDER, (match, name) => (Object.hasOwn(supplied, name) ? escapeValue(supplied[name]) : match))
  return { subject: substitute(template.subject), body: substitute(template.body) }
}

// Resolve one kind through the locale chain and render it. A template stored by
// this owner wins over the built-in one; ``fallback`` is caller-supplied plain
// text used only when no template exists for the kind at all.
export function render(store, owner, input, now) {
  const kind = checkKind(input.kind)
  const locale = normalizeLocale(checkLocale(input.locale))
  const supplied = coerceValues(input.values)
  let chosen = null
  for (const candidate of localeChain(locale)) {
    const stored = dbFor(store, owner, kind, candidate)
    if (stored) { chosen = { ...stored, source: 'db' }; break }
    const builtin = builtinFor(kind, candidate)
    if (builtin) { chosen = { ...builtin, locale: candidate, source: 'builtin' }; break }
  }
  if (!chosen) {
    const fallback = input.fallback
    if (fallback === undefined || fallback === null) fail('notifications/not-found', `No notification template for ${kind}/${locale}`)
    if (typeof fallback !== 'object' || Array.isArray(fallback)) fail('notifications/invalid', 'Template fallback must be an object')
    return {
      kind, locale,
      subject: checkText('fallback subject', fallback.subject, MAX_SUBJECT),
      body: checkText('fallback body', fallback.body, MAX_BODY),
      source: 'fallback',
    }
  }
  const rendered = renderTemplate(chosen, supplied)
  return {
    kind, locale: chosen.locale, source: chosen.source,
    ...(chosen.version === undefined ? {} : { version: chosen.version }),
    ...rendered,
  }
}
