// Browser half of @flybot/timeline, in the dsh client loader format ds-bot uses
// (window.__ModuleLoader__.load, CJS factory, `require` resolves shell-provided react).
// Hand-written (no build step). The bundle id is the package name.
//
// This part is the data layer: a poller for the host's `timeline/window` endpoint, exposed as
// ctx.flybot.timeline / globalThis.__flybot__.timeline. The panel (swimlanes, communication map,
// utilization) draws from it.
//
// Polling rules: one request in flight at a time (the next poll is scheduled when the last one
// ends, 2 s later), only while a panel holds it open (`open()`; reference counted) and the page is
// visible, an error backs off (4 s, 8 s ... 30 s) and never clears the last good window.
window.__ModuleLoader__.load({
  id: '@flybot/timeline',
  factory: () => {
    const ENDPOINT = 'timeline/window'
    const VERSION = 1
    const POLL_MS = 2000
    const MAX_BACKOFF_MS = 30_000
    const WINDOWS = [['5 min', 300_000], ['15 min', 900_000], ['1 h', 3_600_000], ['6 h', 21_600_000], ['24 h', 86_400_000]]

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

    const inject = ['flybot']
    // The service other parts (the panel, ds-bot's slots) use: ctx.flybot.timeline.
    function apply(ctx, config = {}) {
      if (!ctx.flybot || typeof ctx.flybot.call !== 'function') throw new Error('@flybot/timeline needs the flybot browser service (ds-bot)')
      const store = createStore(ctx.flybot, { windowMs: Number.isFinite(config?.windowMs) ? config.windowMs : undefined })
      const api = { store, open: () => store.open(), setWindow: options => store.setWindow(options), refresh: () => store.refresh(), subscribe: fn => store.subscribe(fn), get state() { return store.state }, WINDOWS }
      const offs = []
      if (typeof ctx.flybot === 'object') { ctx.flybot.timeline = api; offs.push(() => { if (ctx.flybot.timeline === api) delete ctx.flybot.timeline }) }
      if (globalThis.__flybot__) { globalThis.__flybot__.timeline = api; offs.push(() => { if (globalThis.__flybot__?.timeline === api) delete globalThis.__flybot__.timeline }) }
      const off = () => { store.dispose(); for (const fn of offs.splice(0)) fn() }
      ctx.effect?.(() => off, 'flybot-timeline: data layer')
      return off
    }
    return { name: 'flybot-timeline', inject, apply, createStore, checkWindow, ENDPOINT, VERSION, POLL_MS, WINDOWS }
  },
})
