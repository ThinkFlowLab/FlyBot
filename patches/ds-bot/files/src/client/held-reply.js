// A Bot's reply to a friend, held for its owner (#418): the decision sits on the reply's own
// bubble in the Bot's chat, which is where the owner reads it. The holding policy's inline
// flybot.approvals entry draws the buttons (the social plugin's card); otherwise plain Approve /
// Reject. A waiting id is claimed, so no other card or pointer repeats it. Once decided, the
// bubble says what became of it, quietly, in the same place.
import { Component, createElement as h, useEffect, useState } from 'react'
import { call as callHost } from './api.js'
import { registry } from './flybot-registry.js'
import { claimApprovals } from './approval-claims.js'
import { isApprovalWaiting } from '../shared/approval-waiting.js'
import { canRetry } from '../shared/held-retry.js'
import { reasonLine } from './reason-line.js'
import { lockedWindow } from './schedules.js'
import { hostText, t } from './i18n.js'
import { relativeShort } from './text.js'

const call = (endpoint, payload) => callHost(`flybot/${endpoint}`, payload)

// A plugin card that throws draws the plain buttons instead, never a broken chat.
let Boundary
const boundary = () => Boundary ??= class HeldReplyBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { console.error(`flybot: ${this.props.id} failed`, error) }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function useInlineEntry(policy) {
  const slots = registry()
  const [, setVersion] = useState(0)
  useEffect(() => slots.subscribe(() => setVersion(slots.version())), [slots])
  return slots.entries('flybot.approvals').find(entry => entry.inline === true && entry.policy === policy)
}

export function HeldReplyActions({ held, actions, roster }) {
  // #2310: the decision is a write, so a locked window draws the host's sentence in its place.
  const locked = lockedWindow(roster)
  const readOnlyLine = () => h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly))
  const custom = useInlineEntry(held?.by)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const waiting = isApprovalWaiting(held?.status)
  useEffect(() => {
    if (!waiting) return undefined
    claimApprovals(`held-reply:${held.id}`, [held.id])
    return () => claimApprovals(`held-reply:${held.id}`, [])
  }, [held?.id, waiting])
  if (!held?.id) return null
  const decide = async (decision) => {
    setBusy(true)
    setError('')
    try { await call('decide', { id: held.id, decision }) } catch (failure) { setError(failure?.message ?? String(failure)) } finally { setBusy(false) }
  }
  if (!waiting) {
    const failed = held.status === 'failed'
    return h('div', { className: 'bt-held-note', 'data-state': held.status, title: failed && held.error ? held.error : undefined },
      h('span', null, held.status === 'approved' ? t('Sent to {to}', { to: held.toName }) : held.status === 'auto' ? t('Auto-sent to {to}', { to: held.toName }) : failed ? t('Not sent: delivery failed') : t('Not sent')),
      // #968: the terminal answer comes from one predicate, not from `status === 'failed'` here and a
      // different field elsewhere. A failure that can never succeed draws no button on any surface.
      failed && canRetry(held) ? (locked ? readOnlyLine() : h('button', { type: 'button', className: 'bt-held-retry', disabled: busy, onClick: () => decide('retry') }, t('Retry'))) : null,
      error ? h('span', { className: 'bt-flybot-approval-error', role: 'alert' }, error) : null)
  }
  // #2409: same rule as the dock and the room card; an absent or unparseable stamp draws nothing.
  const at = typeof held.createdAt === 'number' ? held.createdAt : Date.parse(held.createdAt)
  const age = Number.isFinite(at) && at > 0 ? ` · ${relativeShort(at)}` : null
  // P-538: the same sentence and the same bound the dock's card draws.
  const reason = reasonLine(held.reason)
  const plain = h('div', { className: 'bt-held-card', role: 'region', 'aria-label': t('Waiting for your approval') },
    h('div', { className: 'bt-held-head' }, t('Waiting for your approval'), age),
    h('div', { className: 'bt-flybot-approval-origin' }, t('{from} → {to}', { from: held.from ?? t('A Bot'), to: held.toName })),
    reason ? h('div', { className: 'bt-flybot-approval-reason', title: reason.title }, reason.text) : null,
    locked ? readOnlyLine() : h('div', { className: 'bt-flybot-approval-actions' },
      h('button', { type: 'button', disabled: busy, onClick: () => decide('reject') }, t('Reject')),
      h('button', { type: 'button', className: 'bt-flybot-approve', disabled: busy, onClick: () => decide('approve') }, t('Approve'))),
    error ? h('div', { className: 'bt-flybot-approval-error', role: 'alert' }, error) : null)
  return h('div', { className: 'bt-held-actions', 'data-flybot': 'held-reply-actions' },
    custom ? h(boundary(), { id: custom.id, fallback: plain }, h(custom.component, { held, decide, call, actions, readOnly: locked === true })) : plain)
}
