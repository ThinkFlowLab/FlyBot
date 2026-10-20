// @flybot/timeline host plugin (dsh / cordis plugin shape, same as ds-bot: name + inject + apply).
// Records where time goes across the local Bot team (turns, tool calls, Bot-to-Bot
// deliveries) from the core's activity feed (ctx.flybot.on('turn.start' ...)), keeps an
// append-only capped trace on disk, and answers the panel's poll on `timeline/window`.
// Everything FlyBot-specific goes through ctx.flybot via src/adapter.js.
//
// Off by default (#281): without `enabled: true` the plugin records nothing, writes nothing and
// registers no endpoint, so a profile that still lists it costs nothing.
//
// Config:
//   enabled         true turns the recorder and the endpoint on (default false)
//   dir             where the trace lives (default $DSH_HOME/bot/flybot-timeline)
//   persist         false keeps the trace in memory only (default true)
//   segmentRecords  records per trace file before it rotates (default 2000)
//   segments        trace files kept (default 3: about 3000 spans)
//   retentionMs     records older than this are dropped (default 24 h)
//   flushMs         how often new records reach the disk (default 2000)
//   exporter        "otlp" (POST OTLP/HTTP JSON to otlpUrl) or "json" (append dir/export.jsonl);
//                   unset exports nothing (default)
//   otlpUrl         the OTLP/HTTP traces endpoint (https; http only for localhost)
//   otlpHeaders     extra request headers for otlpUrl (e.g. an Authorization token)
//   exportNames     true also sends Bot and room NAMES; off by default (ids only)
//   exportMs        how often new records are exported (default 5000)
//   serviceName     the OTLP service.name (default "flybot")
import { appendFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createAdapter } from './src/adapter.js'
import { createTimeline } from './src/timeline.js'

export const name = 'flybot-timeline'
export const inject = ['flybot']

// OTLP may carry an auth header, so a plain http address is allowed only on the local host.
export function parseOtlpUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  let url
  try { url = new URL(text) } catch { return undefined }
  const localhost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol === 'https:') return url.toString()
  if (url.protocol === 'http:' && localhost) return url.toString()
  return undefined
}

const JSON_EXPORT_MAX = 8 * 1024 * 1024

// Builds the exporter the timeline pushes to, or undefined when none is configured.
function makeExporter(config, dir, warn) {
  const headers = (config.otlpHeaders && typeof config.otlpHeaders === 'object') ? config.otlpHeaders : {}
  const exportNames = config.exportNames === true
  if (config.exporter === 'otlp') {
    const url = parseOtlpUrl(config.otlpUrl)
    if (url === undefined) {
      warn('flybot-timeline: exporter otlp needs an https otlpUrl (http is allowed for localhost only); the trace stays local')
      return undefined
    }
    return {
      intervalMs: config.exportMs,
      serviceName: config.serviceName,
      exportNames,
      send: async (payload) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      },
    }
  }
  if (config.exporter === 'json') {
    const file = join(dir, 'export.jsonl')
    return {
      intervalMs: config.exportMs,
      serviceName: config.serviceName,
      exportNames,
      send: async (payload) => {
        const line = `${JSON.stringify(payload)}\n`
        const size = await stat(file).then(info => info.size, () => 0)
        if (size + line.length > JSON_EXPORT_MAX) {
          warn('flybot-timeline: json export is capped at %d bytes in %s; new spans are not written', JSON_EXPORT_MAX, file)
          return
        }
        await appendFile(file, line, 'utf8')
      },
    }
  }
  return undefined
}

export function apply(ctx, config = {}) {
  if (config?.enabled !== true) return { timeline: undefined, enabled: false, dispose() {} }
  const adapter = createAdapter(ctx.flybot)
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const { dir = join(dshHome, 'bot', 'flybot-timeline'), persist, segmentRecords, segments, retentionMs, flushMs } = config
  const limits = Object.fromEntries(Object.entries({ segmentRecords, segments, retentionMs, flushMs }).filter(([, value]) => Number.isFinite(value) && value > 0))
  const timeline = createTimeline(adapter, { dir, persist: persist !== false, exporter: makeExporter(config, dir, adapter.warn), ...limits })
  const dispose = () => timeline.dispose()
  // Cordis-style cleanup: ctx.effect runs the returned disposer when the plugin's scope is disposed.
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flybot-timeline')
  else ctx.on?.('dispose', dispose)
  return { timeline, enabled: true, dispose }
}
