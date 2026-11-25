// HEALTHCHECK for the FlyBot Workspace runtime. Tries the container address
// first (DSH 0.2.2 binds one concrete address), then loopback.
const port = process.env.DSH_LISTEN_PORT || '8080'
const hosts = new Set(['127.0.0.1'])
try {
  const { execFileSync } = await import('node:child_process')
  const address = execFileSync('hostname', ['-i'], { encoding: 'utf8' }).trim().split(/\s+/)[0]
  if (address) hosts.add(address)
} catch { /* hostname -i is optional */ }

let last = 'no probe'
for (const host of hosts) {
  try {
    const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) })
    if (response.status === 200 || response.status === 401) process.exit(0)
    last = `HTTP ${response.status} from ${host}`
  } catch (error) {
    last = `${host}: ${error?.message ?? error}`
  }
}
console.error(`healthcheck failed: ${last}`)
process.exit(1)
