#!/usr/bin/env node
// The plane's CLI (#3113). `token` mints an operator token for an account and prints it once —
// the store keeps only the digest, so what leaves the terminal is the only copy. `serve` starts
// the HTTP surface on the loopback with a lifecycle backend of your choice; this slice ships the
// compose-generating backend, which runs nothing.
import { MemoryBackend, ComposeBackend } from '../src/lifecycle.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { openStore } from '../src/store.mjs'
import { serve } from '../src/server.mjs'

const usage = `@flybot/plane — the FlyBot management plane (#3113), first slice.

  node plane/bin/plane.mjs token --data-dir <dir> --account <id>
      Mint an operator token for <id>; printed once, only its sha256 is stored.
  node plane/bin/plane.mjs serve --data-dir <dir> [--port 3090] [--backend compose|memory]
      Serve /api/* on 127.0.0.1. The compose backend materializes instance projects and
      never runs docker; upgrade and recycle are not implemented in this slice.
`

const flag = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 && at + 1 < process.argv.length ? process.argv[at + 1] : null
}

const command = process.argv[2]
const dataDir = flag('--data-dir')
if (!command || !dataDir) {
  console.error(usage)
  process.exit(2)
}

if (command === 'token') {
  const accountId = flag('--account')
  if (!accountId) { console.error('token needs --account <id>'); process.exit(2) }
  const store = openStore(dataDir)
  const { token } = mintOperatorToken(store, accountId)
  console.log(token)
  process.exit(0)
}

if (command === 'serve') {
  const port = Number(flag('--port') ?? 3090)
  const which = flag('--backend') ?? 'compose'
  const backend = which === 'memory' ? new MemoryBackend() : new ComposeBackend({ root: dataDir })
  const server = await serve({ port, dataDir, backend, log: line => console.log(line) })
  console.log(`plane listening on 127.0.0.1:${port} (backend: ${which})`)
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else {
  console.error(usage)
  process.exit(2)
}
