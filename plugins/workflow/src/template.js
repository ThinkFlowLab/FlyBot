// The two workflows the owner-approved demo opens on. Node copy is the demo's
// own fixture (a delivery pipeline with one parallel join, and a Friday digest).
import { chainLabel, normalizeGraph } from './graph.js'


// Prompt guidance for Settings graphs that run Claim / Verify / Triage style
// steps. Paste into node instructions so Bots emit early-end markers the engine
// honors (see checkEarlyEnd in graph.js). Without these, loop/onFail edges with
// max=3 can re-burn Claim↔Verify on the same tip SHA.
export const EARLY_END_GUIDANCE = [
  'Early-end markers (emit one and stop; the engine ends the run and will not loop or onFail-retry):',
  '- needs-human: OUTPUT status: needs-human  (or a whole line: EARLY-END needs-human)',
  '- already-claimed: OUTPUT claimed: already-claimed  (or EARLY-END already-claimed) when agent-working / Claimed-by is present',
  '- open-pr: OUTPUT claimed: open-pr  (or EARLY-END open-pr / already-claimed) when an open PR already fixes the issue — do not claim again',
  '- tip-unchanged: OUTPUT status: tip-unchanged  (or EARLY-END tip-unchanged) when the tip SHA did not change; Verify must escalate once, not re-run the full suite',
].join('\n')

const planner = {
  id: 'planner', name: 'Planner', role: '需求拆解 / 排期',
  instructions: '读取任务卡片与上下文，拆成可执行子任务，指定验收标准，并把产出交给下游节点。',
  inputs: [{ name: 'task', type: 'text', required: true }],
  outputs: [{ name: 'plan', type: 'text' }],
}
const writer = {
  id: 'writer', name: 'Writer', role: '文案 / 文档',
  instructions: 'Draft posts, docs and release notes, keep them short, and lead with the conclusion.',
  inputs: [{ name: 'plan', type: 'text', required: true }],
  outputs: [{ name: 'copy', type: 'text' }],
}
const coder = {
  id: 'coder', name: 'Coder', role: '代码实现',
  instructions: '根据 Planner 的子任务和 Writer 的文案修改代码，提交 PR，并在 PR 描述中列出变更。',
  tools: ['github'],
  inputs: [{ name: 'copy', type: 'text', required: true }],
  outputs: [{ name: 'patch', type: 'text' }],
}
const reviewer = {
  id: 'reviewer', name: 'Reviewer', role: '代码审查',
  instructions: '审查 Coder 的 PR：可读性、边界条件与回归风险。不通过则打回 Coder。若 tip SHA 未变（tip-unchanged），输出 tip-unchanged / EARLY-END tip-unchanged 并只升级一次，不要整套重跑。',
  tools: ['github'],
  inputs: [{ name: 'patch', type: 'text', required: true }],
  outputs: [{ name: 'review', type: 'text' }],
}
const tester = {
  id: 'tester', name: 'Tester', role: '自动化测试', failOnce: true,
  instructions: '运行单元、快照和 E2E。失败时自动重试 1 次，仍失败则停在本节点。',
  inputs: [{ name: 'patch', type: 'text', required: true }],
  outputs: [{ name: 'report', type: 'text' }],
}
const deployer = {
  id: 'deployer', name: 'Deployer', role: '发布上线',
  instructions: '在 Reviewer 与 Tester 都通过后合并，灰度发布，并回填任务卡片状态。',
  tools: ['github'],
  inputs: [{ name: 'review', type: 'text', required: true }, { name: 'report', type: 'text', required: true }],
  outputs: [{ name: 'release', type: 'text' }],
}

export const DELIVERY_ID = 'delivery'
export const WEEKLY_ID = 'weekly'
// The demo's progress line reads "3/10" while Coder is in progress, so the
// delivery script is ten steps (open, each hand-off, the one retry, the close).
export const DELIVERY_STEPS = 10

export function deliveryWorkflow() {
  return {
    id: DELIVERY_ID,
    name: '发布交付流水线',
    description: 'Planner 拆解 → Writer 文案 → Coder 实现 → Reviewer ‖ Tester 并行把关 → Deployer 上线。任务从看板分配进来后按此流程执行。',
    trigger: 'manual',
    nodes: [planner, writer, coder, reviewer, tester, deployer],
    layers: [['planner'], ['writer'], ['coder'], ['reviewer', 'tester'], ['deployer']],
    // Title / note keywords that auto-start this template. Longer words win.
    triggers: ['notice', '交付'],
  }
}

export function weeklyWorkflow() {
  return {
    id: WEEKLY_ID,
    name: '周报汇总流程',
    description: '每周五 17:00 触发：研究员收集，数据分析师汇总，Writer 成稿。',
    trigger: 'schedule',
    scheduleLabel: '周五 17:00',
    nodes: [
      { id: 'researcher', name: '研究员', role: '行业研究', instructions: '收集本周行业动态与竞品更新。', inputs: [{ name: 'task', type: 'text', required: true }], outputs: [{ name: 'notes', type: 'text' }] },
      { id: 'analyst', name: '数据分析师', role: '数据分析', instructions: '汇总核心指标，生成周对比。', inputs: [{ name: 'notes', type: 'text', required: true }], outputs: [{ name: 'metrics', type: 'text' }] },
      { id: 'writer', name: 'Writer', role: '成稿', instructions: '把研究数据和指标写成周报。', inputs: [{ name: 'metrics', type: 'text', required: true }], outputs: [{ name: 'report', type: 'text' }] },
    ],
    layers: [['researcher'], ['analyst'], ['writer']],
    triggers: ['周报'],
  }
}

export function templateById(id) {
  const key = String(id ?? '')
  if (key === 'delivery' || key === DELIVERY_ID) return deliveryWorkflow()
  if (key === 'weekly' || key === WEEKLY_ID) return weeklyWorkflow()
  return null
}

// Enough of each factory pipeline to draw it before anyone copies it. The
// settings page opens this graph; creating a workflow still copies the full
// template, including instructions.
export function templateCatalog() {
  return [deliveryWorkflow(), weeklyWorkflow()].map(item => {
    const graph = normalizeGraph(item)
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      triggers: [...item.triggers],
      chain: chainLabel(graph),
      nodes: graph.nodes.map(node => ({ id: node.id, name: node.name, role: node.role ?? '', x: node.x, y: node.y })),
      edges: graph.edges.map(edge => ({ from: edge.from, to: edge.to })),
      layers: graph.layers.map(layer => [...layer]),
    }
  })
}

export function fixtureTask() {
  return { id: '#1280', title: '缩短交付组群 notice' }
}
