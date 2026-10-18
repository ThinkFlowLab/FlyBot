// Packs each FlyBot package as a DSH profile would install it and checks the tarball:
// every `main`/`exports` target and every `files` entry is inside, nothing from test/ or dev/
// leaks in. Usage: node .github/scripts/check-pack.mjs [outDir]  (run from the repo root;
// with outDir the .tgz files are kept there, for a release).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const packages = ['core', 'plugins/social', 'plugins/tree', 'plugins/timeline']
const out = process.argv[2] ? resolve(process.argv[2]) : undefined
if (out) mkdirSync(out, { recursive: true })
let failed = false
const targets = (exp) => typeof exp === 'string' ? [exp] : exp && typeof exp === 'object' ? Object.values(exp).flatMap(targets) : []
for (const dir of packages) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const args = ['pack', '--json', '--ignore-scripts', ...(out ? ['--pack-destination', out] : ['--dry-run'])]
  const [info] = JSON.parse(execFileSync('npm', args, { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' }))
  const inside = new Set(info.files.map((f) => f.path))
  const has = (p) => inside.has(p.replace(/^\.\//, '')) || [...inside].some((f) => f.startsWith(p.replace(/^\.\//, '').replace(/\/?$/, '/')))
  const want = [pkg.main ?? 'index.js', ...targets(pkg.exports), ...(pkg.files ?? [])]
  const missing = [...new Set(want)].filter((p) => !has(p))
  const leaked = [...inside].filter((f) => /^(test|dev)\//.test(f))
  console.log(`${pkg.name}@${pkg.version}: ${info.files.length} files, ${(info.size / 1024).toFixed(0)} KiB packed${out ? ` -> ${info.filename}` : ''}`)
  for (const p of missing) { console.error(`  missing from the package: ${p}`); failed = true }
  for (const p of leaked) { console.error(`  should not be packed: ${p}`); failed = true }
}
if (failed) process.exit(1)
