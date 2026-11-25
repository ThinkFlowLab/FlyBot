import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, key, volume, WS } from './helpers.js'

function doc(extra = {}) {
  return { workspace_id: WS, title: '步骤输出', body: '这一步写完了报告。', kind: 'document', idempotency_key: key(), ...extra }
}

test('artifacts feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('artifacts'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'flybot-workspace', 'features', 'artifacts', 'artifacts.sqlite3')))
})

test('artifacts/create saves a document for B2 team-run step output, idempotently', async () => {
  const bot = await boot()
  const payload = doc()
  const created = await bot.endpoint('artifacts/create', payload)
  assert.equal(created.ok, true, JSON.stringify(created))
  const artifact = created.value.artifact
  assert.equal(artifact.title, '步骤输出')
  assert.equal(artifact.body, '这一步写完了报告。')
  assert.equal(artifact.kind, 'document')
  assert.equal(artifact.revision, 1)
  assert.equal(artifact.workspace_id, WS)
  assert.equal(typeof artifact.id, 'string')
  assert.equal(artifact.id.length, 32)
  assert.ok(artifact.created_by)
  const replay = await bot.endpoint('artifacts/create', payload)
  assert.equal(replay.ok, true)
  assert.equal(replay.value.artifact.id, artifact.id)
  const clash = await bot.endpoint('artifacts/create', { ...payload, body: '另一份' })
  assert.equal(clash.ok, false)
  assert.equal(clash.error.code, 'conflict')
  const dup = await bot.endpoint('artifacts/create', doc({ title: '步骤输出' }))
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'conflict')
})

test('artifacts/create refuses invalid input and keeps another DS-Bot isolated', async () => {
  const bot = await boot()
  for (const payload of [
    doc({ workspace_id: 'nope' }),
    doc({ title: '' }),
    doc({ body: 'x', idempotency_key: 'short' }),
    doc({ kind: 'media' }),
    { title: '无工作区', body: 'x', kind: 'document', idempotency_key: key() },
  ]) {
    const result = await bot.endpoint('artifacts/create', payload)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error.code, 'invalid')
  }
  const saved = (await bot.endpoint('artifacts/create', doc({ title: '仅此卷' }))).value.artifact
  const other = await boot()
  const missing = await other.endpoint('artifacts/create', doc({ title: '仅此卷', idempotency_key: key() }))
  assert.equal(missing.ok, true)
  assert.notEqual(missing.value.artifact.id, saved.id)
  const isolated = volume()
  const empty = await boot(isolated)
  assert.ok(empty.features.loaded.includes('artifacts'))
  assert.ok(existsSync(join(empty.vol.data, 'flybot-workspace', 'features', 'artifacts', 'artifacts.sqlite3')))
})
