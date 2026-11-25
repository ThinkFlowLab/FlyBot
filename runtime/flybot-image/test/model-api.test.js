import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { applyModelApi, contentsToModelApi, keyRefFor, loadModelApi, parseModelApi, readModelApiFile, redact, resolveModelApiPath, ModelApiError } from '../model-api.js'

const sample = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  api_key: 'sk-test-not-a-real-key',
}

test('parses a valid secret and names the DSH env var', () => {
  const config = parseModelApi(JSON.stringify(sample))
  assert.equal(config.provider, 'deepseek')
  assert.equal(config.base_url, 'https://api.deepseek.com')
  assert.equal(config.model, 'deepseek-chat')
  assert.equal(config.api_key, sample.api_key)
  assert.equal(config.api_key_env, 'DEEPSEEK_API_KEY')
  assert.equal(keyRefFor('open-ai'), 'OPEN_AI_API_KEY')
  assert.equal(config.source, undefined)
  const fromUser = parseModelApi(JSON.stringify({ ...sample, source: 'user' }))
  assert.equal(fromUser.source, 'user')
  const fromPlatform = parseModelApi(JSON.stringify({ ...sample, source: 'platform' }))
  assert.equal(fromPlatform.source, 'platform')
})

test('rejects unsafe or incomplete documents', () => {
  const reject = (body) => {
    assert.throws(() => parseModelApi(JSON.stringify(body)), ModelApiError)
  }
  reject({ provider: 'deepseek' })
  reject({ provider: 'Deep Seek', api_key: 'k' })
  reject({ provider: 'deepseek', api_key: ' k ' })
  reject({ provider: 'deepseek', api_key: 'k', base_url: 'javascript:alert(1)' })
  reject({ provider: 'deepseek', api_key: 'k', base_url: 'https://user:secret@api.example' })
  reject({ provider: 'deepseek', api_key: 'k', model: '$(reboot)' })
  reject({ provider: 'deepseek', api_key: 'k', source: 'credits' })
  assert.throws(() => parseModelApi('not-json'), ModelApiError)
})

test('apply sets the key env var and never includes it in the log line', () => {
  const lines = []
  const env = {}
  applyModelApi(parseModelApi(JSON.stringify(sample)), env, { info: (msg) => lines.push(msg) })
  assert.equal(env.DEEPSEEK_API_KEY, sample.api_key)
  assert.equal(env.FLYBOT_WORKSPACE_MODEL_PROVIDER, 'deepseek')
  assert.equal(env.FLYBOT_WORKSPACE_MODEL_BASE_URL, sample.base_url)
  assert.equal(env.FLYBOT_WORKSPACE_MODEL_NAME, sample.model)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /provider=deepseek/)
  assert.match(lines[0], /key_env=DEEPSEEK_API_KEY/)
  assert.match(lines[0], /source=resolved/)
  assert.equal(env.FLYBOT_WORKSPACE_MODEL_SOURCE, undefined)
  const lines2 = []
  applyModelApi(parseModelApi(JSON.stringify({ ...sample, source: 'user' })), {}, { info: (msg) => lines2.push(msg) })
  assert.match(lines2[0], /source=user/)
  assert.doesNotMatch(lines[0], /sk-test/)
  assert.doesNotMatch(lines[0], /not-a-real-key/)
  assert.equal(redact(sample).api_key, '***')
  assert.doesNotMatch(redact(`leak ${sample.api_key} here`), /sk-test-not-a-real-key/)
})

test('reads only allowlisted secret paths and skips a missing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ot-model-api-'))
  const secrets = join(root, 'data', 'secrets')
  mkdirSync(secrets, { recursive: true })
  const allowed = join(secrets, 'model-api.json')
  writeFileSync(allowed, JSON.stringify(sample))
  // The helper hard-codes /data/secrets and /run/secrets. Exercise it by
  // passing FLYBOT_WORKSPACE_MODEL_API_FILE only after we also test the allowlist
  // via a symlink that lands outside — which must be rejected.
  const outside = join(root, 'outside.json')
  writeFileSync(outside, JSON.stringify(sample))
  const sneaky = join(secrets, 'link.json')
  symlinkSync(outside, sneaky)
  assert.throws(() => readModelApiFile(sneaky), ModelApiError)
  assert.equal(resolveModelApiPath({}), undefined)
  assert.equal(loadModelApi({}), undefined)
  rmSync(root, { recursive: true, force: true })
})

test('treats an empty secret file as absent', () => {
  assert.equal(contentsToModelApi(''), undefined)
  assert.equal(contentsToModelApi('  \n'), undefined)
  const config = contentsToModelApi(JSON.stringify(sample))
  assert.equal(config.api_key, sample.api_key)
})
