// Lint the peer plugins under plugins/ with the oxlint that core's `npm run harness` installs
// (core/dev/harness, or DSH_HARNESS), using core's .oxlintrc.json, so plugins need no copy of
// their own. Also fails if runtime sources import outside the plugin package (#153).
// Usage: node scripts/lint-plugins.mjs [name ...]   (default: every plugins/* dir)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

export const root = resolve(import.meta.dirname, '..')

const BUILTIN = new Set(builtinModules.flatMap((name) => name.startsWith('node:') ? [name, name.slice(5)] : [name, `node:${name}`]))

function declaredNames(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
}

function packageNameOf(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.slice(0, 2).join('/')
  }
  return spec.split('/')[0]
}

export function specifiersOf(source) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const found = []
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(text))) found.push(match[1])
  }
  return found
}

export function runtimeFiles(pluginDir) {
  const files = []
  const add = (rel) => {
    const path = join(pluginDir, rel)
    if (existsSync(path)) files.push(path)
  }
  add('index.js')
  add('client.js')
  const src = join(pluginDir, 'src')
  if (!existsSync(src)) return files
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name)
      if (ent.isDirectory()) walk(path)
      else if (/\.(c|m)?js$/.test(ent.name)) files.push(path)
    }
  }
  walk(src)
  return files
}

function insidePackage(pluginDir, resolved) {
  const rel = relative(pluginDir, resolved)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function outboundImports(pluginDir, pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))) {
  const declared = declaredNames(pkg)
  const problems = []
  for (const file of runtimeFiles(pluginDir)) {
    const relFile = relative(pluginDir, file).split(sep).join('/')
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (!spec || spec.startsWith('node:') || BUILTIN.has(spec)) continue
      if (spec.startsWith('.') || spec.startsWith('/') || isAbsolute(spec)) {
        if (!insidePackage(pluginDir, resolve(dirname(file), spec))) problems.push({ file: relFile, spec })
        continue
      }
      const name = packageNameOf(spec)
      if (declared.has(name)) continue
      if (name === 'react' && relFile === 'client.js') continue
      problems.push({ file: relFile, spec })
    }
  }
  return problems
}

export function packPlugin(pluginDir, destDir) {
  const [info] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destDir], {
    cwd: pluginDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }))
  const tgz = join(destDir, info.filename)
  execFileSync('tar', ['-xzf', tgz, '-C', destDir])
  return join(destDir, 'package')
}

export async function importPackedPlugin(pluginDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'flybot-plugin-pack-'))
  try {
    const packed = packPlugin(pluginDir, tmp)
    const pkg = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'))
    return await import(pathToFileURL(join(packed, pkg.main ?? 'index.js')).href)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function oxlintBin() {
  const harness = [process.env.DSH_HARNESS, join(root, 'core', 'dev', 'harness')].filter(Boolean)
  return harness.map((dir) => join(dir, 'node_modules', 'oxlint', 'bin', 'oxlint')).find(existsSync)
}

function pluginNames(argv) {
  const names = argv.slice(2)
  return names.length ? names : readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
}

export function main(argv = process.argv) {
  const bin = oxlintBin()
  if (!bin) {
    console.error('lint-plugins: no oxlint found; run `npm run harness` in core/, or set DSH_HARNESS')
    process.exit(2)
  }
  let status = 0
  for (const name of pluginNames(argv)) {
    const dir = join('plugins', name)
    const pluginDir = join(root, dir)
    if (!existsSync(join(pluginDir, 'package.json'))) { console.error(`lint-plugins: ${dir} is not a plugin`); status = 2; continue }
    console.log(`=== lint ${dir} ===`)
    const result = spawnSync(process.execPath, [bin, '-c', join('core', '.oxlintrc.json'), '--ignore-pattern', '**/dist/**', dir], { cwd: root, stdio: 'inherit' })
    if (result.error) console.error(`lint-plugins: ${result.error.message}`)
    if (result.status !== 0) status = result.status ?? 1
    const leaks = outboundImports(pluginDir)
    if (leaks.length) {
      for (const { file, spec } of leaks) console.error(`lint-plugins: ${dir}/${file} imports ${JSON.stringify(spec)} (outside this package)`)
      status = 1
    }
    console.log(`=== pack-import ${dir} ===`)
    const tmp = mkdtempSync(join(tmpdir(), 'flybot-plugin-pack-'))
    try {
      const packed = packPlugin(pluginDir, tmp)
      const pkg = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'))
      const href = pathToFileURL(join(packed, pkg.main ?? 'index.js')).href
      const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`], { cwd: tmp, stdio: 'inherit' })
      if (loaded.error) console.error(`lint-plugins: ${loaded.error.message}`)
      if (loaded.status !== 0) {
        console.error(`lint-plugins: packed ${dir} failed to import`)
        status = loaded.status ?? 1
      } else {
        console.log(`lint-plugins: packed ${pkg.name} imported`)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  process.exit(status)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
