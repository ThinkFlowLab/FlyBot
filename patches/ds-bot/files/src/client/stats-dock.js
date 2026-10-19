import { createElement as h, useMemo } from 'react'

// The shell's run-stats footer under the composer reads "1 turns 1 steps": its English
// string is a single plural template. FlyBot registers the shell's own footer one priority
// lower, with the same inject and locale, and hands it a `t` that says "1 turn" / "1 step"
// (#419). Nothing else about the footer changes; Chinese and other copy pass through.
export const STATS_DOCK = 'conversation.composer.dock'
export const STATS_ID = 'stats'

const noun = (count, one, many) => `${count} ${Number(count) === 1 ? one : many}`

// `t` for the footer: only the exact English plural template is rewritten, so a translated
// or reworded shell string is left as the shell wrote it.
export function pluralStats(t) {
  return (key, params) => {
    const text = t(key, params)
    if (key !== 'stats.counts' || !params) return text
    const { turns, steps } = params
    return text === `${turns} turns ${steps} steps` ? `${noun(turns, 'turn', 'turns')} ${noun(steps, 'step', 'steps')}` : text
  }
}

// `entriesOf(slot)` reads the slot ledger (`ctx.slots.entries`). The shell's entry is looked
// up when the footer renders, so plugin load order does not matter; without it, or without
// its hooks, no footer is drawn.
export function statsDock(entriesOf) {
  const shell = () => (entriesOf(STATS_DOCK) ?? []).find(entry => entry?.component !== StatsDock && entry?.options?.id === STATS_ID)
  function StatsDock(props) {
    const t = useMemo(() => (typeof props.t === 'function' ? pluralStats(props.t) : props.t), [props.t])
    const entry = shell()
    if (!entry || typeof props.usePerformanceUsage !== 'function') return null
    return h(entry.component, { ...props, t })
  }
  return { component: StatsDock, inject: (...args) => shell()?.inject?.(...args) ?? {} }
}
