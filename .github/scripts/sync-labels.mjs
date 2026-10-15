// Create or update the labels in .github/labels.json (see docs/autonomous-dev.md).
//
//   node .github/scripts/sync-labels.mjs --repo ThinkFlowLab/FlyBot            # dry run: prints the plan
//   node .github/scripts/sync-labels.mjs --repo ThinkFlowLab/FlyBot --apply    # creates/updates
//
// A maintainer runs it by hand with their own `gh` login; no workflow runs it. It never deletes
// a label and never touches a label that is not in labels.json.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// existing: [{name, color, description}] from the API. Names compare case-insensitively, like GitHub.
export function plan(wanted, existing) {
  const have = new Map(existing.map((l) => [l.name.toLowerCase(), l]))
  return wanted.map((w) => {
    const cur = have.get(w.name.toLowerCase())
    if (!cur) return { action: 'create', label: w }
    const same = cur.color.toLowerCase() === w.color.toLowerCase() && (cur.description || '') === w.description
    return { action: same ? 'keep' : 'update', label: w, current: cur }
  })
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 16 << 20 })

function main() {
  const i = process.argv.indexOf('--repo')
  const repo = i > 0 ? process.argv[i + 1] : undefined
  if (!repo) throw new Error('pass --repo owner/name')
  const apply = process.argv.includes('--apply')
  const wanted = JSON.parse(readFileSync(fileURLToPath(new URL('../labels.json', import.meta.url)), 'utf8'))
  const existing = gh('api', '--paginate', '--jq', '.[]', `repos/${repo}/labels?per_page=100`).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const { action, label } of plan(wanted, existing)) {
    console.log(`${action.padEnd(6)} ${label.name}`)
    if (!apply || action === 'keep') continue
    const fields = ['-f', `color=${label.color}`, '-f', `description=${label.description}`]
    if (action === 'create') gh('api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${label.name}`, ...fields)
    else gh('api', '-X', 'PATCH', `repos/${repo}/labels/${encodeURIComponent(label.name)}`, ...fields)
  }
  if (!apply) console.log('\nDry run. Add --apply to make these changes.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(`sync-labels: ${e.message}`); process.exit(1) }
}
