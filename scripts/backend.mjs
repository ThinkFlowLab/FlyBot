#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, chmodSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createWorkbenchGateway } from '../core/src/host/workbench-gateway.js'
import { fileURLToPath } from 'node:url'
import { homeLock } from '../core/src/host/home-lock.js'
import { backendConfig, callApi, cliPath, connection, homeOf, installDependencies, optionsOf, prepareBackend, privateJson, readJson, requestBody, root } from './backend-lib.mjs'

async function secret() {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim()
  process.stderr.write('Password: '); process.stdin.setRawMode(true); process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = error => { process.stdin.off('data', read); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(value) }
    const read = bytes => { for (const char of bytes.toString()) { if (char === '\u0003') return finish(new Error('Login cancelled')); if (char === '\r' || char === '\n') return finish(); if (char === '\u007f') value = value.slice(0, -1); else value += char } }
    process.stdin.on('data', read)
  })
}
async function start(home) {
  const config = backendConfig(readJson(join(home, 'backend.json')))
  if (!existsSync(cliPath) || !existsSync(join(home, 'profiles/web/node_modules'))) throw new Error('Run init before start')
  const lock = homeLock(join(home, 'backend-launch.lock'))
  if (lock.claim() !== undefined) throw new Error('This backend launcher is already active')
  const transportPath = join(home, 'private/backend-transport.json')
  let child, gateway, log, deadline, failure, startGateway, ready = false
  const int = () => child?.kill('SIGINT'), term = () => child?.kill('SIGTERM')
  try {
    if (existsSync(transportPath)) unlinkSync(transportPath)
    prepareBackend(home, config)
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    mkdirSync(join(home, 'private'), { recursive: true, mode: 0o700 })
    const logPath = join(home, 'private/backend.log')
    log = openSync(logPath, 'a', 0o600); chmodSync(logPath, 0o600)
    child = spawn(process.execPath, ['--import', join(root, 'scripts/backend-resolve.mjs'), cliPath, '--profile', 'web', '--patch', join(home, 'backend.patch.yml'), '--no-open', '--port', String(port)], {
      cwd: join(home, 'workspace'), env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    const activate = async loginUrl => {
      const upstreamOrigin = `http://127.0.0.1:${port}`
      privateJson(transportPath, { baseUrl: `http://127.0.0.1:${config.port}`, ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}), upstreamOrigin, loginUrl })
      const transport = await connection(home, true)
      const status = await callApi(transport, 'auth-mode', {})
      if (status.writable !== true) throw new Error('Backend state is read-only; inspect the private runtime log')
      gateway = createWorkbenchGateway({ upstreamOrigin, upstreamCookie: transport.cookie, ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}) })
      gateway.listen(config.port, '127.0.0.1'); await once(gateway, 'listening')
      ready = true; clearTimeout(deadline)
      process.stdout.write(`Backend ready: http://127.0.0.1:${config.port}\nUse login, then request/query/command with the same --home.\n`)
    }
    const output = bytes => {
      writeSync(log, bytes); buffer = (buffer + bytes.toString()).slice(-16000)
      const found = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/)
      if (!startGateway && found && new URL(found[0]).port === String(port)) startGateway = activate(found[0]).catch(error => { failure = error; child.kill('SIGTERM') })
    }
    child.stdout.on('data', output); child.stderr.on('data', output)
    deadline = setTimeout(() => { failure = new Error('Backend startup exceeded45s; inspect private/backend.log locally'); child.kill('SIGTERM') }, 45000)
    process.on('SIGINT', int); process.on('SIGTERM', term)
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 || signal ? resolve() : reject(new Error('Backend stopped; inspect the private backend.log locally'))) })
    await startGateway
    if (failure) throw failure
    if (!ready) throw new Error('Backend exited before readiness')
  } finally {
    clearTimeout(deadline); process.off('SIGINT', int); process.off('SIGTERM', term)
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    if (log !== undefined) closeSync(log)
    lock.release()
  }
}
async function main() {
  const { command, options, positional } = optionsOf(process.argv.slice(2)), home = homeOf(options)
  if (command === 'help') { console.log('Usage: node scripts/backend.mjs init|start|login|logout|events|request ENDPOINT|query NAME|command NAME --home PATH [--config FILE] [--email EMAIL] [--project ID] [--request-id ID] [--json JSON_OR_@FILE]'); return }
  if (command === 'init') {
    const path = join(home, 'backend.json')
    const config = backendConfig(options.config ? readJson(options.config) : existsSync(path) ? readJson(path) : {})
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const lock = homeLock(join(home, 'backend-launch.lock'))
    if (lock.claim() !== undefined) throw new Error('This backend launcher is already active; stop it before init')
    try {
      installDependencies()
      const profile = prepareBackend(home, config)
      const result = spawnSync('npx', ['--yes', 'pnpm@10.34.6', 'install', '--no-frozen-lockfile', '--prefer-offline'], { cwd: profile, stdio: 'inherit' })
      if (result.status !== 0) throw new Error('Profile installation failed; inspect installation output and retry init')
      console.log('Persistent backend initialized. Configure the real model environment, then start with the same --home.')
    } finally { lock.release() }
    return
  }
  if (command === 'start') return start(home)
  if (!['login', 'logout', 'request', 'query', 'command', 'events'].includes(command)) throw new Error('Unknown command; use help')
  const transport = await connection(home, command === 'login'), sessionPath = join(home, 'private/backend-session.json')
  const current = existsSync(sessionPath) ? readJson(sessionPath) : {}
  const api = (endpoint, payload, token = current.sessionToken) => callApi(transport, endpoint, payload, token)
  if (command === 'login') {
    let session
    if (options.email) session = await api('platform-login', { email: options.email, password: await secret() }, undefined)
    else if (current.sessionToken && await api('auth-whoami', {}).then(Boolean).catch(() => false)) { console.log('Authenticated with the existing private local session.'); return }
    else { const invite = await api('auth-invite', {}, undefined); session = await api('auth-redeem', { token: invite.token, displayName: 'Owner' }, undefined) }
    if (!session.sessionToken) throw new Error('Login did not return a member session')
    privateJson(sessionPath, { sessionToken: session.sessionToken }); console.log(`Authenticated${session.memberId ? ` as ${session.memberId}` : ''}. Session saved privately.`); return
  }
  if (!current.sessionToken) throw new Error('Run login first')
  if (command === 'events') {
    if (!options.project) throw new Error('Select --project')
    const url = new URL('/api/project-events', transport.baseUrl); url.searchParams.set('projectId', options.project)
    if (options.after) url.searchParams.set('after', options.after)
    const response = await fetch(url, { headers: { 'x-flybot-member-session': current.sessionToken, ...(transport.publicOrigin ? { host: new URL(transport.publicOrigin).host, origin: transport.publicOrigin } : {}) } })
    if (!response.ok) throw new Error(`Event stream HTTP${response.status}`)
    for await (const bytes of response.body) process.stdout.write(bytes)
    return
  }
  if (command === 'logout') { await api('auth-revoke', {}); unlinkSync(sessionPath); console.log('Session revoked.'); return }
  if (!positional[0]) throw new Error('Select an endpoint or operation')
  const request = requestBody(command, positional[0], options)
  console.log(JSON.stringify(await api(request.endpoint, request.payload), null, 2))
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(`Backend command failed: ${error.message}`); process.exitCode = 1 })
