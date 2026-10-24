// Declarative harness layer (#874 Option B).
//
// Step 0 (#903): today's setup is the `default` harness. It names the modules the
// runtime already runs. It does not replace them.
//
// Step 1: Lite, Medium, and Heavy are three more configs on that same layer.
// Each one points at the same modules and adds a budget (prompt size, tool cap
// and allow-list, model output cap, step/retry cap). `applied` is false: loading
// a tier does not change prompt.js, tools.js, models.js, or turns.js. The
// default path stays the process harness. Triage picks a tier with one label
// (`harness:lite`, `harness:medium`, `harness:heavy`); `risk:T*` is not a harness.
//
// HarnessPro is the offline check for that config. It names CI, core/dev/eval,
// and rsi-baseline. It does not run them and it does not call a model.
//
// Tree prompt exception: `@flybot/tree` keeps its own marked prompt under
// `plugins/tree` (not one of the three mirrors). That injection stays outside
// this file; eval `P3-tree-split` must keep passing.

export const DEFAULT_HARNESS_ID = 'default'

// Triage sets exactly one of these. The controller does not write them, and
// they are not risk tiers.
export const HARNESS_TIER_LABELS = Object.freeze({
  lite: 'harness:lite',
  medium: 'harness:medium',
  heavy: 'harness:heavy',
})

export const HARNESS_PRO_VERIFIERS = Object.freeze(['ci', 'core/dev/eval', 'rsi-baseline'])

const TIER_BUDGETS = {
  lite: {
    prompt: { maxChars: 8_000 },
    tools: {
      maxCalls: 8,
      allow: ['list_bots', 'list_models', 'recall', 'read_own_chat', 'read_group_chat', 'list_secrets'],
    },
    model: { maxTokens: 2_048 },
    stepRetry: { maxSteps: 4, maxRetries: 0 },
  },
  medium: {
    prompt: { maxChars: 16_000 },
    tools: {
      maxCalls: 24,
      allow: [
        'list_bots', 'list_models', 'recall', 'read_own_chat', 'read_group_chat', 'list_secrets',
        'message_bot', 'ask_user', 'remember', 'forget', 'list_capabilities', 'bot_schedules',
        'read_browser', 'request_secret', 'post_to_group', 'update_bot', 'record_decision',
      ],
    },
    model: { maxTokens: 8_192 },
    stepRetry: { maxSteps: 12, maxRetries: 1 },
  },
  heavy: {
    prompt: { maxChars: 48_000 },
    tools: { maxCalls: 64, allow: null },
    model: { maxTokens: 16_384 },
    stepRetry: { maxSteps: 32, maxRetries: 1 },
  },
}

export function defaultHarness() {
  return {
    id: DEFAULT_HARNESS_ID,
    prompt: { module: './prompt.js', section: 'bot-identity' },
    tools: { module: './tools.js' },
    model: { module: './models.js', note: 'per-Bot model on the Bot record' },
    stepRetry: { module: './turns.js', note: 'written-tool-call retry and turn lifecycle' },
    verifiers: { note: 'CI, merge-gate, and core/dev/eval; not an in-process Step 0 list' },
    exceptions: [
      {
        id: 'tree-prompt',
        path: 'plugins/tree',
        note: '@flybot/tree marked prompt stays outside the default harness file',
      },
    ],
  }
}

function tierHarness(id) {
  const budget = TIER_BUDGETS[id]
  const base = defaultHarness()
  return {
    ...base,
    id,
    prompt: { ...base.prompt, maxChars: budget.prompt.maxChars },
    tools: {
      ...base.tools,
      maxCalls: budget.tools.maxCalls,
      allow: budget.tools.allow === null ? null : [...budget.tools.allow],
    },
    model: { ...base.model, maxTokens: budget.model.maxTokens },
    stepRetry: {
      ...base.stepRetry,
      maxSteps: budget.stepRetry.maxSteps,
      maxRetries: budget.stepRetry.maxRetries,
    },
    verifiers: {
      offline: [...HARNESS_PRO_VERIFIERS],
      note: 'HarnessPro checks this config offline against CI, core/dev/eval, and rsi-baseline. No model call.',
    },
    // Declared budget only. The named modules still run as they do for default.
    applied: false,
  }
}

const TIERS = {
  lite: () => tierHarness('lite'),
  medium: () => tierHarness('medium'),
  heavy: () => tierHarness('heavy'),
}

export function resolveHarness(id = DEFAULT_HARNESS_ID) {
  if (id === DEFAULT_HARNESS_ID) return defaultHarness()
  const build = TIERS[id]
  if (!build) throw new Error(`unknown harness: ${id}`)
  return build()
}

function labelNames(input) {
  const list = Array.isArray(input) ? input : (input?.labels ?? [])
  const names = []
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (typeof name === 'string' && name.trim() !== '') names.push(name.trim().toLowerCase())
  }
  return names
}

export function routeHarness(input) {
  const byLabel = new Map(Object.entries(HARNESS_TIER_LABELS).map(([id, label]) => [label, id]))
  const hits = []
  for (const name of labelNames(input)) {
    if (!name.startsWith('harness:')) continue
    const id = byLabel.get(name)
    if (id === undefined) throw new Error(`unknown harness label: ${name}`)
    if (!hits.includes(id)) hits.push(id)
  }
  if (hits.length > 1) throw new Error(`one harness tier label, got ${hits.map(id => HARNESS_TIER_LABELS[id]).join(', ')}`)
  return resolveHarness(hits[0] ?? DEFAULT_HARNESS_ID)
}

function secretAt(value, path) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = secretAt(value[index], `${path}[${index}]`)
      if (found) return found
    }
    return ''
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const here = path === '' ? key : `${path}.${key}`
      if (/api[_-]?key/i.test(key) || /^(token|secret|password|authorization)$/i.test(key)) return here
      const found = secretAt(child, here)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'string' && (/\bsk-[A-Za-z0-9]{8,}\b/.test(value) || value.includes('DEEPSEEK_API_KEY') || value.includes('GITHUB_TOKEN'))) {
    return path === '' ? 'value' : path
  }
  return ''
}

// Offline shape check. A tier must keep the default modules and name the three
// HarnessPro verifiers. This function does not run CI, eval, or rsi-baseline.
export function harnessPro(harness) {
  const failures = []
  const base = defaultHarness()
  if (!harness || typeof harness.id !== 'string') failures.push('id')
  else if (harness.id !== DEFAULT_HARNESS_ID && TIERS[harness.id] === undefined) failures.push('id')
  for (const key of ['prompt', 'tools', 'model', 'stepRetry']) {
    if (harness?.[key]?.module !== base[key].module) failures.push(`${key}.module`)
  }
  if (harness?.id && harness.id !== DEFAULT_HARNESS_ID) {
    const offline = harness.verifiers?.offline
    const same = Array.isArray(offline)
      && offline.length === HARNESS_PRO_VERIFIERS.length
      && HARNESS_PRO_VERIFIERS.every((name, index) => offline[index] === name)
    if (!same) failures.push('verifiers.offline')
    if (!(harness.prompt?.maxChars > 0)) failures.push('prompt.maxChars')
    if (!(harness.tools?.maxCalls > 0)) failures.push('tools.maxCalls')
    if (harness.tools?.allow !== null && !Array.isArray(harness.tools?.allow)) failures.push('tools.allow')
    if (!(harness.model?.maxTokens > 0)) failures.push('model.maxTokens')
    if (!(harness.stepRetry?.maxSteps > 0)) failures.push('stepRetry.maxSteps')
    if (!Number.isInteger(harness.stepRetry?.maxRetries) || harness.stepRetry.maxRetries < 0) failures.push('stepRetry.maxRetries')
  }
  const secret = secretAt(harness, '')
  if (secret) failures.push(`secret at ${secret}`)
  return { ok: failures.length === 0, failures, verifiers: [...HARNESS_PRO_VERIFIERS] }
}

export function harnessTierOrder() {
  const lite = resolveHarness('lite')
  const medium = resolveHarness('medium')
  const heavy = resolveHarness('heavy')
  const axes = {
    'prompt.maxChars': [lite.prompt.maxChars, medium.prompt.maxChars, heavy.prompt.maxChars],
    'tools.maxCalls': [lite.tools.maxCalls, medium.tools.maxCalls, heavy.tools.maxCalls],
    'model.maxTokens': [lite.model.maxTokens, medium.model.maxTokens, heavy.model.maxTokens],
    'stepRetry.maxSteps': [lite.stepRetry.maxSteps, medium.stepRetry.maxSteps, heavy.stepRetry.maxSteps],
    'stepRetry.maxRetries': [lite.stepRetry.maxRetries, medium.stepRetry.maxRetries, heavy.stepRetry.maxRetries],
  }
  const failures = []
  for (const [name, [low, mid, high]] of Object.entries(axes)) {
    if (!(low <= mid && mid <= high) || low === high) failures.push(name)
  }
  if (!Array.isArray(lite.tools.allow) || !Array.isArray(medium.tools.allow)) failures.push('allow')
  else {
    for (const tool of lite.tools.allow) {
      if (!medium.tools.allow.includes(tool)) failures.push(`allow ${tool}`)
    }
    if (lite.tools.allow.length >= medium.tools.allow.length) failures.push('allow size')
  }
  if (heavy.tools.allow !== null) failures.push('heavy.allow')
  return { ok: failures.length === 0, failures, axes }
}

export function install(rt) {
  rt.harness = resolveHarness(DEFAULT_HARNESS_ID)
  rt.resolveHarness = resolveHarness
  rt.routeHarness = routeHarness
}
