import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readEvent } from '../src/host/feishu-inbound.js'
import { SDK_PACKAGE, createFeishuTransport } from '../src/host/feishu-sdk.js'

// #1266: the one adapter that needs Feishu's own SDK. What is asserted here is the seam, not the
// network: the package is imported only when a socket is dialled, the SDK's flattened v2 event is
// handed to the policy as Feishu's own envelope, and a socket that fails or never opens ends the
// start with a line the row can show.

const APP = { appId: 'cli_0123456789abcdef', appSecret: 'app-secret-value' }

// A stand-in for the package: it records what the adapter asked it to do.
function fakeSdk({ open = true } = {}) {
  const made = []
  class EventDispatcher {
    register(handles) { this.handles = handles; return this }
  }
  class WSClient {
    constructor(params) { this.params = params; this.closed = []; made.push(this) }
    start({ eventDispatcher }) {
      this.handles = eventDispatcher.handles
      if (open) this.params.onReady?.()
      return Promise.resolve()
    }
    close(params) { this.closed.push(params ?? {}) }
  }
  return { made, sdk: { WSClient, EventDispatcher } }
}

const doesNotImport = () => { throw new Error('the package must not be imported here') }

test('the SDK is imported at dial time, and its flattened event reaches the policy as Feishu sends it (#1266)', async () => {
  const { made, sdk } = fakeSdk()
  let imported = 0
  const seen = []
  const transport = createFeishuTransport({
    credentials: () => APP,
    importSdk: async () => { imported += 1; return sdk },
  })
  assert.equal(imported, 0, 'nothing is imported before a socket is dialled')
  const closer = await transport.connect(envelope => { seen.push(envelope) })
  assert.equal(imported, 1)
  assert.equal(made[0].params.appId, APP.appId)
  assert.equal(made[0].params.appSecret, APP.appSecret)

  // The SDK merges `header` and `event` into one object (`event_id` beside `message`); the adapter
  // rebuilds the envelope `readEvent` reads, so the policy keeps one shape.
  await made[0].handles['im.message.receive_v1']({
    event_id: 'e1',
    sender: { sender_id: { open_id: 'ou_owner' } },
    message: { chat_id: 'oc_1', message_type: 'text', content: '{"text":"hello there"}' },
  })
  assert.deepEqual(readEvent(seen[0]), { id: 'e1', openId: 'ou_owner', chatId: 'oc_1', text: 'hello there' })

  closer.close()
  assert.deepEqual(made[0].closed, [{ force: true }])
  closer.close()
  assert.equal(made[0].closed.length, 1, 'closing twice hangs up once')
})

test('a package that is not installed is one readable line, not a stack (#1266)', async () => {
  const transport = createFeishuTransport({
    credentials: () => APP,
    importSdk: async () => { throw new Error(`Cannot find package '${SDK_PACKAGE}' imported from core`) },
  })
  await assert.rejects(transport.connect(async () => {}), /needs @larksuiteoapi\/node-sdk installed: Cannot find package/)
})

test('with no app pair saved nothing is imported and nothing dials (#1266)', async () => {
  const transport = createFeishuTransport({ credentials: () => undefined, importSdk: doesNotImport })
  await assert.rejects(transport.connect(async () => {}), /app id and app secret are needed/)
})

test('a socket that reports an error ends the start with that error (#1266)', async () => {
  class WSClient {
    constructor(params) { this.params = params }
    start() { this.params.onError(new Error('handshake refused')) }
    close() {}
  }
  class EventDispatcher { register(handles) { this.handles = handles; return this } }
  const transport = createFeishuTransport({ credentials: () => APP, importSdk: async () => ({ WSClient, EventDispatcher }) })
  await assert.rejects(transport.connect(async () => {}), /handshake refused/)
})

test('a socket that never opens is given up at the deadline instead of hanging the start (#1266)', async () => {
  const { made, sdk } = fakeSdk({ open: false })
  const transport = createFeishuTransport({ credentials: () => APP, importSdk: async () => sdk, readyTimeoutMs: 10 })
  await assert.rejects(transport.connect(async () => {}), /did not open/)
  assert.equal(made[0].closed.length, 1, 'the half-open client is hung up')
})
