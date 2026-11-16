// A separate read-only history view, never a navigation to the current Agent.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { useDialogFocus, useEscape } from './overlay-hooks.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'

export function useHistoryHit(read, hitToken, accessKey) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ key: '', status: 'loading', value: null })
  const serial = useRef(0)
  const key = `${hitToken ?? ''}:${accessKey}:${attempt}`
  useEffect(() => {
    const ticket = ++serial.current
    const abort = new AbortController()
    setState({ key, status: 'loading', value: null })
    if (!hitToken || typeof read !== 'function') {
      setState({ key, status: 'error', value: null })
      return () => { serial.current += 1; abort.abort() }
    }
    void Promise.resolve().then(() => read({ hitToken }, abort.signal)).then(value => {
      if (serial.current !== ticket || abort.signal.aborted) return
      if (value?.scope !== 'read-only-history' || !Array.isArray(value.entries)) throw new Error('Invalid history response')
      setState({ key, status: 'ready', value })
    }).catch(() => {
      if (serial.current === ticket && !abort.signal.aborted) setState({ key, status: 'error', value: null })
    })
    return () => { serial.current += 1; abort.abort() }
  }, [read, key])
  return { ...(state.key === key ? state : { status: 'loading', value: null }), reload: () => setAttempt(value => value + 1) }
}

export function HistoryHitDialog({ hit, roster, actions, onBack }) {
  const ref = useRef(null)
  useEscape(onBack)
  useDialogFocus(ref)
  const bot = roster.byId[hit.botId]
  // Roster-driven account/ownership/part changes clear displayed content before
  // another authenticated read. No cached search snippet is used as context.
  const accessKey = JSON.stringify([Boolean(bot), bot?.ownerId, bot?.sessionId, bot?.parts, roster.self?.memberId])
  const state = useHistoryHit(actions.readHistoryHit, bot ? hit.hitToken : null, accessKey)
  const view = state.status === 'ready' ? state.value : null
  return h('div', { className: 'bt-palette-layer' },
    h('div', { className: 'bt-backdrop', onMouseDown: onBack }),
    h('section', { className: 'bt-palette bt-history-view', role: 'dialog', 'aria-modal': true, 'aria-label': t('Read-only history match'), tabIndex: -1, ref },
      h('header', { className: 'bt-palette-head' }, h('h2', null, t('Read-only history match')),
        h('button', { type: 'button', className: 'bt-palette-clear', 'aria-label': t('Back to search'), onClick: onBack }, h(CloseIcon))),
      h('p', { className: 'bt-history-disclaimer' }, t('This is segment history, not the current chat. No Bot is activated.')),
      h('p', { className: 'bt-history-disclaimer' }, t('Shows the match and up to two nearby visible messages on each side.')),
      h('div', { className: 'bt-history-content' },
        state.status === 'loading' ? h('p', { role: 'status' }, t('Loading authorized history…')) : null,
        state.status === 'error' ? h('p', { role: 'alert' }, t('History changed, expired, or is no longer accessible. Search again.')) : null,
        view ? h('div', null,
          h('p', null, t('Segment {part} of {count}', { part: view.part, count: view.partCount })),
          h('p', null, t('History session'), ': ', h('code', null, view.sessionId)),
          view.entries.map(entry => h('section', { key: entry.seq, className: 'bt-history-entry', 'data-hit': entry.hit || undefined },
            h('h3', null, entry.hit ? t('Matched message') : t('Nearby message'), ' · ', t(entry.role === 'user' ? 'You' : 'Bot'), ' · ', t('Sequence'), ' ', entry.seq,
              entry.turn === null ? null : ` · ${t('Turn')} ${entry.turn}`),
            entry.omittedBefore ? h('span', null, '…') : null,
            h('pre', null, entry.text),
            entry.truncated ? h('p', { className: 'bt-hint' }, t('Text truncated by the byte limit; this is not complete history.')) : null))) : null),
      h('footer', { className: 'bt-history-foot' },
        h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, t('Back to search')),
        h('button', { type: 'button', className: 'bt-soft', disabled: state.status === 'loading', onClick: state.reload }, t('Reload history context')))))
}
