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
import { join } from 'node:path'
import { createAdapter } from './src/adapter.js'
import { createTimeline } from './src/timeline.js'

export const name = 'flybot-timeline'
export const inject = ['flybot']

export function apply(ctx, config = {}) {
  if (config?.enabled !== true) return { timeline: undefined, enabled: false, dispose() {} }
  const adapter = createAdapter(ctx.flybot)
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const { dir = join(dshHome, 'bot', 'flybot-timeline'), persist, segmentRecords, segments, retentionMs, flushMs } = config
  const limits = Object.fromEntries(Object.entries({ segmentRecords, segments, retentionMs, flushMs }).filter(([, value]) => Number.isFinite(value) && value > 0))
  const timeline = createTimeline(adapter, { dir, persist: persist !== false, ...limits })
  const dispose = () => timeline.dispose()
  // Cordis-style cleanup: ctx.effect runs the returned disposer when the plugin's scope is disposed.
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flybot-timeline')
  else ctx.on?.('dispose', dispose)
  return { timeline, enabled: true, dispose }
}
