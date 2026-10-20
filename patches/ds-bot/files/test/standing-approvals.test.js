import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/standing-approvals.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name !== 'react') throw new Error(`no platform module ${name}`)
    return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) }
  },
})
const { standingOf, StandingApprovalsCard } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

// #540: the Always allowed card in Bot and Group settings, each grant with Remove.
test('a group lists only the grants the signed-in person gave, and all of them before anyone signs in', () => {
  const room = { id: 'r1', standingApprovals: [{ kind: 'bash', ownerId: 'm1' }, { kind: 'pwsh', ownerId: 'm2' }] }
  assert.deepEqual(plain(standingOf(room, { self: { memberId: 'm1' } }).map(grant => grant.kind)), ['bash'])
  assert.deepEqual(plain(standingOf(room, { self: null }).map(grant => grant.kind)), ['bash', 'pwsh'])
})

test('Remove revokes that one grant on its Bot or group, and an empty list draws nothing', () => {
  const calls = []
  const actions = { removeStandingApproval: (...args) => { calls.push(args); return 'p' } }
  const run = value => value
  const bot = { id: 'b', standingApprovals: [{ kind: 'bash:escalate:danger-full-access', label: 'bash · danger-full-access' }] }
  const card = StandingApprovalsCard({ scope: 'bot', target: bot, roster: { self: null }, actions, run, Card: (props, ...children) => ({ props, children }) })
  const [row] = card.children.flat()
  const button = row.children.find(node => node.type === 'button')
  assert.equal(button.children.join(''), 'Remove')
  button.props.onClick()
  assert.deepEqual(plain(calls), [['bot', 'b', 'bash:escalate:danger-full-access']])
  assert.equal(StandingApprovalsCard({ scope: 'room', target: { id: 'r1' }, roster: { self: null }, actions, run, Card: () => ({}) }), null)
})
