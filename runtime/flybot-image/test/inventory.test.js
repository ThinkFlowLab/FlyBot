import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const collect = join(root, 'inventory/collect.mjs')
const validate = join(root, 'inventory/validate.mjs')
const fixture = join(root, 'inventory/testdata/fake-root')
const claudeFixture = join(root, 'inventory/testdata/fake-root-with-claude')

function runCollect(tree) {
  const out = mkdtempSync(join(tmpdir(), 'ot-inv-'))
  const result = spawnSync(process.execPath, [collect, '--root', tree, '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return {
    out,
    inventory: JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8')),
    summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')),
    markdown: readFileSync(join(out, 'inventory.md'), 'utf8'),
  }
}

function runValidate(path, extra = []) {
  return spawnSync(process.execPath, [validate, ...extra, '--inventory', path], { encoding: 'utf8' })
}

test('fixture inventory records OS, npm closures, fonts, and bundled notices', () => {
  const { out, inventory, summary, markdown } = runCollect(fixture)
  try {
    assert.equal(inventory.not_a_legal_opinion, true)
    assert.equal(inventory.public_redistributable_image, false)
    assert.equal(inventory.office_functionality, 'retained')
    assert.equal(inventory.os.os_release.VERSION_CODENAME, 'bookworm')
    assert.equal(inventory.os.package_count, 2)
    const git = inventory.os.packages.find((p) => p.name === 'git')
    assert.ok(git)
    assert.equal(git.source_package, 'git')
    assert.equal(git.copyright_path, '/usr/share/doc/git/copyright')
    assert.match(git.copyright_sha256, /^[0-9a-f]{64}$/)
    assert.ok(git.copyright_fields.licenses.includes('GPL-2'))
    assert.equal(git.source_pointer.kind, 'debian_deb_src_pointer')
    assert.match(git.source_pointer.note, /apt-get source/)

    const dsh = inventory.npm.trees.global_dsh.packages.find((p) => p.name === '@deepseek-ai/dsh')
    assert.equal(dsh.version, '0.2.2-rc.1')
    assert.equal(dsh.license_field, 'MIT')
    assert.equal(dsh.license_field_is, 'npm metadata declaration')
    const kit = inventory.npm.trees.global_dsh.packages.find((p) => p.name === '@deepseek-ai/libreoffice-kit')
    assert.equal(kit.license_field, 'MPL-2.0')
    assert.ok(inventory.npm.trees.dsbot.packages.some((p) => p.name === 'ws'))
    assert.ok(inventory.npm.trees.profile_web.packages.some((p) => p.name === 'katex'))
    assert.ok(inventory.npm.trees.profile_web.packages.some((p) => p.name === 'linked-fixture-pkg'))

    assert.equal(inventory.claude.present, false)
    assert.equal(inventory.fonts.file_count, 1)
    assert.ok(inventory.fonts.files[0].path.endsWith('KaTeX_Main-Regular.woff2'))
    const ofl = inventory.fonts.notices.find((n) => n.path.endsWith('/OFL.txt'))
    assert.ok(ofl)
    assert.match(ofl.text, /SIL OPEN FONT LICENSE/)
    const flybotNotice = inventory.bundled_notices.files.find((f) => f.path === '/opt/licenses/flybot/NOTICE')
    assert.equal(flybotNotice.mentions_trademark, true)
    assert.ok(inventory.bundled_notices.files.some((f) => f.path.includes('libreoffice-kit')))
    assert.match(markdown, /not.*legal opinion/i)
    assert.equal(summary.claude_present, false)

    const checked = runValidate(join(out, 'inventory.json'))
    assert.equal(checked.status, 0, checked.stderr || checked.stdout)
    const imageLike = structuredClone(inventory)
    imageLike.npm.trees.profile_web.package_count = 1
    imageLike.bundled_notices.files = [
      ...(imageLike.bundled_notices.files || []),
      { path: '/opt/licenses/font-notices/katex/LICENSE' },
      { path: '/opt/licenses/sharp-libvips/THIRD-PARTY-NOTICES.md' },
      { path: '/opt/licenses/sharp-libvips/LGPL-3.0.txt' },
      { path: '/opt/licenses/anthropic-sdk/LICENSE' },
    ]
    imageLike.fonts.files = [
      ...(imageLike.fonts.files || []),
      { path: '/opt/demo/KaTeX_Main-Regular.woff2' },
      { path: '/opt/dsh-template/profiles/web/node_modules/ds-bot/node_modules/playwright-core/lib/vite/traceViewer/codicon.DCmgc-ay.ttf' },
    ]
    imageLike.fonts.notices = [
      ...(imageLike.fonts.notices || []),
      { path: '/opt/demo/KaTeX-LICENSE.txt' },
      { path: '/opt/licenses/font-notices/codicon/LICENSE.txt' },
    ]
    imageLike.bundled_notices.files.push({ path: '/opt/licenses/font-notices/codicon/LICENSE.txt' })
    const dshTree = imageLike.npm.trees.global_dsh
    dshTree.packages = [
      ...(dshTree.packages || []),
      {
        name: '@img/sharp-libvips-linux-x64',
        version: '1.3.4',
        path: '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@img/sharp-libvips-linux-x64',
        license_files: [
          { path: '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@img/sharp-libvips-linux-x64/THIRD-PARTY-NOTICES.md' },
          { path: '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@img/sharp-libvips-linux-x64/LGPL-3.0.txt' },
        ],
      },
    ]
    const weak = join(out, 'weak-profile.json')
    writeFileSync(weak, JSON.stringify(imageLike))
    const expectImage = runValidate(weak, ['--expect-image'])
    assert.notEqual(expectImage.status, 0)
    assert.match(expectImage.stderr, /linked packages/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('claude payload presence and license text are recorded when the tree contains them', () => {
  const { out, inventory } = runCollect(claudeFixture)
  try {
    assert.equal(inventory.claude.present, true)
    const sdk = inventory.claude.packages_found.find((p) => p.name === '@anthropic-ai/claude-agent-sdk')
    assert.ok(sdk)
    assert.equal(sdk.license_field, 'SEE LICENSE IN LICENSE.md')
    assert.match(sdk.license_texts[0].text, /Commercial terms fixture/)
    assert.equal(inventory.public_redistributable_image, false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('validate rejects a public-image clearance claim', () => {
  const { out, inventory } = runCollect(fixture)
  try {
    inventory.public_redistributable_image = true
    const bad = join(out, 'bad.json')
    writeFileSync(bad, JSON.stringify(inventory))
    const checked = runValidate(bad)
    assert.notEqual(checked.status, 0)
    assert.match(checked.stderr, /public redistributable image/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('collector records in-package sharp notices and Codicon licenses after the installer runs', () => {
  const dest = mkdtempSync(join(tmpdir(), 'ot-inv-shipped-'))
  const installer = join(root, 'install-redistribution-notices.mjs')
  const notices = join(root, '..', 'third_party')
  try {
    const fontDir = join(dest, 'usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/fonts')
    mkdirSync(fontDir, { recursive: true })
    writeFileSync(join(fontDir, 'KaTeX_Main-Regular.woff2'), 'WOFF')
    const sharpDir = join(dest, 'usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@img/sharp-libvips-linux-x64')
    mkdirSync(sharpDir, { recursive: true })
    writeFileSync(join(sharpDir, 'package.json'), '{"name":"@img/sharp-libvips-linux-x64","version":"1.3.4","license":"LGPL-3.0-or-later"}\n')
    const dshDir = join(dest, 'usr/local/lib/node_modules/@deepseek-ai/dsh')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1","license":"MIT"}\n')
    const codiconDir = join(dest, 'opt/dsh-template/profiles/web/node_modules/ds-bot/node_modules/playwright-core/lib/vite/traceViewer')
    mkdirSync(codiconDir, { recursive: true })
    writeFileSync(join(codiconDir, 'codicon.DCmgc-ay.ttf'), 'TTF')
    const result = spawnSync(process.execPath, [installer, '--root', dest, '--notices', notices], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const { out, inventory } = runCollect(dest)
    try {
      const sharp = inventory.npm.trees.global_dsh.packages.find((p) => p.name === '@img/sharp-libvips-linux-x64')
      assert.ok(sharp, 'sharp package missing from inventory')
      const licensePaths = (sharp.license_files || []).map((f) => f.path)
      assert.ok(licensePaths.some((p) => p.endsWith('/@img/sharp-libvips-linux-x64/THIRD-PARTY-NOTICES.md')), licensePaths.join(','))
      assert.ok(licensePaths.some((p) => p.endsWith('/@img/sharp-libvips-linux-x64/LGPL-3.0.txt')), licensePaths.join(','))
      assert.ok((inventory.fonts.files || []).some((f) => /codicon/i.test(f.path)))
      const noticePaths = (inventory.fonts.notices || []).map((f) => f.path)
        .concat((inventory.bundled_notices.files || []).map((f) => f.path))
      assert.ok(noticePaths.some((p) => /Codicon-LICENSE\.txt$/i.test(p) || /font-notices\/codicon\/LICENSE/i.test(p)), noticePaths.join(','))
      const inventoryFile = join(out, 'inventory.json')
      const checked = runValidate(inventoryFile)
      assert.equal(checked.status, 0, checked.stderr || checked.stdout)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
