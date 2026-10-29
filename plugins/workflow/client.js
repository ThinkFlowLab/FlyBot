// Browser half of @flybot/workflow. A workflow is a row in the sidebar and, once
// opened, the main column: stage chat with normal FlyBot conversation UI, and a
// flowchart drawer. Settings → Workflow graphs is canvas-first with per-node inspector.
// The host owns the graph; this file only draws it. Every string is a React text child.
window.__ModuleLoader__.load({
  id: '@flybot/workflow',
  factory: (require) => {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    let createPortal = null
    try {
      const dom = require('react-dom')
      if (typeof dom?.createPortal === 'function') createPortal = dom.createPortal
    } catch (error) {
      void error
    }
    function portal(node) {
      const root = typeof document !== 'undefined' ? document.body : null
      if (typeof createPortal !== 'function' || !root) return node
      return createPortal(node, root)
    }

    const ZH = {
      Workflows: 'Workflows',
      New: '新建',
      'Hand a task to a Workflow': '把任务交给 Workflow',
      'A task can go to a Workflow, not only to one Bot. The Workflow then runs each Bot in order, or side by side.': '任务不再只能交给单个 Bot —— 交给 Workflow 后，会按固定流程依次（或并行）交给各个 Bot 执行。',
      'Pick a task card': '从 Tasks 看板选择任务卡片',
      'Pick who runs it': '选择执行者',
      Cancel: '取消',
      Assign: '确认分配',
      Workflow: 'Workflow',
      'One Bot (as before)': '单个 Bot（原有方式）',
      'Concurrent runs': '同时运行',
      '{count} running · queue {depth}': '{count} 个在运行 · 队列 {depth}',
      Reset: '重置',
      Flow: '流程图',
      Details: 'Details',
      Runs: '运行记录',
      Running: '运行中',
      Done: '已完成',
      Failed: '失败',
      Idle: '空闲',
      'Not started': '待办',
      'In progress': '进行中',
      'Close': '关闭',
      Pause: '暂停',
      Resume: '继续',
      Stop: '停止',
      Progress: '进度',
      'New workflow': '新建 Workflow',
      Name: '名称',
      'Add a Bot': '添加 Bot',
      Parallel: '与上一步并行',
      Create: '创建',
      'Local Bots': '本机 Bot',
      'No workflows yet.': '还没有 Workflow。',
      'Waiting for a task': '等待任务',
      'A step failed': '有一步失败',
      '{node} failed': '{node} 失败',
      Stopped: '已停止',
      'The hand-off failed': '交接失败',
      'The host ended this run': '宿主中断了这次运行',
      'Message the workflow': '发消息',
      Trigger: '触发方式',
      Manual: '手动，从任务看板分配',
      Schedule: '定时',
      Model: '模型',
      'Each Bot\'s own model': '跟随各个 Bot 的模型',
      '{count} models': '{count} 个模型',
      Permissions: '权限',
      'Full access, same as a normal Bot': '完全访问，与普通 Bot 相同',
      'On failure': '失败策略',
      'Tester retries once. Any other failed step stops the run.': 'Tester 失败后自动重试 1 次。其他节点失败则停住。',
      'A failed step stops the run.': '失败的节点停住，等你处理。',
      Members: '成员',
      'Current run': '当前运行',
      'No runs yet.': '还没有运行记录。',
      'Assign the task': '确认分配',
      Edit: '编辑',
      'Finish editing': '完成',
      'Drag a Bot here': '把 Bot 拖到图上',
      'Layout lives in Settings': '布局在 Settings 画布改',
      'From a template': '从模板新建',
      Remove: '移除',
      'System prompt': '系统提示词',
      Save: '保存',
      'Workflow graphs': 'Workflow 图',
      'Add link': '添加连线',
      'From node': '起点',
      'To node': '终点',
      'Pick a node': '选择一个节点',
      Link: '连线',
      Condition: '条件',
      Loop: '循环',
      Kind: '连线类型',
      when: '当',
      until: '直到',
      Else: '否则',
      'Max iterations': '最多次数',
      'Output name': '输出名',
      Equals: '等于',
      Skipped: '跳过',
      Queued: '排队中',
      'Select a node to edit': '选择一个节点来编辑',
      'Node settings': '节点设置',
      Role: '角色',
      Tools: '工具',
      'Inputs and outputs': '输入和输出',
      Delete: '删除',
      Rename: '重命名',
      'Delete workflow': '删除 Workflow',
      'Rename workflow': '重命名 Workflow',
      'Are you sure you want to delete "{name}"? This cannot be undone.': '确定删除「{name}」？此操作无法撤销。',
      'No open tasks on the Tasks board.': 'Tasks 看板上没有可分配的任务。',
      'Tasks this workflow holds': '此 Workflow 持有的任务',
      'Re-match': '重新匹配',
      '{count} more held tasks': '还有 {count} 个持有的任务',
      'Could not re-match this task': '无法重新匹配该任务',
      'Loading the Tasks board…': '正在读取 Tasks 看板…',
      'Could not load the Tasks board.': '无法读取 Tasks 看板。',
      Retry: '重试',
      'Could not rename this workflow': '无法重命名该 Workflow',
      'Could not delete this workflow': '无法删除该 Workflow',
      'Could not save this workflow': '无法保存该 Workflow',
      'Could not reset this workflow': '无法重置该 Workflow',
      'Could not pause this run': '无法暂停本次运行',
      'Could not resume this run': '无法继续本次运行',
      'Could not stop this run': '无法停止本次运行',
      'Reading workflows…': '正在读取 Workflow…',
      'Changes are saved automatically': '更改会自动保存',
      'Try again': '重试',
      'Could not change the model': '无法更改模型',
      'Next run: {time}': '下次运行：{time}',
      'Step {step}': '步骤 {step}',
      'Parallel branches · Merge after all pass': '并行分支 · 全部通过后汇合',
      'Show more': '展开',
      'Show less': '收起',
      // Stage timeline (#1489). The key is the English line; service.js and
      // narrate.js keep the Chinese text only as the fallback for rows written
      // before the key existed.
      'Task assigned · {task} → {workflow}': '任务已分配 · {task} → {workflow}',
      'Queued · {task} ({ahead} ahead)': '排队 · {task}（前面 {ahead} 个）',
      'Workflow "{name}" created · members {members}': 'Workflow「{name}」已创建 · 成员 {members}',
      '⏸ Paused · {task}': '⏸ 已暂停 · {task}',
      '▶ Resumed · {task}': '▶ 已继续 · {task}',
      '■ Stopped · {task}': '■ 已停止 · {task}',
      '✕ Failed · {task}': '✕ 失败 · {task}',
      '✕ Failed · {task} · {detail}': '✕ 失败 · {task} · {detail}',
      '{node} cannot start: missing input {missing}.': '{node} 不能开始：缺少输入 {missing}。',
      '{node} did not take this step ({code}).': '{node} 没有接到这一步（{code}）。',
      '{node} did not take this step ({code}); retrying in {seconds}s ({tries}/{total}).': '{node} 没有接到这一步（{code}），{seconds} 秒后重试（{tries}/{total}）。',
      '{node} did not take this step ({code}); {total} retries did not land, the run failed.': '{node} 没有接到这一步（{code}），重试 {total} 次仍未落地，run 已标记失败。',
      '{node} timed out: no reply for {minutes} minutes, the run was marked failed.': '{node} 超时：{minutes} 分钟没有回包，run 已标记失败。',
      'Started · {task} · {nodes}': '开始 · {task} · {nodes}',
      'Task {task} entered the workflow; {nodes} claimed it': '任务 {task} 已进入 Workflow，{nodes} 认领',
      '{node} failed; went back to {nodes} to retry': '{node} 失败，已返回 {nodes} 重试',
      '↺ Recovered from failure → {nodes}': '↺ 失败恢复 → {nodes}',
      '{node} failed this step and stops here.': '{node} 这一步失败了，停在本节点。',
      'Snapshot test notice.snap does not match (old copy snapshot not updated). Retried 1/2 automatically, and Coder was asked to update the snapshot.': '快照测试 notice.snap 不一致（旧文案快照未更新）。自动重试 1/2，并已通知 Coder 更新快照。',
      '↻ {node} retried after a failure': '↻ {node} 失败后重试',
      '↻ {node} retried automatically after a failure': '↻ {node} 失败后自动重试',
      '↻ Tester retried automatically after a failure · Coder pushed the snapshot update': '↻ Tester 失败后自动重试 · Coder 已推送快照更新',
      '{node} finished this step.': '{node} 完成了这一步。',
      '∥ Parallel branches started: {nodes}': '∥ 并行分支开始：{nodes}',
      '⇢ Parallel branches joined (join) → {nodes}': '⇢ 并行分支汇合（join）→ {nodes}',
      '✓ Done · {task} · {steps} steps': '✓ 完成 · {task} · {steps} 步',
      '↺ Run reset': '↺ 已重置运行',
      'Broke down "{task}": Writer gets the notice under 2 lines, conclusion first; Coder replaces the copy and the collapse logic; Reviewer and Tester verify in parallel.': '已拆解「{task}」：Writer 把 notice 压到 2 行以内，结论先行；Coder 替换文案与折叠逻辑；Reviewer 与 Tester 并行验收。',
      'Draft done (86 chars → 31): "The delivery team is set up; members sync automatically. Tap here for progress →"': '草稿完成（原 86 字 → 31 字）：「交付组已建好，成员会自动同步。点此查看进度 →」',
      'Patch submitted: replaces the copy and collapses anything over 2 lines. 3 files changed.': '补丁已提交：替换文案，超过 2 行自动折叠。改动 3 个文件。',
      'Review passed. Suggestion: make the collapse threshold a constant, NOTICE_MAX_LINES.': 'Review 通过。建议把折叠阈值做成常量 NOTICE_MAX_LINES。',
      'Retry passed: unit 128/128, snapshots 24/24, E2E 6/6.': '重试通过：单元 128/128，快照 24/24，E2E 6/6。',
      'Merged and rolled out to 10% of traffic. Board card {id} moved to Done.': '已合并并灰度 10% 发布。看板卡片 {id} 已移到「已完成」。',
      '{node} finished this step of "{task}".': '{node} 完成了「{task}」的这一步。',
    }

    function zhUi() {
      const host = globalThis.__flybot__?.t
      return typeof host === 'function' && host('Tasks') === '任务'
    }
    // A host call that must end: a throw, a rejection or a host that never answers settles
    // as one error string, so a failed read cannot leave the page on "Reading workflows…",
    // a failed save cannot look saved, and a stage control (Pause, Stop, Reset) cannot fail
    // silently either. Same shape as readWorkflows()/workflowCallError() in
    // core/src/client/workflows.js, kept here because this page reads the plugin's own calls.
    const CALL_TIMEOUT_MS = 10000
    function callError(failure, fallback) {
      if (typeof failure === 'string' && failure.trim()) return failure.trim()
      const message = typeof failure?.message === 'string' ? failure.message.trim() : ''
      return message || fallback
    }
    function settledCall(call, name, body, fallback, timeoutMs = CALL_TIMEOUT_MS) {
      return new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => finish({ ok: false, error: fallback }), timeoutMs)
        let pending
        try {
          pending = body === undefined ? call(name) : call(name, body)
        } catch (failure) {
          finish({ ok: false, error: callError(failure, fallback) })
          return
        }
        Promise.resolve(pending)
          .then((value) => finish(value === null || value === undefined
            ? { ok: false, error: fallback }
            : (value.ok === false ? { ok: false, error: callError(value.error, fallback) } : value)))
          .catch((failure) => finish({ ok: false, error: callError(failure, fallback) }))
      })
    }
    function fill(text, params) {
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    }
    function tr(key, params) {
      const host = globalThis.__flybot__?.t
      // Ask the host for the key alone: it fills an unknown key's params itself,
      // and that fill would hide the plugin's own copy from the fallback below.
      const fromHost = typeof host === 'function' ? host(key) : key
      const text = fromHost !== key ? fromHost : zhUi() && Object.hasOwn(ZH, key) ? ZH[key] : key
      return fill(text, params)
    }

    // The stage clock at the ages the core's list rows use: "just now", "5 min",
    // "3 h", "2 d", then a date. Read at render time, so a Done run ages; only a
    // row written before the stamp existed still paints its stored text.
    function relativeTime(at) {
      const ms = Number(at)
      if (!Number.isFinite(ms)) return ''
      const diff = Math.max(0, Date.now() - ms)
      if (diff < 60_000) return tr('just now')
      if (diff < 3_600_000) return tr('{n} min', { n: Math.floor(diff / 60_000) })
      if (diff < 86_400_000) return tr('{n} h', { n: Math.floor(diff / 3_600_000) })
      if (diff < 30 * 86_400_000) return tr('{n} d', { n: Math.floor(diff / 86_400_000) })
      return new Date(ms).toLocaleDateString(zhUi() ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
    }

    const STATUS_KEY = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', idle: 'Idle' }
    // Why a run failed, from the record the host keeps (#1493). A failure it did not
    // name still reads Failed: the reason is added information, never a requirement.
    const FAILURE_KEY = {
      stopped: 'Stopped',
      'dispatch-failed': 'The hand-off failed',
      'host-ended': 'The host ended this run',
    }
    function failureText(run) {
      const failure = run?.failure
      if (!failure) return tr('Failed')
      if (failure.code === 'step-failed') {
        const head = failure.nodeName ? tr('{node} failed', { node: failure.nodeName }) : tr('A step failed')
        return failure.text ? `${head} · ${failure.text}` : head
      }
      return tr(FAILURE_KEY[failure.code] ?? 'Failed')
    }
    // A row without a time (an older history entry) stays a row; it just shows none.
    function runTime(at) {
      const ms = Number(at)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const when = new Date(ms)
      if (Number.isNaN(when.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`
      const today = new Date()
      const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate()
      return sameDay ? clock : `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${clock}`
    }
    const COLUMN_KEY = { 'not-started': 'Not started', 'in-progress': 'In progress', done: 'Done' }
    const COLUMN_OF = { open: 'not-started', claimed: 'not-started', working: 'in-progress', blocked: 'in-progress', 'result-ready': 'in-progress', accepted: 'done', cancelled: 'done', failed: 'done' }
    const COLORS = { Planner: '#8b5cf6', Writer: '#f0509a', Coder: '#1fbf6a', Reviewer: '#f5a524', Tester: '#14b8a6', Deployer: '#2f7cf6', '研究员': '#a78bfa', '数据分析师': '#ec4899' }
    // Zero-width plane center line: shift wire coordinates so strokes stay inside the SVG box.
    const WIRE_SPAN = 480
    const NODE_WIRE_OUT = 56
    const NODE_W = 168
    const NODE_H = 72
    // The flowchart drawer is a fixed 400px panel with 18px side padding, so its
    // Flow tab fits the graph into 364px. Settings keeps its own scrolling world
    // plane; only the drawer fits every node and edge to the panel width (#1513).
    const DRAWER_FLOW_W = 364
    const FIT_PAD = 12
    // The Tools field saves a list, and the host normalizes that list on every save
    // (cleanTools drops a trailing empty token). Committing per keystroke therefore
    // ate the separator the next name needed, so the field keeps its text while the
    // user types and commits it on blur, or after this pause (#1520).
    const TOOLS_COMMIT_MS = 600

    function workflowNodeIds(workflow) {
      return new Set((workflow?.nodes ?? []).map(node => node.id))
    }

    function stageMessages(workflow, messages, roster) {
      const nodeIds = workflowNodeIds(workflow)
      const rosterIds = roster?.byId ? new Set(Object.keys(roster.byId)) : new Set()
      return (messages ?? []).filter(message => {
        if (message.kind !== 'bot') return true
        if (rosterIds.has(message.botId)) return true
        return !nodeIds.has(message.botId)
      })
    }

    function useConversationInset() {
      const [left, setLeft] = useState(() => conversationLeft())
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const sync = () => setLeft(conversationLeft())
        sync()
        globalThis.addEventListener?.('resize', sync)
        let obs
        if (typeof ResizeObserver !== 'undefined') {
          obs = new ResizeObserver(sync)
          const side = document.querySelector?.('.bt-side')
          if (side) obs.observe(side)
        }
        return () => {
          globalThis.removeEventListener?.('resize', sync)
          obs?.disconnect?.()
        }
      }, [])
      return left
    }

    function columnOf(task) {
      if (task.column && COLUMN_KEY[task.column]) return task.column
      return COLUMN_OF[task.status] ?? 'not-started'
    }
    function priorityOf(task) {
      if (task.priority === 'urgent') return 'P0'
      if (task.priority === 'high' || task.priority === 'P1') return 'P1'
      if (task.priority === 'low' || task.priority === 'P3') return 'P3'
      return 'P2'
    }
    function shortId(id) {
      const text = String(id ?? '')
      if (text.startsWith('#')) return text
      if (text.startsWith('task-')) return `#${text.slice(-6)}`
      return text
    }
    // The row clips itself with CSS (single line + ellipsis) and the full title
    // rides in a tooltip, so never cut the string: a UTF-16 offset can land
    // inside a surrogate pair and render an emoji/CJK Ext-B title as a replacement character.
    function taskSummary(task, run) {
      if (run?.taskSummary) return run.taskSummary
      const id = shortId(task?.id ?? '')
      const title = String(task?.title ?? '').replace(/\s+/g, ' ').trim()
      if (!id && !title) return ''
      if (!title) return id
      if (!id) return title
      // Remove issue number prefix from title if it duplicates the id
      let cleanTitle = title
      const issueMatch = title.match(/^issue\s+#?\d+\s*[:\-–—]\s*/i)
      if (issueMatch && id) cleanTitle = title.slice(issueMatch[0].length)
      return `${id} · ${cleanTitle}`
    }
    function sidebarPreview(item) {
      const busy = (item.activeCount ?? 0) > 0 && item.run?.live === true
      if (busy) return item.preview || tr('Waiting for a task')
      if (item.trigger === 'schedule' && item.scheduleLabel) return tr('Next run: {time}', { time: item.scheduleLabel })
      return tr('Waiting for a task')
    }
    function glyph() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
        h('rect', { x: 9, y: 2, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 2, y: 17, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 16, y: 17, width: 6, height: 5, rx: 1.5 }),
        h('path', { d: 'M12 7v4M5 17v-3h14v3' }))
    }

    function Mark({ node, roster, size = 28 }) {
      const bot = node?.botId ? roster?.byId?.[node.botId] : null
      const Avatar = globalThis.__flybot__?.BotAvatar
      if (bot && typeof Avatar === 'function') return h(Avatar, { bot, size, badge: false, live: false })
      const color = COLORS[node?.name] ?? '#4d6bfe'
      return h('span', { className: 'wf-av', style: { background: color, width: size, height: size, fontSize: Math.max(11, size * 0.42) } }, (node?.name ?? '?').slice(0, 1))
    }

    const BOT_TINTS = ['#4d6bfe', '#8b5cf6', '#14b8a6', '#f5a524', '#ec4899', '#1fbf6a', '#2f7cf6']
    function botTint(bot) {
      let hash = 0
      for (const ch of String(bot?.id ?? bot?.name ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) | 0
      return BOT_TINTS[Math.abs(hash) % BOT_TINTS.length]
    }

    function botPaletteSubtitle(bot, peers) {
      const role = String(bot?.role ?? '').replace(/\s+/g, ' ').trim()
      const dupes = (peers ?? []).filter(item => item.name === bot.name).length > 1
      if (role) return role.length > 28 ? `${role.slice(0, 27)}…` : role
      if (dupes && bot?.id) return `…${String(bot.id).slice(-6)}`
      return ''
    }

    function PaletteBotFace({ bot, size = 26 }) {
      const Avatar = globalThis.__flybot__?.BotAvatar
      if (typeof Avatar === 'function') return h(Avatar, { bot, size, badge: false, live: false })
      const color = botTint(bot)
      return h('span', {
        className: 'wf-palette-av',
        style: { background: color, width: size, height: size, fontSize: Math.max(11, size * 0.42) },
      }, (bot?.name ?? '?').slice(0, 1))
    }

    function PaletteBotChip({ bot, peers, onPointerDown, dragging }) {
      const sub = botPaletteSubtitle(bot, peers)
      return h('button', {
        type: 'button',
        className: `wf-palette-bot${dragging ? ' dragging' : ''}`,
        'data-bot': bot.id,
        'aria-label': sub ? `${bot.name} · ${sub}` : bot.name,
        onPointerDown,
      },
        h('span', { className: 'wf-palette-grip', 'aria-hidden': true }),
        h(PaletteBotFace, { bot, size: 26 }),
        h('span', { className: 'wf-palette-copy' },
          h('span', { className: 'wf-palette-name' }, bot.name),
          sub ? h('span', { className: 'wf-palette-sub' }, sub) : null))
    }

    function nodeOf(workflow, id) {
      return workflow?.nodes?.find(node => node.id === id)
    }

    function MiniFlowchart({ workflow, compact = false }) {
      const nodes = workflow?.nodes ?? []
      const edges = workflow?.edges ?? []
      if (nodes.length === 0) return null
      const layers = workflow?.layers ?? [[nodes[0]?.id]]
      const width = compact ? 28 : 160
      const nodeW = compact ? 10 : 32
      const nodeH = compact ? 10 : 32
      const spacing = compact ? 14 : 40
      const layerSpacing = compact ? 14 : 48
      const height = compact ? 28 : layers.length * layerSpacing + nodeH
      const viewW = compact ? 28 : width
      const viewH = compact ? 28 : height
      const markerId = compact ? 'wf-mini-arrow-c' : 'wf-mini-arrow'
      return h('svg', {
        width: compact ? '100%' : width,
        height: compact ? '100%' : height,
        viewBox: `0 0 ${viewW} ${viewH}`,
        preserveAspectRatio: 'xMidYMid meet',
        className: compact ? 'wf-mini-flow wf-mini-flow-compact' : 'wf-mini-flow',
        'aria-hidden': compact ? true : undefined,
        'aria-label': compact ? undefined : workflow.name,
      },
        h('defs', null,
          h('marker', { id: markerId, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: compact ? '3' : '4', markerHeight: compact ? '3' : '4', orient: 'auto' },
            h('path', { d: 'M0 0 10 5 0 10z', fill: 'var(--bt-ink-3, #9a9a9a)' }))),
        edges.map(edge => {
          const fromIdx = layers.findIndex(layer => layer.includes(edge.from))
          const toIdx = layers.findIndex(layer => layer.includes(edge.to))
          if (fromIdx < 0 || toIdx < 0 || fromIdx >= toIdx) return null
          const fromLayer = layers[fromIdx]
          const toLayer = layers[toIdx]
          const fromPos = fromLayer.indexOf(edge.from)
          const toPos = toLayer.indexOf(edge.to)
          const midX = viewW / 2
          const x1 = midX + (fromPos - (fromLayer.length - 1) / 2) * spacing
          const y1 = fromIdx * layerSpacing + nodeH
          const x2 = midX + (toPos - (toLayer.length - 1) / 2) * spacing
          const y2 = toIdx * layerSpacing
          return h('path', {
            key: `${edge.from}>${edge.to}`,
            d: `M ${x1} ${y1} L ${x2} ${y2}`,
            stroke: 'var(--bt-ink-3, #9a9a9a)',
            strokeWidth: compact ? 1.2 : 1,
            fill: 'none',
            markerEnd: `url(#${markerId})`,
          })
        }),
        layers.map((layer, layerIdx) => layer.map((nodeId, pos) => {
          const node = nodeOf(workflow, nodeId)
          if (!node) return null
          const x = viewW / 2 + (pos - (layer.length - 1) / 2) * spacing - nodeW / 2
          const y = layerIdx * layerSpacing
          const color = COLORS[node.name] ?? '#4d6bfe'
          return h('g', { key: nodeId },
            h('rect', {
              x, y, width: nodeW, height: nodeH, rx: compact ? 2 : 6,
              fill: color,
              opacity: 0.15,
              stroke: color,
              strokeWidth: 1,
            }),
            compact ? null : h('text', {
              x: x + nodeW / 2,
              y: y + nodeH / 2 + 1,
              textAnchor: 'middle',
              dominantBaseline: 'middle',
              fill: color,
              fontSize: 12,
              fontWeight: 600,
            }, (node.name ?? '?').slice(0, 1)))
        })))
    }

    function RunStrip({ workflow, run, focused, onFocus, onPause, onResume, onStop, onTab, onOpenDrawer }) {
      const running = (run.running ?? []).map(id => nodeOf(workflow, id)).filter(Boolean)
      const chipClass = run.status === 'done' ? 'done' : (run.status === 'failed' ? 'failed' : (run.paused ? 'queued' : (running[0] ? 'running' : 'queued')))
      const chipLabel = run.status === 'done' ? tr('Done') : (run.status === 'failed' ? tr('Failed') : (run.paused ? tr('Pause') : (running[0] ? tr('Running') : tr('Queued'))))
      const meta = run.status === 'failed'
        ? failureText(run)
        : run.paused
        ? `${tr('Pause')} · ${running.map(node => node.name).join(' ‖ ') || '—'} · ${run.doneCount}/${run.nodeCount}`
        : (running[0]
          ? `${tr('Running')} · ${running.map(node => node.name).join(' ‖ ')} · ${run.doneCount}/${run.nodeCount}`
          : (run.status === 'done' ? tr('Done') : tr('Waiting for a task')))
      const focus = () => onFocus?.(run.id)
      const stopBubble = (event) => { event?.stopPropagation?.() }
      return h('div', {
        className: `wf-strip ${focused ? 'wf-strip-focus' : ''}`,
        'data-run-id': run.id,
        role: 'button',
        tabIndex: 0,
        onClick: focus,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus() } },
      },
        h('div', { className: 'wf-strip-head' },
          h('div', { className: 'wf-strip-id' },
            h('div', { className: 'wf-tk', title: run.task?.title ?? '' }, taskSummary(run.task, run)),
            h('div', { className: 'wf-meta' }, meta)),
          h('span', { className: `wf-chip ${chipClass}` }, chipLabel)),
        h('div', { className: 'wf-strip-progress', 'aria-label': tr('Progress'), title: tr('Progress') },
          h('div', { className: 'wf-segs' }, (run.marks ?? []).map((mark, index) => h('span', { key: index, className: `wf-seg ${mark}` })))),
        h('div', { className: 'wf-strip-actions' },
          run.status === 'running' ? (run.paused
            ? h('button', { type: 'button', className: 'wf-btn wf-sm wf-pri', onClick: (event) => { stopBubble(event); onResume?.(run.id) } }, tr('Resume'))
            : h('button', { type: 'button', className: 'wf-btn wf-sm', onClick: (event) => { stopBubble(event); onPause?.(run.id) } }, tr('Pause'))) : null,
          run.status === 'running' ? h('button', { type: 'button', className: 'wf-btn wf-sm wf-danger-outline', onClick: (event) => { stopBubble(event); onStop?.(run.id) } }, tr('Stop')) : null,
          h('button', { type: 'button', className: 'wf-btn wf-sm', onClick: (event) => { stopBubble(event); focus(); onOpenDrawer?.(); onTab('runs') } }, tr('Progress')),
          h('button', { type: 'button', className: 'wf-btn wf-sm', onClick: (event) => { stopBubble(event); focus(); onOpenDrawer?.(); onTab('flow') } }, tr('Flow'))))
    }

    // Stage: view/control only — progress and flowchart; no message composer (#1459).
    function Stage({ workflow, roster, stageLeft, drawer, tab, focusedRunId, onFocusRun, onCloseDrawer, onToggleDrawer, onOpenDrawer, onTab, onAssign, onTip, onReset, editing, onToggleEdit, onCommit, onPause, onResume, onStop, onRematch }) {
      const chatRef = useRef(null)
      const chatFoot = useRef({ height: 0, shown: 0 })
      const liveRuns = liveStageRuns(workflow)
      const held = workflow.heldTasks ?? []
      const viewRun = resolveFocusedRun(workflow, focusedRunId)
      const showSummary = (workflow.queueDepth ?? 0) > 0 || liveRuns.length > 1
      const visible = stageMessages(workflow, workflow.messages, roster)
      useEffect(() => {
        const el = chatRef.current
        if (!el) { chatFoot.current = { height: 0, shown: 0 }; return }
        const prev = chatFoot.current
        chatFoot.current = { height: el.scrollHeight, shown: visible.length }
        // A stage line that is filtered out changes no pixel, so it must not move the chat.
        if (visible.length <= prev.shown) return
        // Follow a new line only from the bottom; a reader who scrolled up keeps their place.
        if (prev.height > 0 && el.scrollTop + (el.clientHeight ?? 0) < prev.height - 24) return
        el.scrollTop = el.scrollHeight
      }, [workflow.messages.length])
      return h('div', { className: 'wf-stage', style: { left: stageLeft } },
        h('div', { className: 'wf-main' },
          h('div', { className: 'wf-top' },
            h('button', { type: 'button', className: 'wf-pill', onClick: onToggleDrawer },
              h('span', { className: 'wf-pill-thumb' }, h(MiniFlowchart, { workflow, compact: true })),
              h('span', { className: 'wf-pill-name' }, workflow.name),
              h('span', { className: 'wf-chev', 'aria-hidden': true }, '▾')),
            h('div', { className: 'wf-actions' },
              h('button', { type: 'button', className: 'wf-btn wf-pri', onClick: onAssign }, tr('Hand a task to a Workflow')))),
          showSummary ? h('div', { className: 'wf-strip wf-strip-summary' },
            h('span', { className: 'wf-chip queued' }, tr('{count} running · queue {depth}', { count: workflow.activeCount ?? liveRuns.length, depth: workflow.queueDepth ?? 0 }))) : null,
          held.length > 0 ? h('div', { className: 'wf-held' },
            h('div', { className: 'wf-held-head' }, tr('Tasks this workflow holds')),
            held.map(taskId => h('div', { className: 'wf-held-row', key: taskId },
              h('span', { className: 'wf-held-id', title: taskId }, taskId),
              h('button', { type: 'button', className: 'wf-btn wf-sm', onClick: () => onRematch?.(taskId) }, tr('Re-match')))),
            (workflow.heldTaskCount ?? held.length) > held.length
              ? h('div', { className: 'wf-held-more' }, tr('{count} more held tasks', { count: (workflow.heldTaskCount ?? held.length) - held.length }))
              : null) : null,
          liveRuns.length > 0 ? h('div', { className: 'wf-strips' },
            liveRuns.map(run => h(RunStrip, {
              key: run.id, workflow, run, focused: viewRun?.id === run.id,
              onFocus: onFocusRun, onPause, onResume, onStop, onTab, onOpenDrawer,
            }))) : null,
          visible.length > 0 ? h('div', { className: 'wf-chat', ref: chatRef },
            h('div', { className: 'wf-chat-in' },
              visible.map(message => h(Bubble, { key: message.id, message, workflow, roster })))) : null),
        drawer ? h('aside', { className: 'wf-drawer' },
          h('div', { className: 'wf-dr-head' },
            h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onCloseDrawer }, '×')),
          h(DrawerBody, { workflow, roster, tab, onTab, onReset, onTip, editing, onToggleEdit, onCommit, viewRun })) : null)
    }

    function Bubble({ message, workflow, roster }) {
      if (message.kind === 'time') return h('div', { className: 'wf-ts' }, relativeTime(message.at) || message.text)
      if (message.kind === 'system') {
        const text = message.key ? tr(message.key, message.params) : message.text
        return h('div', { className: `wf-sys ${message.tone ?? ''}`, title: text }, text)
      }
      if (message.kind === 'user') return h('div', { className: 'wf-user', title: message.text }, message.text)
      const node = nodeOf(workflow, message.botId) ?? { id: message.botId, name: message.botId }
      const text = message.key ? tr(message.key, message.params) : message.text
      return h('div', { className: 'wf-msg' },
        h(Mark, { node, roster, size: 28 }),
        h('div', null,
          h('div', { className: 'wf-who' }, node.name, message.step ? h('span', { className: 'wf-step' }, tr('Step {step}', { step: tr(message.step) })) : null),
          h('div', { className: 'wf-bub', title: text }, text,
            message.attachments?.length ? h('div', { className: 'wf-att' }, message.attachments.map(name => h('span', { key: name }, name))) : null)))
    }

    function DrawerBody({ workflow, roster, tab, onTab, onReset, onTip, editing, onToggleEdit, onCommit, viewRun }) {
      const run = viewRun?.live === true ? viewRun : null
      return h('div', { className: 'wf-dr-body' },
        h('div', { className: 'wf-dr-title' },
          h('div', { className: 'wf-ico wf-ico-lg' }, glyph()),
          h('h2', null, workflow.name),
          h('p', null, workflow.description)),
        h('div', { className: 'wf-tabs', role: 'tablist' },
          ['flow', 'details', 'runs'].map(key => h('button', {
            key, type: 'button', role: 'tab', 'aria-selected': tab === key, className: tab === key ? 'on' : '', onClick: () => onTab(key),
          }, tr(key === 'flow' ? 'Flow' : key === 'details' ? 'Details' : 'Runs')))),
        tab === 'flow' ? h(Flow, { workflow, run, roster, onTip, editing, onCommit }) : null,
        tab === 'details' ? h(Details, { workflow, roster }) : null,
        tab === 'runs' ? h(Runs, { workflow }) : null,
        h('div', { className: 'wf-ctl' },
          h('button', { type: 'button', className: 'wf-btn', onClick: onReset }, `↺ ${tr('Reset')}`),
          h('button', { type: 'button', className: 'wf-btn', onClick: onToggleEdit }, editing ? tr('Finish editing') : tr('Edit'))))
    }

    function nextNodeId(nodes) {
      let n = nodes.length + 1
      const ids = new Set(nodes.map(node => node.id))
      while (ids.has(`n${n}`)) n += 1
      return `n${n}`
    }

    function hitNode(event) {
      const direct = event.target?.dataset?.node ? event.target : null
      const nested = event.target?.closest?.('[data-node]')
      return (nested ?? direct)?.dataset?.node || ''
    }

    // The Settings plane is zero-width, so world x sits on a ±WIRE_SPAN centre
    // line; the fitted drawer plane starts at 0, so it passes span 0 (#1513).
    function wirePath(from, to, span = WIRE_SPAN) {
      const shift = typeof span === 'number' ? span : WIRE_SPAN
      const x1 = (from.x ?? 0) + shift
      const y1 = (from.y ?? 0) + NODE_WIRE_OUT
      const x2 = (to.x ?? 0) + shift
      const y2 = to.y ?? 0
      if (Math.abs(x1 - x2) < 0.5) {
        const mid = (y1 + y2) / 2
        return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
      }
      const midY = Math.round((y1 + y2) / 2)
      return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
    }

    // The drawn card's own size: a fitted plane keeps the 168x72 card, and the
    // laid-out one shrinks it to the panel (#1693). Reading the box here is what
    // keeps the frame around the cards it encloses instead of the old card size.
    function parallelFrameStyle(members) {
      const pad = 10
      const boxes = members.map(node => {
        const x = node.x ?? 0
        const y = node.y ?? 0
        const w = node.w ?? NODE_W
        const h = node.h ?? NODE_H
        return { left: x - w / 2, right: x + w / 2, top: y, bottom: y + h }
      })
      const left = Math.min(...boxes.map(box => box.left))
      const right = Math.max(...boxes.map(box => box.right))
      const top = Math.min(...boxes.map(box => box.top))
      const bottom = Math.max(...boxes.map(box => box.bottom))
      return {
        left: left - pad,
        top: top - 20,
        width: right - left + pad * 2,
        height: bottom - top + pad,
      }
    }

    // Fit a graph to a panel width: only the node centres scale, never the node
    // boxes, so labels stay readable. Positions come back in panel coordinates
    // (x from the left edge, y from the top), the graph is centred horizontally,
    // and `scale` is never above 1 so a wide Settings canvas never enlarges it.
    // It maps world → fitted; `offsetX` / `offsetY` invert a pointer position.
    function fitPlane(nodes, panelWidth = DRAWER_FLOW_W) {
      const width = Math.max(Number(panelWidth) || DRAWER_FLOW_W, NODE_W + FIT_PAD * 2)
      const list = (nodes ?? []).filter(node => node && typeof node === 'object')
      const xs = list.map(node => Number(node.x) || 0)
      const ys = list.map(node => Number(node.y) || 0)
      const minX = xs.length ? Math.min(...xs) : 0
      const maxX = xs.length ? Math.max(...xs) : 0
      const minY = ys.length ? Math.min(...ys) : 0
      const maxY = ys.length ? Math.max(...ys) : 0
      const span = maxX - minX
      const room = Math.max(0, width - FIT_PAD * 2 - NODE_W)
      const scale = span > 0 ? Math.min(1, room / span) : 1
      const offsetX = width / 2 - ((minX + maxX) / 2) * scale
      const offsetY = FIT_PAD - minY
      return {
        width,
        scale,
        offsetX,
        offsetY,
        height: Math.max(420, maxY + NODE_H + FIT_PAD + offsetY),
        nodes: list.map(node => ({ ...node, x: (node.x ?? 0) * scale + offsetX, y: (node.y ?? 0) + offsetY })),
      }
    }

    // The drawer's read-only flowchart is laid out from the steps, not from the
    // stored editor coordinates: hand-dragged x/y drawn into a narrow panel put
    // nodes on top of the parallel frame and left wires hanging in empty space.
    // Rows follow `layers`, a parallel row sits inside its dashed frame, node
    // boxes shrink to the panel width, and each wire is routed orthogonally from
    // the drawn boxes — `heights` are the measured node heights, so a card that
    // wraps to a taller box moves its anchors with it.
    const FLOW_GAP_X = 12
    const FLOW_ROW_GAP = 36
    const FLOW_PAR_PAD = 10
    const FLOW_PAR_LABEL = 28
    const FLOW_NODE_MIN_W = 96
    const FLOW_WRAP_GAP = 12
    function flowRows(workflow) {
      const nodes = (workflow?.nodes ?? []).filter(node => node && typeof node.id === 'string')
      const ids = new Set(nodes.map(node => node.id))
      const seen = new Set()
      const rows = []
      for (const layer of workflow?.layers ?? []) {
        const row = (Array.isArray(layer) ? layer : []).filter(id => ids.has(id) && !seen.has(id))
        row.forEach(id => seen.add(id))
        if (row.length) rows.push(row)
      }
      for (const node of nodes) if (!seen.has(node.id)) rows.push([node.id])
      return rows
    }
    function flowLayout(workflow, panelWidth = DRAWER_FLOW_W, heights = {}) {
      const width = Math.max(Number(panelWidth) || DRAWER_FLOW_W, FLOW_NODE_MIN_W + FIT_PAD * 2)
      const rows = flowRows(workflow)
      const boxes = new Map()
      const frames = []
      const bands = []
      let y = FIT_PAD
      rows.forEach((row, index) => {
        const par = row.length > 1
        const inner = width - FIT_PAD * 2 - (par ? FLOW_PAR_PAD * 2 : 0)
        // A layer wider than the plane wraps onto more lines inside the same frame
        // instead of running past the panel edge, where the clipped branches cannot
        // be reached at all (#1658). The column count comes from the width, so a
        // 3-branch layer in a 400px drawer keeps one line.
        const columns = Math.max(1, Math.min(row.length, Math.floor((inner + FLOW_GAP_X) / (FLOW_NODE_MIN_W + FLOW_GAP_X))))
        const perLine = Math.ceil(row.length / Math.ceil(row.length / columns))
        const lines = []
        for (let at = 0; at < row.length; at += perLine) lines.push(row.slice(at, at + perLine))
        const top = y + (par ? FLOW_PAR_LABEL : 0)
        let cursor = top
        let leftEdge = width
        let rightEdge = 0
        const linesOfBand = []
        lines.forEach((line, lineIndex) => {
          const w = Math.max(FLOW_NODE_MIN_W, Math.min(NODE_W, Math.floor((inner - FLOW_GAP_X * (line.length - 1)) / line.length)))
          const total = w * line.length + FLOW_GAP_X * (line.length - 1)
          const start = Math.round(width / 2 - total / 2)
          let lineH = 0
          line.forEach((id, column) => {
            const hgt = Math.max(24, Number(heights?.[id]) || NODE_H)
            lineH = Math.max(lineH, hgt)
            const left = start + column * (w + FLOW_GAP_X)
            boxes.set(id, { id, row: index, line: lineIndex, left, top: cursor, w, h: hgt, x: left + w / 2 })
          })
          linesOfBand.push({ top: cursor, bottom: cursor + lineH })
          leftEdge = Math.min(leftEdge, start)
          rightEdge = Math.max(rightEdge, start + total)
          cursor += lineH + (lineIndex < lines.length - 1 ? FLOW_WRAP_GAP : 0)
        })
        const bottom = cursor + (par ? FLOW_PAR_PAD : 0)
        const span = rightEdge - leftEdge
        // The label rides the frame's top border; with two branches one line, it fits
        // between the two drops so no wire runs through it.
        const labelMax = lines.length === 1 && row.length === 2 ? span + FLOW_GAP_X - 16 : span
        if (par) frames.push({ key: row.join('+'), left: leftEdge - FLOW_PAR_PAD, top: y, width: span + FLOW_PAR_PAD * 2, height: bottom - y, labelMax })
        bands.push({ top: y, bottom, lines: linesOfBand, left: leftEdge, right: rightEdge })
        y = bottom + FLOW_ROW_GAP
      })
      const height = rows.length ? y - FLOW_ROW_GAP + FIT_PAD : 0
      return { width, height, rows, boxes, frames, bands, wires: flowWires(workflow?.edges ?? [], boxes, bands, width) }
    }
    // The drawer's Edit plane. `fitPlane` scales only the node centres (#1513), so the
    // cards keep their 168px width: three or more branches of one parallel step land
    // on top of each other in a 364px drawer, the later card takes the click, and the
    // branch's out-port cannot start a wire (#1677). While a parallel step's cards do
    // stay apart the fitted plane is used unchanged, so a two-branch Edit plane draws
    // exactly what it drew before; when they cannot, the rows come from `layers` with
    // the Read-only plane's column width and wrap, and the drawn coordinates are the
    // panel's own, which makes a drag a plain pointer delta.
    function editPlane(workflow, panelWidth = DRAWER_FLOW_W, heights = {}) {
      const width = Math.max(Number(panelWidth) || DRAWER_FLOW_W, NODE_W + FIT_PAD * 2)
      const fit = fitPlane(workflow?.nodes, width)
      const at = new Map(fit.nodes.map(node => [node.id, node]))
      const overlaps = (a, b) => Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H
      const crowded = (workflow?.layers ?? []).some(layer => {
        const members = (layer ?? []).map(id => at.get(id)).filter(Boolean)
        return members.some((a, i) => members.some((b, j) => j > i && overlaps(a, b)))
      })
      if (!crowded) return { width, scale: fit.scale, offsetX: fit.offsetX, offsetY: fit.offsetY, height: fit.height, wrapped: false, nodes: fit.nodes }
      // The laid-out rows are `flowLayout`'s own boxes, and its wires are the ones
      // routed around those same boxes — one copy of the row geometry (#1693).
      const layout = flowLayout(workflow, width, heights)
      const stored = new Map((workflow?.nodes ?? []).map(node => [node.id, node]))
      const drawn = [...layout.boxes.values()].map(box => ({
        ...stored.get(box.id), id: box.id, x: box.x, y: box.top, w: box.w, h: box.h,
      }))
      return { width: layout.width, scale: 1, offsetX: 0, offsetY: 0, height: Math.max(420, layout.height), wrapped: true, nodes: drawn, wires: layout.wires, frames: layout.frames }
    }
    // One bus per connected group of edges between two adjacent rows: every
    // source drops to the bus, every target rises from it, so a fork leaves one
    // point and a join meets in one point. Skip and loop edges run in the right
    // gutter. Every point is a box anchor or lies on the segment between two.
    // A layer wider than the panel wraps onto more lines inside one band (#1658),
    // and one band for all its lines means a straight run across the band would
    // cut through the cards of the other line (#1659): a card that is not on the
    // band's last or first line leaves through the wrap seam and runs down the
    // column gap at the band's left edge, which no card reaches.
    function flowWires(edges, boxes, bands, width) {
      const wires = []
      const gaps = new Map()
      const skips = []
      const pathOf = marks => marks.map((point, i) => `${i === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ')
      const lastLine = band => (band.lines?.length ?? 1) - 1
      const seamY = (band, line) => Math.round(band.lines[line].bottom + FLOW_WRAP_GAP / 2)
      const channelX = band => Math.round(band.left - FLOW_WRAP_GAP / 2)
      for (const edge of edges) {
        const from = boxes.get(edge?.from)
        const to = boxes.get(edge?.to)
        if (!from || !to || from === to) continue
        if (!edge.loop && to.row === from.row + 1) {
          const list = gaps.get(from.row) ?? []
          list.push({ edge, from, to })
          gaps.set(from.row, list)
        } else skips.push({ edge, from, to })
      }
      for (const [row, list] of gaps) {
        // Union the edges of this gap into groups that share a source or target.
        const parent = new Map()
        const find = key => { while (parent.get(key) !== key) key = parent.get(key); return key }
        const join = (a, b) => { parent.set(find(a), find(b)) }
        for (const { from, to } of list) {
          if (!parent.has(`s${from.id}`)) parent.set(`s${from.id}`, `s${from.id}`)
          if (!parent.has(`t${to.id}`)) parent.set(`t${to.id}`, `t${to.id}`)
          join(`s${from.id}`, `t${to.id}`)
        }
        const groups = new Map()
        for (const item of list) {
          const key = find(`s${item.from.id}`)
          const group = groups.get(key) ?? { sources: new Map(), targets: new Map(), edges: [] }
          group.sources.set(item.from.id, item.from)
          group.targets.set(item.to.id, item.to)
          group.edges.push(item.edge)
          groups.set(key, group)
        }
        const fromBand = bands[row]
        const toBand = bands[row + 1]
        const fromLast = lastLine(fromBand)
        const downX = channelX(fromBand)
        const upX = channelX(toBand)
        const gapTop = fromBand.bottom
        const gapBottom = toBand.top
        const ordered = [...groups.values()]
        ordered.forEach((group, k) => {
          const busY = Math.round(gapTop + (gapBottom - gapTop) * (k + 1) / (ordered.length + 1))
          const sources = [...group.sources.values()]
          const targets = [...group.targets.values()]
          const key = group.edges.map(edge => `${edge.from}>${edge.to}`).join(',')
          const sourceMarks = box => {
            const bottom = box.top + box.h
            const line = box.line ?? 0
            if (line >= fromLast) return [[box.x, bottom], [box.x, busY]]
            const seam = seamY(fromBand, line)
            return [[box.x, bottom], [box.x, seam], [downX, seam], [downX, busY]]
          }
          const targetMarks = box => {
            const line = box.line ?? 0
            if (line <= 0) return [[box.x, busY], [box.x, box.top]]
            const seam = seamY(toBand, line - 1)
            return [[box.x, busY], [upX, busY], [upX, seam], [box.x, seam], [box.x, box.top]]
          }
          if (sources.length === 1 && targets.length === 1 && Math.abs(sources[0].x - targets[0].x) < 0.5) {
            const source = sources[0]
            const target = targets[0]
            const x = source.x
            if ((source.line ?? 0) >= fromLast && (target.line ?? 0) <= 0) {
              wires.push({ key, kind: 'step', d: `M ${x} ${source.top + source.h} L ${x} ${target.top}`, arrow: true })
              return
            }
            const marks = sourceMarks(source)
            const rise = targetMarks(target)
            if (marks.at(-1)[0] !== rise[0][0]) marks.push([rise[0][0], busY])
            marks.push(...rise.slice(1))
            wires.push({ key, kind: 'step', d: pathOf(marks), arrow: true })
            return
          }
          const xs = sources.concat(targets).map(box => box.x)
          let minX = Math.min(...xs)
          const maxX = Math.max(...xs)
          if (sources.some(box => (box.line ?? 0) < fromLast)) minX = Math.min(minX, downX)
          const parts = sources.map(box => pathOf(sourceMarks(box)))
          if (maxX - minX >= 0.5) parts.push(`M ${minX} ${busY} L ${maxX} ${busY}`)
          wires.push({ key: `${key}|bus`, kind: sources.length > 1 ? 'join' : 'fork', d: parts.join(' '), arrow: false })
          for (const box of targets) wires.push({ key: `${key}|${box.id}`, kind: 'drop', d: pathOf(targetMarks(box)), arrow: true })
        })
      }
      skips.forEach(({ edge, from, to }, k) => {
        const gutter = Math.round(width - 4 - k * 5)
        const fromBand = bands[from.row]
        const toBand = bands[to.row]
        const outY = Math.round(fromBand.bottom + Math.min(10, FLOW_ROW_GAP / 3))
        const inY = Math.round(toBand.top - Math.min(10, FLOW_ROW_GAP / 3))
        const marks = [[from.x, from.top + from.h]]
        const fromLine = from.line ?? 0
        if (fromLine < lastLine(fromBand)) {
          const seam = seamY(fromBand, fromLine)
          const channel = channelX(fromBand)
          marks.push([from.x, seam], [channel, seam], [channel, outY])
        } else marks.push([from.x, outY])
        marks.push([gutter, outY], [gutter, inY])
        const toLine = to.line ?? 0
        if (toLine > 0) {
          const seam = seamY(toBand, toLine - 1)
          const channel = channelX(toBand)
          marks.push([channel, inY], [channel, seam], [to.x, seam], [to.x, to.top])
        } else marks.push([to.x, inY], [to.x, to.top])
        wires.push({
          key: `${edge.from}>${edge.to}|${edge.loop ? 'loop' : 'skip'}`,
          kind: edge.loop || to.row <= from.row ? 'loop' : 'skip',
          d: pathOf(marks),
          arrow: true,
        })
      })
      return wires
    }

    function liveStageRuns(workflow) {
      let liveRuns = (workflow.runs ?? []).filter(run => run?.live === true && (run.status === 'running' || run.status === 'failed'))
      if (liveRuns.length === 0 && workflow.run?.live === true && (workflow.run.status === 'running' || workflow.run.status === 'failed')) {
        liveRuns = [workflow.run]
      }
      return liveRuns
    }

    function attemptTime(run) {
      return Number(run?.updatedAt ?? run?.startedAt ?? run?.at ?? 0) || 0
    }

    // A retry keeps the older attempt as a row of its own, so the room must open on
    // the newest attempt for that taskId, not on whichever row went live first (#1507).
    function newestAttempt(workflow, run) {
      if (!run?.task?.id) return run
      let best = run
      for (const item of liveStageRuns(workflow)) {
        if (item.task?.id !== run.task.id) continue
        if (attemptTime(item) > attemptTime(best)) best = item
      }
      return best
    }

    function resolveFocusedRun(workflow, focusedRunId) {
      const live = liveStageRuns(workflow)
      if (focusedRunId) {
        const picked = live.find(run => run.id === focusedRunId)
        if (picked) return picked
      }
      const current = workflow.run?.live === true && (workflow.run.status === 'running' || workflow.run.status === 'failed')
        ? workflow.run
        : live[0] ?? null
      return current ? newestAttempt(workflow, current) : null
    }

    function runHistoryRows(workflow) {
      const history = workflow.history ?? []
      const queued = workflow.queue ?? []
      const liveRuns = liveStageRuns(workflow)
      if (liveRuns.length === 0 && history.length === 0 && queued.length === 0) return null
      const rows = liveRuns.map(run => ({
        id: run.id,
        live: true,
        task: run.task,
        status: run.status,
        at: run.updatedAt,
        failure: run.failure,
        current: workflow.run?.id === run.id,
      }))
      for (const task of queued) rows.push({ task, status: 'queued', current: false })
      const seen = new Set()
      for (const row of rows) {
        if (row.id) seen.add(row.id)
        seen.add(`${row.task?.id ?? ''}|${row.at ?? ''}`)
      }
      for (const item of history) {
        const key = item.id ?? `${item.task?.id ?? ''}|${item.at ?? ''}`
        if (seen.has(key)) continue
        rows.push({ ...item, current: false })
      }
      return markSuperseded(rows)
    }

    // Retries are not folded: every attempt keeps its row and the older finished one
    // names the attempt that replaced it. Two live attempts are both left unmarked,
    // because either may still be the one that matters (#1507).
    function markSuperseded(rows) {
      const byTask = new Map()
      rows.forEach((row, index) => {
        const taskId = row.task?.id
        if (!taskId) return
        const list = byTask.get(taskId) ?? []
        list.push({ row, index })
        byTask.set(taskId, list)
      })
      for (const list of byTask.values()) {
        if (list.length < 2) continue
        const ordered = [...list].sort((a, b) => attemptTime(a.row) - attemptTime(b.row) || a.index - b.index)
        const newest = ordered[ordered.length - 1].row
        for (const { row } of ordered.slice(0, -1)) {
          if (row.live === true || row.status === 'running' || row.status === 'queued') continue
          if (!row.id || !newest.id) continue
          row.supersededBy = newest.id
          newest.retryOf = row.id
        }
      }
      return rows
    }

    function wireSvgProps(height, width = WIRE_SPAN * 2) {
      return {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      }
    }

    function Flow({ workflow, run, roster, onTip, editing, onCommit }) {
      const [gesture, setGesture] = useState(null)
      const [ghost, setGhost] = useState(null)
      const [dragPreview, setDragPreview] = useState(null)
      // One line under the palette when the laid-out plane refused a move (#1686).
      const [planeHint, setPlaneHint] = useState(null)
      const [selectedNode, setSelectedNode] = useState(null)
      const [termOpen, setTermOpen] = useState(false)
      const [measure, setMeasure] = useState({ width: 0, heights: {} })
      const canvasRef = useRef(null)
      const status = run?.nodeStatus ?? {}
      // Read the drawn panel width and node heights after every paint and on
      // resize, so the wires follow the boxes the browser actually laid out. Both
      // planes are measured: the Read-only one puts its heights into `flowLayout`,
      // and a laid-out Edit plane needs them for its row heights (#1677).
      useEffect(() => {
        const el = canvasRef.current
        const read = () => {
          const width = Math.round(el?.getBoundingClientRect?.().width || 0)
          const heights = {}
          for (const item of el?.querySelectorAll?.('[data-node]') ?? []) {
            const value = Math.round(item.offsetHeight || 0)
            if (value > 0) heights[item.dataset?.node] = value
          }
          setMeasure(prev => {
            const same = prev.width === width && Object.keys(heights).length === Object.keys(prev.heights).length &&
              Object.entries(heights).every(([id, value]) => prev.heights[id] === value)
            return same ? prev : { width, heights }
          })
        }
        read()
        if (typeof ResizeObserver !== 'function' || !el) return undefined
        const observer = new ResizeObserver(read)
        observer.observe(el)
        return () => observer.disconnect()
      })
      const nodes = workflow.nodes
      const edges = workflow.edges ?? []
      // The drawer paints the world graph: fitted while its cards stay apart (#1513),
      // laid out in rows once a parallel step's cards cannot (#1677). Either plane is
      // a fixed frame for the whole gesture: folding the ghost back into it re-centred
      // and rescaled the graph under the pointer and pinned an extreme node (#1575).
      const plane = editPlane(workflow, DRAWER_FLOW_W, measure.heights)
      const scale = plane.scale || 1
      const fitted = new Map(plane.nodes.map(node => [node.id, node]))
      const drawn = new Map(fitted)
      for (const [id, spot] of Object.entries(ghost ?? {})) {
        const base = fitted.get(id)
        if (base) drawn.set(id, { ...base, x: spot.x * scale + plane.offsetX, y: spot.y + plane.offsetY })
      }
      const height = plane.height
      const view = flowLayout(workflow, measure.width > 0 ? measure.width : DRAWER_FLOW_W, measure.heights)
      const locals = (roster?.bots ?? []).filter(bot => bot && bot.remote !== true && !nodes.some(node => node.botId === bot.id))
      const selected = nodes.find(node => node.id === selectedNode)
      // Any change the plane does take clears the one hint a refused move left (#1686).
      const commit = (nextNodes, nextEdges) => { setPlaneHint(null); onCommit?.({ nodes: nextNodes, edges: nextEdges }) }
      const movePointer = (event) => {
        if (!gesture) return
        if (gesture.kind === 'add') {
          setDragPreview({ x: event.clientX, y: event.clientY })
          return
        }
        if (gesture.kind !== 'move') return
        // The panel is fitted, so a pointer delta is worth delta / scale in the
        // stored world graph; the scale is the one the drag started with.
        const k = gesture.scale || 1
        setGhost({ [gesture.id]: { x: Math.round(gesture.x + (event.clientX - gesture.ox) / k), y: Math.round(gesture.y + event.clientY - gesture.oy) } })
      }
      const endPointer = (event) => {
        if (!gesture) return
        setDragPreview(null)
        const hit = hitNode(event)
        if (gesture.kind === 'move' && ghost?.[gesture.id]) {
          // A laid-out plane draws its cards in panel coordinates, so this ghost is a panel point:
          // committing it would rewrite the stored layout from a drag made only to see the cards.
          // The drawer's Edit plane changes structure, not layout (#1686).
          if (plane.wrapped) setPlaneHint(tr('Layout lives in Settings'))
          else commit(nodes.map(node => node.id === gesture.id ? { ...node, ...ghost[gesture.id] } : node), edges)
        } else if (gesture.kind === 'wire' && hit && hit !== gesture.from) {
          commit(workflow.nodes, edges.concat([{ from: gesture.from, to: hit }]))
        } else if (gesture.kind === 'reconnect') {
          const rest = edges.filter(edge => !(edge.from === gesture.from && edge.to === gesture.to))
          if (hit && hit !== gesture.from) commit(workflow.nodes, rest.concat([{ from: gesture.from, to: hit }]))
          else if (!hit) commit(workflow.nodes, rest)
        } else if (gesture.kind === 'add' && event.target?.dataset?.plane) {
          const bot = gesture.bot
          // In a laid-out plane the drop point is a panel point too, and `flowLayout` gives the new
          // card its own row either way, so it keeps the plane's default seat (24, 24) instead.
          const drop = plane.wrapped ? { x: 24, y: 24 } : {
            x: Number.isFinite(event.offsetX) ? Math.round((event.offsetX - plane.offsetX) / scale) : 24,
            y: Number.isFinite(event.offsetY) ? Math.round(event.offsetY - plane.offsetY) : 24,
          }
          commit(workflow.nodes.concat([{ id: nextNodeId(workflow.nodes), name: bot.name, botId: bot.id, role: bot.role ?? '', x: drop.x, y: drop.y }]), edges)
        }
        setGesture(null)
        setGhost(null)
      }
      const updateNode = (nodeId, updates) => {
        commit(nodes.map(item => item.id === nodeId ? { ...item, ...updates } : item), edges)
      }
      const termText = run ? taskSummary(run.task, run) : ''
      const termLong = termText.length > 90
      return h('div', { className: 'wf-canvas', 'data-fit': 'drawer', ref: canvasRef, onPointerMove: movePointer, onPointerUp: endPointer, onPointerCancel: () => { setGesture(null); setGhost(null); setDragPreview(null) } },
        editing ? h('div', { className: 'wf-palette' },
          h('p', { className: 'wf-palette-hint' }, tr('Drag a Bot here')),
          h('div', { className: 'wf-palette-row' },
            locals.map(bot => h(PaletteBotChip, {
              key: bot.id,
              bot,
              peers: locals,
              dragging: gesture?.kind === 'add' && gesture.bot?.id === bot.id,
              onPointerDown: (event) => {
                event.preventDefault?.()
                setGesture({ kind: 'add', bot })
                setDragPreview({ x: event.clientX, y: event.clientY })
              },
            })))) : null,
        editing && plane.wrapped && planeHint ? h('p', { className: 'wf-plane-hint', role: 'status' }, planeHint) : null,
        gesture?.kind === 'add' && dragPreview ? h('div', {
          className: 'wf-drag-ghost',
          style: { left: dragPreview.x + 10, top: dragPreview.y + 10 },
          'aria-hidden': true,
        }, h(PaletteBotFace, { bot: gesture.bot, size: 24 }), h('span', { className: 'wf-drag-ghost-name' }, gesture.bot?.name ?? '')) : null,
        run ? h('div', { className: `wf-term${termLong && !termOpen ? ' wf-term-clamp' : ''}`, title: run.task?.title ?? '' },
          h('span', { className: 'wf-term-text' }, termText),
          termLong ? h('button', { type: 'button', className: 'wf-term-more', 'aria-expanded': termOpen, onClick: () => setTermOpen(!termOpen) }, tr(termOpen ? 'Show less' : 'Show more')) : null) : null,
        !editing ? h(FlowView, { workflow, layout: view, status, roster }) : null,
        editing ? h('div', { className: 'wf-plane', 'data-plane': '1', style: { height, width: plane.width } },
          h('svg', { className: 'wf-wires', 'aria-hidden': true, ...wireSvgProps(height, plane.width) },
            // The laid-out plane draws the wires `flowLayout` routed around its own
            // boxes; the fitted plane keeps the single fold between two cards (#1693).
            plane.wrapped
              ? (plane.wires ?? []).map(wire => h('path', { key: wire.key, d: wire.d, 'data-wire': wire.kind }))
              : edges.map(edge => {
                  const from = drawn.get(edge.from)
                  const to = drawn.get(edge.to)
                  if (!from || !to) return null
                  return h('path', { key: `${edge.from}>${edge.to}`, d: wirePath(from, to, 0) })
                }),
            edges.map(edge => {
              const to = drawn.get(edge.to)
              if (!to) return null
              return h('circle', {
                key: `end:${edge.from}>${edge.to}`,
                cx: to.x, cy: to.y, r: 7, className: 'wf-end',
                'data-port': 'end', 'data-src': edge.from, 'data-dst': edge.to,
                onPointerDown: (event) => { event.preventDefault?.(); event.stopPropagation?.(); setGesture({ kind: 'reconnect', from: edge.from, to: edge.to }) },
              })
            })),
          // The laid-out frame is the band `flowLayout` drew its cards in, so it
          // encloses them by construction; the fitted plane keeps the frame drawn
          // around the scaled cards (#1693).
          plane.wrapped
            ? (plane.frames ?? []).map(frame => h('div', {
                key: frame.key, className: 'wf-par wf-abs',
                style: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
              }, h('div', { className: 'wf-plabel', style: { maxWidth: frame.labelMax } }, tr('Parallel branches · Merge after all pass'))))
            : (workflow.layers ?? []).filter(layer => layer.length > 1).map(layer => {
                const members = layer.map(id => drawn.get(id)).filter(Boolean)
                if (members.length < 2) return null
                return h('div', {
                  key: layer.join('+'), className: 'wf-par wf-abs',
                  style: parallelFrameStyle(members),
                }, h('div', { className: 'wf-plabel' }, tr('Parallel branches · Merge after all pass')))
              }),
          nodes.map(node => {
            const spot = drawn.get(node.id) ?? node
            return h('div', {
              key: node.id,
              'data-node': node.id,
              className: `wf-node wf-abs ${status[node.id] ?? 'queued'} ${selectedNode === node.id ? 'selected' : ''}`,
              style: plane.wrapped ? { left: spot.x - spot.w / 2, top: spot.y, width: spot.w } : { left: spot.x - NODE_W / 2, top: spot.y },
              onClick: () => editing ? setSelectedNode(node.id) : null,
              onPointerDown: (event) => {
                if (!editing || event.target?.dataset?.port || event.target?.dataset?.remove) return
                // The drag starts in the frame that is drawn: the fitted plane divides the
                // pointer delta by its scale, and a laid-out plane is 1:1, so the move is a
                // plain delta there (#1677).
                setGesture({ kind: 'move', id: node.id, ox: event.clientX, oy: event.clientY, x: plane.wrapped ? spot.x : node.x, y: plane.wrapped ? spot.y : node.y, scale })
              },
              onMouseEnter: editing ? (event) => onTip?.({ x: event.clientX, y: event.clientY, node }) : null,
              onMouseLeave: editing ? () => onTip?.(null) : null,
            },
              editing ? h('button', {
                type: 'button', className: `wf-port out${gesture?.kind === 'wire' && gesture.from === node.id ? ' wiring' : ''}`, 'data-port': 'out', 'aria-label': node.name,
                onPointerDown: (event) => { event.preventDefault?.(); event.stopPropagation?.(); setGesture({ kind: 'wire', from: node.id }) },
              }) : null,
              editing ? h('button', {
                type: 'button', className: 'wf-mini', 'data-remove': node.id, 'aria-label': tr('Remove'),
                onClick: (event) => {
                  event.stopPropagation?.()
                  commit(workflow.nodes.filter(item => item.id !== node.id), edges.filter(edge => edge.from !== node.id && edge.to !== node.id))
                  setSelectedNode(null)
                },
              }, '×') : null,
              h(FlowNode, { node, status: status[node.id] ?? 'queued', roster }))
          })) : null,
        run?.status === 'done' ? h('div', { className: 'wf-term on' }, tr('Done')) : null,
        editing && selected ? h('div', { className: 'wf-node-inspector' },
          h('div', { className: 'wf-inspector-header' },
            h('span', null, `${selected.name} · ${tr('System prompt')}`),
            h('button', { type: 'button', className: 'wf-close-inspector', onClick: () => setSelectedNode(null) }, '×')),
          h('textarea', {
            rows: 4,
            value: selected.prompt || '',
            onChange: (event) => updateNode(selected.id, { prompt: event.target.value }),
            placeholder: tr('System prompt'),
          })) : null)
    }

    function FlowView({ workflow, layout, status, roster }) {
      const nodes = workflow.nodes ?? []
      return h('div', { className: 'wf-plane wf-flow-view', 'data-plane': '1', style: { height: layout.height, width: layout.width } },
        h('svg', { className: 'wf-wires', 'aria-hidden': true, ...wireSvgProps(layout.height, layout.width) },
          h('defs', null,
            h('marker', { id: 'wf-flow-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
              h('path', { d: 'M0 1 9 5 0 9z', className: 'wf-arrow' }))),
          layout.wires.map(wire => h('path', {
            key: wire.key, d: wire.d, 'data-wire': wire.kind,
            className: wire.kind === 'loop' ? 'wf-wire-loop' : undefined,
            markerEnd: wire.arrow ? 'url(#wf-flow-arrow)' : undefined,
          }))),
        layout.frames.map(frame => h('div', {
          key: frame.key, className: 'wf-par wf-abs',
          style: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
        }, h('div', { className: 'wf-plabel', style: { maxWidth: frame.labelMax } }, tr('Parallel branches · Merge after all pass')))),
        nodes.map(node => {
          const box = layout.boxes.get(node.id)
          if (!box) return null
          return h('div', {
            key: node.id, 'data-node': node.id,
            className: `wf-node wf-abs ${status[node.id] ?? 'queued'}`,
            style: { left: box.left, top: box.top, width: box.w },
          }, h(FlowNode, { node, status: status[node.id] ?? 'queued', roster }))
        }))
    }

    function FlowNode({ node, status, roster }) {
      return h('div', { className: 'wf-node-row' },
        h(Mark, { node, roster, size: 28 }),
        h('span', { className: 'wf-nt' },
          h('span', { className: 'wf-nm' },
            node.name,
            h('span', { className: `wf-chip wf-chip-inline ${status}` }, tr(STATUS_KEY[status] ?? 'Idle'))),
          h('span', { className: 'wf-rl' }, node.role)))
    }

    function Details({ workflow, roster }) {
      const trigger = workflow.trigger === 'schedule'
        ? `${tr('Schedule')} · ${workflow.scheduleLabel}`
        : tr('Manual')
      const retries = workflow.nodes.some(node => node.failOnce)
      const modelLabel = workflow.model
        ? (roster?.models ?? []).find(m => m.ref === workflow.model)?.name ?? workflow.model
        : tr('Each Bot\'s own model')
      return h('div', { className: 'wf-box' },
        h('div', { className: 'wf-kv' }, h('span', null, tr('Trigger')), h('span', null, trigger)),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Model')), h('span', null, modelLabel)),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Permissions')), h('span', null, tr('Full access, same as a normal Bot'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('On failure')), h('span', null, tr(retries ? 'Tester retries once. Any other failed step stops the run.' : 'A failed step stops the run.'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Concurrent runs')), h('span', null, String(workflow.maxConcurrent ?? 2))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Members')), h('span', null, workflow.chain)))
    }

    function Runs({ workflow }) {
      const rows = runHistoryRows(workflow)
      if (!rows) return h('div', { className: 'wf-muted' }, tr('No runs yet.'))
      return h('div', null, rows.map((item, index) => {
        // #1618: keep HH:MM in its own non-shrinking column with a gap before the
        // status chip, and paint Failed once — skip wf-hist-reason when it only
        // repeats the chip label (generic Failed with no host detail).
        const chipLabel = tr(STATUS_KEY[item.status] ?? 'Queued')
        const reason = item.status === 'failed' ? failureText(item) : ''
        const showReason = Boolean(reason) && reason !== chipLabel
        const chipClass = item.status === 'done' ? 'done'
          : item.status === 'running' ? 'running'
          : item.status === 'failed' ? 'failed'
          : 'queued'
        return h('div', { key: index, className: 'wf-hist' },
          h('span', { className: 'wf-hist-task', title: item.task?.title ?? '' }, taskSummary(item.task, item)),
          h('span', { className: 'wf-hist-meta' },
            item.at ? h('span', { className: 'wf-hist-time' }, runTime(item.at)) : null,
            item.supersededBy ? h('span', { className: 'wf-hist-retry', title: item.supersededBy }, `superseded by ${item.supersededBy}`) : null,
            item.retryOf ? h('span', { className: 'wf-hist-retry', title: item.retryOf }, `retry of ${item.retryOf}`) : null,
            showReason ? h('span', { className: 'wf-hist-reason', title: reason }, reason) : null),
          h('span', { className: `wf-chip ${chipClass}` }, chipLabel))
      }))
    }

    function RenameModal({ workflow, onClose, onConfirm }) {
      const [name, setName] = useState(workflow?.name ?? '')
      return h('div', { className: 'wf-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'wf-modal', role: 'dialog', 'aria-modal': true, 'aria-label': tr('Rename workflow') },
          h('div', { className: 'wf-modal-header' },
            h('h3', null, tr('Rename workflow'),
              h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onClose }, '×'))),
          h('div', { className: 'wf-modal-body' },
            h('label', { className: 'wf-field' }, tr('Name'),
              h('input', { value: name, onChange: (event) => setName(event.target.value) }))),
          h('div', { className: 'wf-modal-footer' },
            h('button', { type: 'button', className: 'wf-btn', onClick: onClose }, tr('Cancel')),
            h('button', { type: 'button', className: 'wf-btn wf-dark', onClick: () => onConfirm?.(name) }, tr('Rename')))))
    }

    function DeleteModal({ workflow, onClose, onConfirm }) {
      return h('div', { className: 'wf-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'wf-modal', role: 'dialog', 'aria-modal': true, 'aria-label': tr('Delete workflow') },
          h('div', { className: 'wf-modal-header' },
            h('h3', null, tr('Delete workflow'),
              h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onClose }, '×'))),
          h('div', { className: 'wf-modal-body' },
            h('p', { className: 'wf-hint' }, tr('Are you sure you want to delete "{name}"? This cannot be undone.', { name: workflow?.name ?? '' }))),
          h('div', { className: 'wf-modal-footer' },
            h('button', { type: 'button', className: 'wf-btn', onClick: onClose }, tr('Cancel')),
            h('button', { type: 'button', className: 'wf-btn wf-danger', onClick: onConfirm }, tr('Delete')))))
    }

    function AssignModal({ workflows, tasks, tasksStatus, tasksError, roster, workflowId, onClose, onConfirm, onRetry }) {
      const [taskId, setTaskId] = useState(tasks[0]?.id ?? '')
      const [target, setTarget] = useState(workflowId || workflows[0]?.id || '')
      // #1457: the dialog opens before loadTasks() answers, so the first client render can have no
      // rows; select the first card once they arrive, or when the selected card is gone.
      useEffect(() => {
        if (tasks.length === 0) return
        if (taskId && tasks.some(task => task.id === taskId)) return
        setTaskId(tasks[0].id)
      }, [tasks, taskId])
      const canAssign = tasksStatus === 'ready' && tasks.some(task => task.id === taskId)
      const seen = new Set()
      const bots = (roster?.bots ?? []).filter(bot => {
        if (!bot || bot.remote === true || !bot.id || !bot.name) return false
        if (seen.has(bot.name)) return false
        seen.add(bot.name)
        return true
      }).slice(0, 12)
      return h('div', { className: 'wf-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'wf-modal', role: 'dialog', 'aria-modal': true, 'aria-label': tr('Hand a task to a Workflow') },
          h('div', { className: 'wf-modal-header' },
            h('h3', null, tr('Hand a task to a Workflow'),
              h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onClose }, '×')),
            h('p', { className: 'wf-hint' }, tr('A task can go to a Workflow, not only to one Bot. The Workflow then runs each Bot in order, or side by side.'))),
          h('div', { className: 'wf-modal-body' },
            h('div', { className: 'wf-step-h' }, h('b', null, '1'), tr('Pick a task card')),
            tasksStatus === 'failed'
              ? h('div', { className: 'wf-assign-fail' },
                h('div', { className: 'wf-err', role: 'alert' }, tasksError || tr('Could not load the Tasks board.')),
                h('button', { type: 'button', className: 'wf-btn', onClick: () => onRetry?.() }, tr('Retry')))
              : tasksStatus !== 'ready'
                ? h('div', { className: 'wf-muted wf-cards-empty' }, tr('Loading the Tasks board…'))
                : tasks.length === 0
                  ? h('div', { className: 'wf-muted wf-cards-empty' }, tr('No open tasks on the Tasks board.'))
                  : h('div', { className: 'wf-cards' }, tasks.map(task => h('button', {
                    key: task.id, type: 'button', className: `wf-kcard ${taskId === task.id ? 'sel' : ''}`, onClick: () => setTaskId(task.id),
                  },
                    h('div', { className: 'wf-id' }, `${shortId(task.id)} · ${priorityOf(task)}`),
                    h('div', { className: 'wf-tt' }, task.title),
                    h('div', { className: 'wf-kcol' }, `● ${tr(COLUMN_KEY[columnOf(task)] ?? 'Not started')}`)))),
            h('div', { className: 'wf-step-h' }, h('b', null, '2'), tr('Pick who runs it')),
            h('div', { className: 'wf-targets' },
              workflows.map(item => h('button', {
                key: item.id, type: 'button', className: `wf-tgt ${target === item.id ? 'sel' : ''}`, onClick: () => setTarget(item.id),
              },
                h('span', { className: 'wf-tgt-thumb' }, h(MiniFlowchart, { workflow: item, roster, compact: true })),
                h('span', null,
                  h('span', { className: 'wf-t1' }, item.name, h('span', { className: 'wf-badge' }, tr('Workflow'))),
                  h('span', { className: 'wf-chain' }, item.chain)),
                h('span', { className: 'wf-rad' }))),
              bots.map(bot => h('button', {
                key: bot.id, type: 'button', className: `wf-tgt ${target === `bot:${bot.id}` ? 'sel' : ''}`, onClick: () => setTarget(`bot:${bot.id}`),
              },
                h(Mark, { node: { name: bot.name, botId: bot.id }, roster, size: 30 }),
                h('span', null,
                  h('span', { className: 'wf-t1' }, bot.name),
                  h('span', { className: 'wf-chain' }, tr('One Bot (as before)'))),
                h('span', { className: 'wf-rad' }))))),
          h('div', { className: 'wf-modal-footer' },
            h('button', { type: 'button', className: 'wf-btn', onClick: onClose }, tr('Cancel')),
            h('button', { type: 'button', className: 'wf-btn wf-dark', disabled: !canAssign, onClick: () => { if (canAssign) onConfirm({ taskId, target }) } }, tr('Assign')))))
    }

    function CreateModal({ roster, templates, onClose, onCreate, onTemplate }) {
      const locals = (roster?.bots ?? []).filter(bot => bot && bot.remote !== true)
      const [name, setName] = useState('')
      const [steps, setSteps] = useState([])
      const [parallel, setParallel] = useState(false)
      const [botId, setBotId] = useState(locals[0]?.id ?? '')
      const add = () => {
        const bot = locals.find(item => item.id === botId)
        if (!bot) return
        setSteps(list => {
          const node = { id: `n${list.length + 1}`, botId: bot.id, name: bot.name, role: bot.role ?? '' }
          if (parallel && list.length > 0) {
            const next = list.slice()
            next[next.length - 1] = [...next[next.length - 1], node]
            return next
          }
          return [...list, [node]]
        })
      }
      return h('div', { className: 'wf-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'wf-modal', role: 'dialog', 'aria-modal': true, 'aria-label': tr('New workflow') },
          h('div', { className: 'wf-modal-header' },
            h('h3', null, tr('New workflow'),
              h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onClose }, '×'))),
          h('div', { className: 'wf-modal-body' },
            (templates ?? []).length > 0 ? h('div', { className: 'wf-field' }, tr('From a template'),
              h('div', { className: 'wf-add' }, (templates ?? []).map(item => h('button', {
                key: item.id, type: 'button', className: 'wf-btn', onClick: () => onTemplate?.(item.id),
              }, item.name)))) : null,
            h('label', { className: 'wf-field' }, tr('Name'),
              h('input', { value: name, onChange: (event) => setName(event.target.value) })),
            h('div', { className: 'wf-field' }, tr('Local Bots'),
              h('div', { className: 'wf-add' },
                h('select', { value: botId, onChange: (event) => setBotId(event.target.value) },
                  locals.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
                h('label', { className: 'wf-par-toggle' },
                  h('input', { type: 'checkbox', checked: parallel, onChange: (event) => setParallel(event.target.checked) }),
                  tr('Parallel')),
                h('button', { type: 'button', className: 'wf-btn', onClick: add }, tr('Add a Bot')))),
            h('ol', { className: 'wf-plan' }, steps.map((layer, index) => h('li', { key: index }, layer.map(node => node.name).join(' ‖ '))))),
          h('div', { className: 'wf-modal-footer' },
            h('button', { type: 'button', className: 'wf-btn', onClick: onClose }, tr('Cancel')),
            h('button', { type: 'button', className: 'wf-btn wf-dark', onClick: () => onCreate({ name, steps }) }, tr('Create')))))
    }

    // Settings → Workflow graphs: canvas-first with per-node inspector
    function WorkflowSettings({ call }) {
      const [pack, setPack] = useState(null)
      const [workflowId, setWorkflowId] = useState('')
      const [selectedNode, setSelectedNode] = useState(null)
      const [editing, setEditing] = useState(false)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        let gone = false
        setLoading(true)
        setError('')
        void settledCall(call, 'workflow/state', undefined, 'The workflow host did not answer').then(value => {
          if (gone) return
          setLoading(false)
          if (value && Array.isArray(value.workflows)) {
            setPack(value)
            const first = value.workflows[0]
            setWorkflowId(id => id || first?.id || '')
          } else setError(value?.error ?? 'The workflow host did not answer')
        })
        return () => { gone = true }
      }, [attempt])
      
      useEffect(() => {
        ensureCss()
        return undefined
      }, [])

      const workflows = pack?.workflows ?? []
      const current = workflows.find(item => item.id === workflowId) ?? workflows[0]
      const nodes = current?.nodes ?? []
      const edges = current?.edges ?? []
      const selected = nodes.find(node => node.id === selectedNode)
      const toolsKey = current && selected ? `${current.id}:${selected.id}` : ''
      
      const save = (nodes, edges) => {
        if (!current) return
        void settledCall(call, 'workflow/graph', { workflowId: current.id, nodes, edges }, 'Could not save this workflow').then(value => {
          if (value?.ok === false) { setError(value.error ?? tr('Could not save this workflow')); return }
          if (value?.workflows) { setPack(value); setError('') }
        })
      }
      
      const updateNode = (nodeId, updates) => {
        save(nodes.map(item => item.id === nodeId ? { ...item, ...updates } : item), edges)
      }
      
      const [edgeForm, setEdgeForm] = useState({ from: '', to: '', kind: 'forward', max: 5, until: { output: '', eq: '' } })
      const [toolsDraft, setToolsDraft] = useState(null)
      const toolsTimer = useRef(null)
      const toolsCommit = useRef(null)
      
      useEffect(() => () => {
        if (toolsTimer.current) clearTimeout(toolsTimer.current)
      }, [])
      
      const commitTools = (nodeId, text) => {
        const next = text.split(',').map(item => item.trim()).filter(Boolean)
        const saved = nodes.find(node => node.id === nodeId)?.tools ?? []
        if (next.length === saved.length && next.every((item, index) => item === saved[index])) return
        updateNode(nodeId, { tools: next })
      }
      
      const flushTools = () => {
        if (toolsTimer.current) { clearTimeout(toolsTimer.current); toolsTimer.current = null }
        const pending = toolsCommit.current
        toolsCommit.current = null
        if (pending) pending()
      }
      
      const addEdge = () => {
        if (!edgeForm.from || !edgeForm.to) return
        const edge = { from: edgeForm.from, to: edgeForm.to }
        if (edgeForm.kind === 'loop') {
          edge.loop = true
          edge.max = Number(edgeForm.max) || 5
          if (edgeForm.until.output) edge.until = edgeForm.until
        } else if (edgeForm.kind === 'condition') {
          edge.when = edgeForm.until
        }
        save(nodes, edges.concat([edge]))
        setEdgeForm({ from: '', to: '', kind: 'forward', max: 5, until: { output: '', eq: '' } })
      }
      
      return h('div', { className: 'wf-settings-canvas', 'data-flybot': 'workflow-settings' },
        error ? h('div', { className: 'wf-err', role: 'alert' }, error) : null,
        error && !pack && !loading
          ? h('button', { type: 'button', className: 'wf-btn', onClick: () => setAttempt(value => value + 1) }, tr('Try again'))
          : null,
        loading ? h('div', { className: 'wf-muted' }, tr('Reading workflows…')) : null,
        !loading && workflows.length === 0 ? h('div', { className: 'wf-muted' }, tr('No workflows yet.')) : null,
        current ? h('div', { className: 'wf-settings-layout' },
          h('div', { className: 'wf-settings-header' },
            h('label', { className: 'wf-field' },
              h('select', {
                'aria-label': tr('Workflow graphs'),
                value: current.id,
                onChange: (event) => { setWorkflowId(event.target.value); setSelectedNode(null) },
              }, workflows.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
            h('label', { className: 'wf-field' },
              h('span', null, tr('Model')),
              h('select', {
                'aria-label': tr('Model'),
                value: current.model || '',
                onChange: (event) => {
                  const model = event.target.value || null
                  void settledCall(call, 'workflow/set-model', { workflowId: current.id, model }, 'Could not change the model').then(value => {
                    if (value?.ok === false) { setError(value.error ?? tr('Could not change the model')); return }
                    if (value?.workflows) { setPack(value); setError('') }
                  })
                },
              },
                h('option', { value: '' }, tr('Each Bot\'s own model')),
                (pack?.roster?.models ?? []).map(model => h('option', { key: model.ref, value: model.ref }, `${model.name} (${model.provider})`)))),
            h('label', { className: 'wf-field' },
              h('span', null, tr('Concurrent runs')),
              h('input', {
                type: 'number',
                'aria-label': tr('Concurrent runs'),
                min: 1,
                max: 8,
                value: current.maxConcurrent ?? 2,
                onChange: (event) => {
                  const maxConcurrent = Number(event.target.value)
                  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) return
                  void Promise.resolve(call('workflow/concurrency', { workflowId: current.id, maxConcurrent })).then(value => {
                    if (value?.ok === false) { setError(value.error ?? ''); return }
                    if (value?.workflows) setPack(value)
                  })
                },
              })),
            h('button', { type: 'button', className: 'wf-btn', onClick: () => setEditing(!editing) },
              editing ? tr('Finish editing') : tr('Edit')),
            editing && !error ? h('span', { className: 'wf-autosave-hint' }, tr('Changes are saved automatically')) : null),
          h('div', { className: 'wf-canvas-main' },
            h(GraphCanvas, {
              workflow: current,
              editing,
              selectedNode,
              onSelectNode: setSelectedNode,
              onCommit: ({ nodes, edges }) => save(nodes, edges),
              roster: pack?.roster
            })),
          editing && selected ? h('div', { className: 'wf-inspector' },
            h('h3', null, tr('Node settings')),
            h('div', { className: 'wf-inspector-content' },
              h('label', { className: 'wf-field' },
                h('span', null, tr('System prompt')),
                h('textarea', {
                  rows: 6,
                  value: selected.prompt || '',
                  onChange: (event) => updateNode(selected.id, { prompt: event.target.value }),
                })),
              h('label', { className: 'wf-field' },
                h('span', null, tr('Role')),
                h('input', {
                  value: selected.role || '',
                  onChange: (event) => updateNode(selected.id, { role: event.target.value }),
                })),
              h('label', { className: 'wf-field', 'data-flybot': 'node-tools' },
                h('span', null, tr('Tools')),
                h('input', {
                  'aria-label': tr('Tools'),
                  value: toolsDraft && toolsDraft.key === toolsKey ? toolsDraft.text : (selected.tools ?? []).join(', '),
                  placeholder: 'github, composio',
                  onChange: (event) => {
                    const text = event.target.value
                    setToolsDraft({ key: toolsKey, text })
                    toolsCommit.current = () => commitTools(selected.id, text)
                    if (toolsTimer.current) clearTimeout(toolsTimer.current)
                    toolsTimer.current = setTimeout(() => {
                      toolsTimer.current = null
                      const pending = toolsCommit.current
                      toolsCommit.current = null
                      pending?.()
                    }, TOOLS_COMMIT_MS)
                  },
                  onBlur: () => { flushTools(); setToolsDraft(draft => (draft && draft.key === toolsKey ? null : draft)) },
                }),
                h('div', { className: 'wf-tools-help', 'data-flybot': 'node-tools-note' },
                  h('span', null, 'Names the connectors this run Bot may use: github grants mcp__github__*, composio grants the Composio connector. File and shell access is always full, like a normal Bot, and a node that names no connector gets none.'),
                  h('span', { lang: 'zh-CN' }, '这里填这个节点 Bot 能用的连接器：github 对应 mcp__github__*，composio 对应 Composio 连接器。文件与 shell 权限始终与普通 Bot 相同（完全放开）；不填连接器时这个节点一个都拿不到。'))))) : null,
          editing && nodes.length >= 2 ? h('div', { className: 'wf-edge-form' },
            h('h3', null, tr('Add link')),
            h('div', { className: 'wf-edge-fields' },
              h('label', { className: 'wf-field' },
                h('span', null, tr('Kind')),
                h('select', {
                  'aria-label': tr('Kind'),
                  value: edgeForm.kind,
                  onChange: (event) => setEdgeForm({ ...edgeForm, kind: event.target.value }),
                }, h('option', { value: 'forward' }, tr('Link')), h('option', { value: 'condition' }, tr('Condition')), h('option', { value: 'loop' }, tr('Loop')))),
              h('label', { className: 'wf-field' },
                h('span', null, tr('From node')),
                h('select', {
                  'aria-label': tr('From node'),
                  value: edgeForm.from,
                  onChange: (event) => setEdgeForm({ ...edgeForm, from: event.target.value }),
                }, h('option', { value: '' }, tr('Pick a node')), nodes.map(node => h('option', { key: node.id, value: node.id }, node.name)))),
              h('label', { className: 'wf-field' },
                h('span', null, tr('To node')),
                h('select', {
                  'aria-label': tr('To node'),
                  value: edgeForm.to,
                  onChange: (event) => setEdgeForm({ ...edgeForm, to: event.target.value }),
                }, h('option', { value: '' }, tr('Pick a node')), nodes.map(node => h('option', { key: node.id, value: node.id }, node.name)))),
              edgeForm.kind === 'loop' ? h('label', { className: 'wf-field' },
                h('span', null, tr('Max iterations')),
                h('input', {
                  type: 'number',
                  'aria-label': tr('Max iterations'),
                  value: edgeForm.max,
                  onChange: (event) => setEdgeForm({ ...edgeForm, max: event.target.value }),
                })) : null,
              edgeForm.kind === 'loop' || edgeForm.kind === 'condition' ? h('label', { className: 'wf-field' },
                h('span', null, edgeForm.kind === 'loop' ? tr('until') : tr('when')),
                h('input', {
                  'aria-label': edgeForm.kind === 'loop' ? tr('until') : tr('when'),
                  value: edgeForm.until.output,
                  onChange: (event) => setEdgeForm({ ...edgeForm, until: { ...edgeForm.until, output: event.target.value } }),
                })) : null,
              edgeForm.kind === 'loop' || edgeForm.kind === 'condition' ? h('label', { className: 'wf-field' },
                h('span', null, tr('Equals')),
                h('input', {
                  'aria-label': tr('Equals'),
                  value: edgeForm.until.eq,
                  onChange: (event) => setEdgeForm({ ...edgeForm, until: { ...edgeForm.until, eq: event.target.value } }),
                })) : null,
              h('button', { type: 'button', className: 'wf-btn wf-pri', disabled: !edgeForm.from || !edgeForm.to, onClick: addEdge }, tr('Add link')))) : null) : null)
    }

    function GraphCanvas({ workflow, editing, selectedNode, onSelectNode, onCommit, roster }) {
      const [gesture, setGesture] = useState(null)
      const stageRef = useRef(null)
      const [panelWidth, setPanelWidth] = useState(0)
      const nodes = workflow?.nodes ?? []
      const edges = workflow?.edges ?? []
      const height = Math.max(420, ...nodes.map(node => (node.y ?? 0) + 150), 0)
      const run = workflow?.run?.live === true ? workflow.run : null
      const status = run?.nodeStatus ?? {}
      // The graph is authored on the 960px design plane. Drawing it at that width
      // inside the settings page grew a second scrollbar and cut edges at the
      // border, so the plane is scaled down to the width the canvas has (#1483).
      const scale = panelWidth > 0 ? Math.min(1, panelWidth / (WIRE_SPAN * 2)) : 1
      const drawnHeight = Math.round(height * scale)
      useEffect(() => {
        const el = stageRef.current
        const measure = () => {
          const measured = el?.getBoundingClientRect?.().width
          if (Number.isFinite(measured) && measured > 0 && Math.abs(measured - panelWidth) > 0.5) setPanelWidth(measured)
        }
        measure()
        if (typeof ResizeObserver !== 'function' || !el) return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
      }, [panelWidth])
      
      const commit = (nextNodes, nextEdges) => onCommit?.({ nodes: nextNodes, edges: nextEdges })
      
      const movePointer = (event) => {
        if (!gesture || gesture.kind !== 'move') return
        const node = nodes.find(n => n.id === gesture.id)
        if (!node) return
        // The plane is scaled to the canvas, so a pointer delta in screen pixels
        // is a larger delta in the graph's own coordinates.
        commit(nodes.map(n => n.id === gesture.id ? {
          ...n,
          x: Math.round((node.x ?? 0) + (event.clientX - gesture.ox) / scale),
          y: Math.round((node.y ?? 0) + (event.clientY - gesture.oy) / scale)
        } : n), edges)
        setGesture({ ...gesture, ox: event.clientX, oy: event.clientY })
      }
      
      const endPointer = (event) => {
        if (!gesture) return
        const hit = hitNode(event)
        if (gesture.kind === 'wire' && hit && hit !== gesture.from) {
          commit(nodes, edges.concat([{ from: gesture.from, to: hit }]))
        }
        setGesture(null)
      }
      
      return h('div', { className: 'wf-canvas-view', ref: stageRef, onPointerMove: movePointer, onPointerUp: endPointer },
        h('div', { className: 'wf-plane', 'data-plane': '1', style: { width: panelWidth, height: drawnHeight } },
          h('div', { className: 'wf-canvas-fit', style: { height, transform: `scale(${scale})` } },
          h('svg', { className: 'wf-wires', 'aria-hidden': true, ...wireSvgProps(height) },
            edges.map(edge => {
              const from = nodes.find(node => node.id === edge.from)
              const to = nodes.find(node => node.id === edge.to)
              if (!from || !to) return null
              return h('path', {
                key: `${edge.from}>${edge.to}`,
                d: wirePath(from, to)
              })
            })),
          nodes.map(node => h('div', {
            key: node.id,
            'data-node': node.id,
            className: `wf-node wf-abs ${selectedNode === node.id ? 'selected' : ''}`,
            style: { left: (node.x ?? 0) - 84, top: node.y ?? 0 },
            onClick: () => onSelectNode?.(node.id),
            onPointerDown: (event) => {
              if (!editing) return
              event.preventDefault()
              setGesture({ kind: 'move', id: node.id, ox: event.clientX, oy: event.clientY })
            },
          },
            editing ? h('button', {
              type: 'button', className: `wf-port out${gesture?.kind === 'wire' && gesture.from === node.id ? ' wiring' : ''}`, 'data-port': 'out',
              onPointerDown: (event) => {
                event.preventDefault()
                event.stopPropagation()
                setGesture({ kind: 'wire', from: node.id })
              },
            }) : null,
            h(FlowNode, { node, status: status[node.id] ?? 'idle', roster: roster ?? {} }))))))
    }

    function conversationLeft() {
      if (typeof document === 'undefined') return 0
      const side = document.querySelector?.('.bt-side')
      const right = side?.getBoundingClientRect?.().right
      return right > 40 ? right : 0
    }

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('flybot-workflow-css')) return
      const style = document.createElement('style')
      style.id = 'flybot-workflow-css'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function Section({ roster, call, actions }) {
      const [pack, setPack] = useState(null)
      const [openId, setOpenId] = useState(null)
      const [drawer, setDrawer] = useState(false)
      const [tab, setTab] = useState('flow')
      const [assignOpen, setAssignOpen] = useState(false)
      const [creating, setCreating] = useState(false)
      const [tasks, setTasks] = useState([])
      const [tasksStatus, setTasksStatus] = useState('idle')
      const [tasksError, setTasksError] = useState('')
      const [tip, setTip] = useState(null)
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(false)
      const [focusedRunId, setFocusedRunId] = useState(null)
      const [rowMenu, setRowMenu] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const stageLeft = useConversationInset()

      const stageCall = (name, body, fallback) => settledCall(call, name, body, fallback)

      const [readError, setReadError] = useState('')

      const refresh = async () => {
        const value = await stageCall('workflow/state', undefined, 'The workflow host did not answer')
        if (value && Array.isArray(value.workflows)) { setPack(value); setReadError('') }
        else setReadError(value?.error ?? 'The workflow host did not answer')
        return value
      }
      
      useEffect(() => {
        ensureCss()
        return undefined
      }, [])
      
      useEffect(() => {
        let gone = false
        void refresh().then(async () => {
          const host = globalThis.__flybot__?.host
          if (gone || typeof host !== 'function') return
          try {
            const rows = await host('tasks', {})
            if (!Array.isArray(rows) || gone) return
            for (const task of rows) {
              if (!task || task.status !== 'open') continue
              const value = await call('workflow/ingest', task)
              if (gone) return
              if (value?.workflows) setPack(value)
            }
          } catch (loadError) {
            void loadError
          }
        })
        return () => { gone = true }
      }, [])
      
      useEffect(() => {
        const root = globalThis.__flybot__
        if (!root) return undefined
        const prev = root.openWorkflowAssign
        // #1457: this path opened the dialog without ever loading the board, so it could only
        // ever show the frozen empty state.
        root.openWorkflowAssign = () => { setAssignOpen(true); setOpenId(id => id); void loadTasks() }
        return () => { root.openWorkflowAssign = prev }
      }, [])
      
      // One poll: while a run is live, for the Bot replies that advance nodes, and while a
      // read error is showing, so a refused read is retried. Two effects used to test the
      // same condition and both fired, so every tick read the whole store twice (#1564).
      const live = (pack?.workflows ?? []).some(item => (item.activeCount ?? 0) > 0)
      useEffect(() => {
        if (!live && !readError) return undefined
        let gone = false
        const timer = setInterval(() => { if (!gone) void refresh() }, 2000)
        return () => { gone = true; clearInterval(timer) }
      }, [live, readError])
      
      useEffect(() => {
        if (!openId || typeof document === 'undefined') return undefined
        const onClick = (event) => {
          const row = event.target?.closest?.('.bt-row, .bt-board-row')
          if (!row || row.closest('[data-flybot="workflow"]')) return
          setOpenId(null)
        }
        document.addEventListener('click', onClick, true)
        return () => document.removeEventListener('click', onClick, true)
      }, [openId])

      const workflows = pack?.workflows ?? []
      const open = workflows.find(item => item.id === openId) ?? null

      useEffect(() => {
        if (!open) { setFocusedRunId(null); return }
        const live = liveStageRuns(open)
        if (live.length === 0) { setFocusedRunId(null); return }
        if (!live.some(run => run.id === focusedRunId)) setFocusedRunId(resolveFocusedRun(open, null)?.id ?? live[0].id)
      }, [open?.id, open?.activeCount, open?.runs?.length, focusedRunId])

      // Hide the shell's composer when a Workflow stage is open (#1486)
      useEffect(() => {
        if (typeof document === 'undefined' || !document.body || !document.body.dataset) return undefined
        if (!open) return undefined
        document.body.dataset.btWorkflow = ''
        return () => { delete document.body.dataset.btWorkflow }
      }, [open?.id])

      const loadTasks = async () => {
        setTasksStatus('loading')
        setTasksError('')
        const host = globalThis.__flybot__?.host
        if (typeof host !== 'function') {
          setTasks([])
          setTasksError(tr('Could not load the Tasks board.'))
          setTasksStatus('failed')
          return
        }
        try {
          const rows = await host('tasks', {})
          const real = Array.isArray(rows)
            ? rows.filter(task => task && task.title && task.status !== 'cancelled').slice(0, 12).map(task => ({
              id: task.id, title: task.title, status: task.status, priority: task.priority, column: columnOf(task),
            }))
            : []
          setTasks(real)
          setTasksStatus('ready')
        } catch (loadError) {
          // #1458: an empty list here used to be rendered as "no tasks to assign", which told the
          // owner the board was empty instead of that the load had failed.
          const detail = String(loadError?.message ?? '').trim()
          setTasks([])
          setTasksError(`${tr('Could not load the Tasks board.')}${detail ? ` (${detail})` : ''}`)
          setTasksStatus('failed')
        }
      }

      const confirmRename = async (workflowId, name) => {
        const trimmed = String(name ?? '').trim()
        if (!trimmed) return
        const value = await call('workflow/rename', { workflowId, name: trimmed })
        if (value?.ok === false) { setError(value.error ?? tr('Could not rename this workflow')); return }
        if (value?.workflows) setPack(value)
        setRenaming(null)
      }

      const confirmDelete = async (workflowId) => {
        const value = await call('workflow/delete', { workflowId })
        if (value?.ok === false) { setError(value.error ?? tr('Could not delete this workflow')); return }
        if (value?.workflows) setPack(value)
        if (openId === workflowId) { setOpenId(null); setDrawer(false) }
        setDeleting(null)
        setRowMenu(null)
      }

      // #1647: drop one task's claim and match it again through the same
      // `workflow/ingest` the board already uses, with the person's explicit
      // flag. One read of the board to hand over the card's own fields, then one
      // read of the store — no second polling loop.
      const rematchTask = async (taskId) => {
        let row = null
        const host = globalThis.__flybot__?.host
        if (typeof host === 'function') {
          try {
            const rows = await host('tasks', {})
            if (Array.isArray(rows)) row = rows.find(task => task && task.id === taskId) ?? null
          } catch (loadError) {
            void loadError
          }
        }
        const value = await stageCall('workflow/ingest', { ...(row ?? { id: taskId }), rematch: true }, 'Could not re-match this task')
        if (value?.ok === false) { setError(value.error ?? tr('Could not re-match this task')); return }
        setError('')
        await refresh()
      }

      const confirmAssign = async ({ taskId, target }) => {
        const task = tasks.find(item => item.id === taskId)
        if (!task) return
        if (String(target).startsWith('bot:')) {
          const botId = String(target).slice(4)
          const value = await call('workflow/assign', { botId, taskId: task.id, title: task.title })
          if (value?.ok === false) { setError(value.error ?? ''); return }
          const host = globalThis.__flybot__?.host
          if (typeof host === 'function') {
            try { await host('task-update', { id: task.id }) } catch (updateError) {
              void updateError
            }
          }
          setAssignOpen(false)
          actions?.openSession?.(botId)
          return
        }
        const value = await call('workflow/assign', { workflowId: target, taskId: task.id, title: task.title })
        if (value?.ok === false) { setError(value.error ?? ''); return }
        setPack(value)
        setOpenId(target)
        setAssignOpen(false)
        setDrawer(true)
        setTab('flow')
      }
      
      const create = async ({ name, steps }) => {
        const nodes = steps.flat()
        if (!name.trim() || nodes.length === 0) return
        const value = await call('workflow/create', {
          name: name.trim(),
          nodes,
          layers: steps.map(layer => layer.map(node => node.id)),
        })
        if (value?.ok === false) { setError(value.error ?? ''); return }
        setPack(value)
        const made = value.workflows.find(item => item.name === name.trim())
        setCreating(false)
        if (made) setOpenId(made.id)
      }

      useEffect(() => {
        if (!rowMenu || typeof document === 'undefined') return undefined
        const close = () => setRowMenu(null)
        const onPointer = (event) => {
          if (!event.target?.closest?.('.wf-context-menu')) close()
        }
        document.addEventListener('pointerdown', onPointer, true)
        return () => document.removeEventListener('pointerdown', onPointer, true)
      }, [rowMenu])

      return h('div', { 'data-flybot': 'workflow' },
        h('div', { className: 'wf-sec' },
          h('span', null, tr('Workflows')),
          h('button', { type: 'button', className: 'wf-new', onClick: () => setCreating(true) }, tr('New'))),
        pack?.tasksWired === false ? h('div', { className: 'wf-wiring', role: 'status' },
          tr('This host does not pass task writes to Workflows, so a card on the board cannot start a run.')) : null,
        workflows.length === 0 && !readError ? h('div', { className: 'wf-muted' }, tr('No workflows yet.')) : null,
        workflows.map(item => h('button', {
          key: item.id, type: 'button', className: `wf-row ${openId === item.id ? 'on' : ''}`,
          onClick: () => { setOpenId(item.id) },
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation?.()
            setRowMenu({ x: event.clientX, y: event.clientY, workflow: item })
          },
        },
          h('span', { className: 'wf-ico' }, h(MiniFlowchart, { workflow: item, compact: true })),
          h('span', { className: 'wf-txt' },
            h('span', { className: 'wf-t1' }, item.name, h('span', { className: 'wf-badge' }, 'Workflow')),
            h('span', { className: 'wf-t2' }, sidebarPreview(item))),
          (item.activeCount ?? 0) > 0 ? h('span', { className: 'wf-live', 'aria-hidden': true }) : null)),
        h('button', { type: 'button', className: 'wf-row wf-assign-row', onClick: () => { setAssignOpen(true); void loadTasks() } },
          h('span', { className: 'wf-ico' }, glyph()),
          h('span', { className: 'wf-txt' }, h('span', { className: 'wf-t1' }, tr('Hand a task to a Workflow')))),
        error ? h('div', { className: 'wf-err', role: 'alert' }, error) : null,
        readError ? h('div', { className: 'wf-err', role: 'alert' }, readError) : null,
        open ? portal(h(Stage, {
          workflow: open, roster, stageLeft, drawer, tab, focusedRunId,
          onFocusRun: setFocusedRunId,
          editing,
          onToggleEdit: () => { setEditing(value => !value); setDrawer(true); setTab('flow') },
          onCommit: (graph) => {
            void stageCall('workflow/graph', { workflowId: open.id, nodes: graph.nodes, edges: graph.edges }, 'Could not save this workflow').then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              setError('')
              if (value?.workflows) setPack(value)
            })
          },
          onCloseDrawer: () => setDrawer(false),
          onOpenDrawer: () => setDrawer(true),
          onToggleDrawer: () => { setDrawer(value => !value); setTab('flow') },
          onTab: (key) => { setTab(key); setDrawer(true) },
          onReset: () => {
            void stageCall('workflow/reset', { workflowId: open.id }, 'Could not reset this workflow').then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              setError('')
              if (value?.workflows) setPack(value)
            })
          },
          onAssign: () => { setAssignOpen(true); void loadTasks() },
          onTip: setTip,
          onPause: (runId) => {
            void stageCall('workflow/pause', { workflowId: open.id, runId }, 'Could not pause this run').then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              setError('')
              if (value?.workflows) setPack(value)
            })
          },
          onResume: (runId) => {
            void stageCall('workflow/resume', { workflowId: open.id, runId }, 'Could not resume this run').then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              setError('')
              if (value?.workflows) setPack(value)
            })
          },
          onStop: (runId) => {
            void stageCall('workflow/reset', { workflowId: open.id, runId }, 'Could not stop this run').then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              setError('')
              if (value?.workflows) setPack(value)
            })
          },
          onRematch: rematchTask,
        })) : null,
        assignOpen ? portal(h(AssignModal, {
          workflows, tasks, tasksStatus, tasksError, roster, workflowId: openId || workflows[0]?.id,
          onClose: () => setAssignOpen(false), onConfirm: confirmAssign, onRetry: loadTasks,
        })) : null,
        creating ? portal(h(CreateModal, {
          roster, templates: pack?.templates, onClose: () => setCreating(false), onCreate: create,
          onTemplate: (template) => {
            void call('workflow/create', { template }).then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              setPack(value)
              setCreating(false)
              const made = value.workflows?.find(item => item.name.endsWith('副本')) ?? value.workflows?.at(-1)
              if (made) { setOpenId(made.id); setDrawer(true); setTab('flow'); setEditing(true) }
            })
          },
        })) : null,
        tip ? h('div', { className: 'wf-tip', style: { left: tip.x + 12, top: tip.y + 12 } },
          h('b', null, tip.node.name),
          h('div', null, tip.node.role),
          h('div', { className: 'wf-k' }, 'Instructions'),
          h('div', null, tip.node.instructions)) : null,
        rowMenu ? portal(h('div', {
          className: 'wf-context-menu',
          style: { left: rowMenu.x, top: rowMenu.y },
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => event.stopPropagation(),
        },
          h('button', { type: 'button', onClick: () => { setRenaming(rowMenu.workflow); setRowMenu(null) } }, tr('Rename')),
          h('button', { type: 'button', className: 'wf-danger-text', onClick: () => { setDeleting(rowMenu.workflow); setRowMenu(null) } }, tr('Delete')))) : null,
        renaming ? portal(h(RenameModal, {
          workflow: renaming,
          onClose: () => setRenaming(null),
          onConfirm: (name) => { void confirmRename(renaming.id, name) },
        })) : null,
        deleting ? portal(h(DeleteModal, {
          workflow: deleting,
          onClose: () => setDeleting(null),
          onConfirm: () => { void confirmDelete(deleting.id) },
        })) : null)
    }

    const CSS = `
.wf-sec{display:flex;align-items:center;justify-content:space-between;padding:12px 8px 4px;font-size:11px;color:var(--bt-ink-3,#9a9a9a)}
.wf-new{color:var(--bt-accent,#4d6bfe);background:none;border:0;cursor:pointer;font:inherit;font-size:11px}
.wf-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.wf-row.on,.wf-row:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.wf-txt{min-width:0;flex:1}
.wf-t1{display:flex;align-items:center;gap:6px;font-size:13px}
.wf-t2,.wf-chain{display:block;font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-badge{font-size:9.5px;padding:0 5px;border-radius:4px;background:color-mix(in srgb,var(--bt-accent,#4d6bfe) 12%,transparent);color:var(--bt-accent,#4d6bfe);line-height:15px}
.wf-live{width:7px;height:7px;border-radius:50%;background:var(--bt-accent,#4d6bfe);flex:none}
.wf-ico{width:32px;height:32px;border-radius:9px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));display:grid;place-items:center;color:var(--bt-accent,#4d6bfe);flex:none;overflow:hidden;padding:2px;box-sizing:border-box}
.wf-mini-flow{display:block;max-width:100%;max-height:100%}
.wf-mini-flow-compact{width:100%;height:100%}
.wf-pill-thumb{width:28px;height:28px;flex:none;display:grid;place-items:center;overflow:hidden;border-radius:6px;background:var(--bt-main,#fcfcfc)}
.wf-ico-lg{width:48px;height:48px;margin:0 auto 16px;border:0;border-radius:14px;background:var(--bt-bubble,#eeeeee);color:var(--bt-ink,#141414)}
.wf-av{border-radius:50%;display:inline-grid;place-items:center;color:#fff;font-weight:650;flex:none}
.wf-stage{position:fixed;top:0;right:0;bottom:0;z-index:30;display:flex;overflow:hidden;background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414)}
.wf-main{flex:1;min-width:0;display:flex;flex-direction:column}
.wf-top{height:56px;display:flex;align-items:center;justify-content:center;position:relative;flex:none}
.wf-pill{display:flex;align-items:center;gap:10px;height:36px;padding:0 12px 0 6px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);cursor:pointer;color:inherit;font:inherit;max-width:min(420px,calc(100% - 120px))}
.wf-pill-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wf-sub{font-size:11px;color:var(--bt-ink-3,#9a9a9a)}.wf-chev{color:var(--bt-ink-3,#9a9a9a)}
.wf-actions{position:absolute;right:14px;top:12px;display:flex;gap:6px}
.wf-btn{height:32px;padding:0 14px;border-radius:999px;border:0;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background-color .12s ease,opacity .12s ease}
.wf-btn:hover:not(:disabled){background:var(--bt-active,rgba(119,119,119,.17))}
.wf-btn.wf-pri,.wf-btn.wf-pri:hover:not(:disabled){background:var(--bt-accent,#4d6bfe);color:var(--bt-accent-ink,#fff)}
.wf-btn.wf-dark{background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc)}
.wf-btn.wf-sm{height:28px}
.wf-strips{display:flex;flex-direction:column;gap:8px;margin:0 auto 4px;width:min(720px,calc(100% - 48px))}
.wf-strip{margin:0;width:100%;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;cursor:pointer;text-align:left;color:inherit}
.wf-strip:focus-visible{outline:2px solid var(--bt-accent,#4d6bfe);outline-offset:2px}
.wf-strip-focus{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent,#4d6bfe) 14%,transparent)}
.wf-strip-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%}
.wf-strip-progress{width:100%}
.wf-strip-progress .wf-segs{width:100%}
.wf-strip-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wf-strip-summary{justify-content:center;border-style:dashed;background:transparent;margin-bottom:2px;cursor:default;flex-direction:row}
.wf-btn.wf-danger-outline{box-shadow:inset 0 0 0 1px rgba(229,72,77,.45);color:#e5484d;background:none}
.wf-held{margin:0 auto 6px;width:min(720px,calc(100% - 48px));border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:12px;padding:8px 12px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
.wf-held-head{font-size:12px;color:var(--bt-ink-2,#666)}
.wf-held-row{display:flex;align-items:center;gap:8px;min-width:0}
.wf-held-id{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.wf-held-more{font-size:12px;color:var(--bt-ink-2,#666)}
.wf-tk{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(360px,42vw)}.wf-meta{font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap}
.wf-segs{display:flex;gap:3px;flex:1;min-width:80px}
.wf-seg{height:5px;border-radius:3px;background:var(--bt-active,rgba(119,119,119,.17));flex:1}
.wf-seg.done{background:var(--bt-accent,#4d6bfe)}.wf-seg.failed{background:#e5484d}.wf-seg.running{background:color-mix(in srgb,var(--bt-accent,#4d6bfe) 35%,transparent)}
.wf-chip{font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.58))}
.wf-chip.running{background:color-mix(in srgb,var(--bt-accent,#4d6bfe) 12%,transparent);color:var(--bt-accent,#4d6bfe)}
.wf-chip.done{background:rgba(22,163,74,.12);color:#16a34a}
.wf-chip.failed{background:rgba(229,72,77,.12);color:#e5484d}
.wf-chat{flex:1;overflow:auto;padding:10px 0 20px}
.wf-chat-in{width:min(760px,calc(100% - 48px));margin:0 auto;display:flex;flex-direction:column;gap:10px}
.wf-ts{text-align:center;font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-sys{align-self:center;font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));border:1px dashed var(--bt-line,rgba(20,20,20,.08));padding:4px 10px;border-radius:12px;max-width:90%;text-align:center;word-wrap:break-word;overflow-wrap:break-word}
.wf-sys.accent{color:var(--bt-accent,#4d6bfe);background:color-mix(in srgb,var(--bt-accent,#4d6bfe) 10%,transparent);border-style:solid}
.wf-sys.ok{color:#16a34a;background:rgba(22,163,74,.1);border-color:transparent}
.wf-sys.bad{color:#e5484d;background:rgba(229,72,77,.1);border-color:transparent}
.wf-msg{display:flex;gap:8px;align-items:flex-end;max-width:78%}
.wf-who{font-size:11px;margin:0 0 3px 2px;display:flex;gap:6px}
.wf-step{color:var(--bt-ink-3,#9a9a9a)}
.wf-bub{background:var(--bt-bubble,#eee);border-radius:12px;padding:8px 11px;line-height:1.6;word-wrap:break-word;overflow-wrap:break-word}
.wf-att{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
.wf-att span{font-size:11.5px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:8px;padding:3px 8px}
.wf-user{align-self:flex-end;background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);border-radius:12px;padding:8px 12px;max-width:70%;line-height:1.6}
.wf-composer-wrap{flex:none;padding:0 0 10px}
.wf-composer{width:min(760px,calc(100% - 48px));margin:0 auto;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:14px;background:var(--bt-card,#fff);display:flex;align-items:center;gap:8px;padding:8px}
.wf-composer input{flex:1;border:0;outline:0;background:transparent;font:inherit;color:inherit}
.wf-mic{width:28px;height:28px;border-radius:9px;border:0;background:var(--bt-accent,#4d6bfe);color:#fff;cursor:pointer}
.wf-under{text-align:center;margin-top:6px;font-size:11px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-drawer{width:400px;flex:none;min-width:0;overflow:hidden;border-left:.5px solid var(--bt-line-2,rgba(20,20,20,.15));display:flex;flex-direction:column;background:var(--bt-main,#fcfcfc);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.wf-dr-head{display:flex;justify-content:flex-end;gap:8px;padding:12px 17px 6px 12px}
.wf-icon{width:28px;height:28px;border-radius:999px;border:0;background:none;cursor:pointer;color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:16px;line-height:1;transition:background-color .12s ease}
.wf-icon:hover{background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414)}
.wf-dr-body{flex:1;overflow:auto;overflow-x:hidden;padding:4px 16px 16px;font-size:13px;line-height:18px}
.wf-dr-title{display:flex;flex-direction:column;align-items:center;padding:14px 0 0;margin-bottom:0}
.wf-dr-title h2{font-size:17px;line-height:24px;font-weight:500;margin:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-dr-title p{font-size:12px;line-height:16px;color:var(--bt-ink-3,rgba(20,20,20,.36));text-align:center;margin:6px 0 0;max-width:100%;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.wf-tabs{position:relative;display:flex;justify-content:center;gap:2px;margin:16px 0 16px}
.wf-tabs button{position:relative;border:0;background:none;border-radius:9999px;padding:4px 8px;font:inherit;font-size:13px;line-height:20px;color:var(--bt-ink-2,rgba(20,20,20,.6));cursor:pointer;white-space:nowrap}
.wf-tabs button:hover{color:var(--bt-ink,#141414)}
.wf-tabs button.on,.wf-tabs button[aria-selected=true]{background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414)}
.wf-term{font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));border:0;border-radius:14px;background:var(--bt-bubble,#eeeeee);padding:6px 12px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
.wf-node-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0}
.wf-chip-inline{margin-left:6px;font-size:9.5px;vertical-align:middle;font-weight:500}
.wf-term.on{color:#16a34a;background:rgba(22,163,74,.1);border-color:transparent}
.wf-canvas{display:flex;flex-direction:column;align-items:center;gap:8px;min-height:440px;position:relative;overflow:auto}
.wf-canvas[data-fit="drawer"]{min-height:0;align-items:stretch;overflow:hidden}
.wf-canvas[data-fit="drawer"] .wf-plane{width:100%;margin:2px 0 0}
.wf-canvas[data-fit="drawer"] .wf-wires{left:0;width:100%;overflow:visible}
.wf-canvas[data-fit="drawer"] .wf-term{white-space:normal;overflow:visible;text-overflow:clip;text-align:left;line-height:1.45;align-self:stretch;max-width:100%;padding:8px 12px;font-size:12px;word-break:break-word}
.wf-canvas[data-fit="drawer"] .wf-term.wf-term-clamp .wf-term-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.wf-term-text{display:block}
.wf-term-more{display:block;margin-top:2px;padding:0;border:0;background:none;color:var(--bt-accent,#4d6bfe);font:inherit;font-size:11.5px;cursor:pointer}
.wf-flow-view .wf-node{box-sizing:border-box}
.wf-flow-view .wf-plabel{width:max-content;box-sizing:border-box;white-space:normal}
.wf-flow-view .wf-wires path{stroke-linejoin:round}
.wf-flow-view .wf-wires path.wf-wire-loop{stroke-dasharray:4 3}
.wf-flow-view .wf-arrow{fill:var(--bt-ink-3,#9a9a9a);stroke:none}
.wf-palette{display:flex;flex-direction:column;align-items:stretch;gap:10px;width:min(100%,360px);margin:0 auto 4px;padding:10px 12px;border:1px dashed var(--bt-line,rgba(20,20,20,.14));border-radius:12px;background:var(--bt-card,#fff)}
.wf-palette-hint{margin:0;font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:center;line-height:1.4}
.wf-plane-hint{margin:0;padding:2px 0;font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:center;line-height:1.4}
.wf-palette-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.wf-palette-bot{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:6px 10px 6px 6px;border:1px solid var(--bt-line,rgba(20,20,20,.1));border-radius:12px;background:var(--bt-main,#fcfcfc);color:inherit;font:inherit;cursor:grab;box-shadow:0 1px 0 rgba(20,20,20,.04);transition:border-color .15s,box-shadow .15s,transform .12s}
.wf-palette-bot:hover{border-color:color-mix(in srgb,var(--bt-accent,#4d6bfe) 35%,transparent);box-shadow:0 2px 8px color-mix(in srgb,var(--bt-accent,#4d6bfe) 12%,transparent)}
.wf-palette-bot:active,.wf-palette-bot.dragging{cursor:grabbing;border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent,#4d6bfe) 14%,transparent);transform:scale(.98)}
.wf-palette-grip{width:6px;height:18px;flex:none;border-radius:2px;background:repeating-linear-gradient(180deg,var(--bt-ink-3,#9a9a9a) 0 2px,transparent 2px 4px);opacity:.45}
.wf-palette-av{border-radius:50%;display:inline-grid;place-items:center;color:#fff;font-weight:650;flex:none}
.wf-palette-copy{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left}
.wf-palette-name{font-size:12.5px;font-weight:600;line-height:1.2;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-palette-sub{font-size:10.5px;color:var(--bt-ink-3,#9a9a9a);line-height:1.2;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-drag-ghost{position:fixed;z-index:100;pointer-events:none;display:inline-flex;align-items:center;gap:6px;padding:5px 10px 5px 5px;border-radius:10px;border:1px solid var(--bt-accent,#4d6bfe);background:var(--bt-card,#fff);box-shadow:0 8px 20px rgba(20,20,20,.12);opacity:.92;transform:translate(-4px,-4px)}
.wf-drag-ghost-name{font-size:12px;font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-plane{position:relative;width:0;margin:8px auto 0;--wf-wire-span:${WIRE_SPAN}px}
.wf-node-inspector{position:absolute;bottom:8px;right:8px;width:320px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,.1);z-index:10}
.wf-inspector-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;font-weight:600}
.wf-close-inspector{background:none;border:0;cursor:pointer;color:var(--bt-ink-3,#9a9a9a);font-size:18px;line-height:1;padding:0;width:20px;height:20px}
.wf-node-inspector textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;padding:8px;resize:vertical;font-size:12px}
.wf-wires{position:absolute;left:calc(-1 * var(--wf-wire-span, ${WIRE_SPAN}px));top:0;width:calc(2 * var(--wf-wire-span, ${WIRE_SPAN}px));overflow:visible;pointer-events:none}
.wf-wires path{fill:none;stroke:var(--bt-line,rgba(20,20,20,.5));stroke-width:2}
.wf-wires .wf-end{pointer-events:auto;fill:var(--bt-card,#fff);stroke:var(--bt-accent,#4d6bfe);cursor:crosshair}
.wf-abs{position:absolute}
.wf-port{position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;border-radius:50%;border:1.5px solid var(--bt-accent,#4d6bfe);background:var(--bt-card,#fff);padding:0;cursor:crosshair;opacity:.55;z-index:2;transition:opacity .15s,box-shadow .15s}
.wf-port:hover,.wf-port:focus-visible,.wf-port.wiring{opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent,#4d6bfe) 22%,transparent)}
.wf-mini{position:absolute;top:-8px;right:-8px;width:18px;height:18px;border-radius:50%;border:1px solid var(--bt-line,rgba(20,20,20,.16));background:var(--bt-card,#fff);cursor:pointer;line-height:16px;padding:0}
.wf-node{width:168px;border:1px solid transparent;background:var(--bt-bubble,#eeeeee);color:var(--bt-ink,#141414);border-radius:18px;padding:8px 10px;display:flex;align-items:center;gap:8px;position:relative;box-sizing:border-box}
@keyframes wf-node-live{0%,100%{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent,#4d6bfe) 18%,transparent)}50%{border-color:color-mix(in srgb,var(--bt-accent,#4d6bfe) 85%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent,#4d6bfe) 32%,transparent)}}
.wf-node.running{border-color:var(--bt-accent,#4d6bfe);animation:wf-node-live 1.5s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.wf-node.running{animation:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent,#4d6bfe) 20%,transparent)}}
.wf-node.done{border-color:rgba(22,163,74,.35)}.wf-node.failed{border-color:#e5484d}
.wf-node.selected{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent,#4d6bfe) 20%,transparent)}
.wf-nt{min-width:0;flex:1;display:flex;flex-direction:column}
.wf-nm{font-weight:500;font-size:13px;line-height:18px}.wf-rl{font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-box{border:.5px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:14px;background:var(--bt-card,#fff);padding:4px 14px}
.wf-kv{display:flex;justify-content:space-between;gap:16px;padding:10px 0;font-size:13px;line-height:18px}
.wf-kv span:first-child{color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-hist{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--bt-line,rgba(20,20,20,.08));font-size:12px}
.wf-hist-task{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-hist-meta{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
.wf-hist-time{flex:none;color:var(--bt-ink-3,#9a9a9a);font-variant-numeric:tabular-nums;white-space:nowrap}
.wf-hist-reason{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5484d}
.wf-hist>.wf-chip{flex:none}
.wf-ctl{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.wf-mask{position:fixed;inset:0;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
.wf-modal{width:560px;max-width:100%;max-height:calc(100vh - 32px);background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414);border-radius:16px;border:1px solid var(--bt-line,rgba(20,20,20,.08));display:flex;flex-direction:column;overflow:hidden}
.wf-modal-header{padding:18px 20px 12px;border-bottom:1px solid var(--bt-line,rgba(20,20,20,.08));flex:none}
.wf-modal-header h3{font-size:15px;display:flex;justify-content:space-between;align-items:center;margin:0 0 4px}
.wf-modal-body{flex:1;overflow-y:auto;padding:12px 20px;min-height:0}
.wf-modal-footer{padding:12px 20px;border-top:1px solid var(--bt-line,rgba(20,20,20,.08));display:flex;justify-content:flex-end;gap:8px;flex:none;background:var(--bt-main,#fcfcfc)}
.wf-hint{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));margin:0}
.wf-tools-help{display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.45;color:var(--bt-ink-3,#9a9a9a)}
.wf-step-h{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));margin:14px 0 8px;display:flex;gap:6px;align-items:center}
.wf-step-h b{width:18px;height:18px;border-radius:50%;background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);display:grid;place-items:center;font-size:11px}
.wf-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.wf-kcard{border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:10px;padding:9px 10px;text-align:left;cursor:pointer;color:inherit;font:inherit}
.wf-kcard.sel,.wf-tgt.sel{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent,#4d6bfe) 12%,transparent)}
.wf-id,.wf-kcol{font-size:11px;color:var(--bt-ink-3,#9a9a9a)}.wf-tt{font-size:12.5px;margin:3px 0 6px;font-weight:500}
.wf-targets{display:flex;flex-direction:column;gap:6px}
.wf-tgt{display:flex;align-items:center;gap:10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:10px;padding:6px 10px;text-align:left;cursor:pointer;color:inherit;font:inherit;width:100%;min-height:44px}
.wf-tgt-thumb{width:30px;height:30px;flex:none;display:grid;place-items:center;overflow:hidden;border-radius:6px;background:var(--bt-main,#fcfcfc)}
.wf-tgt>span:not(.wf-rad):not(.wf-tgt-thumb){min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.wf-rad{margin-left:auto;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--bt-ink-3,#9a9a9a);flex:none}
.wf-tgt.sel .wf-rad{border:5px solid var(--bt-accent,#4d6bfe)}
.wf-field{display:flex;flex-direction:column;gap:6px;font-size:12px;margin-top:12px}
.wf-field input,.wf-field select{height:32px;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;padding:0 8px}
.wf-field textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;padding:6px 8px;resize:vertical}
.wf-add{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wf-plan{margin:10px 0 0;padding-left:18px;font-size:13px}
.wf-tip{position:fixed;z-index:90;width:250px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.55}
.wf-tip .wf-k{color:var(--bt-ink-3,#9a9a9a);font-size:11px;margin-top:6px}
.wf-muted{font-size:12px;color:var(--bt-ink-3,#9a9a9a);padding:4px 8px}
.wf-err{font-size:12px;color:#e5484d;padding:4px 8px}
.wf-wiring{font-size:12px;color:var(--bt-ink-3,#9a9a9a);padding:2px 8px 6px;line-height:1.5}
.wf-assign-row{opacity:.9}
.wf-par{position:relative;z-index:0;pointer-events:none;border:1px dashed var(--bt-ink-3,#9a9a9a);border-radius:14px;padding:16px 8px 8px}
/* .wf-node and .wf-par set position:relative after .wf-abs, which pulled every
   drawn node and frame back into the flow: boxes stacked under the frame and
   lost their wires. The pair outranks both. */
.wf-node.wf-abs{position:absolute;z-index:1;box-sizing:border-box}
.wf-par.wf-abs{position:absolute;box-sizing:border-box}
.wf-plabel{position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:10.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));background:var(--bt-card,#fff);padding:0 6px;white-space:normal;text-align:center;line-height:1.25;max-width:calc(100% - 16px)}
.wf-settings-canvas{padding:16px}
.wf-settings-layout{display:flex;flex-direction:column;gap:16px}
.wf-settings-header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.wf-autosave-hint{font-size:11px;color:var(--bt-ink-3,#9a9a9a)}
.wf-canvas-main{flex:1;min-height:500px;display:flex;flex-direction:column;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:16px;background:var(--bt-card,#fff)}
.wf-canvas-view{width:100%;height:100%;min-height:0;position:relative;overflow:visible}
.wf-canvas-fit{position:relative;width:0;margin:0 auto;transform-origin:50% 0}
.wf-canvas-view .wf-wires path{stroke:var(--bt-ink-2,rgba(20,20,20,.55));stroke-width:2.5}
.wf-cards-empty{padding:8px 4px 12px}
.wf-assign-fail{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:4px 0 8px}
.wf-context-menu{position:fixed;z-index:95;min-width:140px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:2px}
.wf-context-menu button{border:0;background:transparent;color:inherit;font:inherit;font-size:12.5px;text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer}
.wf-context-menu button:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.wf-danger-text{color:#e5484d}
.wf-btn.wf-danger,.wf-btn.wf-danger:hover:not(:disabled){background:#e5484d;color:#fff}
.wf-inspector{width:300px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:16px;background:var(--bt-card,#fff)}
.wf-inspector h3{font-size:14px;margin:0 0 12px}
.wf-inspector-content{display:flex;flex-direction:column;gap:12px}
.wf-inspector-empty{display:flex;align-items:center;justify-content:center}
.wf-inspector-empty p{color:var(--bt-ink-3,#9a9a9a);text-align:center}
.wf-edge-form{border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:16px;background:var(--bt-card,#fff)}
.wf-edge-form h3{font-size:14px;margin:0 0 12px}
.wf-edge-form .wf-edge-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.wf-edge-form .wf-field{margin-top:0}
.wf-edge-form .wf-btn{align-self:end;justify-self:start}
.wf-btn:disabled{opacity:.5;cursor:not-allowed}
.wf-par-toggle{display:flex;align-items:center;gap:6px;font-size:12px}
`

    function apply(ctx) {
      if (!ctx?.flybot?.call) throw new Error('@flybot/workflow needs the flybot browser service')
      const slots = ctx.flybot.slots
      const offs = []
      if (slots?.register) {
        offs.push(slots.register('flybot.sidebar.section', { id: 'workflow', order: 20, component: Section }))
        offs.push(slots.register('flybot.settings.page', { id: 'workflow', order: 45, label: 'Workflow graphs', component: WorkflowSettings }))
      }
      const off = () => { for (const fn of offs.splice(0)) fn() }
      ctx.effect?.(() => off)
      return off
    }

    return {
      name: 'flybot-workflow', inject: ['flybot'], apply, Section, WorkflowSettings,
      tr, columnOf, shortId, stageMessages, taskSummary, wirePath, WIRE_SPAN, NODE_WIRE_OUT,
      runHistoryRows, liveStageRuns, resolveFocusedRun, newestAttempt, parallelFrameStyle, fitPlane,
      editPlane, flowLayout, flowRows,
      DRAWER_FLOW_W, NODE_W, NODE_H,
      botPaletteSubtitle, botTint, settledCall,
    }
  },
})
