// Chat lines for one graph step. Delivery-template nodes use the demo's copy;
// any other graph gets a short line that names the Bot and the task. Text is
// plain: the client renders it as a text node.

import { nodeById, stepLabel, summarizeTask } from './graph.js'
import { DELIVERY_ID } from './template.js'

function names(workflow, ids) {
  return ids.map(id => nodeById(workflow, id)?.name ?? id).join(' ‖ ')
}

function doneText(workflow, nodeId, task) {
  if (workflow.id === DELIVERY_ID) {
    if (nodeId === 'planner') return `已拆解「${task.title}」：Writer 把 notice 压到 2 行以内，结论先行；Coder 替换文案与折叠逻辑；Reviewer 与 Tester 并行验收。`
    if (nodeId === 'writer') return '草稿完成（原 86 字 → 31 字）：「交付组已建好，成员会自动同步。点此查看进度 →」'
    if (nodeId === 'coder') return '补丁已提交：替换文案，超过 2 行自动折叠。改动 3 个文件。'
    if (nodeId === 'reviewer') return 'Review 通过。建议把折叠阈值做成常量 NOTICE_MAX_LINES。'
    if (nodeId === 'tester') return '重试通过：单元 128/128，快照 24/24，E2E 6/6。'
    if (nodeId === 'deployer') return `已合并并灰度 10% 发布。看板卡片 ${task.id} 已移到「已完成」。`
  }
  const node = nodeById(workflow, nodeId)
  return `${node?.name ?? nodeId} 完成了「${task.title}」的这一步。`
}

function attachmentsOf(workflow, nodeId) {
  if (workflow.id !== DELIVERY_ID) return undefined
  if (nodeId === 'writer') return ['notice-copy.md']
  if (nodeId === 'coder') return ['PR #482']
  return undefined
}

function liveText(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text || fallback
}

// A live run quotes the Bot. The delivery script's canned lines stay on the demo path.
function liveLines(workflow, task, event) {
  const label = summarizeTask(task)
  if (event.type === 'start') {
    return [{ kind: 'system', tone: 'accent', text: `开始 · ${label} · ${names(workflow, event.started)}` }]
  }
  if (event.type === 'fail') {
    const node = nodeById(workflow, event.nodeId)
    const text = liveText(event.text, `${node?.name ?? event.nodeId} 这一步失败了，停在本节点。`)
    return [{ kind: 'bot', botId: event.nodeId, step: stepLabel(workflow, event.nodeId), text }]
  }
  if (event.type === 'retry') {
    const node = nodeById(workflow, event.nodeId)
    return [{ kind: 'system', tone: 'bad', text: `↻ ${node?.name ?? event.nodeId} 失败后重试` }]
  }
  if (event.type === 'complete') {
    const node = nodeById(workflow, event.nodeId)
    const lines = [{
      kind: 'bot', botId: event.nodeId, step: stepLabel(workflow, event.nodeId),
      text: liveText(event.text, `${node?.name ?? event.nodeId} finished this step.`),
    }]
    if (event.started.length > 1) lines.push({ kind: 'system', text: `∥ 并行分支开始：${names(workflow, event.started)}` })
    if (event.joined && event.layerSize > 1 && event.started.length > 0) {
      lines.push({ kind: 'system', text: `⇢ 并行分支汇合（join）→ ${names(workflow, event.started)}` })
    }
    if (event.finished) lines.push({ kind: 'system', tone: 'ok', text: `✓ 完成 · ${summarizeTask(task)} · ${workflow.nodes.length} 步` })
    return lines
  }
  if (event.type === 'note') return [{ kind: 'system', tone: event.tone, text: event.text }]
  return []
}

export function linesFor(workflow, task, event) {
  if (event.live === true) return liveLines(workflow, task, event)
  const label = `${task?.id ?? ''} ${task?.title ?? ''}`.trim()
  if (event.type === 'start') {
    return [{ kind: 'system', tone: 'accent', text: `任务 ${label} 已进入 Workflow，${names(workflow, event.started)} 认领` }]
  }
  if (event.type === 'fail') {
    const node = nodeById(workflow, event.nodeId)
    const text = workflow.id === DELIVERY_ID && event.nodeId === 'tester'
      ? '快照测试 notice.snap 不一致（旧文案快照未更新）。自动重试 1/2，并已通知 Coder 更新快照。'
      : `${node?.name ?? event.nodeId} 这一步失败了，停在本节点。`
    return [{ kind: 'bot', botId: event.nodeId, step: stepLabel(workflow, event.nodeId), text }]
  }
  if (event.type === 'retry') {
    const node = nodeById(workflow, event.nodeId)
    const text = workflow.id === DELIVERY_ID && event.nodeId === 'tester'
      ? '↻ Tester 失败后自动重试 · Coder 已推送快照更新'
      : `↻ ${node?.name ?? event.nodeId} 失败后自动重试`
    return [{ kind: 'system', tone: 'bad', text }]
  }
  if (event.type === 'complete') {
    const lines = [{
      kind: 'bot', botId: event.nodeId, step: stepLabel(workflow, event.nodeId),
      text: doneText(workflow, event.nodeId, task),
      ...(attachmentsOf(workflow, event.nodeId) ? { attachments: attachmentsOf(workflow, event.nodeId) } : {}),
    }]
    if (event.started.length > 1) lines.push({ kind: 'system', text: `∥ 并行分支开始：${names(workflow, event.started)}` })
    if (event.joined && event.layerSize > 1 && event.started.length > 0) {
      lines.push({ kind: 'system', text: `⇢ 并行分支汇合（join）→ ${names(workflow, event.started)}` })
    }
    if (event.finished) lines.push({ kind: 'system', tone: 'ok', text: `✓ 完成 · ${summarizeTask(task)} · ${workflow.nodes.length} 步` })
    return lines
  }
  if (event.type === 'reset') return [{ kind: 'system', text: '↺ 已重置运行' }]
  if (event.type === 'note') return [{ kind: 'system', text: event.text }]
  return []
}
