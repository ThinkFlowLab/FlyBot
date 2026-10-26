// Daily release-beat watchdog (#1209, second half).
//
//   node .github/scripts/release-beat.mjs --repo ThinkFlowLab/FlyBot            # dry run for CST today
//   node .github/scripts/release-beat.mjs --repo ThinkFlowLab/FlyBot --date 2026-10-25 --open
//
// The daily release is a timer on a workstation: when that box is offline at 02:00 Asia/Shanghai,
// DSH runs only the latest missed occurrence, so the beat is gone and nothing says so. This is the
// outside observer. Its metric is the newest `v*` **tag**, never a workflow run: `release.yml`
// triggers on `push: tags: ['v*']` and has no cron, so "a release run happened" is always false and
// "the last run was green" would watch nothing at all.
//
// One issue per day: the day is searched for first (open *and* closed count), and an existing alert
// is reported in the summary instead of filing a second one. A `Release v…` pull request still open
// means a release is in flight, so that day gets a summary line and no issue — a slow CI is not a
// missed beat. An API failure exits non-zero and files nothing: one GitHub hiccup must not leave a
// false alert behind.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export const ALERT_PREFIX = 'Release beat missing: '
export const ALERT_TITLE = (date) => `${ALERT_PREFIX}${date}`
export const CST = 'Asia/Shanghai'

const realGh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 << 20, ...options })

// A calendar date (YYYY-MM-DD) in Asia/Shanghai for an instant. `en-CA` prints that order directly.
export function cstDate(instant) {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${instant}`)
  return new Intl.DateTimeFormat('en-CA', { timeZone: CST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

// Semver order, not string order: v0.2.10 comes after v0.2.9, and a string max would pick v0.2.9.
export function latestOf(names) {
  const parsed = names
    .map((name) => ({ name, m: /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(name).trim()) }))
    .filter((entry) => entry.m)
    .map((entry) => ({ name: entry.name.trim(), parts: entry.m.slice(1).map(Number) }))
  if (parsed.length === 0) return null
  parsed.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2])
  return parsed[0].name
}

// The whole decision, no I/O: what the run should do once the facts are in.
//   today          YYYY-MM-DD in Asia/Shanghai
//   latestTag      'v0.2.8' or null when the repository has no v* tag at all
//   latestTagDate  that tag's date in Asia/Shanghai, or null
//   openReleasePr  a `Release v…` pull request is open right now
export function decide({ today, latestTag, latestTagDate, openReleasePr = false } = {}) {
  if (!isDate(today)) throw new Error(`today must be YYYY-MM-DD, got ${today}`)
  if (!latestTag || !isDate(latestTagDate)) return { action: 'skip-no-tag', reason: 'no v* tag could be read' }
  if (latestTagDate === today) return { action: 'ok', reason: `${latestTag} is dated ${today}` }
  // A newest tag dated AFTER the judged day does not answer that day: `--date 2026-10-25` asks whether
  // 10-25 got a tag, and a tag pushed on 10-26 is not one. Only a dispatch onto an earlier day, or a
  // clock ahead of Asia/Shanghai, can land here — a scheduled run judges today and nothing more — and
  // both are better seen than swallowed. Reading this branch as `ok` is what makes the manual check in
  // the issue ("dispatch with date=<yesterday>, it must file one") unable to file anything at all once
  // today's tag already exists.
  if (latestTagDate > today) return { action: 'alert', reason: `no v* tag on ${today}; the newest is ${latestTag} dated ${latestTagDate}, after the judged day` }
  if (openReleasePr) return { action: 'skip-in-flight', reason: 'a Release v… pull request is open' }
  return { action: 'alert', reason: `no v* tag since ${latestTagDate}` }
}

function apiJson(gh, path, jq) {
  const out = gh(['api', path, ...(jq ? ['--jq', jq] : [])], {})
  return out
}

export function newestTag(gh, repo) {
  const names = apiJson(gh, `repos/${repo}/tags?per_page=100`, '.[].name').split('\n').filter(Boolean)
  return latestOf(names)
}

// Annotated tags carry `tagger.date`; a lightweight tag has none, so its commit's `committer.date` is
// the closest true answer. Both are converted to the CST date, never compared as strings of tags.
export function tagDate(gh, repo, tag) {
  const ref = apiJson(gh, `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, '.object.type + " " + .object.sha').trim().split(' ')
  const [type, sha] = ref
  if (!sha) throw new Error(`cannot read ref for ${tag}`)
  const instant = type === 'tag'
    ? apiJson(gh, `repos/${repo}/git/tags/${sha}`, '.tagger.date').trim()
    : apiJson(gh, `repos/${repo}/git/commits/${sha}`, '.committer.date').trim()
  if (!instant) throw new Error(`cannot read a date for ${tag}`)
  return cstDate(instant)
}

export function hasOpenReleasePr(gh, repo) {
  const titles = apiJson(gh, `repos/${repo}/pulls?state=open&per_page=100`, '.[].title').split('\n')
  return titles.some((title) => /^Release v\d/.test(title.trim()))
}

// The newest `release.yml` run, so the alert says where to look before anything else is read (#1209,
// triage spec 3.3). A read failure here returns null and the alert is still filed: losing this link is
// not a reason to lose the signal, and it is the only one of these reads allowed to fail quietly.
export function lastReleaseRun(gh, repo) {
  try {
    const url = apiJson(gh, `repos/${repo}/actions/workflows/release.yml/runs?per_page=1`, '.workflow_runs[0].html_url // ""').trim()
    return url || null
  } catch {
    return null
  }
}

export function alreadyAlerted(gh, repo, date) {
  const q = `repo:${repo} is:issue "${ALERT_TITLE(date)}"`
  const total = apiJson(gh, `search/issues?q=${encodeURIComponent(q)}`, '.total_count').trim()
  return Number(total) > 0
}

export function fileAlert(gh, repo, { date, latestTag, latestTagDate, hours, lastReleaseRun, walked }) {
  const body = [
    `No \`v*\` tag was created on **${date}** (Asia/Shanghai), so the daily release beat did not happen and nothing announced it.`,
    '',
    `- newest tag: \`${latestTag}\`, dated ${latestTagDate}`,
    `- hours since that tag: ${hours < 0 ? 'the tag is newer than the day judged' : hours}`,
    `- last \`release.yml\` run: ${lastReleaseRun ?? 'none found'}`,
    `- the routine's own catch-up (first half of #1209) runs first: check whether it already re-released today`,
    '',
    'The metric here is the newest `v*` tag, not a workflow run: `release.yml` has no cron, so a missing tag produces no run at all.',
    '',
    'Filed by `.github/workflows/release-beat.yml`; one issue per day.',
  ].join('\n')
  const payload = JSON.stringify({ title: ALERT_TITLE(date), body, labels: ['bug', 'area:release'] })
  const out = gh(['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-'], { input: payload })
  const created = JSON.parse(out)
  return created.number ?? null
}

// Everything except the decision itself. Side effects live here and nowhere else, so `decide` is
// testable without a network and the anti-spam path is one branch, not a wrapper around it.
export function run({ gh = realGh, repo, date, open = false, today = cstDate(new Date()), summary = process.env.GITHUB_STEP_SUMMARY, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const day = date ?? today
  if (!isDate(day)) throw new Error(`--date must be YYYY-MM-DD, got ${day}`)
  const latestTag = newestTag(gh, repo)
  const latestTagDate = latestTag ? tagDate(gh, repo, latestTag) : null
  const openReleasePr = hasOpenReleasePr(gh, repo)
  const decision = decide({ today: day, latestTag, latestTagDate, openReleasePr })
  const line = `release-beat: ${decision.action} (${decision.reason})`
  write(line)
  if (summary) {
    try { appendFileSync(summary, `${line}\n`) } catch { /* no summary file: the stdout line is the record */ }
  }
  if (decision.action !== 'alert') return { ...decision, filed: false }
  if (alreadyAlerted(gh, repo, day)) {
    const skipped = `release-beat: already reported for ${day}; no second issue`
    write(skipped)
    return { ...decision, action: 'skip-already-reported', filed: false, reason: `an alert for ${day} already exists` }
  }
  if (!open) return { ...decision, filed: false, dryRun: true }
  const hours = Math.round((Date.parse(day) - Date.parse(latestTagDate)) / 36e5)
  const number = fileAlert(gh, repo, { date: day, latestTag, latestTagDate, hours, lastReleaseRun: lastReleaseRun(gh, repo) })
  write(`release-beat: filed #${number}`)
  return { ...decision, filed: true, number }
}

function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const repo = arg('--repo') || process.env.GH_REPO
  const date = arg('--date') || process.env.RELEASE_BEAT_DATE || undefined
  const open = process.argv.includes('--open')
  run({ repo, date, open })
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (error) { console.error(`release-beat: ${error.message}`); process.exit(1) }
}
