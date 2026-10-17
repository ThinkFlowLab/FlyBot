// The outcome contract and the report assembly for the #204 live runner. Pure code,
// covered keyless by test/report.test.mjs.
//
// One run ends in exactly one outcome:
//   pass (exit 0)              every check passed within its budgets
//   assertion_failed (exit 1)  the app did the task wrong (content, immutability, preview)
//   provider_failed (exit 2)   the model endpoint rejected or failed a call (401/429/5xx)
//   infra_failed (exit 3)      bench, browser, secret or guard failures; never reported as a pass
//   budget_exceeded (exit 4)   a check or the token cap ran out; never retried silently
export const OUTCOMES = { pass: 0, assertion_failed: 1, provider_failed: 2, infra_failed: 3, budget_exceeded: 4 }

export const DEFAULT_BUDGETS = { checkMs: 180_000, quietMs: 6_000, maxTokens: 250_000 }

export function budgetsFrom(env) {
  const num = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  return {
    checkMs: num(env.LIVE_E2E_CHECK_MS, DEFAULT_BUDGETS.checkMs),
    quietMs: num(env.LIVE_E2E_QUIET_MS, DEFAULT_BUDGETS.quietMs),
    maxTokens: num(env.LIVE_E2E_MAX_TOKENS, DEFAULT_BUDGETS.maxTokens),
  }
}

// Fail-closed checks on the run's inputs. A loopback base URL is the mock bench (or the
// usage tap, which names the real upstream in LIVE_E2E_TAP_UPSTREAM); anything else
// without a key, or with the mock's key, is refused rather than run.
export function guardRun({ apiKey, baseUrl, tapUpstream, home, userHome }) {
  const problems = []
  if (!apiKey || apiKey === 'mock-key' || apiKey.length < 16) problems.push('DEEPSEEK_API_KEY is missing, too short, or the mock key')
  let host = 'api.deepseek.com'
  let origin = 'default official endpoint'
  if (baseUrl) {
    try {
      host = new URL(baseUrl).host
      origin = baseUrl
    } catch { problems.push(`DEEPSEEK_BASE_URL is not a URL: ${baseUrl}`) }
  }
  const loopback = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/.test(host)
  if (loopback) {
    if (tapUpstream) {
      try {
        const upstream = new URL(tapUpstream).host
        if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/.test(upstream)) problems.push(`the usage tap's upstream is also loopback: ${tapUpstream}`)
      } catch { problems.push(`LIVE_E2E_TAP_UPSTREAM is not a URL: ${tapUpstream}`) }
    } else {
      problems.push(`DEEPSEEK_BASE_URL is loopback (${host}); the live suite never runs against the mock`)
    }
  }
  if (home && userHome && (home === userHome || home.startsWith(`${userHome}/.dsh`))) {
    problems.push(`the bench home ${home} is inside the user's own DSH data`)
  }
  return { problems, endpoint: { host, origin, viaTap: loopback } }
}

// The provider's health since a mark: llm-tap writes one line per call, and a failed
// call keeps `status`/`error` instead of `text`.
export function providerFailures(tapLines) {
  return tapLines.filter(line => line && line.status !== undefined && !String(line.status).startsWith('2') && !String(line.status).startsWith('3'))
    .map(line => `${line.status ?? 'error'} ${line.error ?? ''}`.trim())
}

export function usageOf(tapLines) {
  const usage = { calls: tapLines.length, prompt: 0, cached: 0, output: 0 }
  for (const line of tapLines) {
    const tokens = line.tokens
    if (!tokens) continue
    usage.prompt += tokens.prompt ?? 0
    usage.cached += tokens.cached ?? 0
    usage.output += tokens.output ?? 0
  }
  return usage
}

export function classify({ checkOutcomes, providerFailures: provider, tokenUsage, budgets }) {
  if (tokenUsage.prompt + tokenUsage.output > budgets.maxTokens) return 'budget_exceeded'
  if (provider.length > 0) return 'provider_failed'
  if (checkOutcomes.includes('assertion_failed')) return 'assertion_failed'
  if (checkOutcomes.includes('budget_exceeded')) return 'budget_exceeded'
  if (checkOutcomes.includes('infra_failed')) return 'infra_failed'
  return 'pass'
}

// Absolute timestamps with an explicit offset, plus the zone the run was asked to report
// in (Asia/Shanghai in CI and the pilot); durations are monotonic milliseconds the runner
// measured with performance.now().
export function buildReport({ runId, revision, config, endpoint, budgets, checks, usage, providerFailures = [], startedAt, endedAt, tz }) {
  const outcome = classify({ checkOutcomes: checks.map(check => check.outcome), providerFailures, tokenUsage: usage, budgets })
  const offset = date => {
    const minutes = -date.getTimezoneOffset()
    const sign = minutes < 0 ? '-' : '+'
    const abs = Math.abs(minutes)
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  }
  const human = (date) => {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(date)
    } catch { return date.toISOString() }
  }
  return {
    schema: 'flybot-live-e2e/1',
    runId,
    revision,
    config,
    endpoint,
    budgets,
    startedAt: { iso: startedAt.toISOString(), offset: offset(startedAt) },
    endedAt: { iso: endedAt.toISOString(), offset: offset(endedAt) },
    humanTimes: { zone: tz, startedAt: human(startedAt), endedAt: human(endedAt) },
    checks,
    usage,
    outcome,
    exitCode: OUTCOMES[outcome],
  }
}

export function summaryLines(report) {
  const lines = [
    `run ${report.runId} (${report.revision})`,
    `model ${report.config.model} via ${report.endpoint.viaTap ? `tap ${report.endpoint.origin} -> ${report.endpoint.host}` : report.endpoint.origin}`,
    `started ${report.startedAt.iso} (UTC${report.startedAt.offset}) / ${report.humanTimes.startedAt} ${report.humanTimes.zone}`,
    `ended ${report.endedAt.iso} (UTC${report.endedAt.offset}) / ${report.humanTimes.endedAt} ${report.humanTimes.zone}`,
    `usage ${report.usage.calls} calls, ${report.usage.prompt} prompt tokens (${report.usage.cached} cached), ${report.usage.output} output; cap ${report.budgets.maxTokens}`,
  ]
  for (const check of report.checks) {
    lines.push(`${check.outcome === 'pass' ? 'ok  ' : 'FAIL'} ${check.id} (${(check.durationMs ?? 0).toFixed(0)} ms) ${check.title}`)
    for (const problem of check.problems ?? []) lines.push(`      ${problem}`)
  }
  for (const problem of report.guardProblems ?? []) lines.push(`guard ${problem}`)
  if (report.stoppedBecause) lines.push(`stopped ${report.stoppedBecause}`)
  for (const finding of report.sanitizerFindings ?? []) lines.push(`unsanitized ${finding}`)
  lines.push(`outcome ${report.outcome} (exit ${report.exitCode})`)
  return lines
}
