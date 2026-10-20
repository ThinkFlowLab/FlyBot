// Dev-only (#511): rebuild the saved team (state.json) from a state journal, up to one
// entry, to replay a multi-Bot bug step by step. Local only: no network (every network
// and process call throws), the output file is new and mode 0600, and a journal with any
// unreadable or inconsistent line is refused as a whole.
// Usage: node scripts/replay.mjs <home>/journal/state.jsonl [--to <seq>] [--out <file>]
// Without --out the team is printed. Open the output in a test bench home (a copy, as
// state.json), never in the home the journal came from.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import childProcess from 'node:child_process'
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
import { replayTo, stateText } from '../src/host/journal.js'

const offline = () => { throw new Error('replay: no network or process calls') }
globalThis.fetch = offline
globalThis.WebSocket = offline
net.Socket.prototype.connect = offline
net.Server.prototype.listen = offline
http.request = http.get = https.request = https.get = offline
dgram.createSocket = offline
tls.connect = http2.connect = dns.lookup = dns.resolve = offline
dns.promises.lookup = dns.promises.resolve = offline
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = offline
syncBuiltinESMExports()

const usage = 'usage: node scripts/replay.mjs <journal.jsonl> [--to <seq>] [--out <file>]'
const fail = (message) => {
  console.error(`replay: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
let journal
let to
let out
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at]
  if (arg === '--to') {
    const value = args[++at]
    if (!/^\d+$/.test(value ?? '')) fail(`--to needs an entry number\n${usage}`)
    to = Number(value)
  } else if (arg === '--out') {
    out = args[++at]
    if (!out) fail(`--out needs a file\n${usage}`)
  } else if (journal === undefined && !arg.startsWith('--')) {
    journal = arg
  } else {
    fail(usage)
  }
}
if (journal === undefined) fail(usage)

let text
try {
  text = stateText(replayTo(readFileSync(journal, 'utf8'), to))
} catch (error) {
  fail(`refused: ${error?.message ?? error}`)
}
if (out === undefined) {
  process.stdout.write(text)
} else {
  try {
    writeFileSync(out, text, { mode: 0o600, flag: 'wx' })
    chmodSync(out, 0o600)
  } catch (error) {
    fail(`cannot write ${out}: ${error?.code ?? error?.message ?? error}`)
  }
}
