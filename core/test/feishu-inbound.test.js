import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_ID_SECRET, APP_SECRET_SECRET, DEDUPE_RING, appCredentials, createInbound, readEvent } from '../src/host/feishu-inbound.js'

// #1266 phase 2: a message in Feishu starts a turn here, over the long connection. The socket is not
// part of this module — every test injects one — so what is asserted is the policy a DSH upgrade or a
// stranger's message would break: one turn per event, the owner only, nothing dialled while off.

const OWNER = 'ou_owner_1'

const event = ({ id = 'e1', openId = OWNER, chatId = 'oc_chat_1', text = 'hello there', type = 'text', content } = {}) => ({
  header: { event_id: id, event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: openId } },
    message: { chat_id: chatId, message_type: type, content: content ?? JSON.stringify({ text }) },
  },
})

function setup(options = {}) {
  // `'ownerOpenId' in options` matters: an explicit `undefined` is the case "the owner was never
  // configured", which must not fall back to the default the other tests use.
  const { enabled = true, connect, nameOf } = options
  const ownerOpenId = 'ownerOpenId' in options ? options.ownerOpenId : OWNER
  const turns = []
  const logs = []
  const dials = []
  const transport = {
    connect: connect ?? (async (onEvent) => { dials.push(onEvent); return { close: async () => {} } }),
    nameOf: nameOf ?? (async () => 'Owner'),
  }
  const inbound = createInbound({
    enabled,
    ownerOpenId,
    transport,
    deliver: async message => { turns.push(message) },
    log: (...args) => logs.push(args.map(String).join(' ')),
    redact: text => String(text).split('app-secret').join('[redacted]'),
    now: () => Date.parse('2026-10-26T10:00:00Z'),
  })
  return { inbound, turns, logs, dials }
}

test('a replayed event_id starts one turn, and the second one says duplicate (#1266)', async () => {
  const { inbound, turns, logs } = setup()
  await inbound.start()
  assert.equal(await inbound.handleEvent(event()), 'delivered')
  assert.equal(await inbound.handleEvent(event()), 'duplicate')
  assert.equal(turns.length, 1)
  assert.equal(turns[0].handle, 'feishu:oc_chat_1')
  assert.equal(turns[0].text, 'hello there')
  assert.match(logs.join('\n'), /duplicate/)
  assert.equal(inbound.view().duplicates, 1)
})

test('a ring this size still forgets the oldest id, so a fresh event is not refused (#1266)', async () => {
  const { inbound, turns } = setup()
  await inbound.start()
  await inbound.handleEvent(event({ id: 'ring-oldest' }))
  for (let n = 0; n < DEDUPE_RING; n += 1) await inbound.handleEvent(event({ id: `filler-${n}` }))
  assert.equal(turns.length, DEDUPE_RING + 1)
  assert.equal(inbound.seen(), DEDUPE_RING)
  // The oldest id left the ring, so a replay of it lands again: bounded memory is the priced choice.
  assert.equal(await inbound.handleEvent(event({ id: 'ring-oldest' })), 'delivered')
  assert.equal(turns.length, DEDUPE_RING + 2)
})

test('a message from anyone but the owner starts no turn (#1266)', async () => {
  const { inbound, turns, logs } = setup()
  await inbound.start()
  assert.equal(await inbound.handleEvent(event({ openId: 'ou_someone_else' })), 'refused')
  assert.equal(turns.length, 0)
  assert.match(logs.join('\n'), /not the owner/)
  assert.equal(inbound.view().refused, 1)
})

test('no owner and no open_id never compare equal (#1266)', async () => {
  const unset = setup({ ownerOpenId: undefined })
  await unset.inbound.start()
  assert.notEqual(await unset.inbound.handleEvent(event()), 'delivered')
  assert.equal(unset.turns.length, 0)
  const blank = setup({ ownerOpenId: '' })
  await blank.inbound.start()
  assert.notEqual(await blank.inbound.handleEvent(event({ openId: '' })), 'delivered')
  assert.equal(blank.turns.length, 0)
})

test('switched off, it dials nothing at all (#1266)', async () => {
  const { inbound, dials } = setup({ enabled: false })
  assert.equal(await inbound.start(), 'off')
  assert.equal(dials.length, 0)
  assert.equal(inbound.view().state, 'off')
})

test('a failed connect is one redacted line in the row, not a thrown start (#1266)', async () => {
  const { inbound } = setup({
    connect: async () => { throw new Error('handshake refused: app-secret=app-secret') },
  })
  assert.equal(await inbound.start(), 'error')
  const view = inbound.view()
  assert.equal(view.state, 'error')
  assert.match(view.error, /handshake refused/)
  assert.doesNotMatch(view.error, /app-secret/)
  assert.match(view.error, /\[redacted\]/)
})

test('one socket per connector: a second start while it dials shares the first (#1266)', async () => {
  const { inbound, dials } = setup()
  const [a, b] = await Promise.all([inbound.start(), inbound.start()])
  assert.equal(a, 'ready')
  assert.equal(b, 'ready')
  assert.equal(dials.length, 1)
  assert.equal(inbound.view().connected, 1)
})

test('an event that is not a text message is logged and starts nothing (#1266)', async () => {
  const { inbound, turns, logs } = setup()
  await inbound.start()
  assert.equal(await inbound.handleEvent(event({ type: 'image' })), 'ignored')
  assert.equal(await inbound.handleEvent(event({ content: 'not json' })), 'ignored')
  assert.equal(await inbound.handleEvent({ header: { event_id: 'e9' } }), 'ignored')
  assert.equal(turns.length, 0)
  assert.match(logs.join('\n'), /no readable text message/)
})

test('a text message drops the mention placeholders and names the chat after the conversation (#1266)', async () => {
  const { inbound, turns } = setup({ nameOf: async () => '  Someone  ' })
  await inbound.start()
  await inbound.handleEvent(event({ text: '@_user_1 ping the desk' }))
  assert.equal(turns[0].text, 'ping the desk')
  assert.equal(turns[0].name, 'Someone')
  const unnamed = setup({ nameOf: async () => { throw new Error('no profile read') } })
  await unnamed.inbound.start()
  await unnamed.inbound.handleEvent(event({ chatId: 'oc_named_later' }))
  assert.equal(unnamed.turns[0].name, 'feishu:oc_named_later')
})

test('readEvent reads only the envelope phase 2 means to accept (#1266)', () => {
  assert.deepEqual(readEvent(event({ id: 'e5', chatId: 'oc_5', text: 'a line' })), { id: 'e5', openId: OWNER, chatId: 'oc_5', text: 'a line' })
  assert.equal(readEvent({}), null)
  assert.equal(readEvent(event({ content: '{}' })), null)
  assert.equal(readEvent(event({ text: '   ' })), null)
  assert.equal(readEvent({ header: { event_id: 'e6' }, event: { sender: { sender_id: { open_id: OWNER } }, message: { chat_id: 'oc', message_type: 'text', content: '{"text":"x"}' } } }) !== null, true)
})

test('the app pair is one credential: either half missing dials nothing (#1266)', () => {
  const secrets = { [APP_ID_SECRET]: 'cli_app_1', [APP_SECRET_SECRET]: 'app-secret-value' }
  const read = name => secrets[name]
  assert.deepEqual(appCredentials(read), { appId: 'cli_app_1', appSecret: 'app-secret-value' })
  assert.equal(appCredentials(name => (name === APP_ID_SECRET ? undefined : secrets[name])), undefined)
  assert.equal(appCredentials(name => (name === APP_SECRET_SECRET ? '   ' : secrets[name])), undefined)
  assert.equal(appCredentials(undefined), undefined)
})

test('the view never carries either half of the app pair (#1266)', async () => {
  const secrets = { [APP_ID_SECRET]: 'cli_app_1', [APP_SECRET_SECRET]: 'app-secret-value' }
  const seen = []
  const transport = {
    connect: async () => { throw new Error(`handshake refused for ${secrets[APP_ID_SECRET]} / ${secrets[APP_SECRET_SECRET]}`) },
  }
  const inbound = createInbound({
    enabled: true,
    ownerOpenId: OWNER,
    transport,
    deliver: async message => { seen.push(message) },
    redact: text => String(text).split(secrets[APP_SECRET_SECRET]).join('[redacted]').split(secrets[APP_ID_SECRET]).join('[redacted]'),
  })
  await inbound.start()
  const view = JSON.stringify(inbound.view())
  assert.match(view, /handshake refused/)
  assert.doesNotMatch(view, /app-secret-value/)
  assert.doesNotMatch(view, /cli_app_1/)
  assert.equal(seen.length, 0)
})

test('with no socket adapter installed it says so instead of pretending (#1266)', async () => {
  const inbound = createInbound({ enabled: true, ownerOpenId: OWNER, deliver: async () => {} })
  assert.equal(await inbound.start(), 'error')
  assert.deepEqual(inbound.view().error, 'no long-connection transport is installed')
  assert.equal(inbound.view().connected, 0)
})

test('an adapter installed after the first start is the one the next start dials (#1266)', async () => {
  // The policy is made before the adapter exists — the shape a module that installs its socket later
  // has. A missing adapter must not be remembered as the answer.
  const transport = { current: undefined }
  const dials = []
  const inbound = createInbound({
    enabled: true,
    ownerOpenId: OWNER,
    transport: () => transport.current,
    deliver: async () => {},
  })
  assert.equal(await inbound.start(), 'error')
  assert.equal(inbound.view().error, 'no long-connection transport is installed')
  transport.current = { connect: async onEvent => { dials.push(onEvent); return { close: async () => {} } } }
  assert.equal(await inbound.start(), 'ready')
  assert.equal(dials.length, 1, 'the adapter that arrived late is the one that dialled')
  assert.equal(inbound.view().connected, 1)
})

test('a stop while the socket dials hangs up the one that arrives and never reports ready (#1266)', async () => {
  let release
  const dialling = new Promise(resolve => { release = resolve })
  const closed = []
  const inbound = createInbound({
    enabled: true,
    ownerOpenId: OWNER,
    transport: {
      connect: async () => { await dialling; return { close: async () => { closed.push(1) } } },
    },
    deliver: async () => {},
  })
  const started = inbound.start()
  await inbound.stop()
  release()
  assert.equal(await started, 'stopped', 'the dial that outlived stop is not adopted')
  assert.deepEqual(closed, [1], 'the socket that arrived after stop is hung up, not leaked')
  assert.equal(inbound.view().state, 'connecting', 'the row does not flip back to ready behind the owner')
  assert.equal(inbound.view().connected, 0)
})

// #1266 INC (Reviewer): the ring used to be written *before* `deliver`, so a delivery that threw
// left the id in it and every replay read `duplicate` — a lost message the owner could never get
// back. The id now enters the ring only once the message has been handed to its chat.
test('a message whose delivery throws is handed over again, not remembered as handled (#1266)', async () => {
  const turns = []
  let refuse = true
  const inbound = createInbound({
    enabled: true,
    ownerOpenId: OWNER,
    transport: { connect: async () => ({ close: async () => {} }) },
    deliver: async message => {
      if (refuse) {
        refuse = false
        throw new Error('no chat seam is installed for a Feishu message')
      }
      turns.push(message)
    },
  })
  await inbound.start()
  await assert.rejects(inbound.handleEvent(event()), /no chat seam is installed/)
  assert.equal(await inbound.handleEvent(event()), 'delivered', 'the same event_id is handled again')
  assert.equal(turns.length, 1)
  assert.equal(inbound.view().duplicates, 0, 'a failed delivery is not a duplicate')
  assert.equal(inbound.seen(), 1, 'the ring holds the id once, after the delivery succeeded')
})

test('two copies of one event arriving together still start one turn (#1266)', async () => {
  const turns = []
  let release
  const handed = new Promise(resolve => { release = resolve })
  const inbound = createInbound({
    enabled: true,
    ownerOpenId: OWNER,
    transport: { connect: async () => ({ close: async () => {} }) },
    deliver: async message => { await handed; turns.push(message) },
  })
  await inbound.start()
  const first = inbound.handleEvent(event())
  const second = inbound.handleEvent(event())
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.sort(), ['delivered', 'duplicate'])
  assert.equal(turns.length, 1)
})
