// Feishu inbound over the long connection, first half (#1266): a message the owner types in Feishu
// starts a turn here. The socket itself is not in this module. Everything that decides is: the
// default-off switch, the owner gate, the bounded `event_id` ring, and the connection state the
// Settings row reads — all of it over an injected transport, so the dependency question (the
// official SDK versus a hand-written protobuf client) changes one adapter and nothing else.
//
// Two things this module deliberately does not decide:
// - how a Feishu conversation is *drawn* here. Phase 2 lands the message through
//   `remote-chat.deliver` (`core/src/host/remote-chat.js`), whose `SOURCE_KIND`/`REMOTE_FORM` are
//   Bot Social's shape; a Feishu chat rendered as "a friend's Bot" is a Settings question that is
//   open, not something to settle inside a transport.
// - how the socket reconnects. A transport that drops hands the same `event_id` in again, and the
//   ring is what makes that land once; speaking twice is the transport's send policy, not ours.
//
// The message from Feishu is untrusted text from outside the team, and `deliver` already fences it.

// A reconnect replays a tail of recent events. This is how far back that tail may reach: a small
// ring, dropped oldest first, never a growing set and never persisted with a secret in it.
export const DEDUPE_RING = 512
// `off` before the owner turns it on, `connecting` while the socket dials, `ready` once open, and
// `error` with one redacted line: the four values phase 1's row already uses for a connector.
export const STATES = ['off', 'connecting', 'ready', 'error']

// Feishu's event envelope: `header.event_id` and `header.event_type`, then `event.sender.sender_id.open_id`
// and `event.message.{chat_id, message_type, content}`, where `content` is a JSON *string*.
// Anything else — a v1 shape, a card callback, an edited message — reads as null and is logged, not
// guessed at: a connector that invents a message out of an unknown body is worse than one that says
// it does not know it.
export function readEvent(envelope) {
  const header = envelope?.header
  const message = envelope?.event?.message
  const sender = envelope?.event?.sender?.sender_id
  if (typeof header?.event_id !== 'string' || header.event_id === '') return null
  if (typeof message?.chat_id !== 'string' || message.chat_id === '') return null
  if (typeof sender?.open_id !== 'string') return null
  if (message.message_type !== 'text') return null
  let text
  try {
    text = JSON.parse(String(message.content ?? '')).text
  } catch {
    return null
  }
  if (typeof text !== 'string' || text.trim() === '') return null
  // A text message mentions people as `@_user_1` placeholders; the handle map that resolves them is
  // not something the owner's own 1:1 chat needs, so the placeholders are dropped rather than shown.
  return { id: header.event_id, openId: sender.open_id, chatId: message.chat_id, text: text.replace(/@_user_\d+\s*/g, '').trim() }
}

// Phase 1 spent one secret per connector (`FEISHU_WEBHOOK`, redacted by secrets.js). The long
// connection needs an app, which is a pair: this reads both through the same `rt.secretValue` and
// answers undefined unless both are present, so a half-configured app dials nothing instead of
// failing at the handshake. The two values never leave this function: the view reports `missing`,
// never the id or the secret.
export const APP_ID_SECRET = 'FEISHU_APP_ID'
export const APP_SECRET_SECRET = 'FEISHU_APP_SECRET'

export function appCredentials(secretValue) {
  const id = secretValue?.(APP_ID_SECRET)
  const secret = secretValue?.(APP_SECRET_SECRET)
  const asText = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const appId = asText(id)
  const appSecret = asText(secret)
  if (appId === undefined || appSecret === undefined) return undefined
  return { appId, appSecret }
}

export const handleOf = chatId => `feishu:${chatId}`

// `transport` is the only piece the dependency decision can change:
//   { connect(onEvent) -> Promise<{ close(): Promise<void>|void }>, nameOf(openId) -> Promise<string|undefined> }
// It may also be a function answering that object, in which case it is called again on every
// `start()`: an adapter that is installed after this module still comes up, and one replaced while
// the connection is off is the one the next start dials.
// `deliver({ handle, text, name })` is `remote-chat`'s seam, and `redact` is `rt.redactSecrets`.
export function createInbound({
  enabled = false,
  ownerOpenId,
  transport,
  deliver,
  log = () => {},
  redact = text => text,
  now = () => Date.now(),
  ring = DEDUPE_RING,
} = {}) {
  const seen = new Set()
  const order = []
  // Events being handed over right now. Two copies of one event can arrive while the first is still
  // in `deliver`; the ring is written only after that resolves (#1266 INC), so this is what keeps the
  // second copy from starting a second turn in the gap.
  const inFlight = new Set()
  const view = { state: enabled ? 'connecting' : 'off', connected: 0, duplicates: 0, refused: 0, ignored: 0 }
  let closer
  let starting
  // Bumped by `stop()`: a dial that was already in flight when the owner stopped the connector is
  // not the socket this module wants open any more, so the one that arrives is hung up instead of
  // adopted, and the row does not flip back to `ready` behind the owner's back.
  let generation = 0

  const socketOf = () => (typeof transport === 'function' ? transport() : transport)

  const remember = (id) => {
    if (seen.has(id)) return false
    seen.add(id)
    order.push(id)
    if (order.length > ring) seen.delete(order.shift())
    return true
  }

  // The owner is the only sender that may start a turn. An unset or empty id refuses everyone: a
  // missing owner and a missing `open_id` must never compare equal.
  const owner = () => (typeof ownerOpenId === 'string' && ownerOpenId !== '' ? ownerOpenId : undefined)

  async function nameOf(openId) {
    if (typeof transport?.nameOf !== 'function') return undefined
    try {
      const name = await transport.nameOf(openId)
      return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
    } catch {
      return undefined
    }
  }

  async function handleEvent(envelope) {
    const read = readEvent(envelope)
    if (read === null) {
      view.ignored += 1
      log('a Feishu event carried no readable text message; no turn started')
      return 'ignored'
    }
    const expected = owner()
    if (expected === undefined || read.openId !== expected) {
      view.refused += 1
      log('a Feishu message from %s is not the owner; no turn started', read.openId)
      return 'refused'
    }
    if (seen.has(read.id) || inFlight.has(read.id)) {
      view.duplicates += 1
      log('a Feishu event %s was already handled; duplicate ignored', read.id)
      return 'duplicate'
    }
    inFlight.add(read.id)
    try {
      const name = (await nameOf(read.openId)) ?? handleOf(read.chatId)
      await deliver({ handle: handleOf(read.chatId), text: read.text, name })
    } finally {
      inFlight.delete(read.id)
    }
    // Only now is the id handled: a `deliver` that threw leaves it out of the ring, so a replayed
    // event is handed over again instead of being called a duplicate for ever (Reviewer, #1266).
    remember(read.id)
    view.lastEventAt = new Date(now()).toISOString()
    return 'delivered'
  }

  // One socket per connector. A second start while the first dials shares it, so a reconnect loop
  // cannot become two members of the same conversation.
  function start() {
    if (!enabled) return Promise.resolve('off')
    if (starting !== undefined) return starting
    const socket = socketOf()
    // No adapter yet is a configuration state, not a failed dial: nothing is remembered, so a later
    // start — a person pressing Try again, once the adapter is there — still dials instead of reading
    // the same error back forever.
    if (typeof socket?.connect !== 'function') {
      view.state = 'error'
      view.error = 'no long-connection transport is installed'
      log('the Feishu long connection has no transport: %s', view.error)
      return Promise.resolve('error')
    }
    const mine = generation
    const attempt = (async () => {
      try {
        const opened = await socket.connect(handleEvent)
        if (mine !== generation) {
          // `stop()` ran while this socket dialled. Hang up what arrived; report it neither ready nor
          // as another connection.
          await Promise.resolve().then(() => opened?.close?.()).catch(() => { /* an already-dead socket is not an error */ })
          return 'stopped'
        }
        closer = opened
        view.state = 'ready'
        view.connected += 1
        delete view.error
        return 'ready'
      } catch (error) {
        if (mine !== generation) return 'stopped'
        view.state = 'error'
        view.error = redact([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'connect failed').slice(0, 300)
        log('the Feishu long connection failed: %s', view.error)
        return 'error'
      }
    })()
    starting = attempt
    // A failed dial is not shared either: the next start tries again with whatever is installed then.
    void attempt.then(result => { if (starting === attempt && result !== 'ready') starting = undefined })
    return attempt
  }

  async function stop() {
    generation += 1
    starting = undefined
    const closing = closer
    closer = undefined
    view.state = enabled ? 'connecting' : 'off'
    if (closing !== undefined) await Promise.resolve().then(() => closing.close()).catch(() => { /* an already-dead socket is not an error */ })
  }

  const viewOf = () => ({ state: view.state, ...(view.error === undefined ? {} : { error: view.error }), ...(view.lastEventAt === undefined ? {} : { lastEventAt: view.lastEventAt }), connected: view.connected, duplicates: view.duplicates, refused: view.refused })
  return { start, stop, handleEvent, view: viewOf, seen: () => seen.size }
}
