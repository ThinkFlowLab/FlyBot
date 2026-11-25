#!/usr/bin/env node
// Copy KaTeX, Codicon, sharp-libvips, and Anthropic SDK notices into a filesystem
// root (the image or a fixture). Notices are placed under /opt/licenses
// and beside actual KaTeX and Codicon font payloads / the sharp-libvips package so
// they travel with the files they describe. Does not alter functionality
// and does not publish an image.
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}
const ROOT = opt('--root', '/')
const here = dirname(fileURLToPath(import.meta.url))
const defaultNotices = join(here, '..', 'third_party')
const NOTICES = opt('--notices', existsSync(defaultNotices) ? defaultNotices : '/opt/licenses')

const skipDirNames = new Set(['proc', 'sys', 'dev', 'tmp', '.git', 'lost+found'])

function isInventoryFixture(path) {
  return path.includes('/inventory/testdata/') || path.endsWith('/inventory/testdata')
}

function walk(dir, visit, depth = 0, seen = new Set()) {
  if (depth > 32 || isInventoryFixture(dir)) return
  let real
  try { real = realpathSync(dir) } catch { return }
  if (seen.has(real)) return
  seen.add(real)
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue
    const path = join(dir, entry.name)
    if (isInventoryFixture(path)) continue
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(path)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch { continue }
    }
    if (isDir && skipDirNames.has(entry.name)) continue
    visit(path, { name: entry.name, isFile, isDir })
    if (isDir) walk(path, visit, depth + 1, seen)
  }
}

function copy(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log('copied', dest)
}

const katexLicense = join(NOTICES, 'font-notices/katex/LICENSE')
const katexNotice = join(NOTICES, 'font-notices/katex/NOTICE.md')
const codiconLicense = join(NOTICES, 'font-notices/codicon/LICENSE.txt')
const codiconNotice = join(NOTICES, 'font-notices/codicon/NOTICE.md')
const sharpFiles = [
  'PACKAGING-LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'npm-README.md',
  'LGPL-3.0.txt',
  'libvips-LGPL-2.1.txt',
  'versions.json',
  'README.md',
].map((name) => [join(NOTICES, 'sharp-libvips', name), name])
const anthropicLicense = join(NOTICES, 'anthropic-sdk/LICENSE')

if (existsSync(katexLicense)) {
  copy(katexLicense, join(ROOT, 'opt/licenses/font-notices/katex/LICENSE'))
}
if (existsSync(katexNotice)) {
  copy(katexNotice, join(ROOT, 'opt/licenses/font-notices/katex/NOTICE.md'))
}
if (existsSync(codiconLicense)) {
  copy(codiconLicense, join(ROOT, 'opt/licenses/font-notices/codicon/LICENSE.txt'))
}
if (existsSync(codiconNotice)) {
  copy(codiconNotice, join(ROOT, 'opt/licenses/font-notices/codicon/NOTICE.md'))
}
if (existsSync(anthropicLicense)) {
  copy(anthropicLicense, join(ROOT, 'opt/licenses/anthropic-sdk/LICENSE'))
}
for (const [src, name] of sharpFiles) {
  if (existsSync(src)) copy(src, join(ROOT, 'opt/licenses/sharp-libvips', name))
}

const katexDirs = new Set()
const codiconDirs = new Set()
const sharpDirs = new Set()
for (const start of ['usr/local', 'opt', 'data']) {
  const dir = join(ROOT, start)
  if (!existsSync(dir)) continue
  walk(dir, (path, entry) => {
    if (!entry.isFile) return
    if (/^KaTeX_.*\.(woff2|woff|ttf)$/i.test(entry.name)) katexDirs.add(dirname(path))
    if (/^codicon.*\.(ttf|woff2|woff)$/i.test(entry.name)) codiconDirs.add(dirname(path))
    if (entry.name === 'package.json' && path.includes('sharp-libvips-linux-x64')) {
      sharpDirs.add(dirname(path))
    }
  })
}

for (const dir of katexDirs) {
  if (existsSync(katexLicense)) copy(katexLicense, join(dir, 'KaTeX-LICENSE.txt'))
  if (existsSync(katexNotice)) copy(katexNotice, join(dir, 'KaTeX-NOTICE.md'))
}
for (const dir of codiconDirs) {
  if (existsSync(codiconLicense)) copy(codiconLicense, join(dir, 'Codicon-LICENSE.txt'))
  if (existsSync(codiconNotice)) copy(codiconNotice, join(dir, 'Codicon-NOTICE.md'))
}
for (const dir of sharpDirs) {
  for (const [src, name] of sharpFiles) {
    if (existsSync(src) && name !== 'README.md') copy(src, join(dir, name))
  }
}
console.log('katex_font_dirs', katexDirs.size)
console.log('codicon_font_dirs', codiconDirs.size)
console.log('sharp_libvips_dirs', sharpDirs.size)
