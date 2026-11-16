// CHANGELOG entries live in one fragment file per change (changelog.d/<name>.<kind>.md), so two PRs
// never edit the same lines of CHANGELOG.md. At release time `release` folds them into a section.
//
//   node .github/scripts/changelog.mjs check                       fragments are well formed; CHANGELOG.md has [Unreleased]
//   node .github/scripts/changelog.mjs preview                     print what the fragments would add (to stdout)
//   node .github/scripts/changelog.mjs release <version> [--date YYYY-MM-DD] [--dry-run]
//                                                                  move [Unreleased] and the fragments into "## [version] - date",
//                                                                  delete the fragment files, leave [Unreleased] empty;
//                                                                  without --date the date is the Asia/Shanghai calendar day
//                                                                  of now, as every released section is dated
//
// No network, no shell, no environment variables: it reads and writes CHANGELOG.md and changelog.d/ only.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KINDS = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security']
const HEADING = kind => `### ${kind[0].toUpperCase()}${kind.slice(1)}`
const NAME = new RegExp(`^[a-z0-9][a-z0-9_-]*(?:\\.[a-z0-9_-]+)*\\.(${KINDS.join('|')})\\.md$`)

// [{ file, kind, text }] sorted by file name; throws one Error listing every problem.
export function readFragments(dir) {
  if (!existsSync(dir)) return []
  const problems = []
  const out = []
  for (const file of readdirSync(dir).sort()) {
    if (file === 'README.md' || file === '.gitkeep') continue
    const match = NAME.exec(file)
    if (!match) { problems.push(`${file}: name must be <slug>.<kind>.md with kind one of ${KINDS.join(', ')} (lower case)`); continue }
    const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim()
    if (!text) problems.push(`${file}: empty`)
    else if (/^(- |\* |#)/.test(text)) problems.push(`${file}: write the entry text only (no leading "- " or heading); the bullet is added when it is assembled`)
    else if (/\n\s*\n/.test(text)) problems.push(`${file}: one entry per file, no blank lines inside it`)
    else out.push({ file, kind: match[1], text })
  }
  if (problems.length) throw new Error(problems.join('\n'))
  return out
}

const bullet = text => `- ${text.split('\n').map((l, i) => (i ? `  ${l.trim()}` : l.trim())).join('\n')}`

// "### Kind" blocks -> Map(kind -> bullet text lines); text before the first heading is kept as `lead`.
export function parseSection(body) {
  const kinds = new Map()
  let lead = ''
  let current = null
  for (const line of body.split('\n')) {
    const heading = /^### (.+?)\s*$/.exec(line)
    if (heading) { current = heading[1]; if (!kinds.has(current)) kinds.set(current, []); continue }
    if (current === null) lead += `${line}\n`
    else kinds.get(current).push(line)
  }
  for (const [name, lines] of kinds) kinds.set(name, lines.join('\n').trim().split('\n').filter((l, i, all) => all.length > 1 || l))
  return { lead: lead.trim(), kinds }
}

export function renderKinds(kinds) {
  const known = KINDS.map(k => HEADING(k).slice(4))
  const order = [...known.filter(k => kinds.has(k)), ...[...kinds.keys()].filter(k => !known.includes(k))]
  return order.map(k => `### ${k}\n\n${kinds.get(k).join('\n').trim()}`).join('\n\n')
}

// Fragments as "### Kind" blocks (Keep a Changelog order).
export function assemble(fragments) {
  const kinds = new Map()
  for (const f of fragments) {
    const name = HEADING(f.kind).slice(4)
    if (!kinds.has(name)) kinds.set(name, [])
    kinds.get(name).push(bullet(f.text))
  }
  return renderKinds(kinds)
}

const UNRELEASED = /^## \[Unreleased\][ \t]*$/m

// The headings are reference links: Markdown needs a "[x]: url" definition or it renders "## [x]" as
// literal brackets, and [Unreleased] compares from whatever tag its definition names.
const HOME = 'https://github.com/ThinkFlowLab/FlyBot'
const VERSION_HEADING = /^## \[([^\]]+)\](?:[ \t]+-[^\n]*)?[ \t]*$/gm
const DEFINITION = /^\[([^\]]+)\]:[ \t]*(\S+)[ \t]*$/gm
const baseOf = url => /^(.*?)\/(?:compare|releases)\//.exec(url ?? '')?.[1] ?? HOME
const escapeName = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every heading needs a definition, and [Unreleased] must compare from the newest release heading;
// each message names the heading it is about.
export function linkProblems(changelog) {
  const problems = []
  const headings = [...changelog.matchAll(VERSION_HEADING)].map(match => match[1])
  const definitions = new Map([...changelog.matchAll(DEFINITION)].map(match => [match[1], match[2]]))
  for (const name of headings) if (!definitions.has(name)) problems.push(`"## [${name}]" has no "[${name}]:" link definition`)
  const newest = headings.find(name => name !== 'Unreleased')
  const unreleased = definitions.get('Unreleased')
  if (unreleased && newest && !new RegExp(`/compare/v${escapeName(newest)}\\.\\.\\.HEAD$`).test(unreleased)) {
    problems.push(`"[Unreleased]:" compares from ${unreleased}, not from the newest release (v${newest})`)
  }
  return problems
}

// The definition block Markdown needs, in the order the file already uses: [Unreleased], the version
// being released, then the older ones. They are stripped and re-appended so the block stays together.
function withLinks(text, version, previous) {
  const definitions = [...text.matchAll(DEFINITION)].map(match => [match[1], match[2]])
  const base = baseOf(definitions.find(([name]) => name === 'Unreleased')?.[1] ?? definitions.find(([name]) => name === previous)?.[1])
  const rest = definitions.filter(([name]) => name !== 'Unreleased' && name !== version)
  const block = [
    `[Unreleased]: ${base}/compare/v${version}...HEAD`,
    `[${version}]: ${previous ? `${base}/compare/v${previous}...v${version}` : `${base}/releases/tag/v${version}`}`,
    ...rest.map(([name, url]) => `[${name}]: ${url}`),
  ]
  return `${text.replace(DEFINITION, '').replace(/\s+$/, '')}\n\n${block.join('\n')}\n`
}

// New CHANGELOG.md text: [Unreleased] emptied, a "## [version] - date" section below it that holds the old
// [Unreleased] entries first and then the fragments, merged per kind.
export function release(changelog, fragments, version, date) {
  const start = changelog.search(UNRELEASED)
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date like 2026-10-15`)
  if (new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\]`, 'm').test(changelog)) throw new Error(`CHANGELOG.md already has a section for ${version}`)
  const afterHeading = changelog.indexOf('\n', start) + 1
  const next = changelog.slice(afterHeading).search(/^## \[/m)
  const end = next < 0 ? changelog.length : afterHeading + next
  const { lead, kinds } = parseSection(changelog.slice(afterHeading, end))
  for (const f of fragments) {
    const name = HEADING(f.kind).slice(4)
    if (!kinds.has(name)) kinds.set(name, [])
    kinds.get(name).push(bullet(f.text))
  }
  if (!kinds.size && !lead) throw new Error('nothing to release: [Unreleased] is empty and changelog.d/ has no fragments')
  const section = `## [${version}] - ${date}\n\n${lead ? `${lead}\n\n` : ''}${renderKinds(kinds)}\n\n`
  const previous = [...changelog.matchAll(VERSION_HEADING)].map(match => match[1]).find(name => name !== 'Unreleased')
  return withLinks(`${changelog.slice(0, afterHeading)}\n${section}${changelog.slice(end)}`, version, previous)
}

// The released sections are dated by the Asia/Shanghai calendar day of the release moment: after
// 16:00Z that is already the next day there, which is the day the section must carry.
export function sectionDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
}

function main(argv) {
  const root = process.env.CHANGELOG_ROOT ?? join(fileURLToPath(import.meta.url), '..', '..', '..')
  const dir = join(root, 'changelog.d')
  const file = join(root, 'CHANGELOG.md')
  const [command, ...rest] = argv
  const fail = message => { console.error(`changelog: ${message}`); process.exit(1) }
  try {
    if (command === 'check') {
      const fragments = readFragments(dir)
      const text = readFileSync(file, 'utf8')
      if (!UNRELEASED.test(text)) fail('CHANGELOG.md has no "## [Unreleased]" section')
      const problems = linkProblems(text)
      if (problems.length) fail(problems.join('\n'))
      console.log(`changelog: ${fragments.length} fragment(s) in changelog.d/ are well formed`)
    } else if (command === 'preview') {
      console.log(assemble(readFragments(dir)))
    } else if (command === 'release') {
      const version = rest.find(a => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--date')
      const dateAt = rest.indexOf('--date')
      const date = dateAt >= 0 ? rest[dateAt + 1] : sectionDate()
      if (!version) fail('usage: changelog.mjs release <version> [--date YYYY-MM-DD] [--dry-run]')
      const fragments = readFragments(dir)
      const text = release(readFileSync(file, 'utf8'), fragments, version, date)
      if (rest.includes('--dry-run')) { console.log(text.split('\n').slice(0, 60).join('\n')); return }
      writeFileSync(file, text)
      for (const f of fragments) rmSync(join(dir, f.file))
      console.log(`changelog: [${version}] - ${date} written, ${fragments.length} fragment(s) removed. Review, then commit CHANGELOG.md and changelog.d/.`)
    } else fail('usage: changelog.mjs check | preview | release <version> [--date YYYY-MM-DD] [--dry-run]')
  } catch (error) { fail(error.message) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
