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
      'Message the workflow': '发消息',
      Trigger: '触发方式',
      Manual: '手动，从任务看板分配',
      Schedule: '定时',
      Model: '模型',
      'Each Bot\'s own model': '跟随各个 Bot 的模型',
      '{count} models': '{count} 个模型',
      Permissions: '权限',
      'Each Bot\'s own permission': '跟随各个 Bot 的权限',
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
      'From a template': '从模板新建',
      Remove: '移除',
      'System prompt': '系统提示词',
      Save: '保存',
      'Workflow graphs': 'Workflow 图',
      'Add link': '添加连线',
      'From node': '起点',
      'To node': '终点',
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
      'Could not rename this workflow': '无法重命名该 Workflow',
      'Could not delete this workflow': '无法删除该 Workflow',
      'Could not save this workflow': '无法保存该 Workflow',
      'Could not reset this workflow': '无法重置该 Workflow',
      'Could not pause this run': '无法暂停本次运行',
      'Could not resume this run': '无法继续本次运行',
      'Could not stop this run': '无法停止本次运行',
      'Reading workflows…': '正在读取 Workflow…',
      'Changes are saved automatically': '更改会自动保存',
      'Next run: {time}': '下次运行：{time}',
      'Step {step}': '步骤 {step}',
      'Parallel branches · Merge after all pass': '并行分支 · 全部通过后汇合',
    }

    function zhUi() {
      const host = globalThis.__flybot__?.t
      return typeof host === 'function' && host('Tasks') === '任务'
    }
    // A stage control calls the host too: a throw, a rejection or a host that never answers
    // settles as one error string, so Pause, Stop, Reset and a graph save cannot fail silently.
    // Same shape as readWorkflows()/workflowCallError() in core/src/client/workflows.js.
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
      const fromHost = typeof host === 'function' ? host(key, params) : key
      if (fromHost !== key) return fromHost
      const text = zhUi() && Object.hasOwn(ZH, key) ? ZH[key] : key
      return fill(text, params)
    }

    const STATUS_KEY = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', idle: 'Idle' }
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
    function taskSummary(task, run) {
      if (run?.taskSummary) return run.taskSummary
      const id = shortId(task?.id ?? '')
      const title = String(task?.title ?? '').replace(/\s+/g, ' ').trim()
      if (!id && !title) return ''
      if (!title) return id
      if (!id) return title.length > 72 ? `${title.slice(0, 69)}…` : title
      // Remove issue number prefix from title if it duplicates the id
      let cleanTitle = title
      const issueMatch = title.match(/^issue\s+#?\d+\s*[:\-–—]\s*/i)
      if (issueMatch && id) cleanTitle = title.slice(issueMatch[0].length)
      const room = Math.max(24, 72 - id.length - 3)
      const short = cleanTitle.length > room ? `${cleanTitle.slice(0, room - 1)}…` : cleanTitle
      return `${id} · ${short}`
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
      const meta = run.paused
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
    function Stage({ workflow, roster, stageLeft, drawer, tab, focusedRunId, onFocusRun, onCloseDrawer, onToggleDrawer, onOpenDrawer, onTab, onAssign, onTip, onReset, editing, onToggleEdit, onCommit, onPause, onResume, onStop }) {
      const chatRef = useRef(null)
      const liveRuns = liveStageRuns(workflow)
      const viewRun = resolveFocusedRun(workflow, focusedRunId)
      const showSummary = (workflow.queueDepth ?? 0) > 0 || liveRuns.length > 1
      useEffect(() => {
        const el = chatRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [workflow.messages.length])
      const visible = stageMessages(workflow, workflow.messages, roster)
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
      if (message.kind === 'time') return h('div', { className: 'wf-ts' }, message.text)
      if (message.kind === 'system') return h('div', { className: `wf-sys ${message.tone ?? ''}`, title: message.text }, message.text)
      if (message.kind === 'user') return h('div', { className: 'wf-user', title: message.text }, message.text)
      const node = nodeOf(workflow, message.botId) ?? { id: message.botId, name: message.botId }
      return h('div', { className: 'wf-msg' },
        h(Mark, { node, roster, size: 28 }),
        h('div', null,
          h('div', { className: 'wf-who' }, node.name, message.step ? h('span', { className: 'wf-step' }, tr('Step {step}', { step: message.step })) : null),
          h('div', { className: 'wf-bub', title: message.text }, message.text,
            message.attachments?.length ? h('div', { className: 'wf-att' }, message.attachments.map(name => h('span', { key: name }, name))) : null)))
    }

    function DrawerBody({ workflow, roster, tab, onTab, onReset, onTip, editing, onToggleEdit, onCommit, viewRun }) {
      const run = viewRun?.live === true ? viewRun : null
      return h('div', { className: 'wf-dr-body' },
        h('div', { className: 'wf-dr-title' },
          h('div', { className: 'wf-ico wf-ico-lg' }, glyph()),
          h('h2', null, workflow.name),
          h('p', null, workflow.description)),
        h('div', { className: 'wf-tabs' },
          ['flow', 'details', 'runs'].map(key => h('button', {
            key, type: 'button', className: tab === key ? 'on' : '', onClick: () => onTab(key),
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

    function parallelFrameStyle(members) {
      const minX = Math.min(...members.map(node => node.x ?? 0))
      const maxX = Math.max(...members.map(node => node.x ?? 0))
      const minY = Math.min(...members.map(node => node.y ?? 0))
      const maxY = Math.max(...members.map(node => (node.y ?? 0) + NODE_H))
      const pad = 10
      return {
        left: minX - NODE_W / 2 - pad,
        top: minY - 20,
        width: maxX - minX + NODE_W + pad * 2,
        height: maxY - minY + pad,
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

    function liveStageRuns(workflow) {
      let liveRuns = (workflow.runs ?? []).filter(run => run?.live === true && (run.status === 'running' || run.status === 'failed'))
      if (liveRuns.length === 0 && workflow.run?.live === true && (workflow.run.status === 'running' || workflow.run.status === 'failed')) {
        liveRuns = [workflow.run]
      }
      return liveRuns
    }

    function resolveFocusedRun(workflow, focusedRunId) {
      const live = liveStageRuns(workflow)
      if (focusedRunId) {
        const picked = live.find(run => run.id === focusedRunId)
        if (picked) return picked
      }
      if (workflow.run?.live === true && (workflow.run.status === 'running' || workflow.run.status === 'failed')) return workflow.run
      return live[0] ?? null
    }

    function runHistoryRows(workflow) {
      const history = workflow.history ?? []
      const queued = workflow.queue ?? []
      const liveRuns = liveStageRuns(workflow)
      if (liveRuns.length === 0 && history.length === 0 && queued.length === 0) return null
      const rows = liveRuns.map(run => ({
        task: run.task,
        status: 'running',
        current: workflow.run?.id === run.id,
      }))
      for (const task of queued) rows.push({ task, status: 'queued', current: false })
      for (const item of history) rows.push({ ...item, current: false })
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
      const [selectedNode, setSelectedNode] = useState(null)
      const status = run?.nodeStatus ?? {}
      const nodes = workflow.nodes.map(node => ghost?.[node.id] ? { ...node, ...ghost[node.id] } : node)
      const edges = workflow.edges ?? []
      // The drawer paints a fitted copy; `nodes` stays the world graph so a drag
      // commits the same coordinates the Settings canvas would (#1513).
      const plane = fitPlane(nodes, DRAWER_FLOW_W)
      const fitted = new Map(plane.nodes.map(node => [node.id, node]))
      const scale = plane.scale || 1
      const height = plane.height
      const locals = (roster?.bots ?? []).filter(bot => bot && bot.remote !== true && !nodes.some(node => node.botId === bot.id))
      const selected = nodes.find(node => node.id === selectedNode)
      const commit = (nextNodes, nextEdges) => onCommit?.({ nodes: nextNodes, edges: nextEdges })
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
          commit(nodes.map(node => node.id === gesture.id ? { ...node, ...ghost[gesture.id] } : node), edges)
        } else if (gesture.kind === 'wire' && hit && hit !== gesture.from) {
          commit(workflow.nodes, edges.concat([{ from: gesture.from, to: hit }]))
        } else if (gesture.kind === 'reconnect') {
          const rest = edges.filter(edge => !(edge.from === gesture.from && edge.to === gesture.to))
          if (hit && hit !== gesture.from) commit(workflow.nodes, rest.concat([{ from: gesture.from, to: hit }]))
          else if (!hit) commit(workflow.nodes, rest)
        } else if (gesture.kind === 'add' && event.target?.dataset?.plane) {
          const bot = gesture.bot
          const x = Number.isFinite(event.offsetX) ? Math.round((event.offsetX - plane.offsetX) / scale) : 24
          const y = Number.isFinite(event.offsetY) ? Math.round(event.offsetY - plane.offsetY) : 24
          commit(workflow.nodes.concat([{ id: nextNodeId(workflow.nodes), name: bot.name, botId: bot.id, role: bot.role ?? '', x, y }]), edges)
        }
        setGesture(null)
        setGhost(null)
      }
      const updateNode = (nodeId, updates) => {
        commit(nodes.map(item => item.id === nodeId ? { ...item, ...updates } : item), edges)
      }
      return h('div', { className: 'wf-canvas', 'data-fit': 'drawer', onPointerMove: movePointer, onPointerUp: endPointer, onPointerCancel: () => { setGesture(null); setGhost(null); setDragPreview(null) } },
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
        gesture?.kind === 'add' && dragPreview ? h('div', {
          className: 'wf-drag-ghost',
          style: { left: dragPreview.x + 10, top: dragPreview.y + 10 },
          'aria-hidden': true,
        }, h(PaletteBotFace, { bot: gesture.bot, size: 24 }), h('span', { className: 'wf-drag-ghost-name' }, gesture.bot?.name ?? '')) : null,
        run ? h('div', { className: 'wf-term', title: run.task?.title ?? '' }, taskSummary(run.task, run)) : null,
        h('div', { className: 'wf-plane', 'data-plane': '1', style: { height, width: plane.width } },
          h('svg', { className: 'wf-wires', 'aria-hidden': true, ...wireSvgProps(height, plane.width) },
            edges.map(edge => {
              const from = fitted.get(edge.from)
              const to = fitted.get(edge.to)
              if (!from || !to) return null
              return h('g', { key: `${edge.from}>${edge.to}` },
                h('path', { d: wirePath(from, to, 0) }),
                editing ? h('circle', {
                  cx: to.x, cy: to.y, r: 7, className: 'wf-end',
                  'data-port': 'end', 'data-src': edge.from, 'data-dst': edge.to,
                  onPointerDown: (event) => { event.preventDefault?.(); event.stopPropagation?.(); setGesture({ kind: 'reconnect', from: edge.from, to: edge.to }) },
                }) : null)
            })),
          (workflow.layers ?? []).filter(layer => layer.length > 1).map(layer => {
            const members = layer.map(id => fitted.get(id)).filter(Boolean)
            if (members.length < 2) return null
            return h('div', {
              key: layer.join('+'), className: 'wf-par wf-abs',
              style: parallelFrameStyle(members),
            }, h('div', { className: 'wf-plabel' }, tr('Parallel branches · Merge after all pass')))
          }),
          nodes.map(node => {
            const spot = fitted.get(node.id) ?? node
            return h('div', {
              key: node.id,
              'data-node': node.id,
              className: `wf-node wf-abs ${status[node.id] ?? 'queued'} ${selectedNode === node.id ? 'selected' : ''}`,
              style: { left: spot.x - NODE_W / 2, top: spot.y },
              onClick: () => editing ? setSelectedNode(node.id) : null,
              onPointerDown: (event) => {
                if (!editing || event.target?.dataset?.port || event.target?.dataset?.remove) return
                setGesture({ kind: 'move', id: node.id, ox: event.clientX, oy: event.clientY, x: node.x, y: node.y, scale })
              },
              onMouseEnter: editing ? (event) => onTip?.({ x: event.clientX, y: event.clientY, node }) : null,
              onMouseLeave: editing ? () => onTip?.(null) : null,
            },
              editing ? h('button', {
                type: 'button', className: 'wf-port out', 'data-port': 'out', 'aria-label': node.name,
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
          })),
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
        h('div', { className: 'wf-kv' }, h('span', null, tr('Permissions')), h('span', null, tr('Each Bot\'s own permission'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('On failure')), h('span', null, tr(retries ? 'Tester retries once. Any other failed step stops the run.' : 'A failed step stops the run.'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Concurrent runs')), h('span', null, String(workflow.maxConcurrent ?? 2))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Members')), h('span', null, workflow.chain)))
    }

    function Runs({ workflow }) {
      const rows = runHistoryRows(workflow)
      if (!rows) return h('div', { className: 'wf-muted' }, tr('No runs yet.'))
      return h('div', null, rows.map((item, index) => h('div', { key: index, className: 'wf-hist' },
        h('span', { title: item.task?.title ?? '' }, taskSummary(item.task, item)),
        h('span', { className: `wf-chip ${item.status === 'done' ? 'done' : item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : 'queued'}` }, tr(item.status === 'done' ? 'Done' : item.status === 'running' ? 'Running' : item.status === 'failed' ? 'Failed' : 'Queued')))))
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

    function AssignModal({ workflows, tasks, roster, workflowId, onClose, onConfirm }) {
      const [taskId, setTaskId] = useState(tasks[0]?.id ?? '')
      const [target, setTarget] = useState(workflowId || workflows[0]?.id || '')
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
            tasks.length === 0
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
            h('button', { type: 'button', className: 'wf-btn wf-dark', onClick: () => onConfirm({ taskId, target }) }, tr('Assign')))))
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
      
      useEffect(() => {
        let gone = false
        setLoading(true)
        void Promise.resolve(call('workflow/state')).then(value => {
          if (gone) return
          setLoading(false)
          if (value && Array.isArray(value.workflows)) {
            setPack(value)
            const first = value.workflows[0]
            setWorkflowId(id => id || first?.id || '')
          } else setError(value?.error ?? 'The workflow host did not answer')
        })
        return () => { gone = true }
      }, [])
      
      const workflows = pack?.workflows ?? []
      const current = workflows.find(item => item.id === workflowId) ?? workflows[0]
      const nodes = current?.nodes ?? []
      const edges = current?.edges ?? []
      const selected = nodes.find(node => node.id === selectedNode)
      
      const save = (nodes, edges) => {
        if (!current) return
        void Promise.resolve(call('workflow/graph', { workflowId: current.id, nodes, edges })).then(value => {
          if (value?.ok === false) { setError(value.error ?? ''); return }
          if (value?.workflows) setPack(value)
        })
      }
      
      const updateNode = (nodeId, updates) => {
        save(nodes.map(item => item.id === nodeId ? { ...item, ...updates } : item), edges)
      }
      
      const [edgeForm, setEdgeForm] = useState({ from: '', to: '', kind: 'forward', max: 5, until: { output: '', eq: '' } })
      
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
                  void Promise.resolve(call('workflow/set-model', { workflowId: current.id, model })).then(value => {
                    if (value?.ok === false) { setError(value.error ?? ''); return }
                    if (value?.workflows) setPack(value)
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
            editing ? h('span', { className: 'wf-autosave-hint' }, tr('Changes are saved automatically')) : null),
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
              h('label', { className: 'wf-field' },
                h('span', null, tr('Tools')),
                h('input', {
                  value: (selected.tools ?? []).join(', '),
                  placeholder: 'github, bash, read, edit...',
                  onChange: (event) => updateNode(selected.id, { tools: event.target.value.split(',').map(s => s.trim()).filter(Boolean) }),
                })))) : null,
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
                }, h('option', { value: '' }), nodes.map(node => h('option', { key: node.id, value: node.id }, node.name)))),
              h('label', { className: 'wf-field' },
                h('span', null, tr('To node')),
                h('select', {
                  'aria-label': tr('To node'),
                  value: edgeForm.to,
                  onChange: (event) => setEdgeForm({ ...edgeForm, to: event.target.value }),
                }, h('option', { value: '' }), nodes.map(node => h('option', { key: node.id, value: node.id }, node.name)))),
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
              h('button', { type: 'button', onClick: addEdge }, tr('Add link')))) : null) : null)
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
              type: 'button', className: 'wf-port out', 'data-port': 'out',
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

    function Section({ roster, call, actions }) {
      const [pack, setPack] = useState(null)
      const [openId, setOpenId] = useState(null)
      const [drawer, setDrawer] = useState(false)
      const [tab, setTab] = useState('flow')
      const [assignOpen, setAssignOpen] = useState(false)
      const [creating, setCreating] = useState(false)
      const [tasks, setTasks] = useState([])
      const [tip, setTip] = useState(null)
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(false)
      const [focusedRunId, setFocusedRunId] = useState(null)
      const [rowMenu, setRowMenu] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const stageLeft = useConversationInset()

      const stageCall = (name, body, fallback) => settledCall(call, name, body, fallback)

      const refresh = async () => {
        const value = await call('workflow/state')
        if (value && Array.isArray(value.workflows)) setPack(value)
        else setError(value?.error ?? 'The workflow host did not answer')
        return value
      }
      
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        if (document.getElementById('flybot-workflow-css')) return undefined
        const style = document.createElement('style')
        style.id = 'flybot-workflow-css'
        style.textContent = CSS
        document.head.appendChild(style)
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
        root.openWorkflowAssign = () => { setAssignOpen(true); setOpenId(id => id) }
        return () => { root.openWorkflowAssign = prev }
      }, [])
      
      useEffect(() => {
        const live = (pack?.workflows ?? []).some(item => (item.activeCount ?? 0) > 0)
        if (!live) return undefined
        let gone = false
        const timer = setInterval(() => { if (!gone) void refresh() }, 2000)
        return () => { gone = true; clearInterval(timer) }
      }, [pack])
      
      // Refresh when a workflow has active runs - poll for Bot replies advancing nodes
      useEffect(() => {
        const active = (pack?.workflows ?? []).filter(item => (item.activeCount ?? 0) > 0)
        if (active.length === 0) return undefined
        let gone = false
        const poll = setInterval(() => {
          if (gone) return
          void refresh()
        }, 2000)
        return () => { gone = true; clearInterval(poll) }
      }, [pack?.workflows?.some(item => (item.activeCount ?? 0) > 0)])
      
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
        if (!live.some(run => run.id === focusedRunId)) setFocusedRunId(live[0].id)
      }, [open?.id, open?.activeCount, open?.runs?.length, focusedRunId])

      // Hide the shell's composer when a Workflow stage is open (#1486)
      useEffect(() => {
        if (typeof document === 'undefined' || !document.body || !document.body.dataset) return undefined
        if (!open) return undefined
        document.body.dataset.btWorkflow = ''
        return () => { delete document.body.dataset.btWorkflow }
      }, [open?.id])

      const loadTasks = async () => {
        const host = globalThis.__flybot__?.host
        if (typeof host !== 'function') { setTasks([]); return }
        try {
          const rows = await host('tasks', {})
          const real = Array.isArray(rows)
            ? rows.filter(task => task && task.title && task.status !== 'cancelled').slice(0, 12).map(task => ({
              id: task.id, title: task.title, status: task.status, priority: task.priority, column: columnOf(task),
            }))
            : []
          setTasks(real)
        } catch (loadError) {
          void loadError
          setTasks([])
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
        workflows.length === 0 ? h('div', { className: 'wf-muted' }, tr('No workflows yet.')) : null,
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
        })) : null,
        assignOpen ? portal(h(AssignModal, {
          workflows, tasks, roster, workflowId: openId || workflows[0]?.id,
          onClose: () => setAssignOpen(false), onConfirm: confirmAssign,
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
.wf-badge{font-size:9.5px;padding:0 5px;border-radius:4px;background:rgba(77,107,254,.12);color:var(--bt-accent,#4d6bfe);line-height:15px}
.wf-live{width:7px;height:7px;border-radius:50%;background:var(--bt-accent,#4d6bfe);flex:none}
.wf-ico{width:32px;height:32px;border-radius:9px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));display:grid;place-items:center;color:var(--bt-accent,#4d6bfe);flex:none;overflow:hidden;padding:2px;box-sizing:border-box}
.wf-mini-flow{display:block;max-width:100%;max-height:100%}
.wf-mini-flow-compact{width:100%;height:100%}
.wf-pill-thumb{width:28px;height:28px;flex:none;display:grid;place-items:center;overflow:hidden;border-radius:6px;background:var(--bt-main,#fcfcfc)}
.wf-ico-lg{width:42px;height:42px;margin:0 auto}
.wf-av{border-radius:50%;display:inline-grid;place-items:center;color:#fff;font-weight:650;flex:none}
.wf-stage{position:fixed;top:0;right:0;bottom:0;z-index:30;display:flex;overflow:hidden;background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414)}
.wf-main{flex:1;min-width:0;display:flex;flex-direction:column}
.wf-top{height:56px;display:flex;align-items:center;justify-content:center;position:relative;flex:none}
.wf-pill{display:flex;align-items:center;gap:10px;height:36px;padding:0 12px 0 6px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);cursor:pointer;color:inherit;font:inherit;max-width:min(420px,calc(100% - 120px))}
.wf-pill-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wf-sub{font-size:11px;color:var(--bt-ink-3,#9a9a9a)}.wf-chev{color:var(--bt-ink-3,#9a9a9a)}
.wf-actions{position:absolute;right:14px;top:12px;display:flex;gap:6px}
.wf-btn{height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.wf-btn.wf-pri{background:var(--bt-accent,#4d6bfe);border-color:var(--bt-accent,#4d6bfe);color:#fff}
.wf-btn.wf-dark{background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);border-color:var(--bt-user,#070707)}
.wf-btn.wf-sm{height:28px}
.wf-strips{display:flex;flex-direction:column;gap:8px;margin:0 auto 4px;width:min(720px,calc(100% - 48px))}
.wf-strip{margin:0;width:100%;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;cursor:pointer;text-align:left;color:inherit}
.wf-strip:focus-visible{outline:2px solid var(--bt-accent,#4d6bfe);outline-offset:2px}
.wf-strip-focus{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px rgba(77,107,254,.14)}
.wf-strip-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%}
.wf-strip-progress{width:100%}
.wf-strip-progress .wf-segs{width:100%}
.wf-strip-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wf-strip-summary{justify-content:center;border-style:dashed;background:transparent;margin-bottom:2px;cursor:default;flex-direction:row}
.wf-btn.wf-danger-outline{border-color:rgba(229,72,77,.45);color:#e5484d}
.wf-tk{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(360px,42vw)}.wf-meta{font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap}
.wf-segs{display:flex;gap:3px;flex:1;min-width:80px}
.wf-seg{height:5px;border-radius:3px;background:var(--bt-active,rgba(119,119,119,.17));flex:1}
.wf-seg.done{background:var(--bt-accent,#4d6bfe)}.wf-seg.failed{background:#e5484d}.wf-seg.running{background:rgba(77,107,254,.35)}
.wf-chip{font-size:10.5px;padding:1px 7px;border-radius:10px;background:var(--bt-active,rgba(119,119,119,.17));color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-chip.running{background:rgba(77,107,254,.12);color:var(--bt-accent,#4d6bfe)}
.wf-chip.done{background:rgba(22,163,74,.12);color:#16a34a}
.wf-chip.failed{background:rgba(229,72,77,.12);color:#e5484d}
.wf-chat{flex:1;overflow:auto;padding:10px 0 20px}
.wf-chat-in{width:min(760px,calc(100% - 48px));margin:0 auto;display:flex;flex-direction:column;gap:10px}
.wf-ts{text-align:center;font-size:11px;color:var(--bt-ink-3,#9a9a9a)}
.wf-sys{align-self:center;font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));border:1px dashed var(--bt-line,rgba(20,20,20,.08));padding:4px 10px;border-radius:12px;max-width:90%;text-align:center;word-wrap:break-word;overflow-wrap:break-word}
.wf-sys.accent{color:var(--bt-accent,#4d6bfe);background:rgba(77,107,254,.1);border-style:solid}
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
.wf-drawer{width:400px;flex:none;min-width:0;overflow:hidden;border-left:1px solid var(--bt-line,rgba(20,20,20,.08));display:flex;flex-direction:column;background:var(--bt-main,#fcfcfc)}
.wf-dr-head{display:flex;justify-content:flex-end;padding:12px}
.wf-icon{width:28px;height:28px;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);cursor:pointer;color:inherit}
.wf-dr-body{flex:1;overflow:auto;overflow-x:hidden;padding:4px 18px 20px}
.wf-dr-title{display:flex;flex-direction:column;align-items:center;gap:4px;margin-bottom:10px}
.wf-dr-title h2{font-size:16px;font-weight:600;margin:0}
.wf-dr-title p{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:center;line-height:1.5;margin:0;max-width:100%;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.wf-tabs{display:flex;justify-content:center;gap:4px;margin:6px 0 12px}
.wf-tabs button{padding:4px 10px;border-radius:7px;border:0;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));cursor:pointer;font:inherit}
.wf-tabs button.on{background:var(--bt-active,rgba(119,119,119,.17));color:var(--bt-ink,#141414)}
.wf-term{font-size:11px;color:var(--bt-ink-2,rgba(20,20,20,.6));border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:3px 10px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-node-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0}
.wf-chip-inline{margin-left:6px;font-size:9.5px;vertical-align:middle;font-weight:500}
.wf-term.on{color:#16a34a;background:rgba(22,163,74,.1);border-color:transparent}
.wf-canvas{display:flex;flex-direction:column;align-items:center;gap:8px;min-height:440px;position:relative;overflow:auto}
.wf-canvas[data-fit="drawer"]{min-height:0;align-items:stretch;overflow:hidden}
.wf-canvas[data-fit="drawer"] .wf-plane{width:100%;margin:2px 0 0}
.wf-canvas[data-fit="drawer"] .wf-wires{left:0;width:100%;overflow:visible}
.wf-canvas[data-fit="drawer"] .wf-term{white-space:normal;overflow:visible;text-overflow:clip;text-align:center;line-height:1.35;align-self:center;max-width:100%}
.wf-palette{display:flex;flex-direction:column;align-items:stretch;gap:10px;width:min(100%,360px);margin:0 auto 4px;padding:10px 12px;border:1px dashed var(--bt-line,rgba(20,20,20,.14));border-radius:12px;background:var(--bt-card,#fff)}
.wf-palette-hint{margin:0;font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:center;line-height:1.4}
.wf-palette-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.wf-palette-bot{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:6px 10px 6px 6px;border:1px solid var(--bt-line,rgba(20,20,20,.1));border-radius:12px;background:var(--bt-main,#fcfcfc);color:inherit;font:inherit;cursor:grab;box-shadow:0 1px 0 rgba(20,20,20,.04);transition:border-color .15s,box-shadow .15s,transform .12s}
.wf-palette-bot:hover{border-color:rgba(77,107,254,.35);box-shadow:0 2px 8px rgba(77,107,254,.12)}
.wf-palette-bot:active,.wf-palette-bot.dragging{cursor:grabbing;border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.14);transform:scale(.98)}
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
.wf-port{position:absolute;left:50%;bottom:-6px;width:12px;height:12px;margin-left:-6px;border-radius:50%;border:2px solid var(--bt-accent,#4d6bfe);background:var(--bt-card,#fff);padding:0;cursor:crosshair}
.wf-mini{position:absolute;top:-8px;right:-8px;width:18px;height:18px;border-radius:50%;border:1px solid var(--bt-line,rgba(20,20,20,.16));background:var(--bt-card,#fff);cursor:pointer;line-height:16px;padding:0}
.wf-node{width:168px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:12px;padding:8px 9px;display:flex;align-items:center;gap:8px;position:relative}
@keyframes wf-node-live{0%,100%{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px rgba(77,107,254,.18),0 0 0 0 rgba(77,107,254,.2)}50%{border-color:rgba(77,107,254,.85);box-shadow:0 0 0 3px rgba(77,107,254,.35),0 0 14px 2px rgba(77,107,254,.22)}}
.wf-node.running{border-color:var(--bt-accent,#4d6bfe);animation:wf-node-live 1.5s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.wf-node.running{animation:none;box-shadow:0 0 0 3px rgba(77,107,254,.2)}}
.wf-node.done{border-color:rgba(22,163,74,.35)}.wf-node.failed{border-color:#e5484d}
.wf-node.selected{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px rgba(77,107,254,.2)}
.wf-nt{min-width:0;flex:1;display:flex;flex-direction:column}
.wf-nm{font-weight:600;font-size:12.5px}.wf-rl{font-size:12px;color:rgba(20,20,20,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-box{border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);padding:10px 12px}
.wf-kv{display:flex;justify-content:space-between;gap:16px;padding:8px 0;font-size:12px}
.wf-kv span:first-child{color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-hist{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--bt-line,rgba(20,20,20,.08));font-size:12px}
.wf-ctl{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
.wf-mask{position:fixed;inset:0;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
.wf-modal{width:560px;max-width:100%;max-height:calc(100vh - 32px);background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414);border-radius:16px;border:1px solid var(--bt-line,rgba(20,20,20,.08));display:flex;flex-direction:column;overflow:hidden}
.wf-modal-header{padding:18px 20px 12px;border-bottom:1px solid var(--bt-line,rgba(20,20,20,.08));flex:none}
.wf-modal-header h3{font-size:15px;display:flex;justify-content:space-between;align-items:center;margin:0 0 4px}
.wf-modal-body{flex:1;overflow-y:auto;padding:12px 20px;min-height:0}
.wf-modal-footer{padding:12px 20px;border-top:1px solid var(--bt-line,rgba(20,20,20,.08));display:flex;justify-content:flex-end;gap:8px;flex:none;background:var(--bt-main,#fcfcfc)}
.wf-hint{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));margin:0}
.wf-step-h{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));margin:14px 0 8px;display:flex;gap:6px;align-items:center}
.wf-step-h b{width:18px;height:18px;border-radius:50%;background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);display:grid;place-items:center;font-size:11px}
.wf-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.wf-kcard{border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:10px;padding:9px 10px;text-align:left;cursor:pointer;color:inherit;font:inherit}
.wf-kcard.sel,.wf-tgt.sel{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.12)}
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
.wf-assign-row{opacity:.9}
.wf-par{position:relative;z-index:0;pointer-events:none;border:1px dashed var(--bt-ink-3,#9a9a9a);border-radius:14px;padding:16px 8px 8px}
.wf-node.wf-abs{z-index:1}
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
.wf-context-menu{position:fixed;z-index:95;min-width:140px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:2px}
.wf-context-menu button{border:0;background:transparent;color:inherit;font:inherit;font-size:12.5px;text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer}
.wf-context-menu button:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.wf-danger-text{color:#e5484d}
.wf-btn.wf-danger{background:#e5484d;border-color:#e5484d;color:#fff}
.wf-inspector{width:300px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:16px;background:var(--bt-card,#fff)}
.wf-inspector h3{font-size:14px;margin:0 0 12px}
.wf-inspector-content{display:flex;flex-direction:column;gap:12px}
.wf-inspector-empty{display:flex;align-items:center;justify-content:center}
.wf-inspector-empty p{color:var(--bt-ink-3,#9a9a9a);text-align:center}
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
      runHistoryRows, liveStageRuns, resolveFocusedRun, parallelFrameStyle, fitPlane,
      DRAWER_FLOW_W, NODE_W, NODE_H,
      botPaletteSubtitle, botTint, settledCall,
    }
  },
})
