// Bench preflight (dev/bench.sh): refuse before the profile is written when the bench cannot
// start, and say what to do about it. Both failures otherwise surface much later as smoke
// failures that look like plugin bugs — no pnpm leaves the profile without node_modules, so
// `dsh` never resolves the plugin bundle; no prebuilt native addon boots the web server but
// fails every Bot turn. A deepseek-harness source checkout carries no native `bin/`, so it
// needs the prebuilt copy from the installed `@deepseek-ai/node-addon-system-<platform>` package.
//
//   node dev/bench-preflight.mjs <harness-dir>
//
// Exit 0 when the bench can start, 1 with the remedy on stderr when it cannot, 2 on bad usage.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The addon loader picks the directory from Node's report, not from the ELF interpreter, so the
// preflight must read the same signal to name the file the loader would try.
export function libcName(platform = process.platform, report = process.report?.getReport()) {
  if (platform !== 'linux') return undefined
  return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
}

export function addonSubpath({ platform = process.platform, libc = libcName(platform) } = {}) {
  return join('bin', ...(libc ? [libc] : []), 'system.node')
}

export function nativeAddonPath(harnessDir, { platform = process.platform, arch = process.arch, libc = libcName(platform) } = {}) {
  return join(harnessDir, 'native', 'system', 'packages', `${platform}-${arch}`, addonSubpath({ platform, libc }))
}

export function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  return !result.error && result.status === 0
}

export function checkBench({
  harnessDir,
  platform = process.platform,
  arch = process.arch,
  libc = libcName(platform),
  hasPnpm = commandExists('pnpm'),
  exists = existsSync,
} = {}) {
  const addon = harnessDir ? nativeAddonPath(harnessDir, { platform, arch, libc }) : undefined
  const result = {
    platform,
    arch,
    libc,
    harnessDir,
    addon,
    package: `@deepseek-ai/node-addon-system-${platform}-${arch}`,
    subpath: addonSubpath({ platform, libc }),
  }
  if (!hasPnpm) return { ...result, ok: false, state: 'missing-pnpm' }
  // An installed harness resolves the addon from its own node_modules; only a source checkout
  // has native/system/packages, and only that tree needs the prebuilt bin/ copied into it.
  const sourceTree = harnessDir && exists(join(harnessDir, 'native', 'system', 'packages'))
  if (sourceTree && !exists(addon)) return { ...result, ok: false, state: 'missing-native-addon' }
  return { ...result, ok: true, state: 'pass' }
}

export function problemLine(result) {
  if (result.state === 'missing-pnpm') {
    return 'bench preflight: pnpm is not on PATH — the profile install needs it; `corepack pnpm` supplies pnpm (put a `pnpm` shim that execs it on PATH, e.g. tools/bin/pnpm).'
  }
  if (result.state === 'missing-native-addon') {
    return `bench preflight: no native addon at ${result.addon} — copy ${result.package}/${result.subpath} (installed under core/dev/harness by \`npm run harness\`) into ${dirname(result.addon)}.`
  }
  return undefined
}

export function main(argv = process.argv.slice(2)) {
  const harnessDir = argv[0] ?? process.env.DSH_HARNESS
  if (!harnessDir) {
    console.error('usage: node dev/bench-preflight.mjs <harness-dir>')
    return 2
  }
  const result = checkBench({ harnessDir })
  if (result.ok) return 0
  console.error(problemLine(result))
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
