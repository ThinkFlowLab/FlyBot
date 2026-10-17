// Opt-in OS boundary probe, separate from the no-process contract simulator.
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

export function validateImage(image) {
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image) || image.trim() !== image) throw new Error('Use an explicit image repository@sha256:digest')
  return image
}

export function containerArgs({ image, name, workspace, script, role }) {
  validateImage(image)
  if (!/^flybot-probe-[a-z0-9-]+$/.test(name) || !['writer', 'verifier'].includes(role)) throw new Error('Invalid probe identity')
  for (const path of [workspace, script]) {
    if (!isAbsolute(path) || path === '/' || resolve(path) !== path || /[,\r\n]/.test(path)) throw new Error('Invalid probe mount')
  }
  if (dirname(workspace) !== dirname(script) || basename(workspace) !== role || basename(script) !== 'probe.mjs') throw new Error('Probe mounts must belong to its disposable root')
  return ['create', '--name', name, '--read-only', '--network', 'none',
    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount', `type=bind,src=${workspace},dst=/work`,
    '--mount', `type=bind,src=${script},dst=/probe.mjs,readonly`,
    '--workdir', '/work', '--entrypoint', '/usr/bin/env', image,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TZ=UTC', 'node', '/probe.mjs', role]
}

const probeScript = `import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
const role = process.argv[2]
const checks = {}
writeFileSync('/work/own-write.txt', role)
assert.equal(readFileSync('/work/own-write.txt', 'utf8'), role)
checks.ownWrite = true
for (const [name, path] of [['peerPrivateRead', '/peer/private.txt'], ['hostPrivateRead', '/host-private.txt']]) {
  assert.throws(() => readFileSync(path), error => ['ENOENT', 'EACCES', 'EPERM'].includes(error.code))
  checks[name] = 'denied'
}
assert.throws(() => writeFileSync('/outside-workspace.txt', 'denied'), error => ['EROFS', 'EACCES', 'EPERM'].includes(error.code))
checks.rootWrite = 'denied'
assert.deepEqual(Object.keys(process.env).sort(), ['PATH', 'TZ'])
checks.ambientEnvironment = 'PATH,TZ only'
const networkCode = await new Promise((resolve, reject) => {
  const socket = createConnection({ host: '192.0.2.1', port: 80 })
  socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Network denial was not observed')) })
  socket.once('connect', () => { socket.destroy(); reject(new Error('Unexpected network connection')) })
  socket.once('error', error => { socket.destroy(); resolve(error.code) })
})
assert.equal(networkCode, 'ENETUNREACH')
checks.externalNetwork = networkCode
if (role === 'writer') writeFileSync('/work/result.json', JSON.stringify({ fixture: 'synthetic', total: 140 }))
else assert.deepEqual(JSON.parse(readFileSync('/work/result.json', 'utf8')), { fixture: 'synthetic', total: 140 })
checks.artifact = role === 'writer' ? 'produced' : 'verified'
console.log(JSON.stringify({ role, node: process.version, checks }))
`

async function docker(args, { signal } = {}) {
  const env = { ...process.env }
  // Select only the managed local daemon; keep registry/proxy configuration.
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key]
  const { stdout } = await promisify(execFile)('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env, signal, encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024,
  })
  return stdout.trim()
}

function verifyConfiguration(inspect) {
  const config = inspect.HostConfig
  assertConfigured(inspect.Config.User === '1000:1000', 'user')
  assertConfigured(config.ReadonlyRootfs && config.NetworkMode === 'none', 'root/network')
  assertConfigured(config.Memory === 128 * 1024 * 1024 && config.NanoCpus === 1_000_000_000 && config.PidsLimit === 64, 'resource limits')
  assertConfigured(config.CapDrop?.includes('ALL') && config.SecurityOpt?.includes('no-new-privileges'), 'privileges')
  assertConfigured(config.Privileged === false && config.PidMode !== 'host' && config.IpcMode !== 'host', 'namespaces')
  assertConfigured(inspect.Mounts.length === 2 && inspect.Mounts.every(m => ['/work', '/probe.mjs'].includes(m.Destination)), 'mounts')
  return { user: '1000:1000', readOnlyRoot: true, network: 'none', memoryBytes: config.Memory, nanoCpus: config.NanoCpus, pids: config.PidsLimit, capDrop: ['ALL'], noNewPrivileges: true }
}

function assertConfigured(value, name) {
  if (!value) throw new Error(`Probe configuration mismatch: ${name}`)
}

export async function runIsolationProbe(image, { invoke = docker, signal } = {}) {
  validateImage(image)
  const started = new Date().toISOString()
  const serverVersion = await invoke(['info', '--format', '{{.ServerVersion}}'], { signal })
  const imageId = await invoke(['image', 'inspect', image, '--format', '{{.Id}}'], { signal })
  const root = mkdtempSync(join(tmpdir(), 'flybot-isolation-'))
  const names = []
  const observations = []
  let report
  try {
    chmodSync(root, 0o755)
    const script = join(root, 'probe.mjs')
    writeFileSync(script, probeScript, { mode: 0o444 })
    writeFileSync(join(root, 'host-private.txt'), 'SYNTHETIC_HOST_PRIVATE')
    for (const role of ['writer', 'verifier']) {
      const workspace = join(root, role)
      mkdirSync(workspace, { mode: 0o777 })
      chmodSync(workspace, 0o777)
      writeFileSync(join(workspace, 'private.txt'), `SYNTHETIC_${role.toUpperCase()}_PRIVATE`, { mode: 0o444 })
    }
    for (const role of ['writer', 'verifier']) {
      if (role === 'verifier') copyFileSync(join(root, 'writer/result.json'), join(root, 'verifier/result.json'))
      const name = `flybot-probe-${randomUUID()}-${role}`
      names.push(name)
      await invoke(containerArgs({ image, name, workspace: join(root, role), script, role }), { signal })
      const configured = verifyConfiguration(JSON.parse(await invoke(['inspect', name], { signal }))[0])
      const observed = JSON.parse(await invoke(['start', '--attach', name], { signal }))
      assertConfigured(observed.role === role, 'role evidence')
      const state = JSON.parse(await invoke(['inspect', name], { signal }))[0].State
      assertConfigured(state.ExitCode === 0 && !state.Running && !state.OOMKilled, 'execution outcome')
      observations.push({ ...observed, configured })
    }
    const bytes = readFileSync(join(root, 'writer/result.json'))
    assertConfigured(bytes.equals(readFileSync(join(root, 'verifier/result.json'))), 'artifact handoff')
    report = { schemaVersion: 1, purpose: 'synthetic-offline-isolation-probe', status: 'passed', started, ended: new Date().toISOString(), image, imageId, docker: serverVersion, artifactSha256: createHash('sha256').update(bytes).digest('hex'), observations }
  } finally {
    const failures = []
    for (const name of names) {
      try { await invoke(['rm', '--force', name]) } catch (error) {
        if (!/No such container/.test(String(error.stderr))) failures.push(error)
      }
    }
    rmSync(root, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'Probe container cleanup failed')
  }
  signal?.throwIfAborted()
  return { ...report, cleanup: 'completed' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--image') throw new Error('Expected --image repository@sha256:digest')
    console.log(JSON.stringify(await runIsolationProbe(process.argv[3], { signal: controller.signal }), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', category: error.code ?? error.name, message: 'Isolation probe did not pass; no runtime integration is authorized by this result.' }))
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
