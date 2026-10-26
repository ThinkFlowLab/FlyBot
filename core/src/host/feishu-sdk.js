// The long-connection adapter over Feishu's own SDK (#1266). This file is the whole of the
// dependency decision: `feishu-inbound.js` keeps the policy and takes a transport, and this adapts
// the SDK's WebSocket client to that `connect(onEvent) -> { close }` shape. A hand-written protobuf
// client would replace this module and nothing else.
//
// The package is imported inside `connect`, never at the top: a host that never turns the long
// connection on, and every test that injects a stub socket, must run without it installed.
//
// `readEvent` reads Feishu's own `{ header, event }` envelope, but the SDK flattens a v2 event
// before it reaches a handler — `event_id` sits beside `message` — so the envelope is rebuilt here
// rather than teaching the policy layer a second shape.
export const SDK_PACKAGE = '@larksuiteoapi/node-sdk'
// A socket that never opens must not hang a start: the row says `error` instead.
export const READY_TIMEOUT_MS = 15_000

const within = (promise, ms, message) => {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

export function createFeishuTransport({
  credentials,
  importSdk = () => import(SDK_PACKAGE),
  log = () => {},
  readyTimeoutMs = READY_TIMEOUT_MS,
} = {}) {
  return {
    // The app pair is read on every dial, not when the adapter is made: the owner saves it on the
    // Secrets page at any time, and a pair that is not there refuses before any import or socket.
    async connect(onEvent) {
      const app = credentials?.()
      if (app === undefined) throw new Error('A Feishu app id and app secret are needed before the long connection can dial')
      let sdk
      try {
        sdk = await importSdk()
      } catch (error) {
        const why = String(error?.message ?? error).split('\n')[0]
        throw new Error(`The Feishu long connection needs ${SDK_PACKAGE} installed: ${why}`)
      }
      const Lark = sdk?.default ?? sdk
      const { WSClient, EventDispatcher } = Lark ?? {}
      if (typeof WSClient !== 'function' || typeof EventDispatcher !== 'function') throw new Error(`${SDK_PACKAGE} does not export the long-connection client`)

      const dispatcher = new EventDispatcher({}).register({
        'im.message.receive_v1': data => onEvent({
          header: { event_id: data?.event_id, event_type: 'im.message.receive_v1' },
          event: { sender: data?.sender, message: data?.message },
        }),
      })
      let settle
      const opened = new Promise((resolve, reject) => { settle = { resolve, reject } })
      const client = new WSClient({
        appId: app.appId,
        appSecret: app.appSecret,
        // `onReady` is the first open; a later reconnect is not a second inbox, so it only logs.
        onReady: () => settle.resolve(),
        onError: error => settle.reject(error),
        onReconnecting: () => log('the Feishu long connection is reconnecting'),
      })
      try {
        await client.start({ eventDispatcher: dispatcher })
        await within(opened, readyTimeoutMs, 'the Feishu long connection did not open')
      } catch (error) {
        try { client.close({ force: true }) } catch { /* nothing was opened */ }
        throw error
      }
      let closed = false
      return {
        close: () => {
          if (closed) return
          closed = true
          try { client.close({ force: true }) } catch { /* an already-dead socket is not an error */ }
        },
      }
    },
  }
}
