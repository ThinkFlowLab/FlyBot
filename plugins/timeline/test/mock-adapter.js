// A stand-in for src/adapter.js's surface: the feed handlers are called directly, the way
// the core's hooks.js calls a listener (a structured copy of the payload).
export function mockAdapter({ bots = [{ id: 'a', name: 'Chief', isMain: true }, { id: 'b', name: 'Writer' }], rooms = [{ id: 'r1', name: 'Team Room' }], readOnly = false } = {}) {
  const adapter = {
    handlers: undefined,
    state: { bots, rooms, readOnly },
    warnings: [],
    endpoints: new Map(),
    subscribe(handlers) { adapter.handlers = handlers; return () => { adapter.handlers = undefined } },
    bots: () => adapter.state.bots,
    rooms: () => adapter.state.rooms,
    readOnly: () => adapter.state.readOnly,
    handle(name, fn) { adapter.endpoints.set(name, fn); return () => adapter.endpoints.delete(name) },
    warn: (...args) => adapter.warnings.push(args.join(' ')),
    feed: (name, payload) => adapter.handlers[name](structuredClone(payload)),
  }
  return adapter
}
