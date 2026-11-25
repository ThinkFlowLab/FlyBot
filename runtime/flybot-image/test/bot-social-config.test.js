import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  BotSocialConfigError,
  ENV_FILE,
  ENV_SERVER,
  loadBotSocialConfig,
  parseBotSocialConfig,
  parseServerUrl,
} from '../bot-social-config.js'
import { FAKE_TOKEN_PREFIX, isFakeToken, mintFakeToken, startFakeBotSocial } from './fake-bot-social.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('parseServerUrl accepts https and loopback http only', () => {
  assert.equal(parseServerUrl('https://social.example/team'), 'https://social.example/team')
  assert.equal(parseServerUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.equal(parseServerUrl('localhost:8787'), 'http://localhost:8787')
  assert.equal(parseServerUrl(''), undefined)
  assert.throws(() => parseServerUrl('http://example.com'), BotSocialConfigError)
  assert.throws(() => parseServerUrl('https://user:pass@social.example'), BotSocialConfigError)
  assert.throws(() => parseServerUrl('https://social.example/?x=1'), BotSocialConfigError)
})

test('parseBotSocialConfig ignores a token left in the file', () => {
  const parsed = parseBotSocialConfig(JSON.stringify({
    server: 'https://social.example',
    displayName: 'Open Team',
    token: 'totally-not-used',
    api_key: 'sk-please-ignore',
  }))
  assert.deepEqual(parsed, { server: 'https://social.example', displayName: 'Open Team' })
  assert.equal(parsed.token, undefined)
  const empty = parseBotSocialConfig('{}')
  assert.deepEqual(empty, {})
  assert.deepEqual(parseBotSocialConfig(''), {})
  assert.deepEqual(parseBotSocialConfig('   \n'), {})
  assert.throws(() => parseBotSocialConfig('not-json'), BotSocialConfigError)
})

test('loadBotSocialConfig prefers an allowlisted file over env, else uses env', () => {
  const home = mkdtempSync(join(tmpdir(), 'ot-bot-social-cfg-'))
  const secrets = join(home, 'run', 'secrets')
  mkdirSync(secrets, { recursive: true })
  const file = join(secrets, 'flybot-workspace-bot-social.json')
  writeFileSync(file, JSON.stringify({ server: 'https://from-file.example', displayName: 'FileBot' }))
  try {
    const fromFile = loadBotSocialConfig({
      [ENV_FILE]: file,
      [ENV_SERVER]: 'https://from-env.example',
    }, { readFile: (path) => readFileSync(path, 'utf8') })
    assert.equal(fromFile.server, 'https://from-file.example')
    assert.equal(fromFile.displayName, 'FileBot')

    const fromEnv = loadBotSocialConfig({ [ENV_SERVER]: 'https://from-env.example' }, {
      readFile: () => undefined,
    })
    assert.equal(fromEnv.server, 'https://from-env.example')

    const idle = loadBotSocialConfig({}, { readFile: () => undefined })
    assert.deepEqual(idle, {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadBotSocialConfig refuses a path outside /run/secrets or /data/secrets', () => {
  const home = mkdtempSync(join(tmpdir(), 'ot-bot-social-bad-'))
  const file = join(home, 'bot-social.json')
  writeFileSync(file, JSON.stringify({ server: 'https://social.example' }))
  try {
    assert.throws(() => loadBotSocialConfig({ [ENV_FILE]: file }), /must live under/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('fake Bot Social issues only ot-fake- tokens and answers platform plus onboard', async () => {
  const fake = await startFakeBotSocial({ takeFirstHandle: true })
  try {
    assert.equal(isFakeToken(fake.token), true)
    assert.equal(fake.token.startsWith(FAKE_TOKEN_PREFIX), true)
    const platform = await (await fetch(`${fake.url}/v1/platform`)).json()
    assert.equal(platform.platform_key, 'bot-social-fake')
    const first = await fetch(`${fake.url}/v1/onboard/flybot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'FlyBot' }),
    })
    assert.equal(first.status, 409)
    const second = await fetch(`${fake.url}/v1/onboard/flybot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'FlyBot2' }),
    })
    assert.equal(second.status, 200)
    const body = await second.json()
    assert.equal(body.connector.token, fake.token)
    assert.equal(isFakeToken(body.connector.token), true)
    assert.equal(fake.stats.onboard, 2)
    assert.equal(mintFakeToken().startsWith(FAKE_TOKEN_PREFIX), true)
  } finally {
    await fake.close()
  }
})

test('recipe and plugin do not force onboard: false or commit a real token', () => {
  const plugin = readFileSync(join(root, 'plugin/index.js'), 'utf8')
  assert.match(plugin, /loadBotSocialConfig/)
  assert.doesNotMatch(plugin, /onboard:\s*false/)
  assert.doesNotMatch(plugin, /sk-[A-Za-z0-9]{8,}/)
  const fakeSrc = readFileSync(join(root, 'test/fake-bot-social.mjs'), 'utf8')
  assert.match(fakeSrc, /ot-fake-/)
  assert.doesNotMatch(fakeSrc, /sk-[A-Za-z0-9]{8,}/)
})
