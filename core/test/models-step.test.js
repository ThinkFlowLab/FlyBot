import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #407: "Models and providers…" and "Manage models" land Settings on the Models page.
// The launcher seat's openSettings() takes no section; a settings.onboarding step is
// handed openSection, so FlyBot opens its own step on purpose and that step opens the page.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/sidebar.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const run = fn => fn()
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, Component: class {}, Fragment: Symbol('F'), useEffect: run, useLayoutEffect: run, useState: v => [typeof v === 'function' ? v() : v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: () => null }
    throw new Error(`Unexpected platform module ${name}`)
  },
  console, setTimeout, clearTimeout, requestAnimationFrame: run, cancelAnimationFrame() {},
})
const { ModelsSettingsStep, MODELS_STEP_ID, MODELS_STEP_ORDER, openHarnessModels, AccountLauncher } = module.exports

test('opened on purpose, the step opens the Models section and hands back', () => {
  const calls = []
  const out = ModelsSettingsStep({ stepId: MODELS_STEP_ID, explicit: true, complete: () => calls.push('complete'), openSection: id => calls.push(`open:${id}`) })
  assert.equal(out, null)
  assert.deepEqual(calls, ['open:models', 'complete'])
})

test('in first-run onboarding the step skips itself without opening Settings', () => {
  const calls = []
  ModelsSettingsStep({ stepId: MODELS_STEP_ID, complete: () => calls.push('complete'), openSection: id => calls.push(`open:${id}`) })
  assert.deepEqual(calls, ['complete'])
  // After the shell's own steps (welcome-notice -100, deepseek-official 0).
  assert.ok(MODELS_STEP_ORDER > 0)
})

test('openHarnessModels asks the launcher seat for the FlyBot step, not plain Settings', () => {
  const opened = []
  AccountLauncher({ seat: true, settingsOpen: false, openSettings: () => opened.push('settings'), openOnboarding: id => opened.push(`step:${id}`), actions: { seatAccount() {} } })
  openHarnessModels()
  assert.deepEqual(opened, [`step:${MODELS_STEP_ID}`])
})

test('the step is registered and every models entry uses it (#407)', () => {
  const src = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
  assert.match(src('index.js'), /shadow\('settings\.onboarding', \{ id: MODELS_STEP_ID, order: MODELS_STEP_ORDER \}, ModelsSettingsStep\)/)
  const menu = src('model-menu.js')
  assert.match(menu, /close\(\); openHarnessModels\(\) \} \}, h\(SlidersIcon\), h\('span', \{ className: 'bt-menu-label' \}, t\('Models and providers…'\)\)/)
  assert.match(menu, /onClick: openHarnessModels \}, h\(SlidersIcon\), t\('Manage models'\)/)
  assert.match(menu, /\[\[t\('Manage models'\), openHarnessModels\]\]/)
  assert.doesNotMatch(menu, /openHarnessSettings/)
})
