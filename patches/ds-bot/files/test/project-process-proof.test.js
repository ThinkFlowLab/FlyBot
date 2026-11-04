import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureProcessScope, priorScopeExited } from '../src/host/project-process-proof.js'
const invocation = 'a'.repeat(32), changed = 'b'.repeat(32)
const fixture = id => ({ pid: 123, environment: { INVOCATION_ID: id }, readText: async path => path.endsWith('boot_id') ? 'same-boot' : path.endsWith('cgroup') ? '0::/system.slice/flybot-test.service\n' : '123 (node) S 1 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 900 0', inspectManager: async () => `InvocationID=${id}\nKillMode=control-group\nControlGroup=/system.slice/flybot-test.service\n` })
test('a changed supervised invocation with the same control-group kill boundary proves prior exit', async () => {
  const original = await captureProcessScope(fixture(invocation))
  assert.equal(original.kind, 'systemd-control-group')
  assert.equal(await priorScopeExited(original, fixture(invocation)), false)
  assert.equal(await priorScopeExited(original, fixture(changed)), true)
})
test('PID disappearance, changed host boot, remote resources or changed kill policy cannot fabricate exit proof', async () => {
  const original = await captureProcessScope(fixture(invocation))
  assert.equal(await priorScopeExited({ kind: 'unmanaged-process', hostPid: 999999 }), false)
  assert.equal(await priorScopeExited(original, { ...fixture(changed), inspectManager: async () => `InvocationID=${changed}\nKillMode=process\nControlGroup=/system.slice/flybot-test.service` }), false)
  assert.equal(await priorScopeExited(original, { ...fixture(changed), readText: async path => path.endsWith('boot_id') ? 'different-boot' : fixture(changed).readText(path) }), false)
  assert.equal(await priorScopeExited({ kind: 'remote-resource' }, fixture(changed)), false)
})

test('birth-checked unmanaged host exit is distinct from independent worker/process-group exit', async () => {
  const { priorHostProcessExited } = await import('../src/host/project-process-proof.js')
  const scope = { kind: 'unmanaged-process', hostPid: 123, bootId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), startTicks: '900', pidNamespace: 'pid:[123]' }
  const readText = async path => path.endsWith('boot_id') ? scope.bootId : `${scope.hostPid} (node) ${['S', ...Array(18).fill('0'), '900'].join(' ')}`
  const readNamespace = async () => scope.pidNamespace
  assert.equal(await priorHostProcessExited(scope, { readText, readNamespace }), false)
  assert.equal(await priorHostProcessExited(scope, { readNamespace, readText: async path => path.endsWith('boot_id') ? scope.bootId : readText(path).then(text => text.replace('900', '901')) }), true)
  assert.equal(await priorHostProcessExited(scope, { readNamespace, readText: async path => { if (path.endsWith('boot_id')) return scope.bootId; throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } }), true)
  for (const code of ['EACCES', 'EPERM', 'EIO']) assert.equal(await priorHostProcessExited(scope, { readNamespace, readText: async () => { throw Object.assign(new Error('unknown'), { code }) } }), false)
  assert.equal(await priorHostProcessExited(scope, { readNamespace, readText: async () => 'other-boot' }), false)
  assert.equal(await priorHostProcessExited({ ...scope, startTicks: null }, { readText, readNamespace }), false)
  assert.equal(await priorScopeExited(scope), false, 'Host death is never a generic resource exit proof')
})
