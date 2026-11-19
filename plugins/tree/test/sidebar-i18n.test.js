// #3114 cut 19: the Bot tree's sidebar always draws the Archived Bots group, each row's status
// tag, and the reorganization notice — all English in a zh window while the rest of the sidebar
// followed the window's language. `plugins/tree/client.js` now routes that copy through its own
// `tr()`; this pins both windows and the eleven baseline pins the draws leave behind. The copy is
// read out of the rendered tree, not the source: a string that reaches the section through the
// dictionary and a string merely spelled like the translation look the same in a diff and differ
// here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DICTIONARY } from '../../../core/src/client/i18n.js'
import { reactStub, renderToString } from './render.js'

const zh = DICTIONARY.zh

// The language a window runs in: `t` answers with the Chinese dictionary for a key it carries and echoes anything else.
const translator = (text, params) => {
  const translated = Object.hasOwn(zh, text) ? zh[text] : String(text)
  return params ? translated.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : translated
}
const zhWindow = { t: translator }
const bareWindow = {}

// The client is a classic script that registers its factory on `window`, and `tr()` reads
// `__flybot__` off the global object at render time — so the sandbox is that global object.
function loadClient(flybot) {
  let mod
  const sandbox = { window: { __ModuleLoader__: { load: entry => { mod = entry.factory(() => reactStub) } } }, console, __flybot__: flybot }
  sandbox.globalThis = sandbox
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  return mod
}

// One archived Bot per reason a row's tag draws — merged into another, archived, retired, idle, and one that fits no role group.
const merged = { id: 'merged', name: 'Old Dev', fields: { 'flybot-tree': { archived: { reason: 'merged', intoName: 'Editor' } } } }
const archived = { id: 'arch', name: 'Old Writer', fields: { 'flybot-tree': { archived: { reason: 'idle' } } } }
const retired = { id: 'ret', name: 'Retired Bot', fields: { 'flybot-tree': { retired: true } } }
const idle = { id: 'idle', name: 'Quiet One', fields: { 'flybot-tree': { idle: 1 } } }
const loose = { id: 'loose', name: 'Loose One', fields: { 'flybot-tree': {} } }

const archivedHtml = (app, expanded = true) =>
  renderToString(app.ArchivedView({ bots: [...app.archivedOf([merged, archived, retired]), idle, loose], expanded }))

// The notice after a reorganization: eight lines with `NOTICE_LINES = 6`, so the card adds the "and 2 more" line.
const run = { id: 'r1', at: Date.UTC(2026, 10, 19, 8, 0), summary: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }
const undoneRun = { ...run, undone: { kept: ['Chief', 'Editor'] } }
const noticeHtml = (app, notice = run) => renderToString(app.ReorgCard({ run: notice }))

// What this cut translates: the twelve keys its draws need (Dismiss, Copy invite link and Bot tree already have an entry).
const KEYS = [
  'Archived bots', 'Archived ({count})', 'Tree reorganized', 'Tree reorganization undone',
  'and {count} more', 'Kept: {names}', 'archived · merged into {name}', 'archived', 'retired',
  'idle', 'outside the tree', 'Undo',
]

// The eleven pins these draws leave behind, one per draw position: the three baselines and the key each entry holds.
const PINS = [
  ['i18n-plugins', 'Dismiss'], ['i18n-template-draws', 'Archived ({})'],
  ['i18n-template-draws', 'Kept: {}'], ['i18n-template-draws', 'and {} more'],
  ['i18n-missing-entries', 'Archived bots'], ['i18n-missing-entries', 'Tree reorganized#1'],
  ['i18n-missing-entries', 'Tree reorganized#2'], ['i18n-missing-entries', 'Tree reorganization undone'],
  ['i18n-missing-entries', 'Undo'], ['i18n-missing-entries', 'archived · merged into {}'],
  ['i18n-missing-entries', 'outside the tree'],
]
const baseline = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}.baseline.json`, import.meta.url), 'utf8')).entries

test('#3114: a zh window reads the Archived bots group in Chinese', () => {
  const html = archivedHtml(loadClient(zhWindow))
  assert.match(html, /aria-label="已归档的 Bot"/, `the section still reads: ${html.slice(0, 140)}`)
  assert.match(html, /class="flybot-tree-title">已归档（5）</, `the count still reads: ${html.slice(0, 200)}`)
  assert.match(html, /class="flybot-tree-role">已归档 · 并入 Editor</, 'a merged Bot names the Bot it merged into')
  for (const tag of ['已归档', '已退役', '空闲', '不在树中']) assert.match(html, new RegExp(`class="flybot-tree-role">${tag}<`), `the ${tag} tag`)
  assert.doesNotMatch(html, /Archived bots|Archived \(|archived · merged|retired|outside the tree/, 'no English tag is left in a zh window')
})

test('#3114: a zh window reads the reorganization notice in Chinese', () => {
  const app = loadClient(zhWindow)
  const html = noticeHtml(app)
  assert.match(html, /aria-label="Bot 树已重组"/, `the notice still reads: ${html.slice(0, 160)}`)
  assert.match(html, /class="flybot-reorg-title">Bot 树已重组</)
  assert.match(html, />还有 2 条</, 'the overflow line counts in Chinese')
  assert.match(html, />撤销</)
  assert.match(html, />关闭</)
  const undone = noticeHtml(app, undoneRun)
  assert.match(undone, /class="flybot-reorg-title">已撤销 Bot 树重组</)
  assert.match(undone, />保留：Chief; Editor</, 'the kept names follow the window too')
  assert.doesNotMatch(undone, />撤销<|Tree reorganization undone/, 'an undone notice offers no Undo, in either language')
})

test('#3114: the tree sidebar keeps no English draw and no translator keeps today\'s English', () => {
  assert.deepEqual(KEYS.filter(key => !Object.hasOwn(zh, key)), [], 'every entry has a Chinese value')

  const app = loadClient(bareWindow)
  const html = archivedHtml(app)
  assert.match(html, /aria-label="Archived bots"/)
  assert.match(html, /class="flybot-tree-title">Archived \(5\)</)
  assert.match(html, /class="flybot-tree-role">archived · merged into Editor</)
  assert.match(html, /class="flybot-tree-role">outside the tree</)
  const notice = noticeHtml(app)

  for (const word of ['Tree reorganized', 'and 2 more', 'Undo', 'Dismiss']) assert.match(notice, new RegExp(`>${word}<`), `the ${word} draw`)

  const pinned = PINS.filter(([file, key]) => baseline(file).includes(`plugins/tree/client.js:${key}`))
  assert.deepEqual(pinned, [], 'no baseline still pins a draw this cut translated')
})
