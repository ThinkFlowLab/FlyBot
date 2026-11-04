// A manager lifecycle boundary can prove exit after restart; a missing PID alone cannot.
import { readFile, readlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const read = path => readFile(path, 'utf8')
const namespace = () => readlink('/proc/self/ns/pid')
const manager = async unit => (await exec('/usr/bin/systemctl', ['show', unit, '--property=InvocationID,KillMode,ControlGroup'], { timeout: 2000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })).stdout
export async function captureProcessScope({ readText = read, inspectManager = manager, environment = process.env, pid = process.pid, readNamespace = namespace } = {}) {
  const base = { kind: 'unmanaged-process', hostPid: pid }
  if (process.platform !== 'linux') return base
  try {
    const [boot, cgroups, stat] = await Promise.all([readText('/proc/sys/kernel/random/boot_id'), readText('/proc/self/cgroup'), readText(`/proc/${pid}/stat`)])
    base.pidNamespace = await readNamespace()
    base.bootId = boot.trim(); base.startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    const group = cgroups.split('\n').find(line => line.startsWith('0::'))?.slice(3), unit = group?.split('/').find(part => /^[A-Za-z0-9_.@-]+\.service$/.test(part))
    if (!unit || !/^[a-f0-9]{32}$/.test(environment.INVOCATION_ID ?? '')) return base
    const fields = Object.fromEntries((await inspectManager(unit)).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    if (fields.InvocationID !== environment.INVOCATION_ID || fields.KillMode !== 'control-group' || fields.ControlGroup !== group) return base
    return { ...base, kind: 'systemd-control-group', unit, controlGroup: group, invocationId: fields.InvocationID, killMode: fields.KillMode }
  } catch { return base }
}
export async function priorScopeExited(scope, options = {}) {
  if (scope?.kind !== 'systemd-control-group' || scope.killMode !== 'control-group') return false
  const current = await captureProcessScope(options)
  // Different machines/boots, unmanaged launchers or changed kill policy remain unknown.
  return current.kind === 'systemd-control-group' && current.bootId === scope.bootId && current.unit === scope.unit && current.controlGroup === scope.controlGroup && current.invocationId !== scope.invocationId
}
export function supervisorProofMatches(scope, proof) {
  return Boolean(scope?.kind === 'systemd-control-group' && scope.killMode === 'control-group' && /^[a-f0-9]{32}$/.test(scope.invocationId ?? '') &&
    proof?.kind === 'systemd-prior-invocation-exited' && proof.previousInvocationId === scope.invocationId)
}

// Proves only the old host process exited. NEVER use this as SDK/container,
// native role tool subprocess or resource preparation exit confirmation.
export async function priorHostProcessExited(scope, { readText = read, readNamespace = namespace } = {}) {
  if (!['unmanaged-process', 'systemd-control-group'].includes(scope?.kind) || !Number.isSafeInteger(scope.hostPid) || scope.hostPid < 1 || !/^[a-f0-9-]{36}$/.test(scope.bootId ?? '') || !/^\d+$/.test(scope.startTicks ?? '') || !/^pid:\[\d+\]$/.test(scope.pidNamespace ?? '')) return false
  try { if ((await readText('/proc/sys/kernel/random/boot_id')).trim() !== scope.bootId || await readNamespace() !== scope.pidNamespace) return false } catch { return false }
  try {
    const stat = await readText(`/proc/${scope.hostPid}/stat`), end = stat.lastIndexOf(')')
    if (end < 0 || stat.slice(0, stat.indexOf(' ')) !== String(scope.hostPid)) return false
    const fields = stat.slice(end + 2).split(' ')
    if (!/^\d+$/.test(fields[19] ?? '')) return false
    return fields[19] !== scope.startTicks || fields[0] === 'Z' || fields[0] === 'X'
  } catch (error) { return error.code === 'ENOENT' }
}
