// Keep the pinned DSH driver aligned with its journal after FlyBot imports
// historical turns under the native Agent's idle maintenance reservation.
import {readFileSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'

const harnessPackage = process.argv[2] || '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'
const requireFromHarness = createRequire(harnessPackage)
const entry = requireFromHarness.resolve('@deepseek-ai/dsh-agent-loop')
const manifest = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'))
if (manifest.name !== '@deepseek-ai/dsh-agent-loop') throw new Error('Unexpected native agent driver package')

const source = readFileSync(entry, 'utf8')
const before = '\t\t\tturn: this.phase.lastTurn,'
const after = '\t\t\tturn: this.loopCtx.agents.turnBoundaryOf(this.session).lastTurn,'
if (source.split(before).length !== 2 || source.includes(after)) {
  throw new Error('Native agent wake boundary changed. Review the FlyBot history import against this DSH version.')
}
writeFileSync(entry, source.replace(before, after))
