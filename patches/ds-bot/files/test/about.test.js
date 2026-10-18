import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Settings → About FlyBot says what this install is: FlyBot's own repository, the core's version with the branch and
// commit a git install runs, and how it is updated (it is not the upstream DS Bot's page).
const { outputFiles } = await build({
  stdin: {
    contents: "export { AboutPage } from './src/client/about.js'; export { DICTIONARY, installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { AboutPage, DICTIONARY, installLocale } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => { if (node && typeof node === 'object') { if (Array.isArray(node)) node.forEach(child => all(child, out)); else { out.push(node); all(node.props?.children, out) } } return out }
const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))

const Section = ({ title, children }) => h('section', { 'data-title': title }, children)
const Row = ({ label, hint, children }) => h('div', { 'data-row': label, 'data-hint': hint }, children)
const REPO = 'https://github.com/ThinkFlowLab/FlyBot'
const page = (update) => {
  const tree = expand(AboutPage({ useUpdate: () => update, actions: { repoStars: () => new Promise(() => {}) }, run: () => Promise.resolve(), Section, Row }))
  const nodes = all(tree)
  return {
    version: text(nodes.find(node => node.props?.className === 'bt-about-version')),
    star: nodes.find(node => node.props?.className === 'bt-star'),
    row: label => nodes.find(node => node.props?.['data-row'] === label),
    hint: label => nodes.find(node => node.props?.['data-row'] === label)?.props['data-hint'],
    links: nodes.filter(node => node.type === 'a').map(node => node.props.href),
  }
}
const base = { current: '0.1.5-flybot.1', repoUrl: REPO, notesUrl: `${REPO}/releases`, enabled: true, phase: 'idle', source: 'git', checkedAt: 0, dsh: { current: '0.2.0-rc.2', available: false, phase: 'idle' } }
const MAINTAINER = 'Updates come from the maintainer: reinstall FlyBot to get them.'

test('the page points at FlyBot: star, source code, release notes and the underlying harness', () => {
  const view = page({ ...base, build: { branch: 'main', commit: '082563a' }, behind: null })
  assert.equal(view.star.props.href, REPO)
  assert.deepEqual(view.links.filter(href => href.includes('github.com')), [REPO, REPO, `${REPO}/releases`])
  assert.equal(view.row('Source code').props['data-hint'], 'github.com/ThinkFlowLab/FlyBot')
  assert.equal(view.row('DeepSeek Harness (underlying)').props['data-hint'], 'Version 0.2.0-rc.2')
  assert.equal(view.row('DeepSeek Harness'), undefined)
  assert.doesNotMatch(JSON.stringify(view.links), /Fei2411/)
})

test('the version line adds the branch and commit of a git install, and stays plain without them', () => {
  assert.equal(page({ ...base, build: { branch: 'main', commit: '082563a' } }).version, 'Version 0.1.5-flybot.1 · main 082563a')
  assert.equal(page({ ...base, build: { branch: 'main' } }).version, 'Version 0.1.5-flybot.1 · main')
  assert.equal(page({ ...base, build: { commit: '082563a' } }).version, 'Version 0.1.5-flybot.1 · 082563a')
  assert.equal(page({ ...base, source: 'registry', build: null }).version, 'Version 0.1.5-flybot.1')
})

test('a git install that follows a branch says how it is updated, and how far behind it is once checked', () => {
  const at = Date.now()
  const hint = update => page({ ...base, ...update }).hint('FlyBot core')
  assert.equal(hint({ build: { branch: 'main', commit: '082563a' } }), `Installed from GitHub (main 082563a). ${MAINTAINER}`)
  assert.equal(hint({ build: { branch: 'main' }, checkedAt: at }), `Installed from GitHub (main). ${MAINTAINER}`, 'no commit to compare')
  assert.match(hint({ build: { branch: 'main', commit: '082563a' }, behind: 0, checkedAt: at }), /^Up to date with main\. · Checked /)
  assert.match(hint({ build: { branch: 'main', commit: '082563a' }, behind: 1, checkedAt: at }), new RegExp(`^1 commit behind main\\. ${MAINTAINER} · Checked `))
  assert.match(hint({ build: { branch: 'main', commit: '082563a' }, behind: 7, checkedAt: at }), new RegExp(`^7 commits behind main\\. ${MAINTAINER} · Checked `))
  assert.match(hint({ build: { branch: 'main', commit: '082563a' }, behind: null, checkedAt: at }), /^Could not compare with main\./)
  // Other installs keep their own wording.
  assert.equal(hint({ source: 'git', build: null, checkedAt: at, latest: null }), 'Updates are not offered for this install.')
  assert.equal(hint({ source: 'path', build: null }), 'Installed from a local folder; update it there.')
  assert.equal(hint({ build: { branch: 'main', commit: '082563a' }, enabled: false }), 'Update checks are off.')
})

test('an install pinned to a commit shows the short commit, no branch, and says it is pinned (#379)', () => {
  const pinned = { build: { commit: '6d04db6', pinned: true }, behind: null, checkedAt: Date.now() }
  assert.equal(page({ ...base, ...pinned }).version, 'Version 0.1.5-flybot.1 · 6d04db6')
  assert.equal(page({ ...base, ...pinned }).hint('FlyBot core'), `Pinned to commit 6d04db6. ${MAINTAINER}`)
  assert.equal(page({ ...base, ...pinned, enabled: false }).hint('FlyBot core'), 'Update checks are off.')
  // A commit read from the lockfile for a tag install is just a commit: no pinned wording.
  assert.equal(page({ ...base, build: { commit: '6d04db6' }, checkedAt: Date.now(), latest: null }).hint('FlyBot core'), 'Updates are not offered for this install.')
})

test('the new About wording has zh copy', () => {
  for (const key of [
    'Installed from GitHub ({where}). Updates come from the maintainer: reinstall FlyBot to get them.', 'Up to date with {branch}.',
    '1 commit behind {branch}. Updates come from the maintainer: reinstall FlyBot to get them.',
    '{count} commits behind {branch}. Updates come from the maintainer: reinstall FlyBot to get them.',
    'Could not compare with {branch}. Updates come from the maintainer: reinstall FlyBot to get them.', 'DeepSeek Harness (underlying)',
    'Pinned to commit {commit}. Updates come from the maintainer: reinstall FlyBot to get them.',
  ]) assert.ok(typeof DICTIONARY.zh[key] === 'string' && DICTIONARY.zh[key] !== '', key)
  const translate = (key, params = {}) => (DICTIONARY.zh[key] ?? key).replace(/\{(\w+)\}/g, (_m, name) => params[name] ?? `{${name}}`)
  const off = installLocale({ register: () => () => {}, bind: () => translate, getLocale: () => ({ active: 'zh' }) })
  try {
    const view = page({ ...base, build: { branch: 'main', commit: '082563a' }, behind: 3, checkedAt: Date.now() })
    assert.match(view.hint(DICTIONARY.zh['FlyBot core']), /^落后 main 3 个提交。更新由维护者发布：重新安装 FlyBot 即可升级。 · /)
    assert.equal(view.row('DeepSeek Harness（底层）').props['data-hint'], '版本 0.2.0-rc.2')
  } finally {
    off()
  }
})
