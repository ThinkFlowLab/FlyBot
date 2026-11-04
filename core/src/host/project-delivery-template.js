// One versioned path through the existing Workflow plugin; no second execution engine.
export const DELIVERY_VERSION = 'project-delivery/v8'
export const DELIVERY_ROLES = ['developer', 'tester', 'reviewer']
export function deliveryGraph(model = '') {
  return {
    maxConcurrent: 1,
    nodes: [
      { id: 'developer', name: 'Developer', role: 'Developer', model, tools: [],
        prompt: 'Implement the task in your assigned worktree. Read the acceptance criteria, edit code and tests. Do not publish, change credentials or edit outside this worktree. The host seals the candidate commit. Finish with OUTPUT implementation: a concise change summary.',
        outputs: [{ name: 'implementation', required: true }] },
      { id: 'tester', name: 'Tester', role: 'Tester', model, tools: [],
        prompt: 'Inspect the implementation in your assigned worktree. Do not edit files. The host independently runs the configured tests against the sealed commit. Finish with OUTPUT tests: your analysis of relevant test coverage.',
        inputs: [{ name: 'implementation', required: true }], outputs: [{ name: 'tests', required: true }] },
      { id: 'reviewer', name: 'Reviewer', role: 'Reviewer', model, tools: [],
        prompt: 'Independently review the candidate diff against the task and acceptance criteria in this worktree. Do not edit files. Read git rev-parse HEAD for the exact candidate SHA. Report findings honestly. Finish with OUTPUT review: {"commit":"the full SHA","verdict":"approve or request-changes","summary":"your findings"}. Approval must name the exact commit you inspected. Under an explicit host merge policy, approve enters the host merge flow; do not run merge commands yourself.',
        inputs: [{ name: 'implementation', required: true }, { name: 'tests', required: true }], outputs: [{ name: 'review', required: true }] },
    ],
    edges: [{ from: 'developer', to: 'tester' }, { from: 'developer', to: 'reviewer' }, { from: 'tester', to: 'reviewer' }],
  }
}
