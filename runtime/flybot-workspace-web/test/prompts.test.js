// Versioned prompt-template library inside the user's own DS-Bot. The volume
// here is a fresh temp dir, so every test starts from an empty library.
//
// What these tests pin, beyond CRUD:
//   * a saved version is immutable — no endpoint and no raw UPDATE can rewrite
//     an existing version row; every save appends a new one,
//   * any version can be read back on its own, and rendering can be pinned to
//     it, so an old version is usable after the prompt moved on,
//   * delete removes the template and every version with it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'

// The declared per-prompt version ceiling; kept here as a literal so the test
// file runs against an unimplemented feature and fails on behaviour, not import.
const MAX_VERSIONS = 100

const call = (bot, op, payload) => bot.endpoint(`prompts/${op}`, payload)
const ok = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, `${op} failed: ${JSON.stringify(result.error)}`)
  return result.value
}
const fails = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `${op} was expected to fail but returned ${JSON.stringify(result.value)}`)
  assert.equal(result.error.code, code, `${op} error code: ${JSON.stringify(result.error)}`)
  return result.error
}

const created = async (bot, payload = {}) => (await ok(bot, 'create', {
  title: 'Greeting', body: 'Hi {{name}} at {{place}}', ...payload,
})).prompt

const dbFile = (vol) => join(vol.data, 'flybot-workspace', 'features', 'prompts', 'prompts.sqlite3')

test('migrations are idempotent and this owner keeps its prompts across a reboot', async () => {
  const vol = volume()
  const first = await boot(vol)
  const prompt = await created(first, { tags: ['writing'] })
  assert.equal((await ok(first, 'list', {})).items.length, 1)

  // Same volume, fresh plugin boot: migrate runs again and must not lose or duplicate anything.
  const second = await boot(vol)
  const again = (await ok(second, 'get', { id: prompt.id })).prompt
  assert.equal(again.body, 'Hi {{name}} at {{place}}')
  assert.deepEqual(again.tags, ['writing'])
  assert.equal(again.current_version, 1)
  assert.equal((await ok(second, 'list', {})).items.length, 1)
  assert.equal((await ok(second, 'versions', { id: prompt.id })).items.length, 1)

  const db = new DatabaseSync(dbFile(vol))
  const objects = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','trigger')").all()
  const names = new Set(objects.map((row) => row.name))
  assert.ok(names.has('prompt_templates') && names.has('prompt_versions'), [...names].join(','))
  assert.ok(objects.some((row) => row.type === 'trigger' && /version/i.test(row.name)),
    'the schema guards version rows with a trigger')
  const applied = db.prepare("SELECT COUNT(*) AS n FROM ot_feature_migrations WHERE feature='prompts'").get()
  assert.equal(applied.n, 1)
  db.close()
})

test('create stores version 1 with extracted variables and deduped tags', async () => {
  const bot = await boot()
  const prompt = await created(bot, {
    title: '  Greeting  ', body: 'Hello {{ name }} and {{place}}', tags: ['Writing', 'work', 'Writing'],
  })
  assert.equal(prompt.title, 'Greeting')
  assert.equal(prompt.body, 'Hello {{ name }} and {{place}}')
  assert.deepEqual(prompt.variables, ['name', 'place'])
  assert.deepEqual(prompt.tags, ['Writing', 'work'])
  assert.equal(prompt.scope, 'private')
  assert.equal(prompt.current_version, 1)
  assert.equal(prompt.version, 1)
  assert.equal(prompt.archived, false)
  assert.ok(prompt.created > 0 && prompt.created === prompt.updated)
  assert.match(prompt.id, /^[0-9a-f]{32}$/)

  const [only] = (await ok(bot, 'versions', { id: prompt.id })).items
  assert.equal(only.version, 1)
  assert.equal(only.title, 'Greeting')
  assert.equal(only.body, prompt.body)
  assert.deepEqual(only.variables, ['name', 'place'])
  assert.equal(only.prompt_id, prompt.id)
  assert.ok(only.created > 0)
})

test('a saved version is immutable: each save appends one and old rows never change', async () => {
  const vol = volume()
  const bot = await boot(vol)
  const made = await created(bot)
  const v1 = (await ok(bot, 'versions', { id: made.id })).items[0]

  const v2 = (await ok(bot, 'update', {
    id: made.id, changes: { title: 'Renamed', body: 'Second {{topic}}' }, expected_version: 1,
  })).prompt
  assert.equal(v2.current_version, 2)
  assert.equal(v2.title, 'Renamed')
  assert.deepEqual(v2.variables, ['topic'])

  const v3 = (await ok(bot, 'update', {
    id: made.id, changes: { body: 'Third' }, expected_version: 2,
  })).prompt
  assert.equal(v3.current_version, 3)

  const versions = (await ok(bot, 'versions', { id: made.id })).items
  assert.deepEqual(versions.map((row) => row.version), [1, 2, 3])
  assert.deepEqual(versions.map((row) => row.body), ['Hi {{name}} at {{place}}', 'Second {{topic}}', 'Third'])
  assert.deepEqual(versions.map((row) => row.title), ['Greeting', 'Renamed', 'Renamed'])
  assert.deepEqual(versions[0], v1, 'version 1 is exactly what was stored at creation')

  // The guard is in the schema, not only in the endpoints: a raw UPDATE of a
  // version row is refused, and the row is unchanged afterwards.
  const db = new DatabaseSync(dbFile(vol))
  assert.throws(
    () => db.prepare('UPDATE prompt_versions SET body=? WHERE prompt_id=? AND version=1').run('tampered', made.id),
    /immutable/,
  )
  assert.equal(db.prepare('SELECT body FROM prompt_versions WHERE prompt_id=? AND version=1').get(made.id).body,
    'Hi {{name}} at {{place}}')
  db.close()
  assert.equal((await ok(bot, 'versions', { id: made.id })).items[0].body, 'Hi {{name}} at {{place}}')
})

test('any version can be fetched by number, and bad numbers are refused', async () => {
  const bot = await boot()
  const made = await created(bot)
  await ok(bot, 'update', { id: made.id, changes: { body: 'Moved on' }, expected_version: 1 })

  const first = (await ok(bot, 'version', { id: made.id, version: 1 })).version
  assert.equal(first.version, 1)
  assert.equal(first.body, 'Hi {{name}} at {{place}}')
  assert.deepEqual(first.variables, ['name', 'place'])
  const second = (await ok(bot, 'version', { id: made.id, version: 2 })).version
  assert.equal(second.body, 'Moved on')
  assert.deepEqual(second.variables, [])
  assert.equal((await ok(bot, 'get', { id: made.id })).prompt.body, 'Moved on')

  await fails(bot, 'version', { id: made.id, version: 99 }, 'prompts/not-found')
  for (const version of [0, -1, '1', 1.5, null]) {
    await fails(bot, 'version', { id: made.id, version }, 'prompts/invalid')
  }
})

test('a stale expected_version is a conflict that changes nothing', async () => {
  const bot = await boot()
  const made = await created(bot)
  await ok(bot, 'update', { id: made.id, changes: { body: 'Second' }, expected_version: 1 })

  await fails(bot, 'update', { id: made.id, changes: { title: 'Stale' }, expected_version: 1 }, 'prompts/conflict')
  const after = (await ok(bot, 'get', { id: made.id })).prompt
  assert.equal(after.title, 'Greeting')
  assert.equal(after.body, 'Second')
  assert.equal(after.current_version, 2)
  assert.equal((await ok(bot, 'versions', { id: made.id })).items.length, 2)

  await fails(bot, 'update', { id: made.id, changes: { unknown: 1 }, expected_version: 2 }, 'prompts/invalid')
  await fails(bot, 'update', { id: made.id, changes: {}, expected_version: 2 }, 'prompts/invalid')
  await fails(bot, 'update', { id: made.id, changes: { body: 'x' } }, 'prompts/invalid')
  await fails(bot, 'update', { id: made.id, changes: { body: 'x' }, expected_version: 0 }, 'prompts/invalid')
  await fails(bot, 'update', { id: made.id, changes: { body: 'x' }, expected_version: 2.5 }, 'prompts/invalid')
  assert.equal((await ok(bot, 'get', { id: made.id })).prompt.current_version, 2)
})

test('render substitutes values without evaluating them and pins a version', async () => {
  const bot = await boot()
  const made = await created(bot, { body: 'Hi {{name}}, meet {{topic}}.' })

  assert.deepEqual(await ok(bot, 'render', { id: made.id, values: { name: 'Ada', topic: 'SQL', extra: 'ignored' } }),
    { text: 'Hi Ada, meet SQL.', missing: [] })
  const missing = await ok(bot, 'render', { id: made.id, values: { name: 'Ada' } })
  assert.deepEqual(missing.missing, ['topic'])
  assert.equal(missing.text, 'Hi Ada, meet {{topic}}.')
  assert.deepEqual((await ok(bot, 'render', { id: made.id, values: {} })).missing, ['name', 'topic'])

  // Values are data, never a template: braces in a value are left alone.
  assert.equal((await ok(bot, 'render', { id: made.id, values: { name: '{{topic}}', topic: 'x' } })).text,
    'Hi {{topic}}, meet x.')
  await fails(bot, 'render', { id: made.id, values: [] }, 'prompts/invalid')
  await fails(bot, 'render', { id: made.id, values: { name: 1, topic: 'SQL' } }, 'prompts/invalid')

  await ok(bot, 'update', { id: made.id, changes: { body: 'Updated {{name}}' }, expected_version: 1 })
  assert.equal((await ok(bot, 'render', { id: made.id, values: { name: 'Ada', topic: 'SQL' } })).text,
    'Updated Ada')
  assert.equal((await ok(bot, 'render', { id: made.id, values: { name: 'Ada', topic: 'SQL' }, version: 1 })).text,
    'Hi Ada, meet SQL.')
  await fails(bot, 'render', { id: made.id, values: { name: 'Ada' }, version: 99 }, 'prompts/not-found')
  await fails(bot, 'render', { id: 'f'.repeat(32), values: {} }, 'prompts/not-found')
})

test('render rejects an expansion over the prompt body limit', async () => {
  const bot = await boot()
  const prompt = await created(bot, {body: '{{x}} {{x}}'})
  await fails(bot, 'render', {id: prompt.id, values: {x: 'x'.repeat(15_000)}}, 'prompts/invalid')
  const rendered = await ok(bot, 'render', {id: prompt.id, values: {x: 'x'.repeat(9_999)}})
  assert.equal(rendered.text.length, 19_999)
})

test('list filters by scope, tag and query and pages by cursor', async () => {
  const bot = await boot()
  const alpha = await created(bot, { title: 'Alpha notes', body: 'About {{topic}}', tags: ['Work'] })
  const beta = await created(bot, { title: 'Beta brief', body: 'Meeting agenda', tags: ['work', 'urgent'] })
  const gamma = await created(bot, { title: 'Gamma', body: 'unrelated', tags: ['life'] })
  const delta = await created(bot, { title: 'Delta shared', body: 'meeting shared', tags: ['Work'], scope: 'workspace' })

  const ids = async (payload) => (await ok(bot, 'list', payload)).items.map((row) => row.id)
  assert.deepEqual(new Set(await ids({ scope: 'private' })), new Set([alpha.id, beta.id, gamma.id]))
  assert.deepEqual(await ids({ scope: 'workspace' }), [delta.id])
  assert.deepEqual(new Set(await ids({ tag: 'WORK' })), new Set([alpha.id, beta.id, delta.id]))
  assert.deepEqual(new Set(await ids({ query: 'MEETING' })), new Set([beta.id, delta.id]))
  assert.deepEqual(new Set(await ids({ query: 'work' })), new Set([alpha.id, beta.id, delta.id]))

  const everyone = await ids({})
  const seen = []
  let cursor = null
  let pages = 0
  do {
    const page = await ok(bot, 'list', { limit: 3, ...(cursor ? { cursor } : {}) })
    assert.ok(page.items.length <= 3)
    seen.push(...page.items.map((row) => row.id))
    cursor = page.cursor
    pages += 1
  } while (cursor)
  assert.deepEqual(seen, everyone)
  assert.equal(pages, 2)

  for (const bad of ['not-a-cursor', 'e30', 7]) await fails(bot, 'list', { cursor: bad }, 'prompts/invalid')
  for (const limit of [0, 101, true, '2']) await fails(bot, 'list', { limit }, 'prompts/invalid')
  await fails(bot, 'list', { query: 'q'.repeat(201) }, 'prompts/invalid')
  await fails(bot, 'list', { scope: 'public' }, 'prompts/invalid')
  await fails(bot, 'list', { tag: 'x'.repeat(41) }, 'prompts/invalid')
})

test('archive hides a prompt from lists but keeps it readable', async () => {
  const bot = await boot()
  const made = await created(bot)
  assert.equal((await ok(bot, 'list', {})).items.length, 1)

  const archived = (await ok(bot, 'archive', { id: made.id })).prompt
  assert.equal(archived.archived, true)
  assert.ok(archived.updated >= made.updated)
  assert.deepEqual((await ok(bot, 'list', {})).items, [])
  const still = (await ok(bot, 'get', { id: made.id })).prompt
  assert.equal(still.archived, true)
  assert.equal(still.body, made.body)
  assert.equal((await ok(bot, 'render', { id: made.id, values: { name: 'Ada', place: 'X' } })).text, 'Hi Ada at X')

  const restored = (await ok(bot, 'archive', { id: made.id, archived: false })).prompt
  assert.equal(restored.archived, false)
  assert.equal((await ok(bot, 'list', {})).items.length, 1)
  await fails(bot, 'archive', { id: made.id, archived: 'yes' }, 'prompts/invalid')
  await fails(bot, 'archive', { id: 'f'.repeat(32) }, 'prompts/not-found')
})

test('delete removes the template and every version with it', async () => {
  const vol = volume()
  const bot = await boot(vol)
  const made = await created(bot)
  await ok(bot, 'update', { id: made.id, changes: { body: 'Second' }, expected_version: 1 })

  assert.deepEqual(await ok(bot, 'delete', { id: made.id }), { deleted: true })
  await fails(bot, 'get', { id: made.id }, 'prompts/not-found')
  await fails(bot, 'versions', { id: made.id }, 'prompts/not-found')
  await fails(bot, 'delete', { id: made.id }, 'prompts/not-found')
  await fails(bot, 'render', { id: made.id, values: {} }, 'prompts/not-found')
  assert.equal((await ok(bot, 'list', {})).items.length, 0)

  const db = new DatabaseSync(dbFile(vol))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_templates').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_versions').get().n, 0)
  db.close()
})

test('a row left by another owner is invisible and cannot be touched', async () => {
  const vol = volume()
  const bot = await boot(vol)
  const mine = await created(bot, { title: 'Mine' })

  const db = new DatabaseSync(dbFile(vol))
  db.prepare('INSERT INTO prompt_templates (id,owner_id,title,body,variables,tags,scope,current_version,archived,created,updated) '
    + 'VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('f'.repeat(32), 'another-owner', 'Theirs', 'secret', '[]', '[]', 'workspace', 1, 0, 1, 1)
  db.prepare('INSERT INTO prompt_versions (prompt_id,version,title,body,variables,created_by,created) VALUES(?,?,?,?,?,?,?)')
    .run('f'.repeat(32), 1, 'Theirs', 'secret', '[]', 'another-owner', 1)
  db.close()

  assert.deepEqual((await ok(bot, 'list', {})).items.map((row) => row.id), [mine.id])
  await fails(bot, 'get', { id: 'f'.repeat(32) }, 'prompts/forbidden')
  await fails(bot, 'update', { id: 'f'.repeat(32), changes: { title: 'x' }, expected_version: 1 }, 'prompts/forbidden')
  await fails(bot, 'versions', { id: 'f'.repeat(32) }, 'prompts/forbidden')
  await fails(bot, 'version', { id: 'f'.repeat(32), version: 1 }, 'prompts/forbidden')
  await fails(bot, 'render', { id: 'f'.repeat(32), values: {} }, 'prompts/forbidden')
  await fails(bot, 'archive', { id: 'f'.repeat(32) }, 'prompts/forbidden')
  await fails(bot, 'delete', { id: 'f'.repeat(32) }, 'prompts/forbidden')

  // An id that is certain to be unallocated: flip the first hex digit of a real one.
  const missing = (mine.id[0] === '0' ? '1' : '0') + mine.id.slice(1)
  await fails(bot, 'get', { id: missing }, 'prompts/not-found')
})

test('bounded values, malformed placeholders and the version ceiling are refused', async () => {
  const bot = await boot()
  const bad = async (payload) => fails(bot, 'create', payload, 'prompts/invalid')
  await bad({ title: '', body: 'Body' })
  await bad({ title: '   ', body: 'Body' })
  await bad({ title: 'x'.repeat(201), body: 'Body' })
  await bad({ title: 'bad\u0001title', body: 'Body' })
  await bad({ title: 'Title', body: '' })
  await bad({ title: 'Title', body: 'x'.repeat(20001) })
  await bad({ title: 'Title', body: 'Body', tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) })
  await bad({ title: 'Title', body: 'Body', tags: ['x'.repeat(41)] })
  await bad({ title: 'Title', body: 'Body', tags: 'not-a-list' })
  await bad({ title: 'Title', body: 'Body', scope: 'public' })
  for (const body of ['Hello {{name', 'Hello name}}', 'Hello {{}}', 'Hello {{1bad}}',
    'Hello {{na me}}', 'Hello {{name!}}', 'Hello {{{name}}}', 'Hello {name}']) {
    await bad({ title: 'Bad', body })
  }
  for (const variables of [['other'], ['name', 'name'], 'name', ['name', 'extra']]) {
    await bad({ title: 'Bad', body: 'Hi {{name}}', variables })
  }
  const many = Array.from({ length: 101 }, (_, index) => `{{v${index}}}`).join(' ')
  await bad({ title: 'Many', body: many })
  assert.equal((await ok(bot, 'list', {})).items.length, 0, 'no rejected create left a row behind')

  const made = await created(bot, { title: 'Ceiling', body: 'Body {{n}}', variables: ['n'] })
  for (let version = 1; version < MAX_VERSIONS; version += 1) {
    await ok(bot, 'update', { id: made.id, changes: { body: `Body {{n}} v${version + 1}` }, expected_version: version })
  }
  await fails(bot, 'update', { id: made.id, changes: { body: 'One too many' }, expected_version: MAX_VERSIONS }, 'prompts/invalid')
  assert.equal((await ok(bot, 'get', { id: made.id })).prompt.current_version, MAX_VERSIONS)
  assert.equal((await ok(bot, 'versions', { id: made.id })).items.length, MAX_VERSIONS)
})
