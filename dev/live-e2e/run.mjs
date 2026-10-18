// The live runner for #204: one run, one fresh bench, four checks, no retries. Tasks go
// through the FlyBot web adapter; usage comes from an llm-tap log when one is given.
// Fails closed on every guard (missing/mock key, loopback endpoint, the user's own DSH
// home) and never reports a pass it did not see. Evidence is written under --evidence
// and scanned by sanitize.mjs; a finding there is an infra failure, and the bundle is
// not fit to upload.
//
//   node dev/live-e2e/run.mjs <bench-home> <web-port> [--model deepseek-official/deepseek-flash]
//        [--harness <deepseek-harness checkout>] [--tap <llm-tap.jsonl>]
//        [--evidence <dir>] [--tz Asia/Shanghai]
//
// Exit codes: 0 pass, 1 assertion_failed, 2 provider_failed, 3 infra_failed, 4 budget_exceeded.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { runScenarios } from './scenarios.mjs'
import { budgetsFrom, buildReport, guardRun, OUTCOMES, providerFailures, summaryLines, usageOf } from './report.mjs'
import { scanTree } from './sanitize.mjs'
import { openFlyBotWeb } from './adapter.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', default: 'deepseek-official/deepseek-flash' },
    harness: { type: 'string' },
    tap: { type: 'string' },
    evidence: { type: 'string' },
    tz: { type: 'string', default: process.env.TZ || 'Asia/Shanghai' },
  },
})
const [HOME, PORT] = positionals
if (!HOME || !PORT) {
  console.error('usage: node dev/live-e2e/run.mjs <bench-home> <web-port> [--model ref] [--harness dir] [--tap file] [--evidence dir] [--tz zone]')
  process.exit(OUTCOMES.infra_failed)
}

const budgets = budgetsFrom(process.env)
const evidence = args.evidence ?? join(HOME, 'evidence')
const startedAt = new Date()
const runId = randomUUID()
const revision = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dshVersion = JSON.parse(readFileSync(join(ROOT, 'core/dev/harness/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
const tapLines = () => (args.tap && existsSync(args.tap) ? readFileSync(args.tap, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])

const writeReport = (report) => {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}
const conclude = (report) => {
  writeReport(report)
  console.log(summaryLines(report).join('\n'))
  process.exit(report.exitCode)
}
const stoppedEarly = (outcome, problems) => {
  const report = buildReport({
    runId, revision,
    config: { node: process.version, dsh: dshVersion, model: args.model },
    endpoint: { host: 'not reached', origin: 'not reached', viaTap: false },
    budgets, checks: [], usage: usageOf(tapLines()), providerFailures: providerFailures(tapLines()),
    startedAt, endedAt: new Date(), tz: args.tz,
  })
  report.outcome = outcome
  report.exitCode = OUTCOMES[outcome]
  report.guardProblems = problems
  return report
}

// Guards first: never open a browser — or write anything — against a bench that should
// not exist, so a guard failure prints and exits without touching the passed home.
const guard = guardRun({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL, tapUpstream: process.env.LIVE_E2E_TAP_UPSTREAM, home: HOME, userHome: homedir() })
if (guard.problems.length > 0) {
  console.error(guard.problems.join('\n'))
  console.error(`outcome infra_failed (exit ${OUTCOMES.infra_failed})`)
  process.exit(OUTCOMES.infra_failed)
}
const harness = args.harness ?? process.env.DSH_HARNESS ?? join(ROOT, 'deepseek-harness')
if (!existsSync(harness)) conclude(stoppedEarly('infra_failed', [`no deepseek-harness checkout at ${harness}; pass --harness or set DSH_HARNESS`]))
mkdirSync(evidence, { recursive: true })

let adapter
try {
  adapter = await openFlyBotWeb({ harness, home: HOME, port: Number(PORT), model: args.model, outDir: evidence, quietMs: budgets.quietMs, checkMs: budgets.checkMs })
} catch (error) {
  const provider = providerFailures(tapLines())
  conclude(stoppedEarly(provider.length > 0 ? 'provider_failed' : 'infra_failed', [error.message]))
}

let checks = []
let override
try {
  const { results, stopped } = await runScenarios(adapter, {
    checkMs: budgets.checkMs,
    betweenChecks: () => {
      const usage = usageOf(tapLines())
      return usage.prompt + usage.output > budgets.maxTokens
        ? { stop: true, reason: `the token cap was reached (${usage.prompt + usage.output} > ${budgets.maxTokens})` }
        : {}
    },
  })
  checks = results
  if (stopped) override = { outcome: 'budget_exceeded', problem: stopped }
} catch (error) {
  // Adapter failures (bench, browser, timeouts) are infra unless the provider explains
  // them; assertion mismatches are already inside the checks.
  const provider = providerFailures(tapLines())
  override = { outcome: provider.length > 0 ? 'provider_failed' : 'infra_failed', problem: error.message }
  checks.push({ id: 'run', title: 'the run itself', outcome: override.outcome, problems: [error.message] })
  await adapter.screenshot('failure').catch(() => {})
}

const report = buildReport({
  runId, revision,
  config: { node: process.version, dsh: dshVersion, model: adapter.modelId ?? args.model },
  endpoint: guard.endpoint,
  budgets, checks, usage: usageOf(tapLines()),
  providerFailures: providerFailures(tapLines()),
  startedAt, endedAt: new Date(), tz: args.tz,
})
if (override) {
  report.outcome = override.outcome
  report.exitCode = OUTCOMES[override.outcome]
  report.stoppedBecause = override.problem
}

const transcript = await adapter.conversationLines().catch(() => [])
writeFileSync(join(evidence, 'transcript.txt'), transcript.map(line => `${line.who}: ${line.text}`).join('\n'))
await adapter.close().catch(() => {})

// Evidence gate: a finding means the bundle is not fit to upload; that is infra, not a
// pass. The stamp is written last, only after a clean scan and the finished report, and
// the workflow's upload step requires it — so a contaminated bundle never becomes an
// artifact (it stays on the bench for debugging).
const findings = scanTree(evidence, process.env.DEEPSEEK_API_KEY)
if (findings.length > 0) {
  report.outcome = 'infra_failed'
  report.exitCode = OUTCOMES.infra_failed
  report.sanitizerFindings = findings
}
writeReport(report)
if (findings.length === 0) writeFileSync(join(evidence, 'sanitized.txt'), `run ${runId} sanitized at ${new Date().toISOString()}\n`)
console.log(summaryLines(report).join('\n'))
process.exit(report.exitCode)
