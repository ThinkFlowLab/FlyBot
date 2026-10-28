// Chat lines for one graph step. Delivery-template nodes use canned copy when
// no Bot reply is quoted; any other graph gets a short line that names the Bot and the task.
// Every frame carries the English key and its params, so the client follows the
// shell language; the stored Chinese text stays as the fallback for rows written
// before the key existed (#1489).

import { nodeById, stepLabel, summarizeTask } from './graph.js'
import { DELIVERY_ID } from './template.js'

function names(workflow, ids) {
  return ids.map(id => nodeById(workflow, id)?.name ?? id).join(' ‖ ')
}

function frame(kind, key, params, text, extra = {}) {
  return { kind, key, params, text, ...extra }
}

function quoted(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function doneCopy(workflow, nodeId, task) {
  if (workflow.id === DELIVERY_ID) {
    if (nodeId === 'planner') {
      return {
        key: 'Broke down "{task}": Writer gets the notice under 2 lines, conclusion first; Coder replaces the copy and the collapse logic; Reviewer and Tester verify in parallel.',
        params: { task: task.title },
        text: `已拆解「${task.title}」：Writer 把 notice 压到 2 行以内，结论先行；Coder 替换文案与折叠逻辑；Reviewer 与 Tester 并行验收。`,
      }
    }
    if (nodeId === 'writer') {
      return {
        key: 'Draft done (86 chars → 31): "The delivery team is set up; members sync automatically. Tap here for progress →"',
        text: '草稿完成（原 86 字 → 31 字）：「交付组已建好，成员会自动同步。点此查看进度 →」',
      }
    }
    if (nodeId === 'coder') {
      return {
        key: 'Patch submitted: replaces the copy and collapses anything over 2 lines. 3 files changed.',
        text: '补丁已提交：替换文案，超过 2 行自动折叠。改动 3 个文件。',
      }
    }
    if (nodeId === 'reviewer') {
      return {
        key: 'Review passed. Suggestion: make the collapse threshold a constant, NOTICE_MAX_LINES.',
        text: 'Review 通过。建议把折叠阈值做成常量 NOTICE_MAX_LINES。',
      }
    }
    if (nodeId === 'tester') {
      return {
        key: 'Retry passed: unit 128/128, snapshots 24/24, E2E 6/6.',
        text: '重试通过：单元 128/128，快照 24/24，E2E 6/6。',
      }
    }
    if (nodeId === 'deployer') {
      return {
        key: 'Merged and rolled out to 10% of traffic. Board card {id} moved to Done.',
        params: { id: task.id },
        text: `已合并并灰度 10% 发布。看板卡片 ${task.id} 已移到「已完成」。`,
      }
    }
  }
  const node = nodeById(workflow, nodeId)
  return {
    key: '{node} finished this step of "{task}".',
    params: { node: node?.name ?? nodeId, task: task.title },
    text: `${node?.name ?? nodeId} 完成了「${task.title}」的这一步。`,
  }
}

function attachmentsOf(workflow, nodeId) {
  if (workflow.id !== DELIVERY_ID) return undefined
  if (nodeId === 'writer') return ['notice-copy.md']
  if (nodeId === 'coder') return ['PR #482']
  return undefined
}

function completeLine(workflow, task, nodeId) {
  const copy = doneCopy(workflow, nodeId, task)
  const attachments = attachmentsOf(workflow, nodeId)
  return frame('bot', copy.key, copy.params, copy.text, {
    botId: nodeId,
    step: stepLabel(workflow, nodeId),
    ...(attachments ? { attachments } : {}),
  })
}

function botReply(workflow, nodeId, text) {
  return { kind: 'bot', botId: nodeId, step: stepLabel(workflow, nodeId), text }
}

// A live run quotes the Bot when event.text is set; otherwise a frame fills in.
function liveLines(workflow, task, event) {
  const label = summarizeTask(task)
  const node = () => nodeById(workflow, event.nodeId)
  const nodeName = () => node()?.name ?? event.nodeId
  const reply = quoted(event.text)
  if (event.type === 'start') {
    const nodes = names(workflow, event.started)
    return [frame('system', 'Started · {task} · {nodes}', { task: label, nodes }, `开始 · ${label} · ${nodes}`, { tone: 'accent' })]
  }
  if (event.type === 'fail') {
    if (event.recovered === true && event.started.length > 0) {
      const target = names(workflow, event.started)
      return [
        reply
          ? botReply(workflow, event.nodeId, reply)
          : frame('bot', '{node} failed; went back to {nodes} to retry', { node: nodeName(), nodes: target }, `${nodeName()} 失败，已返回 ${target} 重试`, { botId: event.nodeId, step: stepLabel(workflow, event.nodeId) }),
        frame('system', '↺ Recovered from failure → {nodes}', { nodes: target }, `↺ 失败恢复 → ${target}`, { tone: 'bad' }),
      ]
    }
    return [reply
      ? botReply(workflow, event.nodeId, reply)
      : frame('bot', '{node} failed this step and stops here.', { node: nodeName() }, `${nodeName()} 这一步失败了，停在本节点。`, { botId: event.nodeId, step: stepLabel(workflow, event.nodeId) })]
  }
  if (event.type === 'retry') {
    return [frame('system', '↻ {node} retried after a failure', { node: nodeName() }, `↻ ${nodeName()} 失败后重试`, { tone: 'bad' })]
  }
  if (event.type === 'complete') {
    const lines = [reply
      ? botReply(workflow, event.nodeId, reply)
      : frame('bot', '{node} finished this step.', { node: nodeName() }, `${nodeName()} 完成了这一步。`, { botId: event.nodeId, step: stepLabel(workflow, event.nodeId) })]
    if (event.started.length > 1) {
      const started = names(workflow, event.started)
      lines.push(frame('system', '∥ Parallel branches started: {nodes}', { nodes: started }, `∥ 并行分支开始：${started}`))
    }
    if (event.joined && event.layerSize > 1 && event.started.length > 0) {
      const started = names(workflow, event.started)
      lines.push(frame('system', '⇢ Parallel branches joined (join) → {nodes}', { nodes: started }, `⇢ 并行分支汇合（join）→ ${started}`))
    }
    if (event.finished) {
      lines.push(frame('system', '✓ Done · {task} · {steps} steps', { task: label, steps: workflow.nodes.length }, `✓ 完成 · ${label} · ${workflow.nodes.length} 步`, { tone: 'ok' }))
    }
    return lines
  }
  if (event.type === 'note') return [{ kind: 'system', tone: event.tone, text: event.text }]
  return []
}

export function linesFor(workflow, task, event) {
  if (event.live === true) return liveLines(workflow, task, event)
  const label = `${task?.id ?? ''} ${task?.title ?? ''}`.trim()
  const node = () => nodeById(workflow, event.nodeId)
  const nodeName = () => node()?.name ?? event.nodeId
  if (event.type === 'start') {
    const nodes = names(workflow, event.started)
    return [frame('system', 'Task {task} entered the workflow; {nodes} claimed it', { task: label, nodes }, `任务 ${label} 已进入 Workflow，${nodes} 认领`, { tone: 'accent' })]
  }
  if (event.type === 'fail') {
    if (event.recovered === true && event.started.length > 0) {
      const target = names(workflow, event.started)
      return [
        frame('bot', '{node} failed; went back to {nodes} to retry', { node: nodeName(), nodes: target }, `${nodeName()} 失败，已返回 ${target} 重试`, { botId: event.nodeId, step: stepLabel(workflow, event.nodeId) }),
        frame('system', '↺ Recovered from failure → {nodes}', { nodes: target }, `↺ 失败恢复 → ${target}`, { tone: 'bad' }),
      ]
    }
    const snapshot = workflow.id === DELIVERY_ID && event.nodeId === 'tester'
    const text = snapshot
      ? '快照测试 notice.snap 不一致（旧文案快照未更新）。自动重试 1/2，并已通知 Coder 更新快照。'
      : `${nodeName()} 这一步失败了，停在本节点。`
    return [snapshot
      ? frame('bot', 'Snapshot test notice.snap does not match (old copy snapshot not updated). Retried 1/2 automatically, and Coder was asked to update the snapshot.', undefined, text, { botId: event.nodeId, step: stepLabel(workflow, event.nodeId) })
      : frame('bot', '{node} failed this step and stops here.', { node: nodeName() }, text, { botId: event.nodeId, step: stepLabel(workflow, event.nodeId) })]
  }
  if (event.type === 'retry') {
    const snapshot = workflow.id === DELIVERY_ID && event.nodeId === 'tester'
    return [snapshot
      ? frame('system', '↻ Tester retried automatically after a failure · Coder pushed the snapshot update', undefined, '↻ Tester 失败后自动重试 · Coder 已推送快照更新', { tone: 'bad' })
      : frame('system', '↻ {node} retried automatically after a failure', { node: nodeName() }, `↻ ${nodeName()} 失败后自动重试`, { tone: 'bad' })]
  }
  if (event.type === 'complete') {
    const lines = [completeLine(workflow, task, event.nodeId)]
    if (event.started.length > 1) {
      const started = names(workflow, event.started)
      lines.push(frame('system', '∥ Parallel branches started: {nodes}', { nodes: started }, `∥ 并行分支开始：${started}`))
    }
    if (event.joined && event.layerSize > 1 && event.started.length > 0) {
      const started = names(workflow, event.started)
      lines.push(frame('system', '⇢ Parallel branches joined (join) → {nodes}', { nodes: started }, `⇢ 并行分支汇合（join）→ ${started}`))
    }
    if (event.finished) {
      lines.push(frame('system', '✓ Done · {task} · {steps} steps', { task: summarizeTask(task), steps: workflow.nodes.length }, `✓ 完成 · ${summarizeTask(task)} · ${workflow.nodes.length} 步`, { tone: 'ok' }))
    }
    return lines
  }
  if (event.type === 'reset') return [frame('system', '↺ Run reset', undefined, '↺ 已重置运行')]
  if (event.type === 'note') return [{ kind: 'system', text: event.text }]
  return []
}
