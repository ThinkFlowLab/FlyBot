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
