// Standing approvals (#540): what the owner chose "Always allow" for, on a Bot or a
// group, each with Remove. A group lists only the grants this person gave (all of them
// on a host nobody signed in to).
import { createElement as h } from 'react'
import { t } from './i18n.js'

// Without a sign-in the host has one person, who gave every grant.
export const standingOf = (target, roster) => {
  const me = roster?.self?.memberId
  return (target?.standingApprovals ?? []).filter(grant => me === undefined || grant.ownerId === me)
}

export function StandingApprovalsCard({ scope, target, roster, actions, run, Card }) {
  const grants = scope === 'room' ? standingOf(target, roster) : (target?.standingApprovals ?? [])
  if (grants.length === 0) return null
  const hint = scope === 'room' ? t('Your Bots in this group do these without asking.') : t('This Bot does these without asking.')
  return h(Card, { title: t('Always allowed') },
    grants.map(grant => h('div', { key: grant.kind, className: 'bt-set-row bt-bs-row', 'data-standing': grant.kind },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, grant.label || grant.kind),
        h('span', { className: 'bt-set-hint' }, hint)),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm',
        'aria-label': t('Remove always allow for {kind}', { kind: grant.label || grant.kind }),
        onClick: () => run(actions.removeStandingApproval(scope, target.id, grant.kind)),
      }, t('Remove')))))
}
