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

// The body picks the page with one `shown === '<key>'` per branch. A page in the list
// with no branch opens a dialog with a header and an empty body.
test('every settings page has a rendered branch', () => {
  const source = readFileSync(join(clientRoot, 'settings.js'), 'utf8')
  const branches = new Set([...source.matchAll(/shown === '([^']+)'/g)].map(match => match[1]))
  const pages = settingsPageKeys()

  const unrendered = pages.filter(key => !branches.has(key))
  assert.deepEqual(unrendered, [], `settings pages with no rendered branch:\n${unrendered.join('\n')}`)

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
