import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const read = name => readFileSync(resolve(root, name), 'utf8')
const docs = ['README.md', 'README.zh.md', 'docs/backend-operations.md', 'docs/development-service-api.md', 'docs/development-service-guide.md']
const names = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1])

test('public API tables enumerate the actual complete command/query contracts', () => {
  const source = read('core/src/host/project-development-service.js')
  const queries = names(source.match(/const queries = new Set\(\[([^\]]+)\]/)[1])
  const operations = [...source.match(/const operations = Object.freeze\(\{([\s\S]*?)\}\)/)[1].matchAll(/'([^']+)':/g)].map(match => match[1])
  const api = read('docs/development-service-api.md')
  const rows = part => [...part.matchAll(/^\| ([a-z][a-z.-]+) \|/gm)].map(match => match[1]).sort()
  const queryText = api.split('## v1查询')[1].split('## v1命令')[0]
  const commandText = api.split('## v1命令')[1].split('## Execution')[0]
  assert.deepEqual(rows(queryText), [...queries].sort())
  assert.deepEqual(rows(commandText), operations.filter(name => !queries.includes(name)).sort())
  assert.equal(queries.length, 24); assert.equal(rows(commandText).length, 26)
  for (const name of ['README.md', 'README.zh.md']) assert.match(read(name), /24查询\/26命令/)
})

test('quickstart JSON, shell syntax and local documentation links stay usable', () => {
  for (const name of docs) {
    const text = read(name)
    for (const match of text.matchAll(/```json\n([\s\S]*?)\n```/g)) assert.doesNotThrow(() => JSON.parse(match[1]), `${name}: invalid JSON`)
    for (const match of text.matchAll(/```bash\n([\s\S]*?)\n```/g)) execFileSync('bash', ['-n'], { input: match[1] })
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^[a-z]+:/i.test(target)) continue
      assert.ok(existsSync(resolve(dirname(resolve(root, name)), decodeURIComponent(target))), `${name}: missing ${target}`)
    }
  }
  for (const name of ['README.md', 'README.zh.md']) {
    const text = read(name)
    assert.doesNotMatch(text, /1811e3b8f|fb_dev\(|fb_api\(|owner@flybot\.example|SuperAgent/)
    assert.match(text, /node scripts\/backend\.mjs init/)
    assert.match(text, /node scripts\/backend\.mjs start/)
    assert.match(text, /README\.native/)
  }
})
