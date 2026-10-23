// test.yml: the shape that a merge queue and the required `tests-ok` check rely on (text checks; no YAML parser needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../workflows/test.yml', import.meta.url), 'utf8')
const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\nconcurrency:'))
const job = name => {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `no job ${name}`)
  const next = text.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
  return text.slice(start, next < 0 ? undefined : start + 1 + next)
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
  assert.doesNotMatch(text, /github\.event\.pull_request/)
  assert.doesNotMatch(text, /event_name\s*[!=]=\s*'pull_request'/)
  for (const name of ['test', 'plugins', 'package']) assert.doesNotMatch(job(name), /^\s+if:/m, `${name} must run for every event`)
})

test('tests-ok: always runs and is green only when test, plugins and package are', () => {
  const ok = job('tests-ok')
  assert.match(ok, /^ {4}name: tests-ok$/m)
  assert.match(ok, /^ {4}if: always\(\)$/m)
  assert.match(ok, /needs: \[test, plugins, package\]/)
  assert.match(ok, /\[ "\$TEST" = success \] && \[ "\$PLUGINS" = success \] && \[ "\$PACKAGE" = success \]/)
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
  for (const line of block.split('\n')) {
    const indent = line.search(/\S/)
    if (scalar >= 0) {
      if (line.trim() === '' || indent > scalar) { kept.push(line); continue }
      scalar = -1
    }
    if (/^\s*[\w.-]+:\s*[|>][-+]?\s*$/.test(line)) { scalar = indent; kept.push(line); continue }
    if (line.trim().startsWith('#')) continue
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
