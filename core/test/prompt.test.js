import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start({ statuses = {}, library = [] } = {}) {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { id: 'main', name: 'Chief' }],
    ['worker', { id: 'worker', name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
    capabilityStatusesView: () => statuses,
    capabilityLibraryView: () => library,
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  // The host's own join: sections in order, empty ones dropped, one blank line between
  // (dsh-system-prompt renderSections). Rendering here keeps the byte-level assertion real.
  const render = id => [...ctx.sections.values()]
    .sort((a, b) => a.order - b.order)
    .map(section => section.text({ agent: { id } }))
    .filter(text => text.length > 0)
    .join('\n\n')
  const capabilities = id => ctx.sections.get('bot-capabilities')?.text({ agent: { id } })
  return { ctx, prompt, render, capabilities }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Group chat …]", "[Message from …]", "[Reply from …]", or "[Continue task]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

// Part B of #645: the default is idle. The prompt used to describe only an active team (a
// coordinator that dispatches, children that report and claim), so a team with no work still
// produced status traffic. Both directions are asserted here: the idle default is present as a
// quotable rule, and the unprompted work instruction is gone.
test('a Bot stays idle until it is addressed or given a task (part B of #645)', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const idle =
    '- By default you stay idle: you do nothing until the user addresses you, you are @-mentioned in a group, your parent Bot gives you a task, or unfinished tasks from work you were given are still on your board. Do not invent work, send messages, or report on your own initiative. Being addressed still gets an answer as usual — this rule is about the default when you have been given nothing to do.'
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    assert.ok(text.split('\n').includes(idle), `${id} carries the idle default as its own rule`)
    assert.equal(text.split(idle).length - 1, 1, `${id} carries the idle rule once`)
    assert.doesNotMatch(text, /report back/, `${id} no longer tells a Bot to report back unprompted`)
    assert.doesNotMatch(text, /\bdispatch\b/, `${id} carries no dispatch instruction`)
  }
  assert.match(prompt('main'), /A coordinator acts on a user task, not on its own initiative\./)
  assert.match(prompt('main'), /Unfinished tasks already on your board are a user task\./)
  assert.match(prompt('worker'), /A "\[Continue task\]" message is unfinished work you were already given/)
  assert.match(prompt('worker'), /Do not invent another job/)
  assert.match(prompt('worker'), /overall: true/)
  assert.match(prompt('worker'), /the task lead records one overall task/)
  assert.match(prompt('worker'), /Do not wait for the user to confirm/)
  assert.doesNotMatch(prompt('worker'), /hand work to another with @Name/)
  assert.match(prompt('worker'), /@Name only wakes a member; it does not assign work or record progress/)
  assert.match(prompt('worker'), /set its column to in-progress with track_tasks/)
  assert.match(prompt('worker'), /That update is the progress/)
  assert.match(prompt('worker'), /post one short question in the group only when a person there has to decide/)
  assert.doesNotMatch(prompt('worker'), /never ask_user in your own chat/)
  assert.match(prompt('worker'), /pass ask with the one question/)
  assert.equal(prompt('worker').split('overall: true').length - 1, 1)
  assert.doesNotMatch(prompt('worker'), /coordinator/, 'the coordinator wording belongs to the Main Bot')
  // A Bot that is addressed answers exactly as before: the reply rule is still there, unchanged.
  const replyRule = '- When a "[Reply from …]" arrives, tell the user the outcome if it matters to them.'
  for (const id of ['main', 'worker']) assert.ok(prompt(id).split('\n').includes(replyRule), `${id} still answers a reply`)
})

// #3273: a Bot must not promise work for one of its own capabilities that cannot be reached.
// The identity section stays byte-stable (the prompt prefix is cached), so the state lives in a
// second section that renders to nothing whenever every attached capability is usable.
test('#3273: a capability whose connection failed is named before the Bot acts', (t) => {
  const { ctx, render, prompt, capabilities } = start({
    statuses: { worker: { github: { state: 'error', error: '401 bad credentials' } } },
    library: [{ name: 'github', kind: 'mcp' }],
  })
  t.after(() => ctx.dispose())
  const text = render('worker')
  assert.equal(capabilities('worker').split('\n')[0], '# Capabilities that need attention', 'the section carries its own title, so the list is not read as a continuation of the identity block')
  assert.equal(capabilities('worker').split('# Capabilities that need attention').length - 1, 1, 'one title, once')
  assert.ok(
    text.split('\n').includes('- github (mcp): 401 bad credentials — tell the user before acting.'),
    `the failed capability and its reason are on one line:\n${text}`,
  )
  assert.equal(text.slice(0, prompt('worker').length), prompt('worker'), 'the identity section is untouched')
  assert.doesNotMatch(prompt('worker'), /401 bad credentials/, 'the identity section stays byte-stable')
})

test('#3273: a capability waiting for the user is named the same way', (t) => {
  const { ctx, render } = start({
    statuses: { worker: { github: { state: 'needs-approval' } } },
    library: [{ name: 'github', kind: 'mcp' }],
  })
  t.after(() => ctx.dispose())
  const text = render('worker')
  assert.ok(
    text.split('\n').includes('- github (mcp): needs user approval — tell the user before acting.'),
    `the unapproved capability asks the Bot to say so first:\n${text}`,
  )
})

test('#3273: only the capabilities that are not usable are listed, ready ones are silent', (t) => {
  const { ctx, capabilities } = start({
    statuses: {
      worker: {
        github: { state: 'error', error: '401 bad credentials' },
        linear: { state: 'ready' },
        slack: { state: 'needs-approval' },
      },
    },
    library: [{ name: 'github', kind: 'mcp' }, { name: 'linear', kind: 'mcp' }, { name: 'slack', kind: 'pack' }],
  })
  t.after(() => ctx.dispose())
  const listed = capabilities('worker').split('\n').filter(line => line.startsWith('- '))
  assert.deepEqual(listed, [
    '- github (mcp): 401 bad credentials — tell the user before acting.',
    '- slack (pack): needs user approval — tell the user before acting.',
  ])
})

// Test found by mutation that a healthy render compared only against another render of the same
// code proves nothing: a trailing space added to the identity text passes both sides. The claim is
// that the healthy prompt *is* the identity text, so its exact head and its exact last line are
// pinned here as literals, and the capability section has to contribute the empty string.
const IDENTITY_LAST_RULE = '- When you cannot continue without an answer, pass ask with the one question on that task. On a group card, worked in your own chat, call ask_user for the user, and post one short question in the group only when a person there has to decide. On your own chat\'s other tasks, ask_user. When the answer arrives, pass answer with what they said and update the task. Do not leave the task waiting without that question.'
const IDENTITY_HEADS = {
  main: "# Your identity\nYou are Chief, a Bot on the user's team in FlyBot.",
  worker: "# Your identity\nYou are Dev, a Bot on the user's team in FlyBot.",
}

test('#3273: a healthy Bot renders exactly the prompt it renders today', (t) => {
  const healthy = start({ statuses: { main: {}, worker: { github: { state: 'ready' } } }, library: [{ name: 'github', kind: 'mcp' }] })
  const none = start()
  t.after(() => healthy.ctx.dispose())
  t.after(() => none.ctx.dispose())
  assert.deepEqual([...healthy.ctx.sections.keys()].sort(), ['bot-capabilities', 'bot-identity'])
  assert.equal(healthy.ctx.sections.get('bot-identity').order, 640)
  assert.equal(healthy.ctx.sections.get('bot-capabilities').order, 700)
  for (const id of ['main', 'worker']) {
    assert.equal(healthy.capabilities(id), '', 'nothing unhealthy renders no section text at all')
    const text = healthy.render(id)
    assert.ok(text.startsWith(IDENTITY_HEADS[id]), `${id}: the rendered prompt starts on the identity title and the Bot's own line, byte for byte`)
    assert.ok(text.endsWith(IDENTITY_LAST_RULE), `${id}: the rendered prompt ends on the last identity rule — no separator, no blank line, no trailing space`)
    assert.equal(text.trimEnd(), text, `${id}: no trailing whitespace`)
    assert.equal(healthy.render(id), none.render(id), 'byte for byte the prompt a Bot with no capabilities gets')
    assert.equal(none.render(id), none.prompt(id), 'the rendered prompt is the identity section alone — no extra section, no blank line')
  }
  // A relay session is not a Bot: it never carries capability state.
  assert.equal(healthy.render('room'), healthy.prompt('room'))
})

test('#3273: one Bot never sees another Bot\'s capability state, and a failure is whole-Bot', (t) => {
  const { ctx, capabilities, render } = start({
    statuses: {
      main: { github: { state: 'ready' } },
      worker: { github: { state: 'error', error: '401 bad credentials' } },
    },
    library: [{ name: 'github', kind: 'mcp' }],
  })
  t.after(() => ctx.dispose())
  assert.equal(capabilities('main'), '', 'the Chief sees no line for a Worker capability that is down')
  assert.equal(render('main').includes('401 bad credentials'), false)
  assert.ok(capabilities('worker').includes('- github (mcp): 401 bad credentials'), 'the Bot whose capability is down sees it')
  // The status view aggregates per Bot across its Sessions, the same way list_capabilities does:
  // a failure reached in one Session is the whole Bot's failure, so the group Session reads it too.
  assert.equal(render('group-worker'), render('worker'))
})

test('#3273: an error with no reason still reads as a sentence', (t) => {
  const { ctx, capabilities } = start({
    statuses: { worker: { github: { state: 'error', error: '   ' }, linear: { state: 'error', error: '' } } },
    library: [{ name: 'github', kind: 'mcp' }, { name: 'linear', kind: 'mcp' }],
  })
  t.after(() => ctx.dispose())
  assert.deepEqual(capabilities('worker').split('\n').filter(line => line.startsWith('- ')), [
    '- github (mcp): not connected — tell the user before acting.',
    '- linear (mcp): not connected — tell the user before acting.',
  ], 'an empty or whitespace-only reason becomes "not connected", never a dangling dash')
})
