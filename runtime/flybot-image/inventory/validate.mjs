#!/usr/bin/env node
// Structural checks over an inventory produced by collect.mjs.
// Passes for a fixture or a real image. --expect-image adds checks that only
// a built FlyBot runtime image should satisfy. This is not legal clearance.
import { readFileSync } from 'node:fs'

const path = process.argv.find((a, i, all) => all[i - 1] === '--inventory') || process.argv[2]
const expectImage = process.argv.includes('--expect-image')
if (!path || path.startsWith('-')) {
  console.error('usage: validate.mjs [--expect-image] --inventory <inventory.json>')
  process.exit(2)
}

const inv = JSON.parse(readFileSync(path, 'utf8'))
const fail = []
const need = (cond, msg) => { if (!cond) fail.push(msg) }

need(inv.not_a_legal_opinion === true, 'not_a_legal_opinion must be true')
need(inv.public_redistributable_image === false, 'must not claim a public redistributable image')
need(inv.office_functionality === 'retained', 'office functionality must stay retained')
need(inv.os && typeof inv.os.package_count === 'number', 'os.package_count missing')
need(inv.npm?.trees, 'npm.trees missing')
need(inv.claude && typeof inv.claude.present === 'boolean', 'claude scan missing')
need(Array.isArray(inv.claude.packages_found), 'claude.packages_found missing')
need(inv.fonts && Array.isArray(inv.fonts.files) && Array.isArray(inv.fonts.notices), 'fonts inventory missing')
need(inv.bundled_notices, 'bundled_notices missing')
need(inv.evidence_classes?.verified_files && inv.evidence_classes?.metadata_declarations, 'evidence classes missing')

for (const key of ['global_dsh', 'global_node_modules', 'dsbot', 'profile_web']) {
  need(inv.npm.trees[key], `missing npm tree ${key}`)
}

if (expectImage) {
  need(inv.os.package_count > 0, 'image should list dpkg packages')
  need(inv.os.packages?.every((p) => p.copyright_path == null || p.copyright_sha256), 'dpkg copyright hashes incomplete')
  need(inv.os.packages?.some((p) => p.name === 'git'), 'git package not listed')
  need(inv.npm.trees.global_dsh.present && inv.npm.trees.global_dsh.package_count > 0, 'global DSH tree empty')
  need(inv.npm.trees.dsbot.present && inv.npm.trees.dsbot.package_count > 0, 'ds-bot tree empty')
  need(inv.npm.trees.profile_web.present && inv.npm.trees.profile_web.package_count >= 7, 'profile web tree missing linked packages (follow symlinks)')
  const files = (inv.bundled_notices.files || []).map((f) => f.path)
  need(files.some((p) => p.includes('/opt/licenses/flybot/') && /notice/i.test(p)), 'missing FlyBot NOTICE in /opt/licenses')
  need(files.some((p) => p.includes('/opt/licenses/ds-bot/')), 'missing ds-bot licenses in /opt/licenses')
  need(files.some((p) => p.includes('/opt/licenses/libreoffice-kit/')), 'missing libreoffice-kit offer in /opt/licenses')
  need(files.some((p) => p.includes('/opt/licenses/font-notices/katex/') && /license/i.test(p)), 'missing KaTeX license under /opt/licenses/font-notices')
  need(files.some((p) => p.includes('/opt/licenses/sharp-libvips/') && /third-party-notices/i.test(p)), 'missing sharp-libvips third-party notices')
  need(files.some((p) => p.includes('/opt/licenses/sharp-libvips/') && /lgpl/i.test(p)), 'missing sharp-libvips LGPL text')
  need(files.some((p) => p.includes('/opt/licenses/anthropic-sdk/') && /license/i.test(p)), 'missing Anthropic SDK license as shipped')
  const katexFonts = (inv.fonts.files || []).filter((f) => /KaTeX_/i.test(f.path))
  need(katexFonts.length > 0, 'image should contain KaTeX font payloads')
  const katexNotices = (inv.fonts.notices || []).filter((f) => /KaTeX-LICENSE|font-notices\/katex|KaTeX-NOTICE/i.test(f.path))
    .concat(files.filter((p) => /KaTeX-LICENSE|font-notices\/katex/i.test(p)))
  need(katexNotices.length > 0, 'KaTeX font payloads must have a copied license/notice')

  const inventoryPaths = []
  for (const f of inv.bundled_notices.files || []) inventoryPaths.push(f.path)
  for (const f of inv.fonts.files || []) inventoryPaths.push(f.path)
  for (const f of inv.fonts.notices || []) inventoryPaths.push(f.path)
  for (const tree of Object.values(inv.npm.trees || {})) {
    for (const pkg of tree.packages || []) {
      for (const f of pkg.license_files || []) inventoryPaths.push(f.path)
    }
  }
  const sharpPackageNotice = inventoryPaths.some((p) => /@img\/sharp-libvips-linux-x64\/THIRD-PARTY-NOTICES\.md$/i.test(p))
  const sharpPackageLgpl = inventoryPaths.some((p) => /@img\/sharp-libvips-linux-x64\/.*lgpl/i.test(p))
  need(sharpPackageNotice, 'missing in-package sharp-libvips THIRD-PARTY-NOTICES.md on license_files or notices')
  need(sharpPackageLgpl, 'missing in-package sharp-libvips LGPL text on license_files or notices')
  const codiconFonts = (inv.fonts.files || []).filter((f) => /codicon/i.test(f.path) && /\.(ttf|woff2?)$/i.test(f.path))
  need(codiconFonts.length > 0, 'image should contain Playwright Codicon font payloads')
  const codiconNotices = inventoryPaths.filter((p) => /font-notices\/codicon/i.test(p) && /license/i.test(p)
    || /Codicon-LICENSE/i.test(p))
  need(codiconNotices.length > 0, 'Codicon font payloads must have a copied license/notice')

}

if (fail.length) {
  console.error('inventory validation failed:')
  for (const f of fail) console.error('-', f)
  process.exit(1)
}
console.log('inventory validation ok' + (expectImage ? ' (image expectations)' : ''))
console.log('os_packages', inv.os.package_count)
console.log('claude_present', inv.claude.present)
if (inv.claude.present) console.log('claude_packages', inv.claude.packages_found.map((p) => p.name).join(', '))
console.log('font_files', inv.fonts.file_count)
console.log('bundled_notices', (inv.bundled_notices.files || []).length)
