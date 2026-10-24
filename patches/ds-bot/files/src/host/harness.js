// Step 0 (#903 / #874 Option B): one declarative harness layer.
// Today's setup is the single `default` harness. Behavior-neutral: the runtime still
// runs the same modules; this file names them as one config so Step 1 can add tiers later.
//
// Tree prompt exception: `@flybot/tree` keeps its own marked prompt under `plugins/tree`
// (not one of the three mirrors ds-bot/ · patches/ds-bot/ · core/). That injection stays
// outside this harness file; eval `P3-tree-split` must keep passing.

export const DEFAULT_HARNESS_ID = 'default'

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

export function resolveHarness(id = DEFAULT_HARNESS_ID) {
  if (id !== DEFAULT_HARNESS_ID) throw new Error(`unknown harness: ${id}`)
  return defaultHarness()
}

export function install(rt) {
  rt.harness = resolveHarness(DEFAULT_HARNESS_ID)
  rt.resolveHarness = resolveHarness
}
