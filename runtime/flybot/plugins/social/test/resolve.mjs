// Test-only module resolution for @flybot/social.
// This OpenTeamily snapshot does not vendor FlyBot `core/` (the old v0.1.5 fork).
// The runtime baseline is upstream DS-Bot v0.3.6 (see PR #21, runtime/ds-bot-upstream/).
// If FLYBOT_CORE (or a future layered checkout) is present, `ds-bot` and `@deepseek-ai/*`
// resolve the way a DSH profile would. Otherwise hooks are skipped so plugin-only tests can run.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const core = process.env.FLYBOT_CORE ? resolve(process.env.FLYBOT_CORE) : undefined
if (core && existsSync(join(core, 'package.json'))) {
  const harness = process.env.DSH_HARNESS ?? join(core, 'dev', 'harness')
  process.env.DSH_HARNESS = harness
  process.env.FLYBOT_CORE = core
  const base = resolve(harness, 'packages/bundle/base/package.json')
  const anchor = pathToFileURL(existsSync(base) ? base : resolve(harness, 'package.json')).href
  const coreUrl = `${pathToFileURL(core).href}/`
  const entry = pathToFileURL(join(core, 'index.js')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'ds-bot') return { url: entry, format: 'module', shortCircuit: true }
      if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(coreUrl)) {
        return nextResolve(specifier, { ...context, parentURL: anchor })
      }
      return nextResolve(specifier, context)
    },
  })
}
