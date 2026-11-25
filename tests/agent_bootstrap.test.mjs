import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPersonalAgentBootstrap } from '../runtime/flybot-image/agent-bootstrap.mjs'

test('personal agent bootstrap is optional', () => {
  assert.equal(loadPersonalAgentBootstrap({}, () => {
    throw Object.assign(new Error('missing'), {code: 'ENOENT'})
  }), null)
  assert.equal(loadPersonalAgentBootstrap({}, () => '  '), null)
  assert.equal(loadPersonalAgentBootstrap({}, () => JSON.stringify({origin: 'example', token: 'unused'})), null)
})

test('personal agent bootstrap uses the provisioning file and returns only the bundle', () => {
  const bundle = {feature: 'agents', instance_id: 'a'.repeat(32), rows: []}
  const read = (path, encoding) => {
    assert.equal(path, '/test/provisioning.json')
    assert.equal(encoding, 'utf8')
    return JSON.stringify({origin: 'http://127.0.0.1', token: 'unused', hostname: 'ignored', agent_bootstrap: bundle})
  }
  assert.deepEqual(loadPersonalAgentBootstrap({FLYBOT_WORKSPACE_RUNTIME_KEY_FILE: '/test/provisioning.json'}, read), bundle)
})

test('unreadable or malformed provisioning files fail to import', () => {
  assert.throws(() => loadPersonalAgentBootstrap({}, () => {
    throw Object.assign(new Error('access denied'), {code: 'EACCES'})
  }), {code: 'EACCES'})
  assert.throws(() => loadPersonalAgentBootstrap({}, () => '[]'), /JSON object/)
  assert.throws(() => loadPersonalAgentBootstrap({}, () => '{'), SyntaxError)
})
