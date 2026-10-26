// The `repo-dev` preset (#1272 step 2): one repository change, from a ready issue to a release, as
// data. Every node names the role that does it, the typed facts it takes in and hands out, the guards
// that must hold before it starts, and the sentence it refuses with. No node id and no role is
// special-cased in `workflow.js`; the same calls run this and the `blank` preset.
//
// Two of the roles are not one Bot on a roster, and they say so in the form the engine can read
// rather than with a placeholder:
//   - `verify` is `SelfTest` **and** CI. The Bot runs the suite; the CI run is the `check:tests-ok`
//     fact this node hands out, and the node refuses until both the self-test and that fact exist.
//   - `gate` is held by *the Reviewer that judged the pull request*, which is the `by` of the verdict
//     this node takes in — not a fixed assignee. The role is `Reviewer` and the guards read the
//     verdict's own `Written-by`, so the card cannot be held by someone who did not write it.
//
// `column` is which board column a card in this node sits in (#1265). `review` carries `false`: a
// review is a pull request's state, not a third lane of its own, so the node stays in the definition
// and draws no column on the board.

export const repoDevWorkflow = Object.freeze({
  id: 'repo-dev',
  name: 'Repository change',
  version: 1,
  inputs: ['issue'],
  deliverables: ['release'],
  nodes: [
    {
      id: 'triage',
      name: 'Triage',
      role: 'Triage',
      column: 'not-started',
      inputs: ['issue'],
      outputs: ['issue.ready'],
      guards: [],
      refusal: '{node} cannot start: it needs {spec} and has not read it yet.',
    },
    {
      id: 'build',
      name: 'Build',
      role: 'Dev',
      column: 'in-progress',
      inputs: ['issue.ready'],
      outputs: ['pr'],
      guards: [],
      refusal: '{node} cannot start: its input {input} is not ready.',
    },
    {
      id: 'verify',
      name: 'Verify — SelfTest and CI',
      role: 'SelfTest',
      column: 'in-progress',
      inputs: ['pr'],
      outputs: ['check:tests-ok'],
      guards: [],
      refusal: '{node} cannot start: it needs {spec} and has not run it yet.',
    },
    {
      id: 'review',
      name: 'Review',
      role: 'Reviewer',
      // A review is the pull request's own state, not a column of the repository board (#1265).
      column: false,
      inputs: ['pr', 'check:tests-ok'],
      outputs: ['verdict'],
      guards: [
        {
          id: 'tests-ran-at-tip',
          spec: 'check:tests-ok',
          is: 'fresh',
          refusal: '{node} refuses: {input} did not run at the tip {now}, so there is nothing to review.',
        },
      ],
      refusal: '{node} cannot start: its input {input} is not current.',
    },
    {
      id: 'gate',
      name: 'Gate',
      role: 'Reviewer',
      column: 'in-progress',
      // The verdict is not an input the node waits for: it is the fact the guards check, which is what
      // says whether the pull request may go on at all. Its own revision is what the head guard reads.
      inputs: ['pr', 'check:tests-ok'],
      outputs: ['risk:tier'],
      guards: [
        {
          id: 'no-hold',
          spec: 'pr',
          is: 'equals',
          value: 'none',
          // The merge gate's own sentence for a held pull request (`merge-gate.mjs` `judge`), pinned
          // in `.github/scripts/fixtures/workflow-cases.json` and asserted byte for byte.
          refusal: 'the pull request carries the `hold` label',
        },
        {
          id: 'verdict-at-tip',
          spec: 'verdict',
          is: 'fresh',
          // …and its sentence for a head that is not the one the caller asked about.
          refusal: 'the pull request head is {now}, not the expected {have}',
        },
        {
          id: 'verdict-says-pass',
          spec: 'verdict',
          is: 'equals',
          value: 'PASS',
          // …and its sentence for a conclusion that says something else, naming who said it.
          refusal: '{by} says {value} at this tip',
        },
        {
          id: 'tests-ran-at-tip',
          spec: 'check:tests-ok',
          is: 'fresh',
          refusal: '{node} refuses: {input} did not run at the tip {now}.',
        },
      ],
      refusal: '{node} cannot start: its input {input} is not current.',
    },
    {
      id: 'merge',
      name: 'Merge',
      // The merge queue writes the commit, so no Bot holds this node.
      role: 'system',
      column: 'done',
      inputs: ['verdict', 'risk:tier'],
      outputs: ['merge-commit'],
      guards: [],
      refusal: '{node} cannot start: its input {input} is not current.',
    },
    {
      id: 'release',
      name: 'Release',
      role: 'Release',
      column: 'done',
      inputs: ['merge-commit'],
      outputs: ['release'],
      guards: [],
      refusal: '{node} cannot start: it needs {spec} and has not published it yet.',
    },
  ],
  edges: [
    { from: 'triage.issue.ready', to: 'build.issue.ready' },
    { from: 'build.pr', to: 'verify.pr' },
    { from: 'verify.check:tests-ok', to: 'review.check:tests-ok' },
    { from: 'review.verdict', to: 'merge.verdict' },
    { from: 'gate.risk:tier', to: 'merge.risk:tier' },
    { from: 'merge.merge-commit', to: 'release.merge-commit' },
  ],
  // No declared loop yet: an INC sends the card back to `build` on the board, and a `loops[]` row is
  // a dependency the graph already has (declaring one nothing implies is `loop/not-an-edge`).
  loops: [],
})

// The roles the preset names, so a caller can pass them as the team without inventing a roster.
export const REPO_DEV_TEAM = Object.freeze(['Triage', 'Dev', 'SelfTest', 'Reviewer', 'Release'])
