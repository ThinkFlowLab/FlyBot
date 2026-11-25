#!/usr/bin/env node
// Collect a package/license inventory from a FlyBot runtime image (or a
// fixture root). Writes JSON and Markdown under --out. Does not publish an
// image, does not contact the network, and is not a legal opinion or a
// public-redistribution clearance.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}
const ROOT = resolve(opt('--root', '/'))
const OUT = resolve(opt('--out', join(process.cwd(), 'image-inventory')))

const skipDirNames = new Set(['proc', 'sys', 'dev', 'tmp', '.git', 'lost+found'])
const licenseNames = new Set([
  'license', 'license.md', 'license.txt', 'licence', 'licence.md', 'licence.txt',
  'copying', 'copying.md', 'notice', 'notice.md', 'ofl.txt', 'ofl.md',
  'montserrat-ofl.txt', 'unlicense',
])
const fontSuffixes = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot'])

function isAttributionFile(name) {
  const lower = String(name || '').toLowerCase()
  if (licenseNames.has(lower)) return true
  if (/^(readme|notice|license|licence|copying|copyright)(\.|$)/i.test(name)) return true
  if (lower === 'pins.json') return true
  if (/license|licence|copying|copyright|notice|ofl|lgpl|gpl/i.test(lower)) return true
  return lower.endsWith('.txt') && /mit|mpl|apache/i.test(lower)
}

const maxLicenseBytes = 200_000

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const safeStat = (path) => { try { return statSync(path) } catch { return null } }
const safeRead = (path, max = maxLicenseBytes) => {
  const st = safeStat(path)
  if (!st?.isFile()) return null
  if (st.size > max) return { truncated: true, bytes: st.size, sha256: null, text: null }
  const buf = readFileSync(path)
  return { truncated: false, bytes: buf.length, sha256: sha256(buf), text: buf.toString('utf8') }
}

const rel = (path) => {
  const text = relative(ROOT, path)
  return text.startsWith('..') ? path : '/' + text.replaceAll('\\', '/')
}

function isInventoryFixture(path) {
  // Only skip fixture trees when they appear *inside* the inventory root
  // (as they would in a badly copied image). When the root itself is the
  // fixture, the relative path will not contain this segment.
  const text = rel(path)
  return text.includes('/inventory/testdata/') || text.endsWith('/inventory/testdata')
}

function walk(dir, visit, depth = 0, seen = new Set()) {
  if (depth > 32) return
  if (isInventoryFixture(dir)) return
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
    visit(path, { name: entry.name, isFile: () => isFile, isDirectory: () => isDir })
    if (isDir) walk(path, visit, depth + 1, seen)
  }
}

function parseOsRelease(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  return out
}

function parseDpkgStatus(text) {
  const packages = []
  for (const block of String(text || '').split('\n\n')) {
    if (!block.trim()) continue
    const get = (key) => {
      const re = new RegExp('^' + key + ': (.*)$', 'm')
      return block.match(re)?.[1]?.trim() ?? null
    }
    const name = get('Package')
    if (!name) continue
    packages.push({
      name,
      version: get('Version'),
      source_package: (get('Source') || name).split(' ')[0],
      source_version: get('Source')?.match(/\(([^)]+)\)/)?.[1] || get('Version'),
      status: get('Status'),
      essential: get('Essential') === 'yes',
    })
  }
  return packages
}

function extractDebianCopyrightFields(text) {
  const fields = []
  const licenses = new Set()
  for (const block of String(text || '').split('\n\n')) {
    const license = block.match(/^License: (.+)$/m)?.[1]?.trim()
    if (license) licenses.add(license)
  }
  const format = text.match(/^Format: (.+)$/m)?.[1]?.trim() || null
  const upstream = text.match(/^Upstream-Name: (.+)$/m)?.[1]?.trim() || null
  const source = text.match(/^Source: (.+)$/m)?.[1]?.trim() || null
  if (format) fields.push(['format', format])
  if (upstream) fields.push(['upstream_name', upstream])
  if (source) fields.push(['source', source])
  return { format, upstream_name: upstream, source, licenses: [...licenses].sort() }
}

function debianSourcePointer(pkg, os) {
  const distro = os.VERSION_CODENAME || os.VERSION_ID || 'debian'
  return {
    kind: 'debian_deb_src_pointer',
    evidence: 'instruction, not a fetched .dsc',
    note: `Enable deb-src for this ${distro} image (deb.debian.org) and run apt-get source ${pkg.source_package}=${pkg.source_version}. The in-image copyright file is at /usr/share/doc/${pkg.name}/copyright when present.`,
  }
}

function collectOs(osRelease, dpkgStatus) {
  const os = parseOsRelease(osRelease)
  const packages = parseDpkgStatus(dpkgStatus).filter((pkg) => (pkg.status || '').includes('installed')).map((pkg) => {
    const copyrightPath = join(ROOT, 'usr/share/doc', pkg.name, 'copyright')
    const file = safeRead(copyrightPath)
    const fields = file?.text ? extractDebianCopyrightFields(file.text) : { licenses: [] }
    return {
      ...pkg,
      copyright_path: file ? rel(copyrightPath) : null,
      copyright_sha256: file?.sha256 ?? null,
      copyright_bytes: file?.bytes ?? null,
      copyright_fields: fields,
      source_pointer: debianSourcePointer(pkg, os),
    }
  })
  packages.sort((a, b) => a.name.localeCompare(b.name))
  return { os_release: os, package_count: packages.length, packages }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function isPackageLicenseFile(name) {
  // Attribution files that travel with a package. Broader than licenseNames
  // so THIRD-PARTY-NOTICES.md and LGPL-*.txt are recorded, but not README.md.
  const lower = String(name || '').toLowerCase()
  if (licenseNames.has(lower)) return true
  if (/^(license|licence|copying|copyright|notice)(\.|$)/i.test(name)) return true
  if (/license|licence|copying|copyright|notice|ofl|lgpl|gpl/i.test(lower)) return true
  return false
}

function packageLicenseFiles(dir) {
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!isPackageLicenseFile(name)) continue
    const path = join(dir, name)
    const st = safeStat(path)
    if (!st?.isFile()) continue
    const file = safeRead(path)
    if (!file) continue
    out.push({ path: rel(path), bytes: file.bytes, sha256: file.sha256, truncated: file.truncated })
  }
  return out
}

function normalizeLicense(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value.type) return value.type
  return JSON.stringify(value)
}

function collectNpmTree(prefix, label) {
  const abs = prefix.startsWith('/') && !prefix.startsWith(ROOT) ? join(ROOT, prefix.replace(/^\/+/, '')) : resolve(ROOT, prefix)
  const packages = []
  if (!existsSync(abs)) return { label, prefix: prefix, present: false, package_count: 0, packages }
  const seen = new Set()
  const visitPkg = (pkgDir) => {
    const manifestPath = join(pkgDir, 'package.json')
    if (seen.has(manifestPath) || !existsSync(manifestPath)) return
    seen.add(manifestPath)
    const manifest = readJson(manifestPath)
    if (!manifest?.name) return
    packages.push({
      name: manifest.name,
      version: manifest.version ?? null,
      license_field: normalizeLicense(manifest.license),
      license_field_is: 'npm metadata declaration',
      path: rel(pkgDir),
      license_files: packageLicenseFiles(pkgDir),
    })
  }
  const start = abs
  if (existsSync(join(start, 'package.json'))) visitPkg(start)
  const search = [start]
  const nested = join(start, 'node_modules')
  if (existsSync(nested)) search.push(nested)
  const walked = new Set()
  for (const dir of search) {
    if (walked.has(dir) || !existsSync(dir)) continue
    walked.add(dir)
    walk(dir, (path, entry) => {
      if (entry.isFile() && entry.name === 'package.json') visitPkg(dirname(path))
    })
  }
  packages.sort((a, b) => (a.name + a.path).localeCompare(b.name + b.path))
  return { label, prefix, present: true, package_count: packages.length, packages }
}

const CLAUDE_NAME = /claude|anthropic/i
function collectClaude(trees) {
  const found = []
  for (const tree of trees) {
    for (const pkg of tree.packages || []) {
      if (CLAUDE_NAME.test(pkg.name) || CLAUDE_NAME.test(pkg.path || '')) {
        const texts = []
        for (const file of pkg.license_files || []) {
          const abs = join(ROOT, file.path.replace(/^\//, ''))
          const body = safeRead(abs, 64_000)
          if (body?.text) texts.push({ path: file.path, sha256: body.sha256, bytes: body.bytes, text: body.text })
        }
        found.push({ tree: tree.label, ...pkg, license_texts: texts })
      }
    }
  }
  return {
    packages_found: found,
    present: found.length > 0,
    note: found.length
      ? 'Packages whose name or path matches claude|anthropic were found in the scanned trees. license_texts are file contents from those packages, not a legal interpretation of their terms.'
      : 'No package name or path in the scanned npm trees matched claude|anthropic. This is a scan of those trees only, not a proof about optional downloads after start.',
  }
}

function collectFonts() {
  const files = []
  const notices = []
  const roots = ['opt', 'usr/local', 'usr/share/fonts', 'usr/share/texmf', 'data']
  for (const r of roots) {
    const dir = join(ROOT, r)
    if (!existsSync(dir)) continue
    walk(dir, (path, entry) => {
      if (!entry.isFile()) return
      const lower = entry.name.toLowerCase()
      const st = safeStat(path)
      if (!st) return
      const suffix = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
      const isFont = fontSuffixes.has(suffix)
      const isNotice = isAttributionFile(entry.name) && /font|ofl|katex|montserrat|sil|codicon|playwright/i.test(path)
      if (!isFont && !isNotice && !/katex|montserrat|codicon/i.test(path)) return
      if (isNotice || (isAttributionFile(entry.name) && /font|ofl|katex|montserrat|sil|codicon|playwright/i.test(path))) {
        const file = safeRead(path)
        if (file) notices.push({ path: rel(path), bytes: file.bytes, sha256: file.sha256, truncated: file.truncated, text: file.truncated ? null : file.text })
        return
      }
      if (isFont || /katex|montserrat|codicon/i.test(entry.name)) {
        files.push({ path: rel(path), bytes: st.size, kind: isFont ? 'font-binary' : 'related', sha256: st.size <= 1_000_000 ? sha256(readFileSync(path)) : null })
      }
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  notices.sort((a, b) => a.path.localeCompare(b.path))
  return { file_count: files.length, files, notices }
}

function collectNotices() {
  const files = []
  const dir = join(ROOT, 'opt/licenses')
  if (existsSync(dir)) {
    walk(dir, (path, entry) => {
      if (!entry.isFile()) return
      if (!isAttributionFile(entry.name)) return
      const file = safeRead(path, 400_000)
      if (!file) return
      const body = file.text || ''
      files.push({
        path: rel(path),
        bytes: file.bytes,
        sha256: file.sha256,
        truncated: file.truncated,
        mentions_trademark: /\btrademarks?\b/i.test(body),
      })
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    path: '/opt/licenses',
    present: existsSync(dir),
    files,
    trademark_note: 'mentions_trademark records the word occurring in a bundled notice file. That is attribution inventory, not trademark clearance.',
  }
}

function uniquePackages(packages) {
  const byPath = new Map()
  for (const pkg of packages) {
    if (!byPath.has(pkg.path)) byPath.set(pkg.path, pkg)
  }
  return [...byPath.values()]
}

function licenseHistogram(packages) {
  const counts = {}
  for (const pkg of packages) {
    const key = pkg.license_field || 'MISSING'
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function unusualLicenses(packages) {
  const re = /gpl|mpl|agpl|lgpl|sspl|see license|proprietary|unlicensed|ofl|sil open/i
  return packages.filter((pkg) => re.test(String(pkg.license_field || ''))).map((pkg) => ({
    name: pkg.name, version: pkg.version, license_field: pkg.license_field, path: pkg.path, tree_hint: pkg.path,
  }))
}

function markdown(inv) {
  const npmAll = uniquePackages(Object.values(inv.npm.trees).flatMap((t) => t.packages || []))
  const unusual = unusualLicenses(npmAll)
  const lines = [
    '# FlyBot runtime image license inventory',
    '',
    `Collected at: ${inv.collected_at}`,
    '',
    'This file is produced from a built image (or a fixture). It is **not** a legal opinion and **not** clearance to publish a pre-built image. Office conversion is retained.',
    '',
    '## OS',
    '',
    `- ${inv.os.os_release.PRETTY_NAME || inv.os.os_release.ID || 'unknown'} (${inv.os.os_release.VERSION_CODENAME || ''})`,
    `- ${inv.os.package_count} dpkg packages`,
    '',
    'Debian source pointer: enable `deb-src` for this distro on deb.debian.org and run `apt-get source <src>=<ver>`. Copyright files were hashed when present under `/usr/share/doc/<pkg>/copyright`.',
    '',
    '## npm trees',
    '',
  ]
  for (const [key, tree] of Object.entries(inv.npm.trees)) {
    lines.push(`- **${key}** (${tree.prefix}): ${tree.present ? tree.package_count + ' packages' : 'not present'}`)
  }
  lines.push('', 'License field counts (metadata declarations):', '')
  const hist = licenseHistogram(npmAll)
  for (const [lic, n] of Object.entries(hist)) lines.push(`- ${lic}: ${n}`)
  lines.push('', '## Unusual or copyleft-looking npm license fields', '')
  if (!unusual.length) lines.push('None in the scanned trees.')
  else for (const pkg of unusual) lines.push(`- \`${pkg.name}@${pkg.version}\` ${pkg.license_field} at \`${pkg.path}\``)
  lines.push('', '## Claude / Anthropic packages', '')
  lines.push(inv.claude.present ? `Found ${inv.claude.packages_found.length} package(s). See inventory.json for file texts.` : 'None found in the scanned npm trees.')
  lines.push('', inv.claude.note, '', '## Fonts', '')
  lines.push(`- ${inv.fonts.file_count} font or font-related files (binaries listed by path/size only)`)
  lines.push(`- ${inv.fonts.notices.length} nearby license/OFL texts`)
  lines.push('', '## Bundled notices at /opt/licenses', '')
  if (!inv.bundled_notices.present) lines.push('Directory not present.')
  else for (const file of inv.bundled_notices.files) {
    lines.push(`- \`${file.path}\` (${file.bytes} bytes, trademark mention: ${file.mentions_trademark})`)
  }
  lines.push('', inv.bundled_notices.trademark_note, '')
  return lines.join('\n')
}

const osRelease = existsSync(join(ROOT, 'etc/os-release')) ? readFileSync(join(ROOT, 'etc/os-release'), 'utf8') : ''
const dpkgStatus = existsSync(join(ROOT, 'var/lib/dpkg/status')) ? readFileSync(join(ROOT, 'var/lib/dpkg/status'), 'utf8') : ''

const npmTrees = {
  global_dsh: collectNpmTree('/usr/local/lib/node_modules/@deepseek-ai/dsh', 'global_dsh'),
  global_node_modules: collectNpmTree('/usr/local/lib/node_modules', 'global_node_modules'),
  dsbot: collectNpmTree('/opt/flybot-workspace/runtime/ds-bot-upstream/ds-bot', 'dsbot'),
  profile_web: collectNpmTree('/opt/dsh-template/profiles/web', 'profile_web'),
}

const inventory = {
  document: 'FlyBot runtime image license inventory',
  not_a_legal_opinion: true,
  public_redistributable_image: false,
  office_functionality: 'retained',
  evidence_classes: {
    verified_files: 'sha256 and path of license/NOTICE/copyright/OFL files actually present under the inventory root',
    metadata_declarations: 'npm package.json license fields and dpkg status fields',
    unresolved_legal_interpretation: 'whether the collected texts allow publishing a pre-built image',
  },
  collected_at: new Date().toISOString(),
  inventory_root: ROOT,
  os: collectOs(osRelease, dpkgStatus),
  npm: { trees: npmTrees },
  claude: collectClaude(Object.values(npmTrees)),
  fonts: collectFonts(),
  bundled_notices: collectNotices(),
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
writeFileSync(join(OUT, 'inventory.md'), markdown(inventory) + '\n')
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
  not_a_legal_opinion: true,
  public_redistributable_image: false,
  office_functionality: inventory.office_functionality,
  os: inventory.os.os_release.PRETTY_NAME || inventory.os.os_release.ID,
  os_packages: inventory.os.package_count,
  npm_package_counts: Object.fromEntries(Object.entries(npmTrees).map(([k, v]) => [k, v.package_count])),
  unusual_npm_license_fields: unusualLicenses(uniquePackages(Object.values(npmTrees).flatMap((t) => t.packages || []))),
  claude_present: inventory.claude.present,
  claude_packages: inventory.claude.packages_found.map((p) => `${p.name}@${p.version}`),
  font_files: inventory.fonts.file_count,
  font_notices: inventory.fonts.notices.length,
  bundled_notice_files: inventory.bundled_notices.files.map((f) => f.path),
}, null, 2) + '\n')
console.log('wrote', join(OUT, 'inventory.json'))
console.log('os_packages', inventory.os.package_count)
console.log('npm', Object.fromEntries(Object.entries(npmTrees).map(([k, v]) => [k, v.package_count])))
console.log('claude_present', inventory.claude.present)
console.log('fonts', inventory.fonts.file_count)
