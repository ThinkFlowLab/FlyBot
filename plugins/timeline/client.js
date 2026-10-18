// Browser half of @flybot/timeline, in the dsh client loader format ds-bot uses
// (window.__ModuleLoader__.load, CJS factory, `require` resolves shell-provided react).
// Hand-written (no build step). The bundle id is the package name.
//
// Two parts. The data layer: a poller for the host's `timeline/window` endpoint, exposed as
// ctx.flybot.timeline / globalThis.__flybot__.timeline. And the panel that draws from it: three
// views (swimlanes, communication map, utilization), opened from a sidebar row or the '+' menu.
// Every string that reaches the page is a React text child or an SVG text node (never markup),
// and is cleaned again here although the host already cleaned it.
//
// Polling rules: one request in flight at a time (the next poll is scheduled when the last one
// ends, 2 s later), only while a panel holds it open (`open()`; reference counted) and the page is
// visible, an error backs off (4 s, 8 s ... 30 s) and never clears the last good window.
window.__ModuleLoader__.load({
  id: '@flybot/timeline',
  factory: (require) => {
    const { createElement: h, useEffect, useState, useCallback } = require('react')
    const ENDPOINT = 'timeline/window'
    const VERSION = 1
    const POLL_MS = 2000
    const MAX_BACKOFF_MS = 30_000
    const WINDOWS = [['1 min', 60_000], ['5 min', 300_000], ['15 min', 900_000], ['1 h', 3_600_000], ['6 h', 21_600_000], ['24 h', 86_400_000]]

    // The host's answer is checked for shape before anything draws from it: a host with another
    // version of the endpoint gives a clear "update" state, not a crash.
    function checkWindow(value) {
      if (value === null || typeof value !== 'object') return 'the host sent no timeline'
      if (value.version !== VERSION) return `the host's timeline is version ${String(value.version)}; this panel reads version ${VERSION}`
      for (const key of ['lanes', 'turns', 'exchanges', 'edges', 'utilization']) {
        if (!Array.isArray(value[key])) return `the host's timeline has no ${key}`
      }
      return undefined
    }

    // timers: { setTimeout, clearTimeout } and visible(): injected by the tests.
    function createStore(flybot, { timers = globalThis, visible = () => globalThis.document?.visibilityState !== 'hidden', windowMs = 900_000 } = {}) {
      let state = { status: 'idle', window: undefined, error: undefined, updatedAt: undefined, windowMs, to: undefined, failures: 0 }
      let holders = 0
      let timer
      let inFlight = false
      let disposed = false
      let generation = 0
      const listeners = new Set()
      const emit = () => { for (const fn of [...listeners]) fn(state) }
      const set = patch => { state = { ...state, ...patch }; emit() }

      const schedule = (ms) => {
        timers.clearTimeout(timer)
        timer = undefined
        if (disposed || holders === 0) return
        timer = timers.setTimeout(() => { timer = undefined; void poll() }, ms)
        timer?.unref?.()
      }
      async function poll() {
        if (disposed || holders === 0) return
        if (!visible()) { schedule(POLL_MS); return } // a hidden page does not poll
        if (inFlight) return
        inFlight = true
        const mine = generation
        const asked = { windowMs: state.windowMs, ...(state.to === undefined ? {} : { to: state.to }) }
        try {
          const value = await flybot.call(ENDPOINT, asked)
          if (mine !== generation) return // the window was changed meanwhile: that request answers
          const problem = checkWindow(value)
          if (problem !== undefined) set({ status: 'error', error: problem, failures: state.failures + 1 })
          else set({ status: 'ok', window: value, error: undefined, updatedAt: Date.now(), failures: 0 })
        } catch (error) {
          if (mine !== generation) return
          set({ status: 'error', error: String(error?.message ?? error).slice(0, 200), failures: state.failures + 1 })
        } finally {
          inFlight = false
        }
        if (mine === generation) schedule(state.failures === 0 ? POLL_MS : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** state.failures))
      }
      const restart = () => {
        generation += 1
        inFlight = false
        timers.clearTimeout(timer)
        timer = undefined
        if (holders > 0) void poll()
      }
      return {
        get state() { return state },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        // A panel opened: poll until the returned close() is called. Counted, so two panels share one poll.
        open() {
          let closed = false
          holders += 1
          if (holders === 1) { set({ status: state.window === undefined ? 'loading' : state.status }); void poll() }
          return () => {
            if (closed) return
            closed = true
            holders -= 1
            if (holders === 0) { timers.clearTimeout(timer); timer = undefined }
          }
        },
        // Looks back: `to` is an epoch ms, or undefined for live.
        setWindow({ windowMs: nextWindow, to } = {}) {
          const clean = Number.isFinite(nextWindow) ? Math.max(30_000, Math.min(86_400_000, Math.round(nextWindow))) : state.windowMs
          state = { ...state, windowMs: clean, to: Number.isFinite(to) ? to : undefined }
          emit()
          restart()
        },
        refresh: restart,
        dispose() { disposed = true; timers.clearTimeout(timer); listeners.clear() },
      }
    }

    // ------------------------------------------------------------------ formatting
    // The host cleaned every name already; this is the second line, for a host that did not.
    const safe = (value, max = 60) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/g, '').trim().slice(0, max)
    const pad = n => String(n).padStart(2, '0')
    const fmtClock = (t, seconds = true) => {
      const d = new Date(t)
      return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}` : '–'
    }
    function fmtDur(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '–'
      if (ms < 1000) return `${Math.round(ms)} ms`
      if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
      if (ms < 60_000) return `${Math.round(ms / 1000)} s`
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${pad(Math.floor((ms % 60_000) / 1000))}s`
      return `${Math.floor(ms / 3_600_000)}h ${pad(Math.floor((ms % 3_600_000) / 60_000))}m`
    }
    const pct = (part, whole) => (whole > 0 ? Math.round(1000 * part / whole) / 10 : 0)
    const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)

    // ------------------------------------------------------------------ time scale
    const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200].map(s => s * 1000)
    function niceTicks(from, to) {
      const step = NICE_STEPS.find(s => (to - from) / s <= 10) ?? NICE_STEPS.at(-1)
      const offset = new Date(from).getTimezoneOffset() * 60_000 // ticks fall on local clock marks
      const ticks = []
      for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) ticks.push(t)
      return { step, ticks }
    }
    const GAP_PX = 22
    // x(t) for [from, to] over `width` px. `compress` shrinks long stretches where nothing happened
    // (no turn, no message) to a short break mark; the rest keeps one common scale.
    function makeScale({ from, to, spans = [], width, compress = false }) {
      const total = Math.max(1, to - from)
      const linear = () => ({ x: t => Math.max(0, Math.min(width, ((t - from) / total) * width)), breaks: [], compressed: false })
      const clock = step => t => fmtClock(t, step < 60_000)
      let scale = linear()
      let pieces
      if (compress) {
        const minGap = Math.max(15_000, total * 0.08)
        const busy = spans.map(([a, b]) => [Math.max(from, a), Math.min(to, b)]).filter(([a, b]) => b >= a).sort((p, q) => p[0] - q[0])
        const merged = []
        for (const span of busy) {
          const last = merged.at(-1)
          if (last && span[0] - last[1] < minGap) last[1] = Math.max(last[1], span[1])
          else merged.push([...span])
        }
        pieces = []
        let cursor = from
        for (const [a, b] of merged) {
          if (a - cursor >= minGap) pieces.push({ a: cursor, b: a, gap: true })
          else if (a > cursor) pieces.push({ a: cursor, b: a })
          pieces.push({ a, b })
          cursor = b
        }
        if (to - cursor >= minGap) pieces.push({ a: cursor, b: to, gap: true })
        else if (to > cursor) pieces.push({ a: cursor, b: to })
        const gaps = pieces.filter(piece => piece.gap)
        if (gaps.length > 0 && gaps.length < pieces.length) {
          const liveMs = pieces.filter(piece => !piece.gap).reduce((sum, piece) => sum + piece.b - piece.a, 0)
          const k = Math.max(1, width - gaps.length * GAP_PX) / Math.max(1, liveMs)
          let px = 0
          for (const piece of pieces) { piece.x0 = px; px += piece.gap ? GAP_PX : (piece.b - piece.a) * k; piece.x1 = px; piece.k = piece.gap ? 0 : k }
          scale = {
            x: (t) => {
              const clamped = Math.max(from, Math.min(to, t))
              const piece = pieces.find(p => clamped <= p.b) ?? pieces.at(-1)
              if (piece.gap) return piece.x0 + ((clamped - piece.a) / Math.max(1, piece.b - piece.a)) * (piece.x1 - piece.x0)
              return piece.x0 + (clamped - piece.a) * piece.k
            },
            breaks: gaps.map(piece => ({ x: (piece.x0 + piece.x1) / 2, ms: piece.b - piece.a })),
            compressed: true,
          }
        }
      }
      if (!scale.compressed) {
        const { step, ticks } = niceTicks(from, to)
        return { ...scale, width, ticks: ticks.map(t => ({ x: scale.x(t), label: clock(step)(t) })) }
      }
      const ticks = []
      for (const piece of pieces.filter(p => !p.gap)) {
        const x = piece.x0
        if (ticks.length === 0 || x - ticks.at(-1).x >= 56) ticks.push({ x, label: fmtClock(piece.a) })
      }
      return { ...scale, width, ticks }
    }

    // ------------------------------------------------------------------ swimlane geometry
    const LABEL_W = 132
    const AXIS_H = 26
    const ROW_H = 22
    const BAR_H = 16
    const LANE_PAD = 6
    const TOP_STRIP = 12 // above a lane's bars: the wait lines and their labels
    const nameOf = (lane) => safe(lane?.name) || safe(lane?.id)
    function layoutSwimlanes(win, { width = 980, compress = false } = {}) {
      const from = num(win.from)
      const to = Math.max(from + 1, num(win.to, from + 1))
      const plotW = width - LABEL_W - 16
      const spans = [
        ...win.turns.map(turn => [turn.t0, turn.t1 ?? to]),
        ...win.rounds.map(round => [round.t0, round.t1 ?? to]),
        ...win.exchanges.flatMap(arrow => [[arrow.t - 500, arrow.t + 500], ...(arrow.replyAt ? [[arrow.replyAt - 500, arrow.replyAt + 500]] : []), ...(arrow.answerAt ? [[arrow.answerAt - 500, arrow.answerAt + 500]] : [])]),
      ]
      const scale = makeScale({ from, to, spans, width: plotW, compress })
      const X = t => LABEL_W + scale.x(t)
      let top = AXIS_H
      const lanes = win.lanes.map((lane) => {
        const rows = Math.max(1, num(lane.rows, 1))
        const h2 = rows * ROW_H + LANE_PAD * 2 + TOP_STRIP
        const out = { id: lane.id, kind: lane.kind, name: nameOf(lane), main: lane.main === true, removed: lane.removed === true, rows, y: top, h: h2, mid: top + TOP_STRIP + (h2 - TOP_STRIP) / 2 }
        top += h2
        return out
      })
      const byId = new Map(lanes.map(lane => [lane.id, lane]))
      const barY = (lane, row) => lane.y + TOP_STRIP + LANE_PAD + num(row) * ROW_H + (ROW_H - BAR_H) / 2
      const bars = []
      for (const turn of win.turns) {
        const lane = byId.get(turn.lane)
        if (!lane) continue
        const end = turn.t1 ?? to
        const x0 = X(Math.max(from, turn.t0))
        const x1 = X(Math.min(to, end))
        const w = Math.max(2, x1 - x0)
        const y = barY(lane, turn.row)
        const roomLane = turn.room ? byId.get(turn.room) : undefined
        bars.push({
          id: safe(turn.id, 80), lane: lane.id, x: x0, y, w, h: BAR_H, running: turn.running === true, lost: turn.lost === true,
          outcome: turn.outcome, group: turn.place === 'group', room: roomLane ? roomLane.name : undefined,
          title: `${lane.name}${roomLane ? ` in ${roomLane.name}` : ''}: ${fmtDur(end - turn.t0)}${turn.running ? ' (running)' : ''}${turn.lost ? ' (cut off by a restart; end unknown)' : ''}${turn.outcome && turn.outcome !== 'completed' ? ` · ${turn.outcome}${turn.errorCode ? ` ${safe(turn.errorCode, 40)}` : ''}` : ''}`,
          tools: turn.tools.map((tool) => {
            const a = X(Math.max(from, tool.t0))
            const b = X(Math.min(to, tool.t1 ?? to))
            return { id: safe(tool.id, 80), x: a, w: Math.max(1.5, b - a), ok: tool.ok, name: safe(tool.name), ms: (tool.t1 ?? to) - tool.t0 }
          }),
        })
      }
      const brackets = win.rounds.map((round) => {
        const lane = byId.get(round.lane)
        if (!lane) return undefined
        const x0 = X(Math.max(from, round.t0))
        const x1 = X(Math.min(to, round.t1 ?? to))
        return { id: safe(round.id, 80), lane: lane.id, x0, x1: Math.max(x1, x0 + 8), y: lane.y + TOP_STRIP + LANE_PAD / 2 + num(round.row) * ROW_H, h: ROW_H + LANE_PAD, running: round.running === true, calls: round.calls.length, title: `${lane.name}: round of ${round.calls.length} member turn${round.calls.length === 1 ? '' : 's'}, ${fmtDur((round.t1 ?? to) - round.t0)}${round.running ? ' (running)' : ''}` }
      }).filter(Boolean)
      const arrows = []
      for (const e of win.exchanges) {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (!a || !b || a === b || e.t < from || e.t > to) continue
        const x = X(e.t)
        const dir = b.mid > a.mid ? 1 : -1
        const arrow = { id: safe(e.id, 80), role: ROLE_CLASS[e.role] ? e.role : 'other', x, y1: a.mid, y2: b.mid - dir * 7, from: a.name, to: b.name, hop: num(e.hop) }
        if (e.role === 'request' || e.role === 'user' || e.role === 'stopped') {
          const endAt = e.replyAt ?? e.answerAt
          if (endAt !== undefined) arrow.wait = { x0: x, x1: Math.max(x + 1, X(Math.min(to, endAt))), y: a.y + TOP_STRIP - 2, label: `${e.role === 'user' ? 'answer' : 'reply'} ${fmtDur(e.latencyMs)}`, ms: e.latencyMs }
          else if (e.waiting) arrow.wait = { x0: x, x1: Math.max(x + 1, X(to)), y: a.y + TOP_STRIP - 2, label: `waiting ${fmtDur(to - e.t)}`, open: true, ms: to - e.t }
        }
        if (arrow.wait) arrow.y1 = arrow.wait.y
        arrow.title = `${a.name} → ${b.name}: ${e.role}${arrow.wait ? ` · ${arrow.wait.label}` : ''} (delivered ${fmtClock(e.t)})`
        arrows.push(arrow)
      }
      return { width, height: top + 8, plotLeft: LABEL_W, plotRight: LABEL_W + plotW, axis: { ticks: scale.ticks.map(tick => ({ x: LABEL_W + tick.x, label: tick.label })), breaks: scale.breaks.map(brk => ({ x: LABEL_W + brk.x, ms: brk.ms })), compressed: scale.compressed }, lanes, bars, brackets, arrows }
    }
    const ROLE_CLASS = { user: 'ask', request: 'req', reply: 'rep', room: 'room', stopped: 'oth', report: 'oth', post: 'oth', mention: 'oth' }

    // ------------------------------------------------------------------ communication map geometry
    function layoutMap(win, { size = 440 } = {}) {
      const involved = new Set(win.edges.flatMap(edge => [edge.from, edge.to]))
      const nodes = win.lanes.filter(lane => lane.kind === 'bot' || involved.has(lane.id))
      const cx = size / 2
      const cy = size / 2
      const radius = size / 2 - 64
      const place = new Map(nodes.map((lane, i) => {
        const angle = -Math.PI / 2 + (nodes.length === 1 ? 0 : (2 * Math.PI * i) / nodes.length)
        return [lane.id, { id: lane.id, kind: lane.kind, name: nameOf(lane), x: cx + (nodes.length === 1 ? 0 : radius * Math.cos(angle)), y: cy + (nodes.length === 1 ? 0 : radius * Math.sin(angle)) }]
      }))
      const edges = []
      for (const edge of win.edges) {
        const a = place.get(edge.from)
        const b = place.get(edge.to)
        if (!a || !b || a === b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.max(1, Math.hypot(dx, dy))
        // The opposite direction bends the other way, so the two arrows do not overlap.
        const bend = 22
        const mx = (a.x + b.x) / 2 + (-dy / len) * bend
        const my = (a.y + b.y) / 2 + (dx / len) * bend
        const shrink = 22 // stop at the node's rim
        const sx = a.x + (mx - a.x) / Math.max(1, Math.hypot(mx - a.x, my - a.y)) * shrink
        const sy = a.y + (my - a.y) / Math.max(1, Math.hypot(mx - a.x, my - a.y)) * shrink
        const ex = b.x + (mx - b.x) / Math.max(1, Math.hypot(mx - b.x, my - b.y)) * (shrink + 4)
        const ey = b.y + (my - b.y) / Math.max(1, Math.hypot(mx - b.x, my - b.y)) * (shrink + 4)
        const count = edge.requests + edge.replies + edge.other
        const label = edge.unanswered > 0 ? `${edge.unanswered} waiting` : edge.answered > 0 ? `~${fmtDur(edge.medianMs)}` : `${count}×`
        edges.push({
          from: edge.from, to: edge.to, d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
          lx: (sx + 2 * mx + ex) / 4, ly: (sy + 2 * my + ey) / 4, width: 1 + Math.min(5, Math.log2(1 + count) * 1.4),
          waiting: edge.unanswered > 0, label,
          title: `${a.name} → ${b.name}: ${edge.requests} request${edge.requests === 1 ? '' : 's'}, ${edge.replies} repl${edge.replies === 1 ? 'y' : 'ies'}${edge.other ? `, ${edge.other} other` : ''}${edge.answered ? ` · answered ${edge.answered}, median ${fmtDur(edge.medianMs)}, slowest ${fmtDur(edge.maxMs)}` : ''}${edge.unanswered ? ` · ${edge.unanswered} not answered` : ''}`,
        })
      }
      return { size, nodes: [...place.values()], edges }
    }
    // "Who waits on whom": the edges that carried requests, the longest total wait first.
    function waitRows(win) {
      const name = new Map(win.lanes.map(lane => [lane.id, nameOf(lane)]))
      return win.edges.filter(edge => edge.requests > 0 && name.has(edge.from) && name.has(edge.to)).map(edge => ({
        waiter: name.get(edge.from), on: name.get(edge.to), requests: edge.requests, answered: edge.answered, waiting: edge.unanswered,
        medianMs: edge.medianMs, maxMs: edge.maxMs, totalMs: edge.totalWaitMs ?? 0,
      })).sort((p, q) => (q.totalMs - p.totalMs) || (q.waiting - p.waiting) || (q.requests - p.requests))
    }

    // ------------------------------------------------------------------ utilization rows
    function utilizationRows(win) {
      const name = new Map(win.lanes.map(lane => [lane.id, nameOf(lane)]))
      return win.utilization.filter(item => name.has(item.lane)).map((item) => {
        const whole = Math.max(1, num(item.windowMs, item.busyMs + item.idleMs))
        return {
          lane: item.lane, name: name.get(item.lane), running: item.running === true, turns: num(item.turns), errors: num(item.errors), longestMs: num(item.longestMs),
          model: pct(item.modelMs, whole), tools: pct(item.toolMs, whole), idle: pct(item.idleMs, whole),
          modelMs: num(item.modelMs), toolMs: num(item.toolMs), idleMs: num(item.idleMs), busyMs: num(item.busyMs),
        }
      })
    }

    // ------------------------------------------------------------------ views
    const CSS = `
      .tl-row { display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:0; background:transparent; color:var(--bt-ink, inherit); font:inherit; text-align:left; cursor:pointer; border-radius:6px }
      .tl-row:hover { background:var(--bt-hover, rgba(127,127,127,.12)) }
      .tl-overlay { position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center }
      .tl-dialog { width:min(1080px, 96vw); max-height:92vh; display:flex; flex-direction:column; background:var(--bt-bg, #fff); color:var(--bt-ink, #1f2328); border:1px solid var(--bt-line, #d0d7de); border-radius:10px; box-shadow:0 10px 40px rgba(0,0,0,.3); font-size:13px }
      .tl-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--bt-line, #d0d7de) }
      .tl-head h2 { margin:0 8px 0 0; font-size:15px }
      .tl-tab, .tl-btn { border:1px solid var(--bt-line, #d0d7de); background:transparent; color:inherit; padding:3px 10px; border-radius:6px; font:inherit; cursor:pointer }
      .tl-tab[aria-selected="true"] { background:var(--bt-accent, #2563eb); border-color:var(--bt-accent, #2563eb); color:#fff }
      .tl-body { overflow:auto; padding:12px 14px }
      .tl-note { margin:0 0 8px; padding:6px 10px; border-radius:6px; background:var(--bt-hover, rgba(127,127,127,.12)) }
      .tl-note.err { background:rgba(220,38,38,.12); color:#b91c1c }
      .tl-foot { padding:8px 14px; border-top:1px solid var(--bt-line, #d0d7de); opacity:.75; font-size:12px }
      .tl-svg text { font:11px system-ui, sans-serif; fill:currentColor }
      .tl-lane-bg { fill:rgba(127,127,127,.07) }
      .tl-lane-bg.alt { fill:rgba(127,127,127,.13) }
      .tl-grid { stroke:var(--bt-line, #d0d7de); stroke-width:1 }
      .tl-turn { fill:var(--bt-accent, #2563eb); opacity:.85 }
      .tl-turn.group { opacity:.55; stroke:var(--bt-accent, #2563eb); stroke-width:1.5 }
      .tl-turn.running { opacity:1; stroke-dasharray:4 2; stroke:var(--bt-ink, #1f2328) }
      .tl-turn.lost { opacity:.35; stroke-dasharray:2 2; stroke:var(--bt-ink, #1f2328) }
      .tl-turn.error { fill:#dc2626 }
      .tl-tool { fill:#d97706 }
      .tl-tool.bad { fill:#7c2d12 }
      .tl-bracket { fill:none; stroke:var(--bt-ink, #1f2328); stroke-width:2; opacity:.7 }
      .tl-bracket.running { stroke-dasharray:4 3 }
      .tl-arrow { stroke:var(--bt-ink, #1f2328); stroke-width:1.4; fill:none }
      .tl-arrow.req { stroke-dasharray:5 3 }
      .tl-arrow.ask { stroke:var(--bt-accent, #2563eb); stroke-dasharray:5 3 }
      .tl-arrow.room { stroke-dasharray:1 3 }
      .tl-arrow.oth { opacity:.45 }
      .tl-wait { stroke:var(--bt-ink, #1f2328); stroke-width:1; stroke-dasharray:2 2; opacity:.7 }
      .tl-wait.open { stroke:#dc2626; opacity:1 }
      .tl-badge { fill:var(--bt-bg, #fff); stroke:var(--bt-line, #d0d7de) }
      .tl-badge-text.open { fill:#dc2626 }
      .tl-svg .tl-badge-text { paint-order:stroke; stroke:var(--bt-bg, #fff); stroke-width:3px }
      .tl-node { fill:var(--bt-bg, #fff); stroke:var(--bt-accent, #2563eb); stroke-width:2 }
      .tl-node.room { stroke-dasharray:3 2 }
      .tl-edge { fill:none; stroke:var(--bt-ink, #1f2328); opacity:.7 }
      .tl-edge.waiting { stroke:#dc2626; stroke-dasharray:5 3; opacity:1 }
      .tl-table { width:100%; border-collapse:collapse; margin-top:10px }
      .tl-table th, .tl-table td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--bt-line, #d0d7de) }
      .tl-bar { display:flex; height:16px; border-radius:4px; overflow:hidden; background:rgba(127,127,127,.15) }
      .tl-bar .m { background:var(--bt-accent, #2563eb) } .tl-bar .t { background:#d97706 } .tl-bar .i { background:transparent }
      .tl-util { display:grid; grid-template-columns:140px 1fr; gap:4px 12px; align-items:center; margin-bottom:10px }
      .tl-legend { display:flex; gap:12px; flex-wrap:wrap; margin:6px 0 }
      .tl-legend i { display:inline-block; width:10px; height:10px; margin-right:4px; border-radius:2px }
    `
    let styled = false
    function useStyles() {
      useEffect(() => {
        if (styled || typeof document === 'undefined') return
        const style = document.createElement('style')
        style.setAttribute('data-flybot-timeline', '')
        style.textContent = CSS
        document.head.appendChild(style)
        styled = true
      }, [])
    }

    const text = (props, value) => h('text', props, String(value))
    function Swimlanes({ win, compress }) {
      const g = layoutSwimlanes(win, { compress })
      const laneRows = g.lanes.map((lane, i) => [
        h('rect', { key: `bg-${lane.id}`, className: i % 2 ? 'tl-lane-bg alt' : 'tl-lane-bg', x: 0, y: lane.y, width: g.width, height: lane.h }),
        text({ key: `lb-${lane.id}`, x: 8, y: lane.mid + 4 }, `${lane.kind === 'room' ? '( ) ' : ''}${lane.name}${lane.main ? ' ★' : ''}${lane.removed ? ' (removed)' : ''}`),
      ])
      const ticks = g.axis.ticks.map(tick => [
        h('line', { key: `gl-${tick.x}`, className: 'tl-grid', x1: tick.x, x2: tick.x, y1: AXIS_H - 4, y2: g.height - 8 }),
        text({ key: `gt-${tick.x}`, x: tick.x + 3, y: 14 }, tick.label),
      ])
      const breaks = g.axis.breaks.map(brk => [
        h('rect', { key: `bk-${brk.x}`, x: brk.x - 8, y: AXIS_H - 4, width: 16, height: g.height - AXIS_H - 4, fill: 'rgba(127,127,127,.3)' }),
        text({ key: `bt-${brk.x}`, x: brk.x - 8, y: g.height - 1 }, `⋯ ${fmtDur(brk.ms)} quiet`),
      ])
      const bars = g.bars.map(bar => h('g', { key: `bar-${bar.id}` },
        h('title', null, bar.title),
        h('rect', { className: `tl-turn${bar.group ? ' group' : ''}${bar.running ? ' running' : ''}${bar.lost ? ' lost' : ''}${bar.outcome === 'error' ? ' error' : ''}`, x: bar.x, y: bar.y, width: bar.w, height: bar.h, rx: 3 }),
        ...bar.tools.map(tool => h('rect', { key: `tool-${tool.id}`, className: `tl-tool${tool.ok === false ? ' bad' : ''}`, x: tool.x, y: bar.y + 4, width: tool.w, height: bar.h - 8 }, h('title', null, `${tool.name}: ${fmtDur(tool.ms)}${tool.ok === false ? ' (failed)' : ''}`))),
      ))
      const brackets = g.brackets.map(b => h('g', { key: `br-${b.id}` },
        h('title', null, b.title),
        h('path', { className: `tl-bracket${b.running ? ' running' : ''}`, d: `M ${b.x0 + 7} ${b.y} Q ${b.x0 - 3} ${b.y + b.h / 2} ${b.x0 + 7} ${b.y + b.h} M ${b.x1 - 7} ${b.y} Q ${b.x1 + 3} ${b.y + b.h / 2} ${b.x1 - 7} ${b.y + b.h}` }),
        h('line', { className: 'tl-wait', x1: b.x0 + 7, x2: b.x1 - 7, y1: b.y + b.h / 2, y2: b.y + b.h / 2 }),
      ))
      const arrows = g.arrows.map((a) => {
        const dir = a.y2 > a.y1 ? 1 : -1
        return h('g', { key: `ar-${a.id}` },
          h('title', null, a.title),
          h('line', { className: `tl-arrow ${ROLE_CLASS[a.role] ?? 'oth'}`, x1: a.x, x2: a.x, y1: a.y1, y2: a.y2 }),
          h('path', { d: `M ${a.x - 4} ${a.y2 - dir * 6} L ${a.x} ${a.y2} L ${a.x + 4} ${a.y2 - dir * 6} Z`, fill: 'currentColor' }),
          a.wait && h('line', { className: `tl-wait${a.wait.open ? ' open' : ''}`, x1: a.wait.x0, x2: a.wait.x1, y1: a.wait.y, y2: a.wait.y }),
          a.wait && text({ className: `tl-badge-text${a.wait.open ? ' open' : ''}`, x: a.wait.open ? a.wait.x1 - 2 : a.wait.x0 + 3, y: a.wait.y - 2, textAnchor: a.wait.open ? 'end' : 'start' }, a.wait.label),
        )
      })
      return h('svg', { className: 'tl-svg', viewBox: `0 0 ${g.width} ${g.height}`, width: '100%', role: 'img', 'aria-label': 'Swimlanes: one lane per Bot, bars for turns, arrows for messages' },
        ...laneRows, ...ticks, ...breaks, ...brackets, ...bars, ...arrows)
    }

    function CommMap({ win }) {
      const map = layoutMap(win)
      const rows = waitRows(win)
      const waitingNow = rows.reduce((sum, row) => sum + row.waiting, 0)
      return h('div', null,
        h('svg', { className: 'tl-svg', viewBox: `0 0 ${map.size} ${map.size}`, width: '100%', style: { maxWidth: '400px' }, role: 'img', 'aria-label': 'Communication map: who sent requests to whom' },
          h('defs', null, h('marker', { id: 'tl-head', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto' }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' }))),
          ...map.edges.map(edge => h('g', { key: `e-${edge.from}-${edge.to}` },
            h('title', null, edge.title),
            h('path', { className: `tl-edge${edge.waiting ? ' waiting' : ''}`, d: edge.d, strokeWidth: edge.width, markerEnd: 'url(#tl-head)' }),
            text({ x: edge.lx, y: edge.ly - 4, textAnchor: 'middle', className: edge.waiting ? 'tl-badge-text open' : 'tl-badge-text' }, edge.label),
          )),
          ...map.nodes.map(node => h('g', { key: `n-${node.id}` },
            h('circle', { className: `tl-node${node.kind === 'room' ? ' room' : ''}`, cx: node.x, cy: node.y, r: 18 }),
            text({ x: node.x, y: node.y + 32, textAnchor: 'middle' }, node.name),
          )),
        ),
        h('p', { className: waitingNow > 0 ? 'tl-note err' : 'tl-note' }, waitingNow > 0 ? `${waitingNow} request${waitingNow === 1 ? '' : 's'} not answered yet.` : 'Every request in this window has an answer (or none was sent).'),
        rows.length === 0 ? h('p', { className: 'tl-note' }, 'No requests between Bots in this window.') : h('table', { className: 'tl-table' },
          h('thead', null, h('tr', null, ...['Waits', 'on', 'Requests', 'Answered', 'Not yet', 'Median', 'Slowest', 'Total wait'].map(head => h('th', { key: head }, head)))),
          h('tbody', null, ...rows.map((row, i) => h('tr', { key: `r-${i}` },
            h('td', null, row.waiter), h('td', null, row.on), h('td', null, String(row.requests)), h('td', null, String(row.answered)), h('td', null, String(row.waiting)),
            h('td', null, row.medianMs === undefined ? '–' : fmtDur(row.medianMs)), h('td', null, row.maxMs === undefined ? '–' : fmtDur(row.maxMs)), h('td', null, fmtDur(row.totalMs)))))),
      )
    }

    function Utilization({ win }) {
      const rows = utilizationRows(win)
      if (rows.length === 0) return h('p', { className: 'tl-note' }, 'No Bots yet.')
      return h('div', null,
        h('div', { className: 'tl-legend' },
          h('span', null, h('i', { style: { background: 'var(--bt-accent, #2563eb)' } }), 'model (turn time outside tools)'),
          h('span', null, h('i', { style: { background: '#d97706' } }), 'tools'),
          h('span', null, h('i', { style: { background: 'rgba(127,127,127,.4)' } }), 'no running turn')),
        ...rows.map(row => h('div', { key: row.lane, className: 'tl-util' },
          h('div', null, `${row.name}${row.running ? ' ● running' : ''}`),
          h('div', null,
            h('div', { className: 'tl-bar', role: 'img', 'aria-label': `${row.name}: model ${row.model}%, tools ${row.tools}%, no running turn ${row.idle}%` },
              h('div', { className: 'm', style: { width: `${row.model}%` } }), h('div', { className: 't', style: { width: `${row.tools}%` } }), h('div', { className: 'i', style: { width: `${row.idle}%` } })),
            h('div', { style: { opacity: 0.8, marginTop: '2px' } }, `busy ${fmtDur(row.busyMs)} (model ${fmtDur(row.modelMs)} · tools ${fmtDur(row.toolMs)}) · no running turn ${fmtDur(row.idleMs)} · ${row.turns} turn${row.turns === 1 ? '' : 's'}${row.errors ? ` · ${row.errors} failed` : ''}${row.longestMs ? ` · longest ${fmtDur(row.longestMs)}` : ''}`),
          ))),
      )
    }

    const TABS = [['lanes', 'Swimlanes'], ['map', 'Who waits on whom'], ['util', 'Utilization']]
    function notesOf(snap) {
      const win = snap.window
      const out = []
      if (snap.status === 'error') out.push({ err: true, text: win ? `Could not refresh: ${safe(snap.error, 200)}. Showing the data from ${fmtClock(snap.updatedAt)}.` : `Could not load the timeline: ${safe(snap.error, 200)}` })
      if (!win) return out
      if (win.coverage && win.coverage.complete === false && win.coverage.oldest) out.push({ text: `The trace starts at ${fmtClock(win.coverage.oldest)}, after the start of this window: older activity was not recorded or has rotated out.` })
      if (win.coverage && win.coverage.oldest === null) out.push({ text: 'Nothing has been recorded yet. The timeline only sees activity from when this plugin started.' })
      if (win.truncated) out.push({ text: 'Only the newest turns and messages are shown; narrow the window to see all.' })
      if (win.trace && win.trace.persisting === false) out.push({ text: 'The trace is kept in memory only (another dsh holds the files, or the folder is not writable): history is lost on restart.' })
      if (!win.live) out.push({ text: `Looking back: this window ends at ${fmtClock(win.to)}.` })
      return out
    }
    function TimelinePanel({ api, onClose }) {
      useStyles()
      const [tab, setTab] = useState('lanes')
      const [compress, setCompress] = useState(false)
      const [snap, setSnap] = useState(api.state)
      useEffect(() => {
        const off = api.subscribe(setSnap)
        const close = api.open()
        setSnap(api.state)
        return () => { off(); close() }
      }, [api])
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      const win = snap.window
      const empty = win && win.turns.length === 0 && win.exchanges.length === 0
      const body = !win ? h('p', { className: 'tl-note' }, snap.status === 'error' ? 'Waiting for the host.' : 'Loading…')
        : empty ? h('p', { className: 'tl-note' }, 'No Bot activity in this window.')
        : tab === 'map' ? h(CommMap, { win }) : tab === 'util' ? h(Utilization, { win }) : h(Swimlanes, { win, compress })
      return h('div', { className: 'tl-overlay', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'tl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Timeline' },
          h('div', { className: 'tl-head' },
            h('h2', null, 'Timeline'),
            ...TABS.map(([id, label]) => h('button', { key: id, className: 'tl-tab', role: 'tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, label)),
            h('span', { style: { flex: 1 } }),
            tab === 'lanes' && h('button', { className: 'tl-btn', 'aria-pressed': compress, title: 'Shrink long quiet stretches', onClick: () => setCompress(!compress) }, compress ? 'Real time' : 'Skip quiet time'),
            h('select', { className: 'tl-btn', 'aria-label': 'Window', value: String(snap.windowMs), onChange: event => api.setWindow({ windowMs: Number(event.target.value) }) },
              ...WINDOWS.map(([label, ms]) => h('option', { key: ms, value: String(ms) }, `Last ${label}`))),
            h('button', { className: 'tl-btn', onClick: () => api.setWindow({ windowMs: snap.windowMs, to: (win ? win.to : Date.now()) - snap.windowMs / 2 }) }, 'Earlier'),
            snap.to !== undefined && h('button', { className: 'tl-btn', onClick: () => api.setWindow({ windowMs: snap.windowMs }) }, 'Live'),
            h('button', { className: 'tl-btn', 'aria-label': 'Close', onClick: onClose }, '✕')),
          h('div', { className: 'tl-body' }, ...notesOf(snap).map((note, i) => h('p', { key: `n${i}`, className: note.err ? 'tl-note err' : 'tl-note', role: note.err ? 'alert' : undefined }, note.text)), body),
          h('div', { className: 'tl-foot' }, 'Times are when a message reached the other Bot\'s log (delivered, not read). "No running turn" is not "waiting": a Bot on a slow model call or tool is busy. Model time is turn time outside tool calls, including queueing; it is not a measured model latency.')))
    }

    // The panel's open/closed state, shared by the sidebar row and the '+' menu entry.
    function createPanelState() {
      let open = false
      const listeners = new Set()
      const set = (value) => { if (open !== value) { open = value; for (const fn of [...listeners]) fn(open) } }
      return { get open() { return open }, show: () => set(true), hide: () => set(false), toggle: () => set(!open), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
    }
    function makeSection(api) {
      return function TimelineSection() {
        useStyles()
        const [open, setOpen] = useState(api.panel.open)
        useEffect(() => api.panel.subscribe(setOpen), [])
        const hide = useCallback(() => api.panel.hide(), [])
        return h('div', null,
          h('button', { className: 'tl-row', onClick: () => api.panel.show(), title: 'See where the team\'s time goes' }, h('span', { 'aria-hidden': 'true' }, '⏱'), h('span', null, 'Timeline')),
          open && h(TimelinePanel, { api, onClose: hide }))
      }
    }

    const inject = ['flybot']
    // The service other parts (the panel, ds-bot's slots) use: ctx.flybot.timeline.
    // config: windowMs (initial window), sidebarSection (default true: a "Timeline" row under the Bot list).
    function apply(ctx, config = {}) {
      if (!ctx.flybot || typeof ctx.flybot.call !== 'function') throw new Error('@flybot/timeline needs the flybot browser service (ds-bot)')
      const store = createStore(ctx.flybot, { windowMs: Number.isFinite(config?.windowMs) ? config.windowMs : undefined })
      const panel = createPanelState()
      const api = { store, panel, open: () => store.open(), setWindow: options => store.setWindow(options), refresh: () => store.refresh(), subscribe: fn => store.subscribe(fn), get state() { return store.state }, WINDOWS }
      const offs = []
      if (typeof ctx.flybot === 'object') { ctx.flybot.timeline = api; offs.push(() => { if (ctx.flybot.timeline === api) delete ctx.flybot.timeline }) }
      if (globalThis.__flybot__) { globalThis.__flybot__.timeline = api; offs.push(() => { if (globalThis.__flybot__?.timeline === api) delete globalThis.__flybot__.timeline }) }
      if (ctx.flybot.slots) {
        if (config?.sidebarSection !== false) offs.push(ctx.flybot.slots.register('flybot.sidebar.section', { id: 'timeline', order: 80, component: makeSection(api) }))
        offs.push(ctx.flybot.slots.register('flybot.new-chat.action', {
          id: 'timeline-open', order: 40, label: 'Timeline', hint: 'See where the team\'s time goes.',
          run: ({ close } = {}) => { api.panel.show(); close?.() },
        }))
      }
      const off = () => { panel.hide(); store.dispose(); for (const fn of offs.splice(0)) fn() }
      ctx.effect?.(() => off, 'flybot-timeline: panel')
      return off
    }
    return {
      name: 'flybot-timeline', inject, apply, createStore, checkWindow, ENDPOINT, VERSION, POLL_MS, WINDOWS, CSS,
      safe, fmtDur, fmtClock, makeScale, niceTicks, layoutSwimlanes, layoutMap, waitRows, utilizationRows, createPanelState,
      Swimlanes, CommMap, Utilization, TimelinePanel, makeSection, notesOf,
    }
  },
})
