// Wires the recorder, the trace and the endpoint to one flybot adapter.
import { createRecorder } from './recorder.js'
import { openTrace, TraceLocked } from './store.js'
import { buildWindow, clampWindow } from './window.js'

export const ENDPOINT = 'timeline/window'

export function createTimeline(adapter, { dir, persist = true, now = Date.now, ...limits } = {}) {
  let trace
  let persisting = persist
  try {
    trace = openTrace({ dir, persist, now, warn: adapter.warn, ...limits })
  } catch (error) {
    // Another live writer, or an unwritable directory: the timeline still works from memory.
    adapter.warn('flybot-timeline: the trace in %s is not writable (%s); recording in memory only', dir, error instanceof TraceLocked ? error.message : error?.message ?? error)
    trace = openTrace({ persist: false, now, warn: adapter.warn, ...limits })
    persisting = false
  }
  const recorder = createRecorder({ adapter, trace, now })
  const off = adapter.subscribe(recorder.handlers)
  recorder.start()

  // The panel polls this every 2 s. Reads only; a host that another dsh holds still answers.
  const window = (body = {}) => buildWindow(trace.records(), {
    now: now(),
    to: Number.isFinite(body?.to) ? body.to : undefined,
    windowMs: clampWindow(body?.windowMs),
    bots: adapter.bots(),
    rooms: adapter.rooms(),
    names: trace.names(),
    stats: { ...trace.stats(), persisting },
  })
  const offEndpoint = adapter.handle(ENDPOINT, window)
  return {
    trace, recorder, window,
    dispose() {
      offEndpoint()
      off()
      trace.close()
    },
  }
}
