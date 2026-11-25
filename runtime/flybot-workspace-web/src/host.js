// Process-wide handle to the user's DS-Bot runtime for FlyBot features.
// The runtime wrapper (runtime/flybot-image/plugin/index.js) calls attachRuntime()
// right after createRuntime(); @flybot-workspace/web and every feature reach the same
// module instance (same file, Node resolves the profile symlinks to real paths).
let attached = null
const waiters = new Set()

// value = { rt, ctx, ...services }. Services the runtime wrapper provides today:
//   chatTurn(conversationKey, text, requestId) → { text, sessionId, turnId }  (one native DS-Bot turn)
//   mainBot() → botId of the user's Main Bot (after provider/model setup)
// Calling attachRuntime again (e.g. once services are ready) replaces the handle.
export function attachRuntime(value) {
  if (!value || !value.rt || !value.ctx) throw new Error('flybot-workspace-web: attachRuntime needs { rt, ctx }')
  attached = Object.freeze({ ...value })
  for (const resolve of waiters) resolve(attached)
  waiters.clear()
  return attached
}

export function detachRuntime() { attached = null }

// Resolve with { rt, ctx } of this user's DS-Bot. Rejects after timeoutMs so a
// feature endpoint fails visibly instead of hanging when DS-Bot did not start.
export function runtime({ timeoutMs = 15_000 } = {}) {
  if (attached) return Promise.resolve(attached)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(done); reject(Object.assign(new Error('DS-Bot runtime is not attached'), { code: 'flybot-workspace/runtime-unavailable' })) }, timeoutMs)
    timer.unref?.()
    const done = (value) => { clearTimeout(timer); resolve(value) }
    waiters.add(done)
  })
}

export function currentRuntime() { return attached }
