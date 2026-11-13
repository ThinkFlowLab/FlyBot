// The Runs tab's attempt labels: "superseded by …" / "retry of …" are the only words on that
// row that were never asked of tr(), so a zh UI painted them in English beside translated chips
// (#3040). They are read back through the same ZH table the tab already uses, and the raw id stays
// in the tooltip.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const react = { createElement: h, useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: fn => fn() }

function load() {
  const modules = new Map()
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? react : {}))),
    },
  }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/workflow')
}

const client = load()

// The host answers a zh UI the way core's `t` does: it translates the words it knows and hands an
// unknown key back as itself — which is the probe `zhUi()` reads. It knows exactly one word here, so
// the Chinese below can only come from the plugin's own ZH table, the path a zh window really takes
// for these two keys: the core dictionary has no entry for them (the workflow chrome strings are
// P-784, on the bundle lane) and the forward scan pins them in
// core/test/i18n-plugins-missing-zh.baseline.json.
const zhHost = (key) => (key === 'Tasks' ? '任务' : key)

function withHost(t, host) {
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = { t: host }
  t.after(() => { globalThis.__flybot__ = prev })
}

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  for (const child of node.children ?? []) texts(child, out)
  return out
}

const historyRow = (extra) => ({
  id: 'run-new', status: 'failed', at: Date.now() - 60_000,
  task: { id: '#1280', title: 'Ship the notice' },
  ...extra,
})

test('#3040: a Runs row names the attempt it replaced in the reader\'s language, not in English', (t) => {
  withHost(t, zhHost)
  const tree = client.Runs({ workflow: { history: [historyRow({ supersededBy: 'run-old' })] } })
  const line = texts(tree).find(text => text.includes('run-old'))
  assert.ok(line, 'the row still names the other attempt')
  assert.ok(line.startsWith('已被 run-old 取代'), `a zh UI reads the label in Chinese, got ${JSON.stringify(line)}`)
})

test('#3040: the retry row names the attempt it replaced, in the same language', (t) => {
  withHost(t, zhHost)
  const tree = client.Runs({ workflow: { history: [historyRow({ id: 'run-newer', retryOf: 'run-old' })] } })
  const line = texts(tree).find(text => text.includes('run-old'))
  assert.ok(line, 'the retry row still names the attempt it replaced')
  assert.ok(line.startsWith('run-old 的重试'), `a zh UI reads the retry label in Chinese, got ${JSON.stringify(line)}`)
})

test('#3040: an en UI keeps the words it already had, so the fix is only the missing translation', (t) => {
  withHost(t, key => key)
  const tree = client.Runs({ workflow: { history: [historyRow({ supersededBy: 'run-old' })] } })
  const line = texts(tree).find(text => text.includes('run-old'))
  assert.equal(line, 'superseded by run-old')
})

test('#3040: a row that names no other attempt draws no label at all', (t) => {
  withHost(t, zhHost)
  const tree = client.Runs({ workflow: { history: [historyRow({})] } })
  const lines = texts(tree)
  assert.equal(lines.some(text => text.includes('取代') || text.includes('重试')), false)
  assert.equal(client.attemptLink({ supersededBy: 'run-old' }), '已被 run-old 取代')
  assert.equal(client.attemptLink({}), '')
})
