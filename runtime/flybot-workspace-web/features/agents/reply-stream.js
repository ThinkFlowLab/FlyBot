import { setTimeout as sleep } from 'node:timers/promises'

const encoder = new TextEncoder()
const terminal = new Set(['succeeded', 'failed', 'cancelled'])

export function waitForReplyChange(progress, delay, signal) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      progress.waiters.delete(done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, delay)
    progress.waiters.add(done)
    if (signal?.aborted) done()
    else signal?.addEventListener('abort', done, {once:true})
  })
}

export function replyStream({ findReply, request, release }) {
  const lifetime = new AbortController()
  const opened = Date.now()
  let streamController
  let previous
  let finished = false
  const close = () => finish(false)
  const timer = setTimeout(close, 190_000)
  timer.unref?.()
  function finish(cancelled) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    request.signal.removeEventListener('abort', close)
    lifetime.abort()
    release()
    if (!cancelled) streamController.close()
  }
  function emit(value) {
    streamController.enqueue(encoder.encode(value))
  }
  const unchanged = ({state,progress}) => state === previous?.state && progress === previous.progress
    && progress?.revision === previous.revision
  const body = new ReadableStream({
    start(controller) {
      streamController = controller
      emit(': connected\n\n')
    },
    async pull() {
      try {
        const {signal} = lifetime
        let reading = findReply()
        while (reading.state === 'pending' && unchanged(reading) && Date.now() - opened < 3000) {
          await sleep(125, undefined, {signal})
          reading = findReply()
        }
        if (reading.state !== 'pending' && unchanged(reading)) {
          if (reading.progress) await waitForReplyChange(reading.progress, 10_000, signal)
          else await sleep(1500, undefined, {signal})
          if (finished) return
          reading = findReply()
        }
        if (reading.state === 'pending' && Date.now() - opened >= 3000) {
          close()
          return
        }
        const {state, progress} = reading
        const revision = progress?.revision
        if (unchanged(reading)) {
          emit('event: heartbeat\ndata: {}\n\n')
          return
        }
        const text = progress?.text ?? reading.text ?? ''
        const old = previous?.text ?? ''
        const change = text.startsWith(old) ? {append:text.slice(old.length)} : {text}
        emit('data: ' + JSON.stringify({state, phase:progress?.phase, revision, ...change}) + '\n\n')
        previous = {state, progress, revision, text}
        if (terminal.has(state)) close()
      } catch {
        close()
      }
    },
    cancel() { finish(true) },
  })
  if (request.signal.aborted) close()
  else request.signal.addEventListener('abort', close, {once:true})
  return new Response(body, {headers:{
    'content-type':'text/event-stream; charset=utf-8',
    'cache-control':'private, no-cache, no-store, no-transform',
    'x-accel-buffering':'no',
    'x-content-type-options':'nosniff',
  }})
}
