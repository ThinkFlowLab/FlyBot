import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', 'src', 'client')

// SETTINGS_PAGES is not exported on purpose: the dialog's page list is private to
// settings.js. Read its literal keys from the source so a call site that names a page
// which is not in the list fails here instead of opening a blank dialog at runtime.
function settingsPageKeys() {
  const source = readFileSync(join(clientRoot, 'settings.js'), 'utf8')
  const line = source.split('\n').find(text => text.startsWith('const SETTINGS_PAGES = ['))
  assert.ok(line, 'settings.js still declares SETTINGS_PAGES as a literal list')
  return [...line.matchAll(/\['([^']+)', '/g)].map(match => match[1])
}

function clientSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) clientSources(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('every openSettings() page key exists in SETTINGS_PAGES', () => {
  const keys = new Set(settingsPageKeys())
  assert.equal(keys.size, 13, 'the settings dialog lists thirteen pages')

  const unknown = []
  let seen = 0
  for (const file of clientSources(clientRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/openSettings\(\s*'([^']+)'/g)) {
        const key = match[1]
        // Plugin pages are contributed by plugins at runtime, not by SETTINGS_PAGES.
        if (key.startsWith('plugin:')) continue
        seen += 1
        if (!keys.has(key)) unknown.push(`${relative(here, file)}:${index + 1} openSettings('${key}') is not a settings page`)
      }
    })
  }

  assert.ok(seen > 0, 'the scan found openSettings() call sites in core/src/client')
  assert.deepEqual(unknown, [], `openSettings() calls with unknown page keys:\n${unknown.join('\n')}`)
})

// PAGE_ICONS is private too, and it is two tables: the shared icons in icons.js and
// the page-specific ones here. A page the list shows with no icon renders a hole, and
// an icon keyed to a page that does not exist is dead weight that hides a rename.
function literalKeys(line) {
  return [...line.matchAll(/(?:^|[{,\s])([A-Za-z][\w-]*)\s*:/g)].map(match => match[1])
}

function settingsIconKeys() {
  const settings = readFileSync(join(clientRoot, 'settings.js'), 'utf8')
  const pageIcons = settings.split('\n').find(text => text.startsWith('const PAGE_ICONS = {'))
  assert.ok(pageIcons, 'settings.js still declares PAGE_ICONS as a literal object')
  assert.match(pageIcons, /\.\.\.SETTINGS_ICONS/, 'PAGE_ICONS still inherits the shared icons')

  const icons = readFileSync(join(clientRoot, 'icons.js'), 'utf8')
  const shared = icons.split('\n').find(text => text.startsWith('export const SETTINGS_ICONS = {'))
  assert.ok(shared, 'icons.js still exports SETTINGS_ICONS as a literal object')
  return { pageIcons: new Set(literalKeys(pageIcons)), shared: new Set(literalKeys(shared)) }
}

test('every settings page has an icon', () => {
  const { pageIcons, shared } = settingsIconKeys()
  const missing = settingsPageKeys().filter(key => !pageIcons.has(key) && !shared.has(key))
  assert.deepEqual(missing, [], `settings pages with no icon:\n${missing.join('\n')}`)
})

test('PAGE_ICONS keys are settings pages', () => {
  const pages = new Set(settingsPageKeys())
  const { pageIcons, shared } = settingsIconKeys()
  const stray = [...pageIcons, ...shared].filter(key => !pages.has(key))
  assert.deepEqual(stray, [], `PAGE_ICONS keys that are not settings pages:\n${stray.join('\n')}`)
})

// A page counts as rendered only when its branch paints something: a bare `shown === 'about'`
// keeps the literal and still opens an empty dialog. Usage never branches on `shown` at all —
// its panel stays mounted behind `usageOpened`, and one call inside that block draws it (#3153).
function usageBlock(source) {
  const start = source.indexOf("usageOpened ? h('div', { key: 'usage'")
  assert.ok(start >= 0, 'settings.js still gates the Usage panel on usageOpened')
  const close = ': null)'
  const end = source.indexOf(close, start)
  assert.ok(end > start, `the usageOpened block still closes with ${close}`)
  return source.slice(start, end + close.length)
}

// key -> the component that key's own render form draws, or undefined. `usage` is read inside
// its usageOpened block, so moving `h(UsagePage, …)` out of that block no longer counts.
function pinnedComponent(key, source) {
  if (key !== 'usage') return undefined
  return /h\((UsagePage),/.exec(usageBlock(source))?.[1]
}

function definedComponents(source) {
  const names = new Set()
  for (const match of source.matchAll(/(?:function|const|let)\s+([A-Z]\w*)/g)) names.add(match[1])
  for (const match of source.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

test('every settings page has a rendered branch', () => {
  const source = readFileSync(join(clientRoot, 'settings.js'), 'utf8')
  // key -> the component its branch draws, read from `shown === '<key>' … ? h(<Component …`
  const painted = new Map()
  for (const line of source.split('\n')) {
    for (const named of line.matchAll(/shown === '([^']+)'/g)) {
      const drawn = /\?\s*h\(([A-Z]\w*)/.exec(line.slice(named.index))
      if (drawn) painted.set(named[1], drawn[1])
    }
  }
  const pages = settingsPageKeys()
  const branches = new Set([...source.matchAll(/shown === '([^']+)'/g)].map(match => match[1]))

  const unrendered = pages.filter(key => !painted.has(key) && pinnedComponent(key, source) === undefined)
  assert.deepEqual(unrendered, [], `settings pages with no rendered branch:\n${unrendered.join('\n')}`)

  const components = definedComponents(source)
  const loose = pages
    .map(key => [key, painted.get(key) ?? pinnedComponent(key, source)])
    .filter(([, name]) => name !== undefined && !components.has(name))
    .map(([key, name]) => `${key} -> ${name}`)
  assert.deepEqual(loose, [], `rendered branches that name an undefined component:\n${loose.join('\n')}`)

  const stray = [...branches].filter(key => !pages.includes(key))
  assert.deepEqual(stray, [], `rendered branches that name no settings page:\n${stray.join('\n')}`)
})

// The page list drops one entry on a condition. The key in that comparison is easy to
// mistype, and a typo either hides the page everywhere or shows it where it should not.
test('the conditional page filter names a settings page', () => {
  const source = readFileSync(join(clientRoot, 'settings.js'), 'utf8')
  const filter = /key !== '([^']+)' \|\| projectPresent\(\)/.exec(source)
  assert.ok(filter, 'settings.js still filters one page on projectPresent()')
  const names = settingsPageKeys()
  assert.deepEqual(names.includes(filter[1]) ? [] : [filter[1]], [],
    `the conditional page filter names a page outside SETTINGS_PAGES:\n${filter[1]}`)
})
