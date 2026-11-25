// Minimal FlyBot slot registry. Matches the register(name, entry) shape that
// @flybot/social's client.js uses. Unknown names are accepted so a newer
// client can land a slot this host does not yet bridge into dsh web.

const byName = (map, name) => {
  if (!map.has(name)) map.set(name, [])
  return map.get(name)
}

export function createSlotRegistry() {
  const entries = new Map()
  const listeners = new Map()

  const emit = (name) => {
    for (const listener of listeners.get(name) ?? []) listener()
  }

  return {
    register(name, entry) {
      if (typeof name !== 'string' || name.length === 0 || typeof entry !== 'object' || entry === null) {
        throw new Error('invalid FlyBot slot registration')
      }
      const item = { ...entry, name }
      const list = byName(entries, name)
      list.push(item)
      list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id ?? '').localeCompare(String(b.id ?? '')))
      emit(name)
      return () => {
        const current = entries.get(name)
        if (!current) return
        const at = current.indexOf(item)
        if (at !== -1) current.splice(at, 1)
        if (current.length === 0) entries.delete(name)
        emit(name)
      }
    },
    entries(name) {
      return [...(entries.get(name) ?? [])]
    },
    subscribe(name, listener) {
      if (typeof listener !== 'function') return () => {}
      byName(listeners, name).push(listener)
      return () => {
        const list = listeners.get(name)
        if (!list) return
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
      }
    },
  }
}
