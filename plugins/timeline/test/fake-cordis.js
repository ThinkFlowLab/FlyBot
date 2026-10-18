// A minimal Cordis-like context for @flybot/timeline's host test, shipped with the plugin (#34):
// enough of the services ds-bot's apply() needs to boot, plus ctx.plugin(plugin, config),
// which runs a plugin in its own scope (its ctx.effect cleanups run when that scope is disposed)
// and only after the services in plugin.inject are provided. No ds-bot test helpers are used.
export function fakeCordis() {
  const services = {}
  const disposers = []
  const registeredTools = new Map()
  const listeners = new Map()
  const scope = (cleanups) => ({
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
  })
  const ctx = {
    ...scope(disposers),
    registeredTools,
    get: name => services[name],
    set(name, value) { services[name] = value; ctx[name] = value },
    provide(name, value) { ctx.set(name, value) },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(l => l !== listener))
    },
    // Events with more than one argument (DSH's session/event is (session, event)).
    emitArgs(name, ...args) { for (const l of listeners.get(name) ?? []) l(...args) },
    emit(name, payload) { for (const l of listeners.get(name) ?? []) if (l.length < 2) l(payload) },
    tools: {
      register(tool) { registeredTools.set(tool.name, tool); return () => registeredTools.delete(tool.name) },
      guard() { return () => {} },
      schemas: () => [],
    },
    systemPrompt: { section() { return () => {} } },
    connection: { fetch: { register() { return () => {} } } },
    llm: { listProviders: () => [] },
    // Loads a plugin as Cordis would: in a child scope that sees the parent's services.
    plugin(plugin, config) {
      const missing = (plugin.inject ?? []).filter(name => services[name] === undefined)
      if (missing.length) throw new Error(`${plugin.name}: missing services ${missing.join(', ')}`)
      const cleanups = []
      const child = Object.assign(Object.create(ctx), scope(cleanups))
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        for (const d of cleanups.splice(0).reverse()) d()
      }
      plugin.apply(child, config)
      disposers.push(dispose)
      return { dispose }
    },
    dispose() {
      return Promise.allSettled(disposers.splice(0).reverse().map(dispose => dispose()))
    },
  }
  return ctx
}
