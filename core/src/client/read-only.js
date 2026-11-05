// #2502: the host's sentence tells the reader to close the other window and reload. The sidebar
// (#2247) and the refusal toast (#2265) grew that entry; the Settings header, the drawer, the
// Inbox and the Memory panel kept the sentence with nothing to answer it, and inside the Inbox
// modal the sidebar's own button cannot be reached at all. This is the shared piece those
// surfaces draw: the host's own words under `role="status"`, and one Reload outside that node (a
// live region must stay text), running the same `actions.reloadTeam` read the sidebar runs — never
// a page reload, which would drop the composer.
import { hostText, t } from './i18n.js'

// A sentence of nothing but whitespace says nothing, so it draws nothing. Read the way the
// sidebar reads it (#2247), so the two surfaces cannot disagree about which window is locked.
export const readOnlySaid = roster => typeof roster?.readOnly === 'string' && roster.readOnly.trim() !== ''

// `reload: false` keeps the sentence and drops the control, for a view that already carries one:
// one Reload per screen, on the topmost sentence. The caller passes `h` rather than this module
// importing react: one more react import would renumber every module's binding in the generated
// `client.js`, turning a five-line change into a two-thousand-line diff of the bundle.
export function readOnlyLine(h, roster, actions, { key, className, style, reload = true } = {}) {
  if (!readOnlySaid(roster)) return null
  return h('div', { key, className: ['bt-readonly-line', className].filter(Boolean).join(' '), style },
    h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly)),
    reload
      ? h('button', {
          type: 'button',
          className: 'bt-read-only-reload',
          onClick: () => { void Promise.resolve(actions?.reloadTeam?.()).catch(error => actions?.reportError?.(error, 'reload')) },
        }, t('Reload'))
      : null)
}
