// A turn that dies before writing a single word leaves the chat looking like a Bot that read the
// reminder and chose to stay quiet (#1044): on 2026-10-24 eight beats in a row were dead for three
// and a half hours because a provider budget cap refused every model call and nothing was drawn.
//
// The host already knows: `noteEnded` keeps the newest turns and marks a failure that produced no text
// `silent`, with the streak at the same place. This draws those lines above the composer, one per turn,
// newest last. It never posts, never retries and never counts as a reply, so a dead beat is visible while
// the audience rules see exactly what they saw before.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { failureLines } from '../shared/turn-failures.js'

export { failureLines }

export function TurnFailures({ sessionId, work }) {
  const [snapshot, setSnapshot] = useState(() => work?.getSnapshot?.())
  useEffect(() => {
    if (typeof work?.subscribe !== 'function') return undefined
    const read = () => setSnapshot(work.getSnapshot())
    const off = work.subscribe(read)
    read()
    return off
  }, [work])
  const lines = failureLines(snapshot, sessionId, t)
  if (lines.length === 0) return null
  return h('div', { className: 'bt-turn-failures', 'data-flybot': 'turn-failures' },
    lines.map(line => h('div', { key: line.id, className: 'bt-turn-failure', 'data-flybot': 'turn-failure' },
      h('span', { className: 'bt-turn-failure-text' }, line.text),
      line.streak === undefined ? null : h('span', { className: 'bt-turn-failure-streak' }, ` ${t('{count} turns in a row', { count: line.streak })}`))))
}

export const TURN_FAILURES_CSS = `
.bt-turn-failures{width:100%;max-width:min(992px,100%);margin:0 auto;padding:0 0 6px;box-sizing:border-box}
.bt-turn-failure{display:flex;gap:6px;align-items:baseline;padding:6px 10px;border-radius:8px;font-size:12px;line-height:1.45;background:color-mix(in srgb,var(--bt-ink) 6%,transparent);color:color-mix(in srgb,var(--bt-ink) 72%,transparent)}
.bt-turn-failure-streak{opacity:.72}
`
