// Out-of-app delivery, first half (#355): the adapter that will carry a reminder to Slack.
// A reminder has to reach the owner when the desktop app is closed, so delivery cannot be a
// client toast. The transport is injected; what this module owns is the policy around it: one
// idempotency key per reminder, so a retried send cannot arrive twice; exponential backoff that
// honours `Retry-After`; three attempts at most; no retry at all for a failure that will not
// change (the channel is gone, the app was removed). A channel switched off makes zero transport
// calls, including one that is switched off while it waits to retry.
//
// The real Slack transport waits for the owner's credential, so it is not here: the module speaks
// Slack's `chat.postMessage` shape and ships a fake transport that records every call and scripts
// each answer, which is what makes the retry and dedupe tests possible without a network or a key
// (core/test/notify.test.js). Nothing reads this module yet either — `schedules.js` wiring is the
// second half, once a real channel exists.

export const MAX_ATTEMPTS = 3
// 500 ms, 1 s, 2 s, ... and then a ceiling, so a flaky link retries quickly and a rate limit
// waits as long as the server asked.
export const BASE_DELAY_MS = 500
export const MAX_DELAY_MS = 30_000
// Reminders remembered after they were sent, so a second call for the same one is not a second
// message. A long-lived host drops the oldest rather than grow without bound.
const SENT_KEPT = 1_000

const invalid = message => Object.assign(new Error(message), { code: 'notify/invalid' })

// Failures that can pass on their own: the link, the rate limit, and Slack's own transient codes.
// Slack answers `internal_error` and `fatal_error` for its own trouble and `service_unavailable` /
// `request_timeout` while it is restarting or slow, so one of those must not cost the owner a
// reminder. Everything else is structural (`channel_not_found`, `not_in_channel`, an argument Slack
// will keep refusing, a shape we do not know): the same call would fail the same way, and spending
// two more attempts buys nothing. A new transient code belongs in this set.
const RETRYABLE = new Set(['network', 'rate_limited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])

// Slack answers `{ ok: true, ts }`, or `{ ok: false, error }` with `retryAfterMs` for a 429. A
// transport may also throw instead of answering `network`; both count as a broken link.
function readAnswer(answer) {
  if (answer && answer.ok === true && typeof answer.ts === 'string' && answer.ts) return { ok: true, ts: answer.ts }
  const error = answer && answer.ok === false ? String(answer.error ?? '') : ''
  if (error === 'rate_limited') {
    const asked = Number(answer.retryAfterMs)
    return { ok: false, error, retryAfterMs: Number.isFinite(asked) && asked > 0 ? asked : 0, permanent: false }
  }
  if (error === '') return { ok: false, error: 'network', permanent: false }
  if (RETRYABLE.has(error)) return { ok: false, error, permanent: false }
  return { ok: false, error, permanent: true }
}

// A Slack stand-in for tests. Every call is recorded in `calls`; answers come from `script`, each
// used once, and the last one repeats — so `[rateLimited(2000), { ok: true }]` is one retry and
// then success, and a script of one answer describes every call. An item may be a function of
// (message, attempt), and an `Error` instance is thrown, which is how a broken link looks.
export function fakeSlack(script = [{ ok: true }]) {
  const calls = []
  const queue = Array.isArray(script) ? [...script] : [script]
  return {
    calls,
    async postMessage(message) {
      calls.push(message)
      const scripted = queue.length > 1 ? queue.shift() : queue[0] ?? { ok: true }
      const answer = typeof scripted === 'function' ? await scripted(message, calls.length) : scripted
      if (answer instanceof Error) throw answer
      if (!answer || answer.ok !== true) return { ...answer }
      return { ...answer, ts: answer.ts ?? `ts-${calls.length}` }
    },
  }
}

// The three failures as a transport can spell them, so a test or a later Slack transport does not
// have to re-type the strings.
export const rateLimited = retryAfterMs => ({ ok: false, error: 'rate_limited', retryAfterMs })
export const channelNotFound = () => ({ ok: false, error: 'channel_not_found' })
export const networkFailure = () => ({ ok: false, error: 'network' })

export function createNotifier(options = {}) {
  const { transport, channel } = options
  const attempts = options.attempts ?? MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS
  const log = options.log ?? (() => {})
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  if (!transport || typeof transport.postMessage !== 'function') throw invalid('a transport with postMessage() is required')
  if (typeof channel !== 'string' || !channel.trim()) throw invalid('a channel is required')
  if (!Number.isInteger(attempts) || attempts < 1) throw invalid('attempts must be a positive integer')

  let enabled = options.enabled !== false
  const sent = new Map()
  const refused = new Map()
  const inFlight = new Map()
  const backoff = attempt => Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)

  async function attemptOnce(message) {
    let answer
    try {
      answer = readAnswer(await transport.postMessage(message))
    } catch (error) {
      answer = readAnswer({ ok: false, error: 'network', cause: error })
    }
    return answer
  }

  async function run(key, message) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Checked before every call, not only at the start: switching the channel off stops a
      // reminder that is already waiting out a backoff.
      if (!enabled) return { state: 'skipped', attempts: attempt - 1, reason: 'channel-off' }
      const answer = await attemptOnce(message)
      if (answer.ok) {
        sent.set(key, answer.ts)
        while (sent.size > SENT_KEPT) sent.delete(sent.keys().next().value)
        log('notify: sent %s to %s on attempt %d', key, channel, attempt)
        return { state: 'sent', ts: answer.ts, attempts: attempt }
      }
      if (answer.permanent) {
        refused.set(key, answer.error)
        log('notify: %s cannot reach %s: %s', key, channel, answer.error)
        return { state: 'failed', error: answer.error, attempts: attempt, permanent: true }
      }
      if (attempt === attempts) {
        log('notify: %s not delivered to %s after %d attempts: %s', key, channel, attempt, answer.error)
        return { state: 'failed', error: answer.error, attempts: attempt, permanent: false }
      }
      // `Retry-After` is a floor, never a ceiling: if the server asks for longer than our own
      // backoff, waiting less only earns another 429.
      const waitMs = Math.max(backoff(attempt), answer.retryAfterMs ?? 0)
      log('notify: %s attempt %d failed (%s); retrying in %d ms', key, attempt, answer.error, waitMs)
      await delay(waitMs)
    }
    return { state: 'failed', error: 'network', attempts, permanent: false }
  }

  return {
    get enabled() { return enabled },
    setEnabled(flag) { enabled = flag !== false },
    // At-least-once, deduplicated per `key`: the same reminder handed over again after it was sent
    // is answered with the first result and never reaches the transport a second time; one handed
    // over again while it is in flight joins that attempt instead of starting another. A reminder
    // that gave up after its three attempts is not remembered, so a later run may try again.
    send({ key, text, blocks, threadTs } = {}) {
      if (typeof key !== 'string' || !key.trim()) throw invalid('send() needs a non-empty key')
      if ((typeof text !== 'string' || !text.trim()) && !Array.isArray(blocks)) throw invalid('send() needs text or blocks')
      if (!enabled) return Promise.resolve({ state: 'skipped', attempts: 0, reason: 'channel-off' })
      if (sent.has(key)) return Promise.resolve({ state: 'duplicate', ts: sent.get(key), attempts: 0 })
      if (refused.has(key)) return Promise.resolve({ state: 'failed', error: refused.get(key), attempts: 0, permanent: true })
      if (inFlight.has(key)) return inFlight.get(key)
      const message = { channel, text, ...(blocks ? { blocks } : {}), ...(threadTs ? { threadTs } : {}) }
      const started = run(key, message).finally(() => inFlight.delete(key))
      inFlight.set(key, started)
      return started
    },
  }
}
