// test.yml: the shape that a merge queue and the required `tests-ok` check rely on (text checks; no YAML parser needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const text = readFileSync(new URL('../workflows/test.yml', import.meta.url), 'utf8')
const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\nconcurrency:'))
// One step of the `test` job, by the name it reports (#2054, #2099).
const step = name => {
  const at = text.indexOf(`      - name: ${name}\n`)
  assert.ok(at >= 0, `no step ${name}`)
  const next = text.slice(at + 1).search(/\n      - /)
  return text.slice(at, next < 0 ? undefined : at + 1 + next)
}
const job = name => {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `no job ${name}`)
  const next = text.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
  return text.slice(start, next < 0 ? undefined : start + 1 + next)
}

// #2124: a required context is a job id or a job name, never a step, so the signature has to be a
// job. These two read a workflow's job graph the way GitHub does: the ids at two-space indent, and
// the `needs:` of one job from either the flow form or the block form.
const jobIds = (source = text) => [...source.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1])
const needsOf = (source, name) => {
  const at = source.indexOf(`\n  ${name}:\n`)
  assert.ok(at >= 0, `no job ${name}`)
  const end = source.slice(at + 1).search(/\n {2}[a-z][\w-]*:\n/)
  const block = source.slice(at, end < 0 ? undefined : at + 1 + end)
  const flow = /^ {4}needs: \[([^\]]*)\]$/m.exec(block)
  if (flow) return flow[1].split(',').map((value) => value.trim())
  const one = /^ {4}needs: ([a-z][\w-]*)$/m.exec(block)
  if (one) return [one[1]]
  const list = /^ {4}needs:\n((?: {6}- \S+\n?)+)/m.exec(block)
  return list ? [...list[1].matchAll(/- (\S+)/g)].map((m) => m[1]) : []
}

test('triggers: pull_request, merge_group (no filters), push only on main, dispatch', () => {
  assert.match(triggers, /^ {2}pull_request:\s*$/m)
  assert.match(triggers, /^ {2}merge_group:\s*$/m, 'a merge queue needs merge_group or required checks never report on queue entries')
  assert.match(triggers, /^ {2}workflow_dispatch:\s*$/m)
  assert.match(triggers, /^ {2}push:\n {4}branches: \[main\]$/m, 'push stays on main so gh-readonly-queue/* branches do not run twice')
  const mergeGroup = triggers.slice(triggers.search(/^ {2}merge_group:/m)).split('\n').slice(1).filter(l => l.trim() && !l.trim().startsWith('#'))
  assert.ok(!/^ {4}(paths|paths-ignore|branches)/.test(mergeGroup[0] ?? ''), 'merge_group takes no path or branch filters')
  assert.match(triggers, /paths-ignore: \['docs\/\*\*', '\*\*\/\*\.md'\]/, 'paths-ignore is on push only')
  assert.ok(triggers.indexOf('paths-ignore') < triggers.indexOf('pull_request:'), 'paths-ignore must stay under push, not pull_request or merge_group')
})

test('no job is skipped on merge_group: nothing keys on the pull_request event', () => {
  // #2099 narrowed this: the base checkout reads `github.event.pull_request.base.sha` as a `with:`
  // input, which skips nothing. What the rule forbids is a position that can skip a job — a
  // job-level `if:`, or any condition keyed on the event — so the reverse assertion below pins the
  // event to the one line it may be read on: the `ref:` of the base checkout.
  assert.doesNotMatch(text, /event_name\s*[!=]=\s*'pull_request'/)
  assert.doesNotMatch(text, /^\s+if:.*github\.event\.pull_request/m, 'a condition on the pull_request event would skip a queue entry')
  for (const name of ['test', 'plugins', 'package']) assert.doesNotMatch(job(name), /^\s+if:/m, `${name} must run for every event`)
  const reads = text.split('\n').filter(line => line.includes('github.event.pull_request'))
  assert.equal(reads.length, 1, 'only the base checkout reads the pull_request event')
  assert.match(reads[0], /^\s+ref: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}$/)
})

// #2099: `test.yml` ran the copy of the checker that the pull request itself carries, so a pull
// request could weaken `judge()` — or delete the step — and pass the check it had just edited. The
// signature is now judged by the copy in the base commit, the shape `merge-gate.yml` already uses.
test('#2099: the gate signature runs the checker from the base commit', () => {
  const signature = step('Gate change signature')
  assert.match(signature, /^\s+run: node base\/\.github\/scripts\/policy-sign\.mjs$/m, "the step runs the base copy, not the pull request's own")

  const at = text.indexOf('          path: base\n')
  assert.ok(at >= 0, 'test.yml checks the base commit out into `base/`')
  const start = text.lastIndexOf('\n      - ', at) + 1
  const base = text.slice(start, text.indexOf('\n      - ', at))
  assert.match(base, /uses: actions\/checkout@3d3c42e5/, 'the same pinned checkout the rest of the file uses')
  assert.match(base, /^ {8}with:\n {10}ref: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}$/m, 'the read is a `with:` input — an input cannot skip a job — and a queue run carries no pull_request, so merge_group.base_sha is required')
  assert.match(base, /persist-credentials: false/)
})

test('#2099: a pull request that weakens its own copy of the checker is still refused', () => {
  const command = /^\s+run: (.+)$/m.exec(step('Gate change signature'))?.[1] ?? ''
  const [program, script] = command.split(/\s+/)
  assert.equal(program, 'node', 'the signature step runs node')
  const dir = mkdtempSync(join(tmpdir(), 'policy-sign-'))
  // The pull request's own copy says "ok, carry on"; the base copy refuses. Which copy the step
  // runs is the whole difference, so the fixture makes the two answer differently.
  for (const [path, body] of [['.github/scripts/policy-sign.mjs', 'process.exit(0)\n'], ['base/.github/scripts/policy-sign.mjs', 'process.exit(1)\n']]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  const run = spawnSync(program, [script], { cwd: dir, encoding: 'utf8' })
  assert.notEqual(run.status, 0, `the step ran \`${script}\`: a pull request that weakened its own copy must still be refused`)
})

// #2124: the required contexts are job names, so a step that is deleted leaves its job green and
// nothing notices. The signature is a job of its own, named `policy-sign`, and `test` needs it: a
// pull request that deletes the job leaves a required context unreported instead of passing.
test('#2124: the signature is its own job, named for the required context', () => {
  const signature = job('policy-sign')
  assert.match(signature, /^ {4}name: policy-sign$/m, 'the check name is the job name a required-context list can name')
  assert.match(signature, /^\s+run: node base\/\.github\/scripts\/policy-sign\.mjs$/m, 'the job runs the base copy, not the pull request\'s own')
  assert.match(signature, /^ {10}ref: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}$/m)
  assert.match(signature, /^ {10}path: base$/m)
  assert.match(signature, /^ {10}persist-credentials: false$/m)

  const runner = job('test')
  assert.deepEqual(needsOf(text, 'test'), ['policy-sign'], 'the suite waits for the signature, so an unsigned change spends no suite time')
  assert.ok(!runner.includes('Gate change signature'), 'the signature is not a step of `test`: a step carries no context of its own')
  assert.ok(!runner.includes('path: base'), 'the base checkout belongs to the signature job, not to the suite')
  for (const name of ['test', 'plugins', 'package']) assert.ok(jobIds().includes(name), `${name} still exists`)

  const ok = job('tests-ok')
  assert.match(ok, /needs: \[policy-sign, test, plugins, package\]/, 'the required context also names the signature, so a failure is red there too')
  assert.match(ok, /\[ "\$SIGN" = success \]/)
})

// The defect (#2124): delete the job and the context is missing, not green. The same edit that used
// to leave `test` reporting success now leaves `test` unable to run at all.
test('#2124: deleting the signature job leaves the required context unreported, not green', () => {
  const ids = jobIds()
  for (const id of ids) for (const need of needsOf(text, id)) assert.ok(ids.includes(need), `${id} needs ${need}, which exists`)
  assert.ok(needsOf(text, 'tests-ok').includes('policy-sign'))
  assert.ok(needsOf(text, 'test').includes('policy-sign'))

  const block = job('policy-sign')
  const without = text.replace(block, '').replace(/\njobs:\n/, '\njobs:\n')
  const left = jobIds(without)
  assert.ok(!left.includes('policy-sign'), 'the job is gone from the doctored workflow')
  const dangling = [...needsOf(without, 'test'), ...needsOf(without, 'tests-ok')].filter((need) => !left.includes(need))
  assert.deepEqual([...new Set(dangling)].sort(), ['policy-sign'], 'both the suite and the required context now name a job that no longer exists — the check cannot report success without it')
})

test('tests-ok: always runs and is green only when policy-sign, test, plugins and package are', () => {
  const ok = job('tests-ok')
  assert.match(ok, /^ {4}name: tests-ok$/m)
  assert.match(ok, /^ {4}if: always\(\)$/m)
  assert.match(ok, /needs: \[policy-sign, test, plugins, package\]/)
  assert.match(ok, /\[ "\$SIGN" = success \] && \[ "\$TEST" = success \] && \[ "\$PLUGINS" = success \] && \[ "\$PACKAGE" = success \]/)
})

test('main keeps its run (no cancel), every other ref, queue branches included, cancels', () => {
  assert.match(text, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/)
  assert.match(text, /group: test-\$\{\{ github\.ref \}\}/)
})

// live-e2e.yml (#811, #813): the gates that make a keyless run touch nothing. The preflight
// decides and publishes `key=true|false`; the steps that read the secret and the six steps that
// need it are gated on that output. The hole this closes is real: on #30, deleting one `if:`
// changed what a keyless run does and every test still passed, because nothing read this file.
const live = readFileSync(new URL('../workflows/live-e2e.yml', import.meta.url), 'utf8')

// A secret reaches a step through its own `env:` mapping, a `with:` input, or any other expression
// position (`run:`, `if:`, the flow form of `env:`). All three are an interpolation inside the
// step's block, so one `${{ … secrets. … }}` scan covers every carrier — and the interpolation is
// what matters, not the word: a step that only names the secret in a comment never receives it
// (#813's no-false-positive rule, and the reverse of the old bare `/secrets\./`).
// `\bsecrets\b` rather than `secrets\.`, so `${{ secrets['DEEPSEEK_API_KEY'] }}` is a carrier too:
// the bracket form names no dot and the old pattern would have missed it the same way. The
// expression may hold one `}` of its own — `${{ format('{0}', secrets.X) }}` — so the scan crosses
// a single `}` and stops only at the closing `}}` (#813 review, INC at 823cff45).
const SECRET = /\$\{\{(?:(?!\}\})[\s\S])*?\bsecrets\b/

// A trailing `#` comment is YAML syntax: it is dropped before interpolation, so it is not a carrier.
// Where a comment starts depends on the kind of the scalar, not on quotes that merely appear inside
// it (#834): in a plain scalar ` #` opens a comment whatever the quotes around it are, a quoted
// scalar keeps its `#` as text (a backslash escapes the closing quote in `"…"`, and `''` is a
// quote in `'…'`), and a flow collection has the same quoted rules inside its braces.
const scalarStart = line => {
  const mapping = /^(\s*(?:-\s+)?)(?:"[^"]*"|'[^']*'|[^\s#][^:]*?):(?=\s|$)/.exec(line)
  if (mapping) return mapping[0].length
  const item = /^\s*-\s+(?=\S)/.exec(line)
  return item ? item[0].length : -1
}

// The index of the `#` that starts a comment, or -1. `quotes` says whether the context reads quote
// characters at all: a plain scalar does not, so `echo "tag # x"` ends at that `#`.
const commentStart = (text, quotes) => {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") { i += 1; continue }
        quote = ''
      }
      continue
    }
    if (quotes && (ch === '"' || ch === "'")) { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return i
  }
  return -1
}

// The closing quote of a scalar that starts with one, or -1 while it is still open.
const closingQuote = text => {
  const quote = text[0]
  for (let i = 1; i < text.length; i += 1) {
    if (quote === '"' && text[i] === '\\') { i += 1; continue }
    if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") { i += 1; continue }
      return i
    }
  }
  return -1
}

// A quoted scalar may continue onto the next line (`run: "echo hi` with the closing quote on a later
// line). A `#` on a continuation line is text, not a comment, so the strip has to know the scalar is
// still open: `openQuoteClose` returns the index of the closing quote on this line, or -1 (#850).
const openQuoteClose = (line, quote) => {
  for (let i = 0; i < line.length; i += 1) {
    if (quote === '"' && line[i] === '\\') { i += 1; continue }
    if (line[i] === quote) {
      if (quote === "'" && line[i + 1] === "'") { i += 1; continue }
      return i
    }
  }
  return -1
}

const withoutTrailingComment = line => {
  const start = scalarStart(line)
  if (start < 0) return line
  const value = line.slice(start)
  const lead = value.length - value.replace(/^\s+/, '').length
  const text = value.slice(lead)
  if (!text) return line
  if (text[0] === '|' || text[0] === '>') return line
  let cut = -1
  if (text[0] === '"' || text[0] === "'") {
    const close = closingQuote(text)
    if (close < 0) return line
    const after = commentStart(text.slice(close + 1), false)
    if (after >= 0) cut = lead + close + 1 + after
  } else if (text[0] === '{' || text[0] === '[') {
    const at = commentStart(text, true)
    if (at >= 0) cut = lead + at
  } else {
    // A plain scalar: a quote character in it is just a character, so a ` #` always starts the comment.
    const at = commentStart(text, false)
    if (at >= 0) cut = lead + at
  }
  if (cut < 0) return line
  return line.slice(0, start + cut).trimEnd()
}

// Inside a `run: |` or a `with:` block scalar, a `#` line is literal text that GitHub interpolates
// before the shell or the action reads it, so the comment strip stops at the scalar: a
// `# … ${{ secrets.X }}` inside a script is still a carrier and still has to be gated.
export const withoutYamlComments = block => {
  const kept = []
  let scalar = -1
  let quote = '' // a quoted scalar that did not close on its own line (#850)
  for (const line of block.split('\n')) {
    if (quote) {
      const close = openQuoteClose(line, quote)
      if (close < 0) { kept.push(line); continue }
      const after = commentStart(line.slice(close + 1), false)
      kept.push(after < 0 ? line : line.slice(0, close + 1 + after).trimEnd())
      quote = ''
      continue
    }
    const indent = line.search(/\S/)
    if (scalar >= 0) {
      if (line.trim() === '' || indent > scalar) { kept.push(line); continue }
      scalar = -1
    }
    if (/^\s*[\w.-]+:\s*[|>](?:[1-9][-+]?|[-+]?[1-9]?)?(?:\s+#.*)?\s*$/.test(line)) { scalar = indent; kept.push(line); continue }
    if (line.trim().startsWith('#')) continue
    const start = scalarStart(line)
    if (start >= 0) {
      const text = line.slice(start).replace(/^\s+/, '')
      if ((text[0] === '"' || text[0] === "'") && closingQuote(text) < 0) { quote = text[0]; kept.push(line); continue }
    }
    kept.push(withoutTrailingComment(line))
  }
  return kept.join('\n')
}

export const mapsSecret = block => SECRET.test(withoutYamlComments(block))

// An `env:` one level up (0 = workflow, 4 = job) hands the secret to every step below it, and the
// step split cannot see that: each step would look like a non-carrier while reading the key, so a
// missing gate would have nothing to point at. Refusing is the only safe answer. Both spellings
// count — the block form and the flow form on the `env:` line itself.
export const inheritsSecret = (text, indent) => {
  const lines = text.split('\n')
  const owner = new RegExp(`^ {${indent}}env:(.*)$`)
  for (let i = 0; i < lines.length; i++) {
    const match = owner.exec(lines[i])
    if (!match) continue
    if (mapsSecret(match[1])) return true
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && !lines[j].startsWith(' '.repeat(indent + 2))) break
      body.push(lines[j])
    }
    if (mapsSecret(body.join('\n'))) return true
  }
  return false
}

export const stepsOf = text => text
  .split(/^ {6}- /m)
  .slice(1)
  .map(block => ({
    block,
    name: (/^name: (.+)$/m.exec(block)?.[1] ?? '(no name)').trim(),
    id: (/^ {8}id: (.+)$/m.exec(block)?.[1] ?? '').trim(),
    gate: (/^ {8}if: (.+)$/m.exec(block)?.[1] ?? '').trim(),
    // Any carrier in the step's own block — `env:`, `with:` or an inline expression.
    mapsSecret: mapsSecret(block),
  }))
const liveSteps = stepsOf(live)
const KEYED = [
  'npm ci (core)',
  'Install the pinned DSH runtime',
  'Clone DeepSeek Harness at the pinned tag',
  'Start the usage tap',
  'Start the real-model bench',
  'Run the four checks',
]

test('#811: a step that maps a secret is gated on the preflight, and the preflight is gated on nothing', () => {
  const preflight = liveSteps.filter(step => step.id === 'preflight')
  assert.equal(preflight.length, 1, 'exactly one step decides, and it is found by id: preflight')
  assert.equal(preflight[0].gate, '', 'the deciding step cannot be gated on its own output')
  assert.ok(preflight[0].mapsSecret, 'the deciding step has to read the key, or nothing is decided')
  for (const step of liveSteps) {
    if (step.mapsSecret && step.id !== 'preflight') {
      assert.ok(step.gate, `"${step.name}" maps a secret without an if:; a keyless run would execute it`)
      assert.match(step.gate, /steps\.preflight\.outputs\.key/, `"${step.name}" must be gated on steps.preflight.outputs.key`)
    }
  }
})

test('#811: the seven steps that need the key carry the same gate', () => {
  for (const name of [...KEYED, 'Stop the bench and the tap']) {
    const step = liveSteps.find(s => s.name === name)
    assert.ok(step, `no step named "${name}"`)
    assert.match(step.gate, /steps\.preflight\.outputs\.key == 'true'/, `"${name}" lost its gate`)
  }
  const cleanup = liveSteps.find(s => s.name === 'Stop the bench and the tap')
  assert.match(cleanup.gate, /^always\(\) &&/, 'the cleanup runs only after a keyed run started')
  assert.equal(KEYED.length, 6, 'six steps need the key; a seventh would not be covered here')
})

// #813: the old carrier test asked one question ("is there an `env:` block at eight spaces?") and
// answered a different one ("does the word `secrets.` appear anywhere?"), so a `with:` carrier and
// an inline `run:` carrier were both invisible and an ungated step of either shape passed.
test('#813: mapsSecret sees every carrier, and a comment naming the secret is not one', () => {
  const step = body => `name: probe\n${body}`
  const carriers = {
    'step-level env:': '        env:\n          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}\n',
    'with: input': '        with:\n          api-key: ${{ secrets.DEEPSEEK_API_KEY }}\n',
    'inline run:': '        run: node check.mjs --key "${{ secrets.DEEPSEEK_API_KEY }}"\n',
    'flow-style env:': '        env: { DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }} }\n',
    'bracket form in a with: input': '        with:\n          api-key: ${{ secrets[\'DEEPSEEK_API_KEY\'] }}\n',
    // The expression opens a brace of its own before naming the secret (#813 review).
    'format() with a brace before the secret': '        with:\n          api-key: ${{ format(\'{0}\', secrets.DEEPSEEK_API_KEY) }}\n',
    'join() in an inline run:': '        run: node check.mjs --key "${{ join(secrets.DEEPSEEK_API_KEY, \',\') }}"\n',
    // Interpolated before the shell reads the line, so a comment inside a script is a carrier too.
    'comment inside a run: block': '        run: |\n          # the key arrives here\n          echo "${{ secrets.DEEPSEEK_API_KEY }}"\n',
    // A quoted scalar keeps its `#`: the backslash escapes the closing quote, so the expression is
    // inside the value Actions interpolates (#834, the false green this test used to pin as green).
    'an escaped quote before # in a double-quoted run:': '        run: "echo \\"x # ${{ secrets.DEEPSEEK_API_KEY }}\\""\n',
    'an escaped quote before # in a double-quoted env: value': '        env:\n          DEEPSEEK_API_KEY: "a\\"b # ${{ secrets.DEEPSEEK_API_KEY }}"\n',
    // The flow form of `env:` has the same quoting rules inside its braces.
    'an escaped quote before # in a flow env: value': '        env: { DEEPSEEK_API_KEY: "a\\"b # ${{ secrets.DEEPSEEK_API_KEY }}" }\n',
    // A single-quoted scalar keeps its `#` as well, and `''` is a quote inside it.
    'a quoted # inside a single-quoted scalar': "        run: 'echo ''quoted'' # ${{ secrets.DEEPSEEK_API_KEY }}'\n",
  }
  for (const [label, body] of Object.entries(carriers)) {
    assert.equal(mapsSecret(step(body)), true, `${label} carries the secret and must be detected`)
  }
  const nonCarriers = {
    'a YAML comment naming the secret': '        run: node check.mjs\n        # this step never reads ${{ secrets.DEEPSEEK_API_KEY }}\n',
    // The negative control of the escaped-quote pair: the scalar closes before the `#`, so the
    // expression is a comment and never reaches the shell (#834).
    'a value closed before a # comment': '        run: "echo hi" # ${{ secrets.DEEPSEEK_API_KEY }}\n',
    // And the plain scalar the old fixture pinned the other way round: inside a plain scalar the
    // quote characters are text, so ` #` opens the comment whatever precedes it (#834).
    'a plain scalar where # opens the comment': '        run: echo "tag # ${{ secrets.DEEPSEEK_API_KEY }}"\n',
    'a plain scalar whose comment follows a single quote': "        run: echo 'tag # ${{ secrets.DEEPSEEK_API_KEY }}'\n",
    'a trailing YAML comment on the run: line': '        run: echo hi  # ${{ secrets.DEEPSEEK_API_KEY }}\n',
    'a trailing YAML comment on a with: value': '        with:\n          name: evidence  # not ${{ secrets.DEEPSEEK_API_KEY }}\n',
    'a with: input that is not a secret': '        with:\n          node-version: 24\n          cache: npm\n',
    'prose mentioning secrets.': '        name: the secrets. are set by the repository\n',
  }
  for (const [label, body] of Object.entries(nonCarriers)) {
    assert.equal(mapsSecret(step(body)), false, `${label} is not a carrier and cannot demand a gate`)
  }
})

// #834: the two shapes the issue measured on a YAML parser. A step is a carrier when the value
// Actions interpolates holds the expression, not when a hand-scanned line happens to keep it.
test('#834: a plain scalar keeps nothing of a # comment, and an escaped quote keeps the expression', () => {
  // Appended the way the issue reproduced it: one step at the end of the real workflow, no gate.
  const withProbe = body => stepsOf(`${live}\n      - name: probe\n${body}`)
  const probe = body => withProbe(body).find(step => step.name === 'probe')
  const carriers = body => withProbe(body).filter(step => step.mapsSecret).map(step => step.name)

  // Case 1: `run:` is a plain scalar, so ` #` opens a comment whatever quotes precede it and the
  // expression never reaches the shell. It must stay out of the carrier list (the old scanner put it
  // in, and the two #811 tests then failed on a step that reads nothing).
  const plain = probe('        run: echo "tag # ${{ secrets.DEEPSEEK_API_KEY }}"\n')
  assert.equal(plain.mapsSecret, false, 'a plain scalar whose # opens a comment is not a carrier')
  assert.equal(
    carriers('        run: echo "tag # ${{ secrets.DEEPSEEK_API_KEY }}"\n').length,
    liveSteps.filter(step => step.mapsSecret).length,
    'the plain-scalar probe adds no carrier to the ones the workflow really has',
  )

  // Case 2: the scalar is double-quoted, so `\"` is an escaped quote, the `#` is text, and an
  // ungated step really does hold the key. It must be a carrier, and the #811 rule must catch it.
  const escaped = probe('        run: "echo \\"x # ${{ secrets.DEEPSEEK_API_KEY }}\\""\n')
  assert.equal(escaped.mapsSecret, true, 'an escaped quote leaves the expression inside the value')
  assert.equal(escaped.gate, '', 'the probe carries no gate, so the #811 rule has something to catch')

  // The `env:` spelling of the same shape: the matcher #830 replaced caught it, this one must too.
  const env = probe('        env:\n          DEEPSEEK_API_KEY: "a\\"b # ${{ secrets.DEEPSEEK_API_KEY }}"\n')
  assert.equal(env.mapsSecret, true, 'an escaped quote in an env: value is still a carrier')
  assert.ok(carriers('        env:\n          DEEPSEEK_API_KEY: "a\\"b # ${{ secrets.DEEPSEEK_API_KEY }}"\n').includes('probe'))

  // The negative control of case 2: the same quoting, but closed before the `#`, is a comment.
  const closed = probe('        run: "echo hi" # ${{ secrets.DEEPSEEK_API_KEY }}\n')
  assert.equal(closed.mapsSecret, false, 'a comment after a closed scalar is not a carrier')
})

// #850: a block scalar's header may carry an indentation indicator or a trailing comment, and a quoted
// scalar may close on a later line. In both, the body line's ` # ` is text that Actions interpolates, so
// the step holds the key and has to be gated. One test per shape, plus the control that keeps a `|2`
// without an expression out of the carrier list.
const probeStep = body => stepsOf(`${live}\n      - name: probe\n${body}`).find(step => step.name === 'probe')

test('#850: a block scalar with an indentation indicator (|2) is a carrier', () => {
  const step = probeStep('        run: |2\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n')
  assert.equal(step.mapsSecret, true, 'the body line is inside the |2 value, so it is a carrier')
  assert.equal(step.gate, '', 'the probe carries no gate, so the #811 rule has something to catch')
})

test('#850: a block scalar whose header carries a trailing comment is a carrier', () => {
  const step = probeStep('        run: | # note\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n')
  assert.equal(step.mapsSecret, true, 'the ` # note` ends the header, not the scalar, so the body is a carrier')
  assert.equal(step.gate, '', 'the probe carries no gate, so the #811 rule has something to catch')
})

test('#850: a folded block scalar with an indentation indicator (>2) is a carrier', () => {
  const step = probeStep('        run: >2\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n')
  assert.equal(step.mapsSecret, true, 'the body line is inside the >2 value, so it is a carrier')
  assert.equal(step.gate, '', 'the probe carries no gate, so the #811 rule has something to catch')
})

test('#850: a double-quoted scalar that closes on a later line is a carrier', () => {
  const step = probeStep('        run: "echo hi\n          # ${{ secrets.DEEPSEEK_API_KEY }}"\n')
  assert.equal(step.mapsSecret, true, 'the quote is still open on the # line, so the # is text, not a comment')
  assert.equal(step.gate, '', 'the probe carries no gate, so the #811 rule has something to catch')
})

test('#850: a block scalar with no expression stays out of the carrier list', () => {
  // The control: `|2` must not become a carrier by itself, or the four cases above would pass for the
  // wrong reason and every block scalar would demand a gate.
  const step = probeStep('        run: |2\n          # plain comment\n')
  assert.equal(step.mapsSecret, false, 'a |2 whose body names no expression is not a carrier')
})

// #850 round two: YAML lets the chomping indicator and the indentation indicator appear in either
// order, so `|2-` and `|-2` are the same scalar. The header test accepted only chomping-first, and the
// body's `#` line was dropped for every `|2-` shape.
const indicatorShapes = {
  'chomping after the indicator (|2-)': '        run: |2-\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n',
  'keep chomping after the indicator (|2+)': '        run: |2+\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n',
  'folded, chomping after the indicator (>2-)': '        run: >2-\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n',
  'chomping after the indicator with a header comment (|2- # note)': '        run: |2- # note\n          # ${{ secrets.DEEPSEEK_API_KEY }}\n',
  'block form under with: (script: |2-)': '        with:\n          script: |2-\n            # ${{ secrets.DEEPSEEK_API_KEY }}\n',
}

for (const [label, body] of Object.entries(indicatorShapes)) {
  test(`#850: a block scalar with ${label} is a carrier`, () => {
    const step = probeStep(body)
    assert.equal(step.mapsSecret, true, 'the body line is inside the scalar, so it is a carrier')
    assert.equal(step.gate, '', 'the probe carries no gate, so the #811 rule has something to catch')
  })
}

test('#813: the secret reaches exactly three steps, and the preflight alone stays ungated', () => {
  const carriers = liveSteps.filter(step => step.mapsSecret)
  // The preflight, plus the two steps that hold the key themselves. The other four keyed steps and
  // the cleanup run on the key without ever holding it; the #811 test above gates those by name.
  assert.deepEqual(
    carriers.map(step => step.id || step.name).sort(),
    ['Start the real-model bench', 'preflight', 'run'],
    'the secret must reach exactly these three steps',
  )
  assert.deepEqual(
    carriers.filter(step => !step.gate).map(step => step.id),
    ['preflight'],
    'the deciding step is the one step that must never be gated on itself',
  )
})

test('#813: no workflow- or job-level env: hands the key down where a step gate cannot reach it', () => {
  assert.equal(inheritsSecret(live, 0), false, 'a workflow-level env: would give every step the key and leave nothing to gate')
  assert.equal(inheritsSecret(live, 4), false, 'a job-level env: would give every step the key and leave nothing to gate')
  // The failure direction of the same helper: a silent `false` has to be distinguishable from a check that cannot see the block.
  assert.equal(
    inheritsSecret('  job:\n    env:\n      DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}\n    steps:\n', 4),
    true,
    'a job-level secret is exactly what this has to refuse',
  )
  // The flow form on the `env:` line itself inherits just as widely, and is legal YAML.
  assert.equal(
    inheritsSecret('  job:\n    env: { DEEPSEEK_API_KEY: "${{ secrets.DEEPSEEK_API_KEY }}" }\n    steps:\n', 4),
    true,
    'the flow form must be refused as well, or the whole job reads the key ungated',
  )
  assert.equal(
    inheritsSecret('  job:\n    env: { BENCH: live-e2e }\n    steps:\n', 4),
    false,
    'a flow-form env: without the secret is not an inheritance',
  )
  assert.equal(inheritsSecret('  job:\n    env:\n      BENCH: live-e2e\n    steps:\n', 4), false)
})
