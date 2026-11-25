// A copy of the core's test/fake-ctx.js (plugin-local, so the plugin tests need no core internals; #34).
// A stand-in for the plugin context that records what apply() registers, in order,
// without starting any service.
export function fakeContext({ services = {} } = {}) {
  const calls = []
  const disposers = []
  const registeredTools = new Map()
  const guards = []
  // Listeners by event name, in registration order.
  const listeners = new Map()
  const sections = new Map()
  const ctx = {
    calls,
    registeredTools,
    guards,
    listeners,
    sections,
    logger: { warn() {}, info() {} },
    get: name => services[name],
    // Cordis ctx.set: ds-bot provides its `flybot` service here (hooks.js).
    set(name, value) {
      services[name] = value
      ctx[name] = value
    },
    on(name, listener, options) {
      calls.push(`on ${name}${options?.prepend ? ' (prepend)' : ''}`)
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    // Calls the plain listeners of an event; middleware (with `next`) is not run.
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) listener(payload)
      }
    },
    // Calls every listener of an event with these arguments (e.g. session/event).
    emitArgs(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    effect(execute, label) {
      calls.push(`effect ${label}`)
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    // Settles once every cleanup has, including the writes some of them wait for.
    dispose() {
      return Promise.allSettled(disposers.splice(0).reverse().map(dispose => dispose()))
    },
    tools: {
      register(tool) {
        calls.push(`tool ${tool.name}`)
        registeredTools.set(tool.name, tool)
        return () => {}
      },
      guard(guard) {
        calls.push('tools guard')
        guards.push(guard)
        return () => {}
      },
      schemas: () => [],
    },
    systemPrompt: {
      section(section) {
        calls.push(`prompt ${section.name} ${section.order}`)
        sections.set(section.name, section)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          calls.push(`route ${route.methods.join(',')} ${route.path}`)
          return () => {}
        },
      },
    },
    llm: { listProviders: () => [] },
  }
  return ctx
}
