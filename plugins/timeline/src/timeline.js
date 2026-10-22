// Wires the recorder, the trace and the endpoint to one flybot adapter.
import { createRecorder } from './recorder.js'
import { openTrace, TraceLocked } from './store.js'
import { buildWindow, clampWindow } from './window.js'
import { createExporter, otlpPayload, spansFrom } from './otel.js'
import { buildHealth } from './health.js'
import { createAlertTracker } from './alerts.js'

export const ENDPOINT = 'timeline/window'
export const EXPORT_ENDPOINT = 'timeline/export'
export const HEALTH_ENDPOINT = 'timeline/health'
export const ALERTS_ENDPOINT = 'timeline/alerts'

export function createTimeline(adapter, { dir, persist = true, now = Date.now, exporter, ...limits } = {}) {
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

  // OTLP export is opt-in: without an `exporter` (send + intervalMs) nothing leaves the host.
  let exportTimer
  let exportNow
  if (exporter && typeof exporter.send === 'function') {
    const cursor = createExporter({ send: exporter.send, serviceName: exporter.serviceName, serviceVersion: exporter.serviceVersion, exportNames: exporter.exportNames === true, warn: adapter.warn })
    exportNow = async () => { try { return await cursor.push(trace.records(), trace.names()) } catch (error) { adapter.warn('flybot-timeline: export failed: %s', error?.message ?? error); return 0 } }
    const intervalMs = Number.isFinite(exporter.intervalMs) && exporter.intervalMs > 0 ? exporter.intervalMs : 5000
    exportTimer = setInterval(() => { void exportNow() }, intervalMs)
    exportTimer.unref?.()
  }

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
  // On-demand OTLP export (#357): the same mapping the timer exporter uses, built from the trace
  // as it stands. Ids only unless the caller asks for names (#483), so a one-off export never
  // sends another home's names by accident.
  const exportWindow = (body = {}) => otlpPayload(spansFrom(trace.records(), { names: body?.names === true ? trace.names() : {} }), { serviceName: body?.serviceName })
  const offExport = adapter.handle(EXPORT_ENDPOINT, exportWindow)
  // Team health (#357): the same window, reduced to per-Bot signals and flags. Read-only.
  const health = (body = {}) => buildHealth(window(body))
  const offHealth = adapter.handle(HEALTH_ENDPOINT, health)
  // Durable alerts (#584): the same window, folded across reads so a condition opens once and
  // resolves when it clears. Read-only and in memory; nothing new reaches the trace.
  const alerts = createAlertTracker()
  const alertView = (body = {}) => alerts.fold(window(body))
  const offAlerts = adapter.handle(ALERTS_ENDPOINT, alertView)
  return {
    trace, recorder, window, exportNow, exportWindow, health, alerts, alertView,
    dispose() {
      if (exportTimer !== undefined) clearInterval(exportTimer)
      offEndpoint()
      offExport()
      offHealth()
      offAlerts()
      off()
      trace.close()
    },
  }
}
