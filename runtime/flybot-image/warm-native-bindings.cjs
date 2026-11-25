// Build-time helper: dsh's node-addon-require-builtin extracts a prebuilt .node
// into /tmp and dlopens it. The compose manager starts this image with a
// noexec tmpfs on /tmp, so that path is unusable at runtime. Copy the binding
// into the package's build/ directory (on the read-only, executable rootfs).
'use strict'
const { cpSync, existsSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { dirname, join } = require('node:path')

const DSH_MODULES = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules'
const builtin = join(DSH_MODULES, 'node-addon-require-builtin')
const prebuild = join(DSH_MODULES, 'node-addon-require-builtin-linux-x64-gnu')

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  let names
  try { names = readdirSync(dir) } catch { return acc }
  for (const name of names) {
    const path = join(dir, name)
    let st
    try { st = statSync(path) } catch { continue }
    if (st.isDirectory()) walk(path, acc)
    else if (name.endsWith('.node')) acc.push(path)
  }
  return acc
}

try {
  require(builtin)
} catch (error) {
  console.warn('warm-native-bindings: initial require failed:', error.message)
}

const found = [...walk(builtin), ...walk(prebuild), ...walk('/tmp'), ...walk('/root')]
console.log('warm-native-bindings: found', found.length, 'node bindings')
for (const path of found) console.log('  ', path)
const src = found.find((path) => path.includes('require_builtin')) ?? found[0]
if (!src) {
  console.error('warm-native-bindings: no .node file was produced')
  process.exit(1)
}

const abi = process.versions.modules
const dests = [
  join(builtin, `build/nodeabi/node-v${abi}-linux-x64-gnu/require_builtin.node`),
  join(builtin, 'build/napi/napi-v9-linux-x64-gnu/require_builtin.node'),
]
for (const dest of dests) {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest)
  console.log('warm-native-bindings: installed', dest)
}

process.env.TMPDIR = '/var/empty-flybot-workspace-no-tmp'
try {
  mkdirSync(process.env.TMPDIR, { recursive: true, mode: 0o500 })
} catch { /* best effort: a missing/empty tmpdir should force the build/ path */ }
delete require.cache[require.resolve(builtin)]
require(builtin)
console.log('warm-native-bindings: require succeeded without a usable /tmp')
