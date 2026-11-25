// CI smoke for the FlyBot Workspace runtime image. Requires Docker.
// Starts the image the way the compose manager does: user 1000, read-only
// rootfs, /data volume, tmpfs /tmp, no extra /workspace mount. Probes dsh web
// on 8080 and the Bot API. Does not claim a license-complete release.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2]
assert.ok(image, 'usage: node test/smoke.mjs <image>')
const name = `ot-flybot-smoke-${randomUUID()}`
const data = `${name}-data`
const containers = new Set()
const volumes = []

const docker = (args, { allowFailure = false } = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

try {
  // Do not pre-create the volume. docker run will create it and seed /data
  // (UID 1000 ownership) from the image, the same way Compose does on first create.
  volumes.push(data)

  const inspect = JSON.parse(docker(['image', 'inspect', image]).stdout)
  const cfg = inspect[0].Config
  assert.equal(String(cfg.User), '1000:1000', 'image user must be 1000:1000')
  assert.ok((cfg.ExposedPorts ?? {})['8080/tcp'], 'image must expose 8080')
  assert.ok(cfg.Healthcheck?.Test, 'image must declare a HEALTHCHECK')

  const server = `${name}-web`
  containers.add(server)
  docker([
    'run', '--detach', '--name', server, '--network', 'none',
    '--user', '1000:1000',
    '--read-only',
    '--memory', '1536m',
    '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
    '--mount', `type=volume,src=${data},dst=/data`,
    '-e', 'DSH_TELEMETRY_DISABLED=1',
    '-e', 'DSH_LISTEN_PORT=8080',
    image,
  ])
  await setTimeout(1500)
  const running = docker(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}} {{.State.Error}}', server], { allowFailure: true })
  if (running.stdout.trim().split(/\s+/)[0] !== 'true') {
    const logs = docker(['logs', server], { allowFailure: true })
    throw new Error(`container exited before it became ready: ${running.stdout.trim()}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`)
  }

  const address = docker(['exec', server, 'sh', '-c', 'hostname -i 2>/dev/null || echo 127.0.0.1']).stdout.trim().split(/\s+/)[0]
  assert.ok(address, 'container must have a bind address')
  const probe = `
    const response = await fetch('http://${address}:8080/');
    if (![200, 401].includes(response.status)) throw new Error('Unexpected HTTP status: ' + response.status);
  `
  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline) {
    if (docker(['exec', server, 'node', '--input-type=module', '-e', probe], { allowFailure: true }).status === 0) {
      ready = true
      break
    }
    await setTimeout(500)
  }
  const logs = docker(['logs', server])
  const combined = `${logs.stdout}\n${logs.stderr}`
  assert.ok(ready, `web server must answer HTTP on 8080\n${combined}`)

  const processOwner = docker(['exec', server, 'stat', '-c', '%u:%g', '/proc/1']).stdout.trim()
  assert.equal(processOwner, '1000:1000', 'PID 1 must run as 1000:1000')

  const imageRuntime = '/opt/flybot-workspace/runtime/flybot-image'
  docker(['exec', server, 'test', '-f', imageRuntime + '/agent-bootstrap.mjs'])
  docker(['exec', server, 'test', '!', '-e', imageRuntime + '/agent-loop.mjs'])

  const profileJson = docker(['exec', server, 'node', '--input-type=module', '-e',
    "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('/data/profiles/web/package.json','utf8'))",
  ]).stdout
  const manifest = JSON.parse(profileJson)
  assert.equal(manifest.dependencies['@flybot-workspace/flybot-runtime']?.startsWith('link:'), true, 'wrapper must be linked from the image path')
  assert.ok(manifest.dsh?.profile?.bundles?.includes('@flybot-workspace/flybot-runtime'), 'wrapper must be a profile bundle')
  assert.ok(manifest.dsh?.profile?.bundles?.includes('@flybot-workspace/flybot-social-web'), 'social web client must be a profile bundle')
  const socialCompanion = JSON.parse(readFileSync(new URL('../../flybot-web-slots/social-web/package.json', import.meta.url), 'utf8'))
  assert.equal(socialCompanion.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(socialCompanion.exports['./client'], './client.js')
  assert.ok(!manifest.dsh?.profile?.bundles?.includes('ds-bot'), 'upstream ds-bot must not also be a bundle')
  assert.ok(manifest.dsh?.profile?.bundles?.includes('@flybot-workspace/web'), 'FlyBot DS-Bot plugin must be a profile bundle')

  const loginUrl = combined.match(/http:\/\/127\.0\.0\.1:8080\/\?token=[^\s]+/)?.[0]
    ?? combined.match(/http:\/\/[0-9.]+:8080\/\?token=[^\s]+/)?.[0]
  assert.ok(loginUrl, `web server must print a login URL on 8080\n${combined}`)
  const tokenUrl = loginUrl.replace(/http:\/\/127\.0\.0\.1:8080/, `http://${address}:8080`)
  const api = docker(['exec', server, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const login = await fetch(process.argv[1], { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'login must return a cookie')
    const response = await fetch('http://${address}:8080/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
    })
    assert.ok(response.ok, 'the Bot API must answer: ' + response.status)
    const result = await response.json()
    assert.ok(result.ok, result.error?.message)
    assert.ok(Array.isArray(result.value.bots), 'the DS Bot runtime must load')
    // Exercise the actual native validator/storage/Main Bot, not a permissive mock.
    // Mirrors the deployment acceptance slug which previously exceeded 32 chars
    // once prefixed. The CI container runs UID 1000 with a read-only rootfs.
    const call = async (path, endpoint, payload = {}) => {
      const response = await fetch('http://${address}:8080' + path, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ endpoint, payload }),
      })
      const body = await response.json()
      assert.ok(response.ok && body.ok, endpoint + ': ' + JSON.stringify(body.error))
      return body.value
    }
    const speech = await call('/api/flybot-workspace', 'meetings/v1', {
      method: 'GET', path: '/v1/workspaces/' + 'a'.repeat(32) + '/meetings/speech',
    })
    assert.equal(speech.status, 200)
    assert.ok(['checking', 'unprepared'].includes(speech.body?.phase), JSON.stringify(speech.body))
    assert.equal(speech.body.ready, false, 'a fresh offline volume must wait for model preparation')
    const slug = 'deploy-accept-00000000'
    const content = ${JSON.stringify('# CI native skill\nRead these instructions.')}
    const saved = await call('/api/flybot-workspace', 'skills/save', { name: slug, content })
    assert.equal(saved.attached, true)
    assert.ok(saved.name.length <= 32)
    const state = await call('/api/bot', 'state')
    assert.equal(state.capabilities.find(c => c.name === saved.name)?.content, content)
    assert.ok(state.bots.some(bot => bot.capabilities?.includes(saved.name)))
    assert.ok((await call('/api/flybot-workspace', 'skills/list')).items.some(c => c.name === saved.name))
    const skills = (method, path, body) => call('/api/flybot-workspace', 'skills/v1', {method, path:'/v1/skills/' + path, body})
    const catalogue = await skills('GET','catalog')
    assert.equal(catalogue.status, 200)
    const item = catalogue.body.items.find(skill => skill.id === 'meeting-notes')
    const bind = enabled => skills('POST','bindings',{enabled,scope:'account',skill_id:item.id,
      digest:item.digest,version:item.version,permissions:['model_context']})
    assert.equal((await bind(true)).status, 200)
    const bound = await call('/api/bot', 'state')
    assert.equal(bound.capabilities.find(c => c.name === 'ot-bound-meeting-notes')?.content, item.content.trim())
    assert.ok(bound.bots.some(bot => bot.capabilities?.includes('ot-bound-meeting-notes')))
    await call('/api/flybot-workspace', 'skills/remove', { name: slug })
    assert.equal((await bind(false)).status, 200)
    const revoked = await call('/api/bot', 'state')
    assert.ok(revoked.bots.every(bot => !bot.capabilities?.includes(saved.name) && !bot.capabilities?.includes('ot-bound-meeting-notes')))

    const flybot = await fetch('http://${address}:8080/api/flybot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'social/server', payload: {} }),
    })
    assert.ok(flybot.ok, 'the FlyBot social API must answer: ' + flybot.status)
    const social = await flybot.json()
    assert.ok(social.ok, social.error?.message)
    assert.notEqual(social.value, undefined)
  `, tokenUrl], { allowFailure: true })
  if (api.status !== 0) {
    const later = docker(['logs', server], { allowFailure: true })
    throw new Error(`Bot API probe failed (${api.status}):\n${api.stderr}\ncontainer logs:\n${later.stdout}\n${later.stderr}`)
  }

  const fakeSrc = new URL('./fake-bot-social.mjs', import.meta.url)
  const copied = docker(['cp', fakeSrc.pathname, `${server}:/data/fake-bot-social.mjs`], { allowFailure: true })
  if (copied.status !== 0) {
    throw new Error(`could not copy the fake Bot Social server into /data: ${copied.stderr}`)
  }
  docker(['exec', '-d', server, 'node', '/data/fake-bot-social.mjs', '--host', '127.0.0.1', '--port', '8787'])
  const platformProbe = `
    const response = await fetch('http://127.0.0.1:8787/v1/platform');
    if (!response.ok) throw new Error('fake Bot Social is not up: ' + response.status);
  `
  const socialDeadline = Date.now() + 10_000
  let fakeReady = false
  while (Date.now() < socialDeadline) {
    if (docker(['exec', server, 'node', '--input-type=module', '-e', platformProbe], { allowFailure: true }).status === 0) {
      fakeReady = true
      break
    }
    await setTimeout(200)
  }
  assert.ok(fakeReady, 'fake Bot Social must listen on 127.0.0.1:8787 inside the container')

  const onboard = docker(['exec', server, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createHash } from 'node:crypto'
    import { lstatSync, readdirSync, readFileSync } from 'node:fs'
    const login = await fetch(process.argv[1], { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'login must return a cookie')
    const idle = await fetch('http://${address}:8080/api/flybot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'social/server', payload: {} }),
    })
    assert.ok(idle.ok, 'social/server must answer before onboarding: ' + idle.status)
    const before = await idle.json()
    assert.ok(before.ok, before.error?.message)
    assert.equal(before.value?.server ?? null, null)
    const set = await fetch('http://${address}:8080/api/flybot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'social/server-set', payload: { server: 'http://127.0.0.1:8787', confirm: true } }),
    })
    const body = await set.json()
    assert.ok(set.ok && body.ok, 'social/server-set must onboard: ' + set.status + ' ' + JSON.stringify(body.error || body.value))
    assert.equal(body.value.state, 'connected')
    assert.equal(body.value.server, 'http://127.0.0.1:8787')
    // A server chosen in Settings is not the profile default, so credentials
    // land at flybot-social.json.<sha256-8> beside the default path.
    const tag = createHash('sha256').update('http://127.0.0.1:8787').digest('hex').slice(0, 8)
    const names = readdirSync('/data/bot').filter((name) => name.startsWith('flybot-social.json'))
    const credPath = names.includes('flybot-social.json.' + tag)
      ? '/data/bot/flybot-social.json.' + tag
      : names[0] ? '/data/bot/' + names[0] : '/data/bot/flybot-social.json'
    const info = lstatSync(credPath)
    assert.equal(info.mode & 0o777, 0o600)
    const saved = JSON.parse(readFileSync(credPath, 'utf8'))
    assert.equal(typeof saved.token, 'string')
    assert.match(saved.token, /^ot-fake-[0-9a-f]{32}$/)
    process.stdout.write(saved.token)
  `, tokenUrl], { allowFailure: true })
  if (onboard.status !== 0) {
    const later = docker(['logs', server], { allowFailure: true })
    throw new Error(`Bot Social onboard probe failed (${onboard.status}):\n${onboard.stderr}\n${onboard.stdout}\ncontainer logs:\n${later.stdout}\n${later.stderr}`)
  }
  const connectorToken = onboard.stdout.trim()
  assert.match(connectorToken, /^ot-fake-[0-9a-f]{32}$/)
  const afterLogs = docker(['logs', server], { allowFailure: true })
  const afterCombined = `${afterLogs.stdout}\n${afterLogs.stderr}`
  assert.equal(afterCombined.includes(connectorToken), false, 'connector token must not appear in container logs')

  console.log('PASS: image user 1000, port 8080, read-only start, profile wrapper, Bot API, FlyBot social API, fake Bot Social onboard')
} finally {
  for (const container of containers) docker(['rm', '--force', container], { allowFailure: true })
  for (const volume of volumes) docker(['volume', 'rm', volume], { allowFailure: true })
}
