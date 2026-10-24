#!/usr/bin/env node
// Commit-reviewed writer and checker for the experience library.
// Adding a lesson writes one JSON file under this directory. It does not edit
// harness tiers. Review the file in the pull request that adds it.
//
//   node core/dev/experience/check.mjs [--root dir]
//   node core/dev/experience/check.mjs [--root dir] add --id <id> --date YYYY-MM-DD \
//     --trigger <text> --wrong <text> --right <text> [--repo owner/name] [--tech-stack id]
//     [--seen N] [--ref #N]
//
// --repo alone writes repos/<owner>/<name>/<id>.json.
// --tech-stack alone writes stacks/<id>/<id>.json with repo null.
// Both write a repo entry tagged with that stack.
// Passing neither --repo nor --tech-stack is an error.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { checkExperience, DEFAULT_EXPERIENCE_ROOT, prepareExperienceEntry } from '../../src/host/experience.js'

const argv = process.argv.slice(2)
const positional = []
const flags = new Map()
const refs = []

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const key = arg.slice(2)
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`missing value for --${key}`)
    process.exit(2)
  }
  index += 1
  if (key === 'ref') refs.push(value)
  else if (flags.has(key)) {
    console.error(`duplicate --${key}`)
    process.exit(2)
  } else flags.set(key, value)
}

const root = flags.get('root') ?? DEFAULT_EXPERIENCE_ROOT
const command = positional[0] ?? 'check'
if (positional.length > 1 || (command !== 'check' && command !== 'add')) {
  console.error('usage: check.mjs [--root dir] [add --id ... --date ... --trigger ... --wrong ... --right ...]')
  process.exit(2)
}

if (command === 'check') {
  const report = checkExperience(root)
  if (!report.ok) {
    for (const line of report.failures) console.error(line)
    process.exit(1)
  }
  console.log(`ok ${root}`)
  process.exit(0)
}

try {
  const stack = flags.get('tech-stack')
  const fields = {
    id: flags.get('id'),
    repo: flags.has('repo') ? flags.get('repo') : null,
    techStacks: stack === undefined ? [] : [stack],
    date: flags.get('date'),
    trigger: flags.get('trigger'),
    wrong: flags.get('wrong'),
    right: flags.get('right'),
  }
  if (flags.has('seen')) {
    if (!/^[1-9]\d*$/.test(flags.get('seen'))) throw new Error('seen')
    fields.seen = Number(flags.get('seen'))
  }
  if (refs.length > 0) fields.refs = refs
  const planned = prepareExperienceEntry(fields)
  const base = resolve(root)
  const file = resolve(base, planned.relativePath)
  if (file !== base && !file.startsWith(base + sep)) throw new Error('experience path escapes root')
  if (existsSync(file)) {
    console.error(`exists ${file}`)
    process.exit(1)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, planned.body, { flag: 'wx' })
  console.log(file)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
