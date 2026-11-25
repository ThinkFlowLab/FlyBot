// Versioned prompt-template library: this owner's saved prompts with immutable
// versions, tags, scope and non-evaluating {{variable}} rendering. It lives on
// the user's own DS-Bot volume under /data/flybot-workspace/features/prompts/ and is
// served through the plugin endpoint contract
// (docs/DSBOT_PLUGIN_ARCHITECTURE.md §2.1): POST /api/flybot-workspace
// {endpoint: "prompts/<op>", payload}.
//
// It replaces the platform module flybot-workspace/prompts.py from the first version
// of this PR. That module was never wired into app.py (no route, no schema init,
// no page), so no platform endpoint is retired here and no legacy bundle exists
// to import: the plugin endpoints below are the first reachable surface for the
// capability, and the tables start empty on every volume.
//
// Kept as its own feature rather than folded into features/agents: an agent is a
// DS-Bot persona (instructions, quick starts, its own conversations), while a
// prompt template is a reusable piece of user text with an independent version
// history, tags and rendering. Merging them would put a second version lifecycle
// inside the agents tables and tie prompt history to persona edits; §2.1 makes
// one directory per capability the normal seam.
//
// Scope keeps the retired module's words, private or workspace, so imported or
// future data keeps its meaning. This volume has exactly one owner: both scopes
// belong to whoever runs this DS-Bot, nothing is shared cross-user here, and the
// scope filter only labels intent. Chat uses private templates for reusable drafts.
//
// Rendering is plain substitution of {{name}} with a bounded regular expression.
// It never evaluates the body, formats it, renders HTML or sends it anywhere, and
// braces in a supplied value stay data.
//
// Versions are append-only, enforced twice: no endpoint writes to an existing
// version row, and the schema carries a trigger that aborts any such UPDATE. A
// version snapshots the title as well as the body and variables, so an old
// version reads back whole (the retired module kept only the body).
//
// Endpoints: prompts/<op> — create, get, list, update, versions, version,
// render, archive, delete.
import { FeatureError, newId, nowSeconds } from '../../featurekit/http.js'
import { defineFeature } from '../../featurekit/feature.js'

export const TITLE_MAX = 200
export const BODY_MAX = 20_000
export const VARIABLES_MAX = 100
export const TAGS_MAX = 20
export const TAG_MAX = 40
export const QUERY_MAX = 200
export const LIMIT_DEFAULT = 50
export const LIMIT_MAX = 100
export const MAX_VERSIONS = 100
export const MAX_PROMPTS = 1000
export const SCOPES = ['private', 'workspace']

const CURSOR_MAX = 512
const CHANGE_FIELDS = ['title', 'body', 'variables', 'tags', 'scope']
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const PLACEHOLDER_SOURCE = '\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]{0,63})\\s*\\}\\}'
const likeEscape = (text) => text.replace(/\\/g, () => '\\\\').replace(/%/g, () => '\\%').replace(/_/g, () => '\\_')

export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS prompt_templates (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 variables TEXT NOT NULL DEFAULT '[]',
 tags TEXT NOT NULL DEFAULT '[]',
 scope TEXT NOT NULL CHECK(scope IN ('private','workspace')),
 current_version INTEGER NOT NULL CHECK(current_version >= 1),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS prompt_template_owner
 ON prompt_templates(owner_id, archived, id);
CREATE INDEX IF NOT EXISTS prompt_template_title
 ON prompt_templates(owner_id, title);
CREATE TABLE IF NOT EXISTS prompt_versions (
 prompt_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version >= 1),
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 variables TEXT NOT NULL DEFAULT '[]',
 created_by TEXT NOT NULL,
 created INTEGER NOT NULL,
 PRIMARY KEY(prompt_id, version));
CREATE INDEX IF NOT EXISTS prompt_version_prompt
 ON prompt_versions(prompt_id, version);
CREATE TRIGGER IF NOT EXISTS prompt_versions_immutable
 BEFORE UPDATE ON prompt_versions
 BEGIN SELECT RAISE(ABORT, 'prompt versions are immutable'); END;
`]

const invalid = (message) => { throw new FeatureError(400, 'prompts/invalid', message) }
const notFound = (message) => { throw new FeatureError(404, 'prompts/not-found', message) }
const conflict = (message) => { throw new FeatureError(409, 'prompts/conflict', message) }
const forbidden = (message) => { throw new FeatureError(403, 'prompts/forbidden', message) }

// Same rule as the retired module: printable text, no C0 controls (except tab,
// newline and carriage return in a body), no DEL, no C1 controls, no lone
// surrogates. Length is counted in UTF-16 units, which is stricter for astral
// characters than the Python original's code points.
function validText(value, maximum, newlines = false) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return false
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code < 32 && !(newlines && (character === '\n' || character === '\r' || character === '\t'))) return false
    if (code === 127 || (code >= 0x80 && code <= 0x9f)) return false
    if (code >= 0xd800 && code <= 0xdfff) return false
  }
  return true
}

function title(value) {
  if (!validText(value, TITLE_MAX)) invalid('title must be bounded printable text')
  const text = value.trim()
  if (!text) invalid('title must not be blank')
  return text
}

function body(value) {
  if (!validText(value, BODY_MAX, true)) invalid('body must be bounded text')
  return value
}

// Variable names come from {{name}} placeholders; every brace left outside one
// is a malformed placeholder, including the single-brace {name} form.
function extractVariables(text) {
  const names = []
  const seen = new Set()
  let last = 0
  let remainder = ''
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    remainder += text.slice(last, match.index)
    last = match.index + match[0].length
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  remainder += text.slice(last)
  if (remainder.includes('{') || remainder.includes('}')) {
    invalid('malformed placeholder; use {{name}} with short variable names')
  }
  if (names.length > VARIABLES_MAX) invalid('too many variables')
  return names
}

function variables(value, text) {
  const extracted = extractVariables(text)
  if (value === undefined || value === null) return extracted
  if (!Array.isArray(value) || value.length > VARIABLES_MAX) {
    invalid('variables must be a bounded list of short names')
  }
  const names = []
  const seen = new Set()
  for (const name of value) {
    if (typeof name !== 'string' || !VAR_NAME.test(name) || seen.has(name)) {
      invalid('variables must be unique short names')
    }
    seen.add(name)
    names.push(name)
  }
  if (names.length !== extracted.length || names.some((name) => !extracted.includes(name))) {
    invalid('declared variables must match the body placeholders')
  }
  return names
}

function tags(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > TAGS_MAX) invalid('tags must be a bounded list')
  const result = []
  const seen = new Set()
  for (const tag of value) {
    if (typeof tag !== 'string') invalid('tags must be text')
    const text = tag.trim()
    if (!validText(text, TAG_MAX)) invalid('tag must be bounded printable text')
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function scope(value) {
  if (value === undefined) return 'private'
  if (!SCOPES.includes(value)) invalid('scope must be private or workspace')
  return value
}

function filterScope(value) {
  if (value === undefined || value === null) return null
  if (!SCOPES.includes(value)) invalid('scope must be private or workspace')
  return value
}

const jsonList = (raw) => {
  try {
    const value = JSON.parse(raw ?? '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export function view(row) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    title: row.title,
    body: row.body,
    variables: jsonList(row.variables),
    tags: jsonList(row.tags),
    scope: row.scope,
    current_version: row.current_version,
    version: row.current_version,
    archived: Boolean(row.archived),
    created: row.created,
    updated: row.updated,
  }
}

const versionView = (row) => ({
  prompt_id: row.prompt_id,
  version: row.version,
  title: row.title,
  body: row.body,
  variables: jsonList(row.variables),
  created_by: row.created_by,
  created: row.created,
})

function encodeCursor(titleKey, id) {
  return Buffer.from(JSON.stringify({ title: titleKey, id }), 'utf8').toString('base64url')
}

function decodeCursor(token) {
  if (typeof token !== 'string' || !token || token.length > CURSOR_MAX) invalid('invalid cursor')
  let value
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch { invalid('invalid cursor') }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'title'
      || typeof value.title !== 'string' || typeof value.id !== 'string' || !value.id) invalid('invalid cursor')
  return { title: value.title, id: value.id }
}

function loadPrompt(store, owner, id) {
  if (typeof id !== 'string' || !id || id.length > 64) invalid('prompt id is required')
  const row = store.get('SELECT * FROM prompt_templates WHERE id=?', id)
  if (!row) notFound('prompt not found')
  if (row.owner_id !== owner) forbidden('prompt belongs to another owner')
  return row
}

function loadVersion(store, owner, id, number) {
  loadPrompt(store, owner, id)
  if (!Number.isInteger(number) || number < 1) invalid('version must be a positive integer')
  const row = store.get('SELECT * FROM prompt_versions WHERE prompt_id=? AND version=?', id, number)
  if (!row) notFound('prompt version not found')
  return row
}

function insertVersion(store, id, version, promptTitle, promptBody, promptVariables, owner, now) {
  store.run(
    'INSERT INTO prompt_versions (prompt_id,version,title,body,variables,created_by,created) VALUES(?,?,?,?,?,?,?)',
    id, version, promptTitle, promptBody, JSON.stringify(promptVariables), owner, now,
  )
}

export function createPrompt(store, owner, payload, now = nowSeconds()) {
  const promptTitle = title(payload?.title)
  const promptBody = body(payload?.body)
  const promptVariables = variables(payload?.variables, promptBody)
  const promptTags = tags(payload?.tags)
  const promptScope = scope(payload?.scope)
  const id = newId()
  store.transaction(() => {
    const count = store.get('SELECT COUNT(*) AS n FROM prompt_templates WHERE owner_id=?', owner).n
    if (count >= MAX_PROMPTS) invalid('prompt limit reached')
    store.run(
      'INSERT INTO prompt_templates (id,owner_id,title,body,variables,tags,scope,current_version,archived,created,updated) '
      + 'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, owner, promptTitle, promptBody, JSON.stringify(promptVariables), JSON.stringify(promptTags),
      promptScope, 1, 0, now, now,
    )
    insertVersion(store, id, 1, promptTitle, promptBody, promptVariables, owner, now)
  })
  return view(loadPrompt(store, owner, id))
}

export function getPrompt(store, owner, id) {
  return view(loadPrompt(store, owner, id))
}

export function listPrompts(store, owner, options = {}) {
  const limit = options.limit === undefined || options.limit === null ? LIMIT_DEFAULT : options.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
    invalid(`limit must be an integer from 1 to ${LIMIT_MAX}`)
  }
  const where = ['owner_id=?', 'archived=0']
  const params = [owner]
  const wanted = filterScope(options.scope)
  if (wanted) {
    where.push('scope=?')
    params.push(wanted)
  }
  if (options.tag !== undefined && options.tag !== null) {
    if (typeof options.tag !== 'string') invalid('tag must be text')
    const text = options.tag.trim()
    if (!validText(text, TAG_MAX)) invalid('tag is invalid')
    where.push('EXISTS (SELECT 1 FROM json_each(prompt_templates.tags) j WHERE lower(j.value)=lower(?))')
    params.push(text)
  }
  if (options.query !== undefined && options.query !== null) {
    if (typeof options.query !== 'string') invalid('query must be text')
    const text = options.query.trim()
    if (text.length > QUERY_MAX) invalid('query is too long')
    if (text) {
      const pattern = '%' + likeEscape(text.toLowerCase()) + '%'
      where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\' "
        + "OR EXISTS (SELECT 1 FROM json_each(prompt_templates.tags) j WHERE lower(j.value) LIKE ? ESCAPE '\\'))")
      params.push(pattern, pattern, pattern)
    }
  }
  if (options.cursor !== undefined && options.cursor !== null) {
    const { title: titleKey, id } = decodeCursor(options.cursor)
    where.push('(lower(title)>? OR (lower(title)=? AND id>?))')
    params.push(titleKey, titleKey, id)
  }
  const rows = store.all(
    'SELECT *, lower(title) AS sort_title FROM prompt_templates WHERE ' + where.join(' AND ')
    + ' ORDER BY lower(title), id LIMIT ?',
    ...params, limit + 1,
  )
  let items = rows
  let cursor = null
  if (rows.length > limit) {
    items = rows.slice(0, limit)
    const last = items[items.length - 1]
    cursor = encodeCursor(last.sort_title, last.id)
  }
  return { items: items.map(view), cursor }
}

export function updatePrompt(store, owner, id, changes, expectedVersion, now = nowSeconds()) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    invalid('changes must be a non-empty object')
  }
  if (Object.keys(changes).some((key) => !CHANGE_FIELDS.includes(key))) invalid('unsupported prompt field')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    invalid('expected version must be a positive integer')
  }
  let result
  store.transaction(() => {
    const row = loadPrompt(store, owner, id)
    if (row.current_version !== expectedVersion) conflict('prompt changed; reload before updating')
    if (row.current_version >= MAX_VERSIONS) invalid('prompt version limit reached')
    const nextTitle = 'title' in changes ? title(changes.title) : row.title
    const nextBody = 'body' in changes ? body(changes.body) : row.body
    const nextVariables = 'variables' in changes ? variables(changes.variables, nextBody)
      : 'body' in changes ? variables(undefined, nextBody) : jsonList(row.variables)
    const nextTags = 'tags' in changes ? tags(changes.tags) : jsonList(row.tags)
    const nextScope = 'scope' in changes ? scope(changes.scope) : row.scope
    const version = row.current_version + 1
    const changed = store.run(
      'UPDATE prompt_templates SET title=?,body=?,variables=?,tags=?,scope=?,current_version=?,updated=? '
      + 'WHERE id=? AND owner_id=? AND current_version=?',
      nextTitle, nextBody, JSON.stringify(nextVariables), JSON.stringify(nextTags), nextScope,
      version, now, id, owner, row.current_version,
    )
    if (changed.changes !== 1) conflict('prompt changed; reload before updating')
    insertVersion(store, id, version, nextTitle, nextBody, nextVariables, owner, now)
    result = view(loadPrompt(store, owner, id))
  })
  return result
}

export function listVersions(store, owner, id) {
  loadPrompt(store, owner, id)
  return store.all('SELECT * FROM prompt_versions WHERE prompt_id=? ORDER BY version', id).map(versionView)
}

export function getVersion(store, owner, id, number) {
  return versionView(loadVersion(store, owner, id, number))
}

export function renderPrompt(store, owner, id, values, number) {
  const row = loadPrompt(store, owner, id)
  let promptBody = row.body
  let promptVariables = jsonList(row.variables)
  if (number !== undefined && number !== null) {
    const pinned = loadVersion(store, owner, id, number)
    promptBody = pinned.body
    promptVariables = jsonList(pinned.variables)
  }
  const supplied = values === undefined || values === null ? {} : values
  if (typeof supplied !== 'object' || Array.isArray(supplied)) invalid('values must be an object')
  for (const [key, value] of Object.entries(supplied)) {
    if (typeof key !== 'string' || typeof value !== 'string') invalid('variable names and values must be text')
  }
  const missing = promptVariables.filter((name) => !Object.hasOwn(supplied, name))
  const placeholders = new RegExp(PLACEHOLDER_SOURCE, 'g')
  let length = promptBody.length
  for (const [placeholder, name] of promptBody.matchAll(placeholders)) {
    if (Object.hasOwn(supplied, name)) length += supplied[name].length - placeholder.length
  }
  if (length > BODY_MAX) invalid('rendered prompt exceeds the body limit')
  const text = promptBody.replace(placeholders,
    (match, name) => (Object.hasOwn(supplied, name) ? supplied[name] : match))
  return { text, missing }
}

export function archivePrompt(store, owner, id, archived = true, now = nowSeconds()) {
  if (typeof archived !== 'boolean') invalid('archived must be a boolean')
  store.transaction(() => {
    loadPrompt(store, owner, id)
    store.run('UPDATE prompt_templates SET archived=?, updated=? WHERE id=? AND owner_id=?',
      archived ? 1 : 0, now, id, owner)
  })
  return view(loadPrompt(store, owner, id))
}

export function deletePrompt(store, owner, id) {
  loadPrompt(store, owner, id)
  store.transaction(() => {
    store.run('DELETE FROM prompt_versions WHERE prompt_id=?', id)
    store.run('DELETE FROM prompt_templates WHERE id=? AND owner_id=?', id, owner)
  })
  return true
}

export default defineFeature({
  name: 'prompts',
  migrations: MIGRATIONS,
  endpoints: ({ store, owner }) => ({
    async create(payload) { return { prompt: createPrompt(store, owner, payload) } },
    async get(payload) { return { prompt: getPrompt(store, owner, payload?.id) } },
    async list(payload) { return listPrompts(store, owner, payload ?? {}) },
    async update(payload) {
      return { prompt: updatePrompt(store, owner, payload?.id, payload?.changes, payload?.expected_version) }
    },
    async versions(payload) { return { items: listVersions(store, owner, payload?.id) } },
    async version(payload) { return { version: getVersion(store, owner, payload?.id, payload?.version) } },
    async render(payload) {
      return renderPrompt(store, owner, payload?.id, payload?.values, payload?.version)
    },
    async archive(payload) {
      const archived = payload?.archived === undefined ? true : payload.archived
      return { prompt: archivePrompt(store, owner, payload?.id, archived) }
    },
    async delete(payload) { return { deleted: deletePrompt(store, owner, payload?.id) } },
  }),
})
