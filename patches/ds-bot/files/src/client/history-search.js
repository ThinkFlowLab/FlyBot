// Async history state separated from the palette's loaded-outline fallback.
import { useEffect, useRef, useState } from 'react'
export const HISTORY_DISPLAY_MAX = 100
export function useHistorySearch(search, query) {
  const [state, setState] = useState({ query: '', items: [], status: 'idle', cursor: null })
  const latest = useRef(0)
  const alive = useRef(true)
  const activeAbort = useRef(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; latest.current += 1; activeAbort.current?.abort() } }, [])
  const request = async (wanted, previous, ticket) => {
    activeAbort.current?.abort()
    const abort = new AbortController()
    activeAbort.current = abort
    try {
      const reply = await search({ query: wanted, limit: Math.min(20, HISTORY_DISPLAY_MAX - previous.items.length), ...(previous.cursor ? { cursor: previous.cursor } : {}) }, abort.signal)
      if (!alive.current || latest.current !== ticket) return
      if (reply?.scope !== 'local-bot-chats' || !Array.isArray(reply.items)) throw new Error('Unsupported history response')
      const items = [...previous.items, ...reply.items].slice(0, HISTORY_DISPLAY_MAX)
      setState({ query: wanted, items, status: 'ready', cursor: items.length < HISTORY_DISPLAY_MAX ? reply.cursor : null, incomplete: reply.incomplete,
        limited: reply.limited || (items.length >= HISTORY_DISPLAY_MAX && Boolean(reply.cursor)) })
    } catch {
      if (alive.current && latest.current === ticket) setState({ query: wanted, items: [], status: 'error', cursor: null })
    } finally { if (activeAbort.current === abort) activeAbort.current = null }
  }
  useEffect(() => {
    const ticket = ++latest.current
    const initial = { query, items: [], cursor: null }
    if (typeof search !== 'function' || !query.trim() || [...query].length > 256) {
      setState({ ...initial, status: 'idle' })
      return undefined
    }
    setState({ ...initial, status: 'loading' })
    const timer = setTimeout(() => { void request(query, initial, ticket) }, 250)
    return () => { clearTimeout(timer); activeAbort.current?.abort() }
  }, [search, query])
  const current = state.query === query ? state : { query, items: [], cursor: null, status: typeof search === 'function' && query.trim() ? 'loading' : 'idle' }
  const more = () => {
    if (current.status !== 'ready' || !current.cursor) return
    const ticket = ++latest.current
    setState({ ...current, status: 'loading' })
    void request(query, current, ticket)
  }
  return { ...current, more }
}
