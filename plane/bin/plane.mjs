#!/usr/bin/env node
// Operator CLI. `token` is the one place a plaintext operator token is printed — once.
import { resolve } from 'node:path'
import { join } from 'node:path'
import { openStore } from '../src/store.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { ComposeBackend } from '../src/lifecycle.mjs'
import { createPlane } from '../index.js'
import { serve } from '../src/server.mjs'

const USAGE = `usage:
  node plane/bin/plane.mjs token --data-dir <dir> [--account <id>]
  node plane/bin/plane.mjs serve --data-dir <dir> [--port 3090]

token   mint an operator token (printed once; only its sha256 is stored)
serve   run the management-plane API on 127.0.0.1:<port>`

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=')
    if (inline !== undefined) flags[key] = inline
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[i + 1], (i += 1)
    else flags[key] = true
  }
  return flags
}

function dataDirFrom(flags) {
  if (typeof flags['data-dir'] !== 'string' || flags['data-dir'] === '') {
    console.error('plane: --data-dir <dir> is required')
    process.exit(2)
  }
  return resolve(flags['data-dir'])
}

const [command, ...rest] = process.argv.slice(2)
const flags = parseFlags(rest)

if (command === 'token') {
  const dataDir = dataDirFrom(flags)
  const account = typeof flags.account === 'string' ? flags.account : 'owner_local'
  const store = openStore(dataDir)
  const token = mintOperatorToken(store, account)
  // stdout only: this is the mint, not a log line.
  console.log(`account: ${account}`)
  console.log(`token: ${token}`)
  console.error('plane: this token is shown once and is not recoverable; store it outside the repository.')
} else if (command === 'serve') {
  const dataDir = dataDirFrom(flags)
  const port = flags.port === undefined ? 3090 : Number(flags.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('plane: --port must be an integer between 1 and 65535')
    process.exit(2)
  }
  const store = openStore(dataDir)
  const backend = new ComposeBackend({ instancesDir: join(dataDir, 'instances') })
  const plane = createPlane({ dataDir, store, backend })
  serve({ port, plane, store })
  console.log(`plane: listening on http://127.0.0.1:${port}`)
} else {
  console.error(USAGE)
  process.exit(2)
}
