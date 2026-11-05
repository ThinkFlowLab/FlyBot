// Resource-side stop acknowledgement plus exact process birth/exit, not Task success.
import { mkdir, lstat, realpath, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { captureProcessScope, priorHostProcessExited } from './project-process-proof.js'
const exec = promisify(execFile)
export const SDK_EXIT_VERSION = 'project-sdk-exit/v1'
function identity(value) {
  if (value?.version !== SDK_EXIT_VERSION || !isAbsolute(value.root ?? '') || !/^[A-Za-z0-9_-]{1,120}$/.test(value.workerId ?? '') || !/^[A-Za-z0-9_-]{1,120}$/.test(value.leaseId ?? '') || !Number.isSafeInteger(value.generation) || value.generation < 1) throw Error('Invalid SDK exit identity')
  return { version: SDK_EXIT_VERSION, workerId: value.workerId, leaseId: value.leaseId, generation: value.generation }
}
async function target(value, create = false) {
  const expected = identity(value), root = await realpath(value.root), directory = join(root, '.flybot-sdk-exit')
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw Error('SDK exit directory changed')
  return { expected, path: join(directory, expected.workerId + '.json') }
}
async function record(value) {
  const { expected, path } = await target(value), info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw Error('SDK exit record changed')
  const row = JSON.parse(await readFile(path, 'utf8'))
  if (Object.entries(expected).some(([key, field]) => row[key] !== field) || !['running', 'stopped'].includes(row.status)) throw Error('SDK exit record identity changed')
  return { row, path }
}
export async function registerSdkExit(value) {
  const { expected, path } = await target(value, true)
  await writeFile(path, JSON.stringify({ ...expected, scope: await captureProcessScope(), status: 'running' }), { flag: 'wx', mode: 0o600 })
}
export async function acknowledgeSdkStop(value) {
  const { row, path } = await record(value)
  if (row.scope.hostPid !== process.pid) throw Error('SDK exit writer changed')
  const pending = path + '.stopped'
  await writeFile(pending, JSON.stringify({ ...row, status: 'stopped' }), { flag: 'wx', mode: 0o600 })
  await rename(pending, path)
}
// pidfd pins the verified process; no signal fallback to a potentially reused PID.
const stopProcess = `import os,sys,json,signal
s=json.loads(sys.argv[1])
fd=os.pidfd_open(s['hostPid'])
try:
 if open('/proc/sys/kernel/random/boot_id').read().strip()!=s['bootId'] or os.readlink('/proc/self/ns/pid')!=s['pidNamespace']: sys.exit(2)
 stat=open('/proc/'+str(s['hostPid'])+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
 if fields[19]!=s['startTicks']: sys.exit(2)
 signal.pidfd_send_signal(fd,signal.SIGTERM)
finally: os.close(fd)
`
export async function inspectSdkExit(value, { stop = false } = {}) {
  let current
  try { current = await record(value) } catch { return { status: 'unknown', reason: 'missing-or-invalid-receipt' } }
  if (current.row.status === 'stopped' && await priorHostProcessExited(current.row.scope)) return { status: 'exited', ...identity(value), scope: current.row.scope }
  if (!stop) return { status: 'unknown', reason: 'stop-or-process-exit-unconfirmed' }
  try {
    const scope = current.row.scope
    if (!/^[a-f0-9-]{36}$/.test(scope?.bootId ?? '') || !/^\d+$/.test(scope?.startTicks ?? '') || !/^pid:\[\d+\]$/.test(scope?.pidNamespace ?? '') || !Number.isSafeInteger(scope.hostPid) || scope.hostPid < 1) return { status: 'unknown', reason: 'process-birth-unavailable' }
    await exec('python3', ['-c', stopProcess, JSON.stringify(scope)], { timeout: 2000, maxBuffer: 8192, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } })
  } catch { return { status: 'unknown', reason: 'verified-stop-unavailable' } }
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const result = await inspectSdkExit(value)
    if (result.status === 'exited') return result
  }
  return { status: 'unknown', reason: 'stop-or-process-exit-unconfirmed' }
}
export async function forgetSdkExit(value) {
  const { path } = await record(value)
  await unlink(path)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, text] = process.argv.slice(2), value = JSON.parse(text)
    if (action === 'forget') { await forgetSdkExit(value); process.stdout.write('{}') }
    else if (['inspect', 'stop'].includes(action)) process.stdout.write(JSON.stringify(await inspectSdkExit(value, { stop: action === 'stop' })))
    else throw Error('Unsupported SDK exit operation')
  } catch { process.stdout.write(JSON.stringify({ status: 'unknown', reason: 'exit-evidence-unavailable' })); process.exitCode = 1 }
}
