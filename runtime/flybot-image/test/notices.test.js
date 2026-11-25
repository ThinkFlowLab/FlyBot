import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(root, 'install-redistribution-notices.mjs')
const notices = join(root, '..', 'third_party')

test('installer copies KaTeX, Codicon, and sharp-libvips notices beside the payloads', () => {
  const dest = mkdtempSync(join(tmpdir(), 'ot-notices-'))
  try {
    const fontDir = join(dest, 'usr/local/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/fonts')
    mkdirSync(fontDir, { recursive: true })
    writeFileSync(join(fontDir, 'KaTeX_Main-Regular-test.woff2'), 'WOFF')
    const sharpDir = join(dest, 'usr/local/lib/node_modules/@img/sharp-libvips-linux-x64')
    mkdirSync(sharpDir, { recursive: true })
    writeFileSync(join(sharpDir, 'package.json'), '{"name":"@img/sharp-libvips-linux-x64","version":"1.3.4","license":"LGPL-3.0-or-later"}\n')
    const codiconDir = join(dest, 'opt/dsh-template/profiles/web/node_modules/ds-bot/node_modules/playwright-core/lib/vite/traceViewer')
    mkdirSync(codiconDir, { recursive: true })
    writeFileSync(join(codiconDir, 'codicon.DCmgc-ay.ttf'), 'TTF')
    const result = spawnSync(process.execPath, [installer, '--root', dest, '--notices', notices], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const katexLicense = join(fontDir, 'KaTeX-LICENSE.txt')
    assert.equal(
      readFileSync(katexLicense, 'utf8'),
      readFileSync(join(notices, 'font-notices/katex/LICENSE'), 'utf8'),
    )
    assert.ok(existsSync(join(fontDir, 'KaTeX-NOTICE.md')))
    assert.ok(existsSync(join(dest, 'opt/licenses/font-notices/katex/LICENSE')))
    assert.ok(existsSync(join(dest, 'opt/licenses/sharp-libvips/THIRD-PARTY-NOTICES.md')))
    assert.ok(existsSync(join(dest, 'opt/licenses/sharp-libvips/LGPL-3.0.txt')))
    assert.ok(existsSync(join(dest, 'opt/licenses/anthropic-sdk/LICENSE')))
    assert.ok(existsSync(join(sharpDir, 'THIRD-PARTY-NOTICES.md')))
    assert.ok(existsSync(join(sharpDir, 'LGPL-3.0.txt')))
    assert.equal(
      readFileSync(join(codiconDir, 'Codicon-LICENSE.txt'), 'utf8'),
      readFileSync(join(notices, 'font-notices/codicon/LICENSE.txt'), 'utf8'),
    )
    assert.ok(existsSync(join(dest, 'opt/licenses/font-notices/codicon/LICENSE.txt')))
    assert.match(result.stdout, /katex_font_dirs 1/)
    assert.match(result.stdout, /codicon_font_dirs 1/)
    assert.match(result.stdout, /sharp_libvips_dirs 1/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
