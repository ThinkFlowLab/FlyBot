import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const harness = process.env.DSH_HARNESS || join(root, 'core/dev/harness')
const bin = join(harness, 'node_modules/oxlint/bin/oxlint')
if (!existsSync(bin)) throw new Error('Run npm run harness in core/, or set DSH_HARNESS')
const result = spawnSync(process.execPath, [bin, '-c', 'core/.oxlintrc.json', 'dev/live-e2e', 'scripts/lint-live-e2e.mjs'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
