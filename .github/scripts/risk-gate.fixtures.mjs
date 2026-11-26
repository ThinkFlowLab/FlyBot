// Shared set-up for the risk-gate tests: the rules as they ship, the gate built from them, and a
// changed file shaped like the pull request files API returns it. Not a test file.
import { createGate, loadRules } from './risk-gate.mjs'

export const rules = loadRules(new URL('../agent/risk-rules.json', import.meta.url))
export const gate = createGate(rules)
export const meaning = Object.fromEntries(Object.entries(rules.tiers).map(([t, d]) => [t, d.meaning]))
// A changed file as GET /pulls/{n}/files returns it.
export const file = (filename, patchLines = ['+x'], extra = {}) => ({
  filename, status: 'modified', additions: patchLines.length, deletions: 0, changes: patchLines.length,
  patch: '@@ -1 +1 @@\n' + patchLines.join('\n'), ...extra,
})
