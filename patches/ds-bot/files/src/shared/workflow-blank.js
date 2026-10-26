// The `blank` preset (#1272): three nodes, one Bot each, no guards, no repository. It is here as
// proof that a workflow is data — nothing in src/shared/workflow.js names these ids, and the same
// JSON dropped in the workspace as `workflows/blank.json` is the whole definition.

export const blankWorkflow = Object.freeze({
  id: 'blank',
  name: 'Blank',
  version: 1,
  inputs: ['text:topic'],
  deliverables: ['link:published'],
  nodes: [
    {
      id: 'draft',
      name: 'Draft',
      bot: 'Writer',
      inputs: ['text:topic'],
      outputs: ['text:draft'],
      guards: [],
      refusal: '{node} cannot start: it needs {spec} and has none.',
    },
    {
      id: 'review',
      name: 'Review',
      bot: 'Editor',
      inputs: ['text:draft'],
      outputs: ['text:edited'],
      guards: [],
      refusal: '{node} cannot start: its input {input} is missing or stale.',
    },
    {
      id: 'publish',
      name: 'Publish',
      bot: 'Publisher',
      inputs: ['text:edited'],
      outputs: ['link:published'],
      guards: [],
      refusal: '{node} cannot start: it needs {spec} and has none.',
    },
  ],
  edges: [
    { from: 'draft.text:draft', to: 'review.text:draft' },
    { from: 'review.text:edited', to: 'publish.text:edited' },
  ],
  loops: [],
})

// The Bots the preset names, so a caller can pass them as the team without inventing a roster.
export const BLANK_TEAM = Object.freeze(['Writer', 'Editor', 'Publisher'])
