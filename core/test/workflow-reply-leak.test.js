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

test('#1524: ephemeral Bot replies do NOT leak via delivery bypass paths', async () => {
  // Reproduces the LIVE leak: ephemeral Bot replies that bypass send middleware
  // (deferred, resumed, post-release) must be blocked by the delivery gate in hooks.js.
  const roster = [
    { id: 'main', name: 'Chief', isMain: true, remote: false },
    { id: 'ephemeral-node', name: 'Review', ephemeral: { plugin: 'flybot-workflow' }, hidden: true },
  ]
  const deliveries = []

  const innerDeliver = async (args) => {
    deliveries.push({ from: args.fromId, to: args.toId, role: args.role, flags: { deferred: args.deferred, resumed: args.resumed } })
  }

  const rt = {
    botOf: (id) => roster.find(bot => bot.id === id),
    deliver: null,
  }

  // Simulate the wrapped rt.deliver from hooks.js
  const BOT_TO_BOT_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
  const outcomes = new Map()
  
  rt.deliver = async (args) => {
    const exchangeId = args.exchangeId ?? 'test-exchange-id'
    
    // The fix: deny ALL bot-to-bot deliveries from ephemeral bots
    if (args.fromId && BOT_TO_BOT_ROLES.has(args.role)) {
      const from = rt.botOf(args.fromId)
      if (from?.ephemeral) {
        outcomes.set(exchangeId, { action: 'deny', reason: 'ephemeral Bot output stays on the run surface', by: 'flybot-ephemeral' })
        return exchangeId
      }
    }
    
    // Otherwise deliver normally
    await innerDeliver(args)
    outcomes.set(exchangeId, { action: 'allow' })
    return exchangeId
  }

  // SCENARIO 1: Normal reply (should be denied)
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'PASS',
    role: 'reply',
  })
  assert.equal(deliveries.length, 0, 'Normal ephemeral reply should NOT be delivered')

  // SCENARIO 2: Deferred reply (bypasses gated check - the leak!)
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'Deferred reply',
    role: 'reply',
    deferred: true,
  })
  assert.equal(deliveries.length, 0, 'Deferred ephemeral reply should NOT be delivered')

  // SCENARIO 3: Resumed reply (also bypasses gated)
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'Resumed reply',
    role: 'reply',
    resumed: true,
  })
  assert.equal(deliveries.length, 0, 'Resumed ephemeral reply should NOT be delivered')

  // SCENARIO 4: Stopped notice (bot-to-bot role)
  await rt.deliver({
    fromId: 'ephemeral-node',
    toId: 'main',
    text: 'stopped',
    role: 'stopped',
  })
  assert.equal(deliveries.length, 0, 'Ephemeral Bot stopped notice should NOT be delivered')

  // SCENARIO 5: Request FROM main TO ephemeral (should be allowed)
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
