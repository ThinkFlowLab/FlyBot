// An external process behind the same room participant boundary as DSH (#198). A Bot whose
// record carries `external` has a supervised child process speaking for it in rooms instead of
// a DSH Session; the identity stays on the Bot, so a grant, a seat and a removal all apply to it
// like any other member. There is no shell anywhere: the record holds an argv array.
//
// The protocol on the child's stdio is one JSON object per line.
//   in:  { type: 'turn', text, note, from?, exchangeId }   { type: 'stop' }
//   out: { text }   or   { error }
// Anything else on stdout is ignored, so a process may log.
import { spawn } from 'node:child_process'
import { ROOM_REPLY_TIMEOUT_MS } from './constants.js'

export const EXTERNAL_DRIVERS = ['subprocess']
// argv[0] may not be one of these: an argv array whose first word is a shell is the shell line
// this record refuses, only spelled differently (#198).
const INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'env'])
const MAX_COMMAND = 32
const MAX_ENV = 32
const MAX_OUT = 4096

const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)

// The one shape a Bot record may carry. A string command is refused rather than split into
// words: a room's settings are shared, and a command line is how a shared setting becomes code
// that runs on this machine (#198).
export function cleanExternal(input) {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('external must be an object')
  const driver = input.driver ?? 'subprocess'
  if (!EXTERNAL_DRIVERS.includes(driver)) throw new Error(`external.driver must be one of ${EXTERNAL_DRIVERS.join(', ')}`)
  if (!Array.isArray(input.command)) throw new Error('external.command must be an array of arguments, not a shell line')
  if (input.command.length === 0 || input.command.length > MAX_COMMAND) throw new Error(`external.command needs 1 to ${MAX_COMMAND} entries`)
  const program = String(input.command[0] ?? '').split(/[\\/]/).pop().toLowerCase()
  if (INTERPRETERS.has(program)) throw new Error(`external.command may not start with an interpreter (${program}): give the program itself, not a shell line`)
  const command = input.command.map((part) => {
    const text = String(part ?? '')
    if (text.trim() === '' || text.includes('\u0000')) throw new Error('external.command entries must be non-empty strings, without a NUL byte')
    return text
  })
  const out = { driver, command }
  if (input.cwd !== undefined && input.cwd !== null) {
    if (typeof input.cwd !== 'string' || input.cwd.trim() === '') throw new Error('external.cwd must be a folder path')
    out.cwd = input.cwd
  }
  if (input.env !== undefined && input.env !== null) {
    if (typeof input.env !== 'object' || Array.isArray(input.env)) throw new Error('external.env must be an object of variables')
    const env = {}
    for (const [name, value] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`external.env: ${name} is not a variable name`)
      if (typeof value !== 'string') throw new Error(`external.env: ${name} must be a string`)
      env[name] = value
    }
    if (Object.keys(env).length > MAX_ENV) throw new Error(`external.env holds at most ${MAX_ENV} variables`)
    if (Object.keys(env).length > 0) out.env = env
  }
  return out
}

export function createExternalRoomParticipant(rt) {
  // One process per (room, Bot): the same external Bot in two rooms is two supervised processes
  // over one identity, which is what makes an invite to a second room cost nothing on the record.
  const processes = new Map()
  const keyOf = (room, member) => `${room.id}\u0000${member.id}`
  const sessionIdOf = (room, member) => `external:${room.id}:${member.id}`

  // The room sees what happened to its participant, not just a turn that never came back (#198).
  async function report(room, member, state, detail) {
    rt.warn?.('ds-bot: external Bot %s in %s: %s%s', member.name, room.name, state, detail ? ` (${detail})` : '')
    try {
      await rt.externalRoomLine?.(room, {
        who: member.name,
        botId: member.id,
        authorId: member.id,
        authorKind: 'bot',
        kind: 'external',
        text: state === 'crashed'
          ? `${member.name}'s external process crashed${detail ? ` (${detail})` : ''}. Its turns in this room have no answer until it starts again.`
          : `${member.name}'s external process ${state}${detail ? ` (${detail})` : ''}.`,
      })
    } catch (error) {
      rt.warn?.('ds-bot: the state of %s in %s was not posted: %s', member.name, room.name, error)
    }
  }

  function settle(entry, state, detail) {
    entry.state = state
    entry.detail = detail
    if (entry.turn !== undefined) {
      const turn = entry.turn
      entry.turn = undefined
      turn.finish({ failure: { reason: state, detail } })
    }
  }

  function start(room, member) {
    const key = keyOf(room, member)
    const known = processes.get(key)
    if (known !== undefined) {
      // Still running: the same process answers every turn in this room.
      if (known.child !== undefined || known.turn !== undefined) return known
      // It died (crash, clean exit, or the user stopped it). The next turn starts a fresh
      // one, which is what the room's line promises (#198).
      processes.delete(key)
    }
    const record = member.external
    const entry = { state: 'starting', detail: undefined, turn: undefined, child: undefined, buffer: '' }
    processes.set(key, entry)
    let child
    try {
      child = spawn(record.command[0], record.command.slice(1), {
        cwd: record.cwd ?? rt.workDirOf?.({ botId: member.id, roomId: room.id }),
        env: { ...process.env, ...record.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      settle(entry, 'crashed', oneLine(error?.message ?? error))
      void report(room, member, 'crashed', entry.detail)
      return entry
    }
    entry.child = child
    entry.state = 'idle'
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      entry.buffer += chunk
      let index
      while ((index = entry.buffer.indexOf('\n')) !== -1) {
        const line = entry.buffer.slice(0, index).trim()
        entry.buffer = entry.buffer.slice(index + 1)
        if (line !== '') settleLine(entry, line)
      }
      if (entry.buffer.length > MAX_OUT) entry.buffer = ''
    })
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { entry.stderr = `${entry.stderr ?? ''}${chunk}`.slice(-MAX_OUT) })
    child.on('error', (error) => {
      entry.child = undefined
      settle(entry, 'crashed', oneLine(error?.message ?? error))
      void report(room, member, 'crashed', entry.detail)
    })
    child.on('exit', (code, signal) => {
      entry.child = undefined
      // A stop the child obeyed — it read the message and left on its own — is the same exit the
      // signal branch below skips: it stopped when asked, so the room must not hear 'crashed' (#198).
      if (entry.state === 'stopped' || entry.stopping === true) return
      const clean = code === 0 && entry.stopping !== true
      const detail = signal !== null ? `signal ${signal}` : `exit ${code}`
      settle(entry, clean ? 'exited' : 'crashed', detail)
      void report(room, member, entry.state, detail)
      entry.stopping = false
    })
    return entry
  }

  function endChild(entry) {
    entry.stopping = true
    entry.state = 'stopped'
    const child = entry.child
    if (child === undefined) return
    // The protocol message is a courtesy the child may act on; the signal follows so a child that
    // never reads still goes (#198).
    try { child.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`) } catch { /* the pipe may already be closed */ }
    const kill = () => { try { child.kill('SIGTERM') } catch { /* the process may already be gone */ } }
    const grace = setTimeout(kill, 50)
    grace.unref?.()
    child.once?.('exit', () => clearTimeout(grace))
  }

  // A member who loses the seat, or a Bot that is deleted, takes its process with it: a child
  // that outlives the membership would keep speaking for an identity that is not in the room (#198).
  function closeParticipant(roomId, botId) {
    const key = `${roomId}\u0000${botId}`
    const entry = processes.get(key)
    if (entry === undefined) return false
    processes.delete(key)
    endChild(entry)
    entry.turn?.finish(null)
    entry.turn = undefined
    return true
  }

  function settleLine(entry, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    const turn = entry.turn
    if (turn === undefined) return
    entry.turn = undefined
    if (typeof message.text === 'string') {
      entry.state = 'idle'
      turn.finish(message.text)
      return
    }
    entry.state = 'idle'
    turn.finish({ failure: { reason: 'error', detail: oneLine(message.error ?? message.message ?? 'the process reported an error') } })
  }

  function snapshot(sessionId) {
    for (const [key, entry] of processes) {
      if (sessionIdOfOf(key) !== sessionId) continue
      return { working: entry.turn !== undefined, ...(entry.turn === undefined ? {} : { since: entry.turn.since }), state: entry.state }
    }
    return { working: false }
  }
  const sessionIdOfOf = (key) => {
    const cut = key.indexOf('\u0000')
    return `external:${key.slice(0, cut)}:${key.slice(cut + 1)}`
  }

  async function open({ room, member }) {
    const entry = start(room, member)
    // The room keeps the id the same way it keeps a DSH Session's, so snapshot, removal and
    // cancellation find this participant without a second lookup (#198).
    room.sessions ??= {}
    room.sessions[member.id] = sessionIdOf(room, member)
    return { id: room.sessions[member.id], created: entry.state !== 'crashed' && entry.state !== 'exited' }
  }

  async function runTurn({ room, member, sessionId, text, note, signal, started, by, exchangeId }) {
    if (signal?.aborted) return null
    const entry = start(room, member)
    const turn = { botId: member.id, sessionId, exchangeId }
    if (entry.child === undefined || entry.state === 'crashed' || entry.state === 'exited') {
      // Already said once when it happened; a turn still gets an ending rather than silence.
      return { failure: { reason: entry.state === 'exited' ? 'exited' : 'crashed', detail: entry.detail } }
    }
    started.push(turn)
    const done = new Promise((resolve) => {
      let timer
      const finish = (value) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', abort)
        if (entry.turn === turn) entry.turn = undefined
        resolve(value)
      }
      const abort = () => {
        endChild(entry)
        finish(null)
      }
      timer = setTimeout(() => {
        // A slow process is 'no answer', exactly what the DSH driver reports for the same case:
        // the room's round maps { missed: true } to silence, not to a model failure (#198).
        entry.state = 'timeout'
        entry.detail = 'no answer inside the room turn timeout'
        void report(room, member, 'timeout', entry.detail)
        finish({ missed: true })
      }, rt.roomReplyTimeoutMs ?? ROOM_REPLY_TIMEOUT_MS)
      entry.turn = { ...turn, since: Date.now(), finish }
      entry.state = 'busy'
      signal?.addEventListener?.('abort', abort, { once: true })
    })
    try {
      entry.child.stdin.write(`${JSON.stringify({ type: 'turn', text, note, ...(by ? { from: by } : {}), exchangeId })}\n`)
    } catch (error) {
      settle(entry, 'crashed', oneLine(error?.message ?? error))
      void report(room, member, 'crashed', entry.detail)
    }
    return done
  }

  async function cancel({ sessionId }) {
    for (const [key, entry] of processes) {
      if (sessionIdOfOf(key) !== sessionId) continue
      if (entry.turn === undefined) return false
      endChild(entry)
      // A turn the user stopped ends the way a stopped DSH turn does: with nothing to answer,
      // not with a failure.
      const turn = entry.turn
      entry.turn = undefined
      entry.state = 'stopped'
      turn.finish(null)
      return true
    }
    return false
  }

  // The host shutting a room down (and a test finishing) takes the children with it (#198).
  function close() {
    for (const key of Array.from(processes.keys())) {
      const cut = key.indexOf('\u0000')
      closeParticipant(key.slice(0, cut), key.slice(cut + 1))
    }
  }

  return { kind: 'external', open, runTurn, snapshot, cancel, close, closeParticipant }
}
