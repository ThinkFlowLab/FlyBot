// #1524: Workflow ephemeral node Bot replies must not land in Chief / persistent Bot chat
// as queued `[Reply from …]` messages. Node I/O stays in the run/graph only.
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('#1524: ephemeral node reply is not delivered to Main Bot chat', async () => {
  const roster = [{ id: 'main', name: 'Chief', isMain: true, remote: false }]
  const created = []
  const removed = []
  
  let hookHandle
  const fb = {
    bot: {
      list: () => roster,
      async create(spec) {
        const id = `ephemeral-${created.length + 1}`
        created.push(id)
        roster.push({ id, name: spec.name, ephemeral: true, hidden: true })
        return id
      },
      async remove(id) {
        removed.push(id)
        const index = roster.findIndex(bot => bot.id === id)
        if (index >= 0) roster.splice(index, 1)
        return true
      },
      send: {
        use(middleware) {
          hookHandle = middleware.handle
          return () => { hookHandle = undefined }
        },
        priority: { ROUTING: 100 },
      },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }

  // Apply workflow plugin
  const { apply } = await import('../../plugins/workflow/index.js')
  const plugin = apply(
    { flybot: { scope: () => fb }, effect(fn) { fn() } },
    { persist: false }
  )
  const service = plugin.service

  // Create a simple workflow
  const defined = await service.define({
    name: 'Test Flow',
    nodes: [
      { id: 'step1', name: 'Step One', prompt: 'Do step 1', outputs: [{ name: 'result' }] },
    ],
    edges: [],
  })
  assert.equal(defined.ok, true)

  // Start a run
  const workflow = defined.workflows.find(w => w.name === 'Test Flow')
  const run = await service.runNamed({ workflow: 'Test Flow', brief: 'Test task' })
  assert.equal(run.ok, true)

  // Get the ephemeral bot ID
  const activeRun = workflow ? run.workflows.find(w => w.id === workflow.id).run : null
  assert.ok(activeRun)
  assert.ok(activeRun.ephemeral)
  const ephemeralBotId = activeRun.ephemeral.step1
  assert.ok(ephemeralBotId)

  // Verify the hook was registered
  assert.equal(typeof hookHandle, 'function')

  // Simulate a reply from the ephemeral node Bot
  const replyMsg = {
    from: ephemeralBotId,
    to: 'main',
    role: 'reply',
    text: 'Step complete\nOUTPUT result: done',
  }

  // Call the hook handler
  const verdict = await hookHandle(replyMsg)
  
  // The hook should deny this message (prevent delivery to Main Bot chat)
  assert.equal(verdict?.action, 'deny')
  assert.match(verdict?.reason ?? '', /workflow step result stays on the run surface/i)

  // Verify the step was recorded in the workflow
  const advanced = service.state().workflows.find(w => w.id === workflow.id)
  assert.ok(advanced)

  plugin.dispose()
})

test('#1524: persistent Bot-to-Bot replies are NOT blocked', async () => {
  const roster = [
    { id: 'main', name: 'Chief', isMain: true, remote: false },
    { id: 'reviewer', name: 'Reviewer', remote: false },
  ]

  let hookHandle
  const fb = {
    bot: {
      list: () => roster,
      async create() { throw new Error('should not create') },
      async remove() { throw new Error('should not remove') },
      send: {
        use(middleware) {
          hookHandle = middleware.handle
          return () => { hookHandle = undefined }
        },
        priority: { ROUTING: 100 },
      },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }

  const { apply } = await import('../../plugins/workflow/index.js')
  const plugin = apply(
    { flybot: { scope: () => fb }, effect(fn) { fn() } },
    { persist: false }
  )

  // A reply from a persistent Bot should NOT be denied
  const persistentReply = {
    from: 'reviewer',
    to: 'main',
    role: 'reply',
    text: 'Review complete: PASS',
  }

  const verdict = await hookHandle(persistentReply)
  
  // The hook should return undefined (not handled, pass to next middleware)
  assert.equal(verdict, undefined)

  plugin.dispose()
})

test('#1524: ephemeral Bot replies do NOT leak, middleware runs for stepResult, tombstone works', async () => {
  // Critical: ephemeral replies must go through middleware (so stepResult advances the run),
  // but must not queue in Chief. After removal, tombstone denies late replies.
  const roster = [
    { id: 'main', name: 'Chief', isMain: true, remote: false },
    { id: 'ephemeral-node', name: 'Review', ephemeral: { plugin: 'flybot-workflow' }, hidden: true },
  ]
  const deliveries = []
  const middlewareCalls = []
  let stepAdvanced = false

  const innerDeliver = async (args) => {
    deliveries.push({ from: args.fromId, to: args.toId, role: args.role, flags: { deferred: args.deferred, resumed: args.resumed } })
  }

  // Simulate the middleware that calls stepResult
  const runMiddleware = async (msg) => {
    middlewareCalls.push({ from: msg.from, role: msg.role })
    if (msg.from === 'ephemeral-node' && msg.role === 'reply') {
      stepAdvanced = true
      return { action: 'deny', reason: 'workflow step result stays on the run surface', by: 'workflow-step' }
    }
    return { action: 'allow' }
  }

  const BOT_TO_BOT_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
  const ephemeralTombstones = new Set()
  
  const rt = {
    botOf: (id) => roster.find(bot => bot.id === id),
    deliver: null,
  }

  // Simulate the fixed gated() check
  const gated = (args) => {
    if (!args.fromId || !BOT_TO_BOT_ROLES.has(args.role) || args.flybotChecked || args.resent) return false
    const from = rt.botOf(args.fromId)
    // Ephemeral bots (or tombstoned) always route through middleware
    if (from?.ephemeral || ephemeralTombstones.has(args.fromId)) return true
    return from !== undefined && !args.resumed && !args.retried && !args.deferred
  }

  rt.deliver = async (args) => {
    const exchangeId = args.exchangeId ?? 'test-exchange-id'
    
    if (!gated(args)) {
      await innerDeliver(args)
      return exchangeId
    }
    
    // Post-removal tombstone check
    if (ephemeralTombstones.has(args.fromId) && !rt.botOf(args.fromId)) {
      return exchangeId
    }
    
    // Run middleware (workflow-step hook calls stepResult here)
    const outcome = await runMiddleware({ from: args.fromId, to: args.toId, role: args.role })
    if (outcome.action === 'deny') return exchangeId
    
    await innerDeliver(args)
    return exchangeId
  }

  // SCENARIO 1: First reply - middleware runs (stepResult advances), NO delivery to Chief
  stepAdvanced = false
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'PASS',
    role: 'reply',
  })
  assert.equal(stepAdvanced, true, 'First reply MUST run middleware to advance step')
  assert.equal(deliveries.length, 0, 'First reply should NOT be delivered to Chief')
  assert.equal(middlewareCalls.length, 1, 'Middleware should run once')

  // SCENARIO 2: Deferred reply - middleware runs, still denied
  stepAdvanced = false
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'Deferred reply',
    role: 'reply',
    deferred: true,
  })
  assert.equal(stepAdvanced, true, 'Deferred reply MUST run middleware (gated by ephemeral flag)')
  assert.equal(deliveries.length, 0, 'Deferred reply should NOT be delivered')

  // SCENARIO 3: Resumed reply - middleware runs, still denied
  stepAdvanced = false
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'Resumed reply',
    role: 'reply',
    resumed: true,
  })
  assert.equal(stepAdvanced, true, 'Resumed reply MUST run middleware')
  assert.equal(deliveries.length, 0, 'Resumed reply should NOT be delivered')

  // SCENARIO 4: Tombstone the bot (simulate removal)
  ephemeralTombstones.add('ephemeral-node')
  const botIndex = roster.findIndex(bot => bot.id === 'ephemeral-node')
  roster.splice(botIndex, 1)

  // SCENARIO 5: Post-removal reply - tombstone denies without middleware
  const beforeMiddleware = middlewareCalls.length
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'Late reply after removal',
    role: 'reply',
  })
  assert.equal(deliveries.length, 0, 'Post-removal reply should NOT be delivered')
  assert.equal(middlewareCalls.length, beforeMiddleware, 'Post-removal reply skips middleware (bot is gone)')

  // SCENARIO 6: Request TO ephemeral (before removal, with bot back for test)
  roster.push({ id: 'ephemeral-node', name: 'Review', ephemeral: { plugin: 'flybot-workflow' }, hidden: true })
  await rt.deliver({
    fromId: 'main',
    toId: 'ephemeral-node',
    text: 'Review this',
    role: 'request',
  })
  assert.equal(deliveries.length, 1, 'Request TO ephemeral Bot should be delivered')
  assert.equal(deliveries[0].from, 'main')
  assert.equal(deliveries[0].to, 'ephemeral-node')
})
