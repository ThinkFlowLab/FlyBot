// Install doctor: checks the Node floor and the three plugin packages a FlyBot install
// needs before the maintainer runs the install commands. Reads the filesystem only: no
// network, no tokens, no ~/.dsh.
//
//   node scripts/install-doctor.mjs   prints PASS/FAIL per check and the install commands
//
// The package name of the core is still ds-bot after the ds-bot -> core rename; the
// GitHub paths below are what they look like inside the FlyBot repository.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_FLOOR = '22.19.0'

const PACKAGES = [
  ['core', 'ds-bot'],
  ['plugins/social', '@flybot/social'],
  ['plugins/tree', '@flybot/tree'],
  ['plugins/timeline', '@flybot/timeline'],
]

export function parseNodeVersion(versionString) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionString ?? ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function nodeMeetsFloor(versionString, floor = NODE_FLOOR) {
  const have = parseNodeVersion(versionString)
  const want = parseNodeVersion(floor)
  if (!have || !want) return false
  if (have.major !== want.major) return have.major > want.major
  if (have.minor !== want.minor) return have.minor > want.minor
  return have.patch >= want.patch
}

// A plugin package is installable when it has a package.json with the expected name and
// a dsh.bundle.patch that resolves to a file. Malformed manifests are reported, never thrown.
export function checkPluginPackage(pluginDir, expectedName) {
  const errors = []
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') errors.push(`no package.json in ${pluginDir}`)
    else if (error instanceof SyntaxError) errors.push(`package.json is not valid JSON: ${error.message}`)
    else errors.push(`package.json cannot be read: ${error.message}`)
    return { ok: false, errors }
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { ok: false, errors: [`package.json in ${pluginDir} must hold a JSON object`] }
  }
  if (manifest.name !== expectedName) {
    errors.push(`package name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(expectedName)}`)
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined || patch === null) {
    errors.push('dsh.bundle.patch is missing')
  } else if (typeof patch !== 'string') {
    errors.push(`dsh.bundle.patch must be a string, not ${typeof patch}`)
  } else {
    try {
      if (!statSync(join(pluginDir, patch)).isFile()) errors.push(`dsh.bundle.patch is not a file: ${patch}`)
    } catch (error) {
      errors.push(`dsh.bundle.patch cannot be resolved: ${patch} (${error.message})`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export function buildInstallCommands({
  repo = 'ThinkFlowLab/FlyBot',
  ref = 'main',
  profile = 'web',
  dshPackage = '@deepseek-ai/dsh@0.2.0-rc.2',
} = {}) {
  return ['/core', '/plugins/social', '/plugins/tree', '/plugins/timeline']
    .map(path => `npx -y ${dshPackage} plugin --profile ${profile} add "github:${repo}#${ref}&path:${path}"`)
}

export function defaultRoot() {
  return join(fileURLToPath(new URL('..', import.meta.url)), '..')
}

export function runDoctor({ root = defaultRoot(), nodeVersion = process.version } = {}) {
  const checks = []
  const nodeOk = nodeMeetsFloor(nodeVersion)
  checks.push({
    label: `Node ${nodeVersion} meets the floor ${NODE_FLOOR}`,
    ok: nodeOk,
    errors: nodeOk ? [] : [`Node ${nodeVersion} is older than ${NODE_FLOOR}`],
  })
  for (const [dir, expectedName] of PACKAGES) {
    const result = checkPluginPackage(join(root, ...dir.split('/')), expectedName)
    checks.push({ label: `${dir} is a plugin package named ${expectedName}`, ...result })
  }
  return { ok: checks.every(check => check.ok), root, checks, commands: buildInstallCommands() }
}

function main() {
  const report = runDoctor()
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label}`)
    for (const error of check.errors) console.log(`     ${error}`)
  }
  console.log('\nInstall commands:')
  for (const command of report.commands) console.log(`  ${command}`)
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} install doctor on ${report.root}`)
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
