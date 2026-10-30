// The three Project ranks are one vocabulary: the sidebar entry (#1828), its role menu and the
// board's Project team block (#1860) all print the same words, so the mapping lives here instead
// of in each module that draws a rank. The policy itself stays in the host.
import { t } from './i18n.js'

const ROLE_LABELS = { owner: 'Owner', maintainer: 'Maintainer', member: 'Member' }

export function roleText(role) {
  if (role === null || role === undefined || role === '') return ''
  return t(ROLE_LABELS[role] ?? String(role))
}
