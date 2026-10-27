// Browser half of @flybot/workflow. A workflow is a row in the sidebar and, once
// opened, the main column: pill header, progress strip, bubbles, composer, and
// a flowchart drawer. The host owns the graph; this file only draws it.
// Every string is a React text child. require('react') is the shell's React.
window.__ModuleLoader__.load({
  id: '@flybot/workflow',
  factory: (require) => {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    // createPortal with no container throws. The sidebar slot boundary then draws
    // nothing until reload, so a click on a row, New, or Hand-a-task removes the
    // whole Workflows section (#1375). A missing body keeps the node in the tree.
    let createPortal = null
    try {
      const dom = require('react-dom')
      if (typeof dom?.createPortal === 'function') createPortal = dom.createPortal
    } catch (error) {
      // The unit renderer supplies react only. The chat then stays in the section tree.
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
      'Run demo': '演示运行',
      'Replay demo': '重放演示',
      'A live run is in progress': '有真实运行在进行，演示不会插队',
      'Concurrent runs': '同时运行',
      '{count} running · queue {depth}': '{count} 个在运行 · 队列 {depth}',
      Pause: '暂停',
      Next: '下一步',
      Reset: '重置',
      Flow: '流程图',
      Details: 'Details',
      Runs: '运行记录',
      'Running now': '运行中',
      Queued: '排队中',
      Running: '运行中',
      Done: '已完成',
      Failed: '失败',
      Idle: '空闲',
      'Not started': '待办',
      'In progress': '进行中',
      'Close': '关闭',
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
      'Each Bot’s own model': '跟随各个 Bot 的模型',
      Permissions: '权限',
      'Each Bot’s own permission': '跟随各个 Bot 的权限',
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
    }

    function zhUi() {
      const host = globalThis.__flybot__?.t
      return typeof host === 'function' && host('Tasks') === '任务'
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
    const FIXTURE_TASKS = [
      { id: '#1280', title: '缩短交付组群 notice', column: 'in-progress', priority: 'P1' },
      { id: '#1281', title: '发布说明：Workflow Beta 上线', column: 'not-started', priority: 'P1' },
      { id: '#1276', title: '修复群聊 @ 提及跳转错位', column: 'not-started', priority: 'P2' },
    ]

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

    function nodeOf(workflow, id) {
      return workflow?.nodes?.find(node => node.id === id)
    }

    function Stage({ workflow, roster, playing, drawer, tab, draft, onDraft, onCloseDrawer, onToggleDrawer, onTab, onPlay, onNext, onReset, onAssign, onSend, onTip, editing, onToggleEdit, onCommit }) {
      const chatRef = useRef(null)
      const run = workflow.run
      const names = workflow.nodes.map(node => node.name).join(', ')
      useEffect(() => {
        const el = chatRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [workflow.messages.length, playing])
      const running = (run?.running ?? []).map(id => nodeOf(workflow, id)).filter(Boolean)
      return h('div', { className: 'wf-stage', style: { left: conversationLeft() } },
        h('div', { className: 'wf-main' },
          h('div', { className: 'wf-top' },
            h('button', { type: 'button', className: 'wf-pill', onClick: onToggleDrawer },
              h('span', { className: 'wf-stack' }, workflow.nodes.slice(0, 4).map(node => h(Mark, { key: node.id, node, roster, size: 22 }))),
              h('span', { className: 'wf-pill-name' }, workflow.name),
              h('span', { className: 'wf-sub' }, `${workflow.nodes.length} Bots`),
              h('span', { className: 'wf-chev', 'aria-hidden': true }, '▾')),
            h('div', { className: 'wf-actions' },
              h('button', { type: 'button', className: 'wf-btn', onClick: onAssign }, tr('Hand a task to a Workflow')),
              h('button', { type: 'button', className: 'wf-btn wf-pri', onClick: onPlay, disabled: (workflow.activeCount ?? 0) > 0 }, playing ? tr('Pause') : `▶ ${tr('Replay demo')}`))),
          run ? h('div', { className: 'wf-strip' },
            h('div', { className: 'wf-strip-id' },
              h('div', { className: 'wf-tk' }, `${run.task?.id ?? ''} ${run.task?.title ?? ''}`),
              h('div', { className: 'wf-meta' }, running[0]
                ? `${tr('Running now')} · ${running.map(node => node.name).join(' ‖ ')} · ${run.doneCount}/${run.nodeCount}`
                : (run.status === 'done' ? tr('Done') : tr('Waiting for a task')))),
            h('div', { className: 'wf-segs' }, (run.marks ?? []).map((mark, index) => h('span', { key: index, className: `wf-seg ${mark}` }))),
            h('span', { className: `wf-chip ${run.status === 'done' ? 'done' : (running[0] ? 'running' : 'queued')}` }, run.status === 'done' ? tr('Done') : (running[0] ? tr('Running') : tr('Queued'))),
            (workflow.queueDepth > 0 || (workflow.activeCount ?? 0) > 1) ? h('span', { className: 'wf-chip queued' }, tr('{count} running · queue {depth}', { count: workflow.activeCount ?? 0, depth: workflow.queueDepth ?? 0 })) : null,
            h('button', { type: 'button', className: 'wf-btn wf-sm', onClick: () => onTab('flow') }, tr('Flow'))) : null,
          h('div', { className: 'wf-chat', ref: chatRef },
            h('div', { className: 'wf-chat-in' },
              workflow.messages.map(message => h(Bubble, { key: message.id, message, workflow, roster })),
              playing ? running.map(node => h('div', { key: `type-${node.id}`, className: 'wf-msg' },
                h(Mark, { node, roster, size: 28 }),
                h('div', null,
                  h('div', { className: 'wf-who' }, node.name, h('span', { className: 'wf-step' }, tr('Running'))),
                  h('div', { className: 'wf-bub wf-typing' }, h('i'), h('i'), h('i'))))) : null)),
          h('div', { className: 'wf-composer-wrap' },
            h('form', { className: 'wf-composer', onSubmit: (event) => { event.preventDefault(); onSend() } },
              h('input', {
                value: draft, placeholder: `${tr('Message the workflow')} ${workflow.name} (${names})`,
                onChange: (event) => onDraft(event.target.value),
              }),
              h('button', { type: 'submit', className: 'wf-mic', 'aria-label': tr('Assign') }, '↑')),
            h('div', { className: 'wf-under' }, run ? `运行 ${run.steps}/${run.stepBudget} 步 · 已完成 ${run.doneCount} 个节点` : null))),
        drawer ? h('aside', { className: 'wf-drawer' },
          h('div', { className: 'wf-dr-head' },
            h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onCloseDrawer }, '×')),
          h(DrawerBody, { workflow, roster, tab, onTab, onPlay, onNext, onReset, playing, onTip, editing, onToggleEdit, onCommit })) : null)
    }

    function Bubble({ message, workflow, roster }) {
      if (message.kind === 'time') return h('div', { className: 'wf-ts' }, message.text)
      if (message.kind === 'system') return h('div', { className: `wf-sys ${message.tone ?? ''}` }, message.text)
      if (message.kind === 'user') return h('div', { className: 'wf-user' }, message.text)
      const node = nodeOf(workflow, message.botId) ?? { id: message.botId, name: message.botId }
      return h('div', { className: 'wf-msg' },
        h(Mark, { node, roster, size: 28 }),
        h('div', null,
          h('div', { className: 'wf-who' }, node.name, message.step ? h('span', { className: 'wf-step' }, `步骤 ${message.step}`) : null),
          h('div', { className: 'wf-bub' }, message.text,
            message.attachments?.length ? h('div', { className: 'wf-att' }, message.attachments.map(name => h('span', { key: name }, name))) : null)))
    }

    function DrawerBody({ workflow, roster, tab, onTab, onPlay, onNext, onReset, playing, onTip, editing, onToggleEdit, onCommit }) {
      const run = workflow.run
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
        tab === 'details' ? h(Details, { workflow }) : null,
        tab === 'runs' ? h(Runs, { workflow }) : null,
        h('div', { className: 'wf-ctl' },
          h('button', { type: 'button', className: 'wf-btn wf-pri', onClick: onPlay, disabled: (workflow.activeCount ?? 0) > 0 }, playing ? tr('Pause') : tr('Replay demo')),
          h('button', { type: 'button', className: 'wf-btn', onClick: onNext }, `${tr('Next')} ›`),
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

    function wirePath(from, to) {
      const x1 = from.x
      const y1 = from.y + 58
      const x2 = to.x
      const y2 = to.y
      const mid = (y1 + y2) / 2
      return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
    }

    // The flowchart is the graph: positions and edges are the saved model, and
    // the status chip is that node's run state. Edit mode drags nodes, draws
    // edges from the bottom port, and drops a local Bot onto the canvas.
    function Flow({ workflow, run, roster, onTip, editing, onCommit }) {
      const [gesture, setGesture] = useState(null)
      const [ghost, setGhost] = useState(null)
      const status = run?.nodeStatus ?? {}
      const nodes = workflow.nodes.map(node => ghost?.[node.id] ? { ...node, ...ghost[node.id] } : node)
      const edges = workflow.edges ?? []
      const height = Math.max(420, ...nodes.map(node => (node.y ?? 0) + 150), 0)
      const locals = (roster?.bots ?? []).filter(bot => bot && bot.remote !== true && !nodes.some(node => node.botId === bot.id))
      const commit = (nextNodes, nextEdges) => onCommit?.({ nodes: nextNodes, edges: nextEdges })
      const movePointer = (event) => {
        if (!gesture || gesture.kind !== 'move') return
        setGhost({ [gesture.id]: { x: Math.round(gesture.x + event.clientX - gesture.ox), y: Math.round(gesture.y + event.clientY - gesture.oy) } })
      }
      const endPointer = (event) => {
        if (!gesture) return
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
          const x = Number.isFinite(event.offsetX) ? Math.round(event.offsetX) : 24
          const y = Number.isFinite(event.offsetY) ? Math.round(event.offsetY) : 24
          commit(workflow.nodes.concat([{ id: nextNodeId(workflow.nodes), name: bot.name, botId: bot.id, role: bot.role ?? '', x, y }]), edges)
        }
        setGesture(null)
        setGhost(null)
      }
      return h('div', { className: 'wf-canvas', onPointerMove: movePointer, onPointerUp: endPointer },
        editing ? h('div', { className: 'wf-palette' },
          h('div', { className: 'wf-muted' }, tr('Drag a Bot here')),
          locals.map(bot => h('button', {
            key: bot.id, type: 'button', className: 'wf-chip', 'data-bot': bot.id,
            onPointerDown: (event) => { event.preventDefault?.(); setGesture({ kind: 'add', bot }) },
          }, bot.name))) : null,
        h('div', { className: 'wf-term' }, run?.task ? `${run.task.id} ${run.task.title}` : tr('Waiting for a task')),
        editing ? h('div', { className: 'wf-prompts' }, nodes.map(node => h('label', { key: node.id, className: 'wf-prompt' },
          h('span', null, `${node.name} · ${tr('System prompt')}`),
          h('textarea', {
            'data-prompt': node.id,
            rows: 3,
            defaultValue: node.prompt || node.instructions || '',
            onPointerDown: (event) => event.stopPropagation?.(),
            onBlur: (event) => {
              const prompt = event.target?.value ?? ''
              if (prompt === (node.prompt || '')) return
              commit(workflow.nodes.map(item => item.id === node.id ? { ...item, prompt } : item), edges)
            },
          })))) : null,
        h('div', { className: 'wf-plane', 'data-plane': '1', style: { height } },
          h('svg', { className: 'wf-wires', 'aria-hidden': true },
            edges.map(edge => {
              const from = nodes.find(node => node.id === edge.from)
              const to = nodes.find(node => node.id === edge.to)
              if (!from || !to) return null
              return h('g', { key: `${edge.from}>${edge.to}` },
                h('path', { d: wirePath(from, to) }),
                editing ? h('circle', {
                  cx: to.x, cy: to.y, r: 7, className: 'wf-end',
                  'data-port': 'end', 'data-src': edge.from, 'data-dst': edge.to,
                  onPointerDown: (event) => { event.preventDefault?.(); event.stopPropagation?.(); setGesture({ kind: 'reconnect', from: edge.from, to: edge.to }) },
                }) : null)
            })),
          (workflow.layers ?? []).filter(layer => layer.length > 1).map(layer => {
            const members = layer.map(id => nodes.find(node => node.id === id)).filter(Boolean)
            if (members.length < 2) return null
            const minX = Math.min(...members.map(node => node.x))
            const maxX = Math.max(...members.map(node => node.x))
            const y = Math.min(...members.map(node => node.y))
            return h('div', {
              key: layer.join('+'), className: 'wf-par wf-abs',
              style: { left: minX - 108, top: y - 18, width: maxX - minX + 216, height: 92 },
            }, h('div', { className: 'wf-plabel' }, '并行分支 · 全部通过后汇合'))
          }),
          nodes.map(node => h('div', {
            key: node.id,
            'data-node': node.id,
            className: `wf-node wf-abs ${status[node.id] ?? 'queued'}`,
            style: { left: (node.x ?? 0) - 84, top: node.y ?? 0 },
            onPointerDown: (event) => {
              if (!editing || event.target?.dataset?.port || event.target?.dataset?.remove) return
              setGesture({ kind: 'move', id: node.id, ox: event.clientX, oy: event.clientY, x: node.x, y: node.y })
            },
            onMouseEnter: (event) => onTip?.({ x: event.clientX, y: event.clientY, node }),
            onMouseLeave: () => onTip?.(null),
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
              },
            }, '×') : null,
            h(FlowNode, { node, status: status[node.id] ?? 'queued', roster })))),
        run?.status === 'done' ? h('div', { className: 'wf-term on' }, tr('Done')) : null)
    }

    function FlowNode({ node, status, roster }) {
      return [
        h('span', { className: `wf-chip ${status}` }, tr(STATUS_KEY[status] ?? 'Idle')),
        h(Mark, { node, roster, size: 28 }),
        h('span', { className: 'wf-nt' },
          h('span', { className: 'wf-nm' }, node.name),
          h('span', { className: 'wf-rl' }, node.role)),
      ]
    }

    function Details({ workflow }) {
      const trigger = workflow.trigger === 'schedule'
        ? `${tr('Schedule')} · ${workflow.scheduleLabel}`
        : tr('Manual')
      const retries = workflow.nodes.some(node => node.failOnce)
      return h('div', { className: 'wf-box' },
        h('div', { className: 'wf-kv' }, h('span', null, tr('Trigger')), h('span', null, trigger)),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Model')), h('span', null, tr('Each Bot’s own model'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Permissions')), h('span', null, tr('Each Bot’s own permission'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('On failure')), h('span', null, tr(retries ? 'Tester retries once. Any other failed step stops the run.' : 'A failed step stops the run.'))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Concurrent runs')), h('span', null, String(workflow.maxConcurrent ?? 2))),
        h('div', { className: 'wf-kv' }, h('span', null, tr('Members')), h('span', null, workflow.chain)))
    }

    function Runs({ workflow }) {
      const history = workflow.history ?? workflow.run?.history ?? []
      const queued = workflow.queue ?? []
      const current = workflow.run?.task
      if (!current && history.length === 0 && queued.length === 0) return h('div', { className: 'wf-muted' }, tr('No runs yet.'))
      const rows = history.map(item => ({ ...item, current: false }))
      for (const task of queued) rows.push({ task, status: 'queued', current: false })
      if (current && !rows.some(item => item.task?.id === current.id && item.status === workflow.run.status)) rows.push({ task: current, status: workflow.run.status, current: true })
      return h('div', null, rows.map((item, index) => h('div', { key: index, className: 'wf-hist' },
        h('span', null, `${item.task?.id ?? ''} ${item.task?.title ?? ''}`),
        h('span', { className: `wf-chip ${item.status === 'done' ? 'done' : item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : 'queued'}` }, tr(item.status === 'done' ? 'Done' : item.status === 'running' ? 'Running' : item.status === 'failed' ? 'Failed' : 'Queued')))))
    }

    function AssignModal({ workflows, tasks, roster, workflowId, onClose, onConfirm }) {
      const [taskId, setTaskId] = useState(tasks[1]?.id ?? tasks[0]?.id ?? '')
      const [target, setTarget] = useState(workflowId || workflows[0]?.id || '')
      const bots = (roster?.bots ?? []).filter(bot => bot && bot.remote !== true && bot.id && bot.name).slice(0, 12)
      return h('div', { className: 'wf-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'wf-modal', role: 'dialog', 'aria-modal': true, 'aria-label': tr('Hand a task to a Workflow') },
          h('h3', null, tr('Hand a task to a Workflow'),
            h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onClose }, '×')),
          h('p', { className: 'wf-hint' }, tr('A task can go to a Workflow, not only to one Bot. The Workflow then runs each Bot in order, or side by side.')),
          h('div', { className: 'wf-step-h' }, h('b', null, '1'), tr('Pick a task card')),
          h('div', { className: 'wf-cards' }, tasks.map(task => h('button', {
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
              h('span', { className: 'wf-ico' }, glyph()),
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
              h('span', { className: 'wf-rad' })))),
          h('div', { className: 'wf-mfoot' },
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
          h('h3', null, tr('New workflow'),
            h('button', { type: 'button', className: 'wf-icon', 'aria-label': tr('Close'), onClick: onClose }, '×')),
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
          h('ol', { className: 'wf-plan' }, steps.map((layer, index) => h('li', { key: index }, layer.map(node => node.name).join(' ‖ ')))),
          h('div', { className: 'wf-mfoot' },
            h('button', { type: 'button', className: 'wf-btn', onClick: onClose }, tr('Cancel')),
            h('button', { type: 'button', className: 'wf-btn wf-dark', onClick: () => onCreate({ name, steps }) }, tr('Create')))))
    }

    function edgeNote(edge) {
      if (edge.loop === true) {
        const until = edge.until ? ` ${tr('until')} ${edge.until.output}=${edge.until.eq}` : ''
        return `${tr('Loop')} ×${edge.max ?? 3}${until}`
      }
      if (edge.when?.else === true) return tr('Else')
      if (edge.when) return `${tr('when')} ${edge.when.output}=${edge.when.eq}`
      return ''
    }

    function WorkflowSettings({ call }) {
      const [pack, setPack] = useState(null)
      const [workflowId, setWorkflowId] = useState('')
      const [from, setFrom] = useState('')
      const [to, setTo] = useState('')
      const [kind, setKind] = useState('link')
      const [whenName, setWhenName] = useState('')
      const [whenEq, setWhenEq] = useState('')
      const [loopMax, setLoopMax] = useState('3')
      const [untilName, setUntilName] = useState('')
      const [untilEq, setUntilEq] = useState('')
      const [error, setError] = useState('')
      useEffect(() => {
        let gone = false
        void Promise.resolve(call('workflow/state')).then(value => {
          if (gone) return
          if (value && Array.isArray(value.workflows)) {
            setPack(value)
            const first = value.workflows[0]
            setWorkflowId(id => id || first?.id || '')
            setFrom(id => id || first?.nodes?.[0]?.id || '')
            setTo(id => id || first?.nodes?.[1]?.id || first?.nodes?.[0]?.id || '')
          } else setError(value?.error ?? 'The workflow host did not answer')
        })
        return () => { gone = true }
      }, [])
      const workflows = pack?.workflows ?? []
      const current = workflows.find(item => item.id === workflowId) ?? workflows[0]
      const save = (nodes, edges) => {
        if (!current) return
        void Promise.resolve(call('workflow/graph', { workflowId: current.id, nodes, edges })).then(value => {
          if (value?.ok === false) { setError(value.error ?? ''); return }
          if (value?.workflows) setPack(value)
        })
      }
      const nameOf = (id) => current?.nodes.find(node => node.id === id)?.name ?? id
      return h('div', { className: 'wf-settings', 'data-flybot': 'workflow-settings' },
        error ? h('div', { className: 'wf-err', role: 'alert' }, error) : null,
        workflows.length === 0 ? h('div', { className: 'wf-muted' }, tr('No workflows yet.')) : null,
        current ? h('div', null,
          h('label', { className: 'wf-field' }, tr('Workflow graphs'),
            h('select', {
              'aria-label': tr('Workflow graphs'),
              value: current.id,
              onChange: (event) => setWorkflowId(event.target.value),
            }, workflows.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          current.nodes.map(node => h('label', { key: node.id, className: 'wf-field' },
            `${node.name} · ${tr('System prompt')}`,
            h('textarea', {
              'data-prompt': node.id,
              rows: 4,
              defaultValue: node.prompt || node.instructions || '',
              onBlur: (event) => {
                const prompt = event.target?.value ?? ''
                if (prompt === (node.prompt || '')) return
                save(current.nodes.map(item => item.id === node.id ? { ...item, prompt } : item), current.edges)
              },
            }))),
          (current.edges ?? []).map(edge => {
            const note = edgeNote(edge)
            return h('div', { key: `${edge.from}>${edge.to}`, className: 'wf-hist' },
              h('span', null, note ? `${nameOf(edge.from)} → ${nameOf(edge.to)} · ${note}` : `${nameOf(edge.from)} → ${nameOf(edge.to)}`),
              h('button', {
                type: 'button',
                onClick: () => save(current.nodes, current.edges.filter(item => item.from !== edge.from || item.to !== edge.to)),
              }, tr('Remove')))
          }),
          h('div', { className: 'wf-add' },
            h('label', { className: 'wf-field' }, tr('Kind'),
              h('select', { 'aria-label': tr('Kind'), value: kind, onChange: (event) => setKind(event.target.value) },
                h('option', { value: 'link' }, tr('Link')),
                h('option', { value: 'condition' }, tr('Condition')),
                h('option', { value: 'loop' }, tr('Loop')))),
            h('label', { className: 'wf-field' }, tr('From node'),
              h('select', { 'aria-label': tr('From node'), value: from, onChange: (event) => setFrom(event.target.value) },
                current.nodes.map(node => h('option', { key: node.id, value: node.id }, node.name)))),
            h('label', { className: 'wf-field' }, tr('To node'),
              h('select', { 'aria-label': tr('To node'), value: to, onChange: (event) => setTo(event.target.value) },
                current.nodes.map(node => h('option', { key: node.id, value: node.id }, node.name)))),
            kind === 'condition' ? h('label', { className: 'wf-field' }, tr('Output name'),
              h('input', { 'aria-label': tr('Output name'), value: whenName, onChange: (event) => setWhenName(event.target.value) })) : null,
            kind === 'condition' ? h('label', { className: 'wf-field' }, tr('Equals'),
              h('input', { 'aria-label': tr('Equals'), value: whenEq, onChange: (event) => setWhenEq(event.target.value) })) : null,
            kind === 'loop' ? h('label', { className: 'wf-field' }, tr('Max iterations'),
              h('input', { 'aria-label': tr('Max iterations'), value: loopMax, onChange: (event) => setLoopMax(event.target.value) })) : null,
            kind === 'loop' ? h('label', { className: 'wf-field' }, tr('until'),
              h('input', { 'aria-label': tr('until'), value: untilName, onChange: (event) => setUntilName(event.target.value) })) : null,
            kind === 'loop' ? h('label', { className: 'wf-field' }, tr('Equals'),
              h('input', { 'aria-label': tr('Equals'), value: untilEq, onChange: (event) => setUntilEq(event.target.value) })) : null,
            h('button', {
              type: 'button', className: 'wf-btn',
              onClick: () => {
                if (!from || !to) return
                if (kind !== 'loop' && from === to) return
                if ((current.edges ?? []).some(edge => edge.from === from && edge.to === to)) return
                let edge = { from, to }
                if (kind === 'condition') {
                  const output = whenName.trim().toLowerCase()
                  if (!output) return
                  edge = { from, to, when: { output, eq: whenEq } }
                } else if (kind === 'loop') {
                  const max = Number(loopMax)
                  edge = { from, to, loop: true, max: Number.isInteger(max) ? max : 3 }
                  const output = untilName.trim().toLowerCase()
                  if (output) edge.until = { output, eq: untilEq }
                }
                save(current.nodes, [...(current.edges ?? []), edge])
              },
            }, tr('Add link')))) : null)
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
      const [playing, setPlaying] = useState(false)
      const [draft, setDraft] = useState('')
      const [tasks, setTasks] = useState(FIXTURE_TASKS)
      const [tip, setTip] = useState(null)
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(false)
      const playingRef = useRef(false)
      playingRef.current = playing

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
            // The board can be absent. Manual assign still lists the fixture cards.
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
        if (!playing || !openId) return undefined
        const live = (pack?.workflows ?? []).find(item => item.id === openId)
        if ((live?.activeCount ?? 0) > 0) { setPlaying(false); return undefined }
        const timer = setInterval(() => { void call('workflow/demo-step', { workflowId: openId }).then(refresh).then(value => {
          const row = value?.workflows?.find(item => item.id === openId)
          if (value?.ok === false || (row?.activeCount ?? 0) > 0 || !row?.run || row.run.status === 'done') setPlaying(false)
        }) }, 1200)
        return () => clearInterval(timer)
      }, [playing, openId, pack])
      useEffect(() => {
        const live = (pack?.workflows ?? []).some(item => (item.activeCount ?? 0) > 0)
        if (!live) return undefined
        let gone = false
        const timer = setInterval(() => { if (!gone) void refresh() }, 2000)
        return () => { gone = true; clearInterval(timer) }
      }, [pack])
      useEffect(() => {
        if (!openId || typeof document === 'undefined') return undefined
        const onClick = (event) => {
          const row = event.target?.closest?.('.bt-row, .bt-board-row')
          if (!row || row.closest('[data-flybot="workflow"]')) return
          setOpenId(null)
          setPlaying(false)
        }
        document.addEventListener('click', onClick, true)
        return () => document.removeEventListener('click', onClick, true)
      }, [openId])

      const workflows = pack?.workflows ?? []
      const open = workflows.find(item => item.id === openId) ?? null

      const loadTasks = async () => {
        const host = globalThis.__flybot__?.host
        if (typeof host !== 'function') { setTasks(FIXTURE_TASKS); return }
        try {
          const rows = await host('tasks', {})
          const real = Array.isArray(rows) ? rows.filter(task => task && task.title && task.status !== 'cancelled').slice(0, 12).map(task => ({
            id: task.id, title: task.title, status: task.status, priority: task.priority, column: columnOf(task),
          })) : []
          setTasks(real.length > 0 ? real : FIXTURE_TASKS)
        } catch (loadError) {
          // The board can be absent on a read-only host. The fixture cards still let the owner try the path.
          void loadError
          setTasks(FIXTURE_TASKS)
        }
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
              // The board can be absent. The route is stored; the next card write applies the owner.
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

      return h('div', { 'data-flybot': 'workflow' },
        h('div', { className: 'wf-sec' },
          h('span', null, tr('Workflows')),
          h('button', { type: 'button', className: 'wf-new', onClick: () => setCreating(true) }, tr('New'))),
        workflows.length === 0 ? h('div', { className: 'wf-muted' }, tr('No workflows yet.')) : null,
        workflows.map(item => h('button', {
          key: item.id, type: 'button', className: `wf-row ${openId === item.id ? 'on' : ''}`,
          onClick: () => { setOpenId(item.id); setPlaying(false) },
        },
          h('span', { className: 'wf-ico' }, glyph()),
          h('span', { className: 'wf-txt' },
            h('span', { className: 'wf-t1' }, item.name, h('span', { className: 'wf-badge' }, 'Workflow')),
            h('span', { className: 'wf-t2' }, item.preview || tr('Waiting for a task'))),
          item.run?.status === 'running' ? h('span', { className: 'wf-live', 'aria-hidden': true }) : null)),
        h('button', { type: 'button', className: 'wf-row wf-assign-row', onClick: () => { setAssignOpen(true); void loadTasks() } },
          h('span', { className: 'wf-ico' }, glyph()),
          h('span', { className: 'wf-txt' }, h('span', { className: 'wf-t1' }, tr('Hand a task to a Workflow')))),
        error ? h('div', { className: 'wf-err', role: 'alert' }, error) : null,
        open ? portal(h(Stage, {
          workflow: open, roster, playing, drawer, tab, draft, onDraft: setDraft,
          editing,
          onToggleEdit: () => { setEditing(value => !value); setDrawer(true); setTab('flow') },
          onCommit: (graph) => {
            void call('workflow/graph', { workflowId: open.id, nodes: graph.nodes, edges: graph.edges }).then(value => {
              if (value?.ok === false) { setError(value.error ?? ''); return }
              if (value?.workflows) setPack(value)
            })
          },
          onCloseDrawer: () => setDrawer(false),
          onToggleDrawer: () => { setDrawer(value => !value); setTab('flow') },
          onTab: (key) => { setTab(key); setDrawer(true) },
          onPlay: () => {
            if ((open.activeCount ?? 0) > 0) { setError(tr('A live run is in progress')); setPlaying(false); return }
            setPlaying(value => !value)
          },
          onNext: () => { setPlaying(false); void call('workflow/demo-step', { workflowId: open.id }).then(value => { if (value?.workflows) setPack(value) }) },
          onReset: () => { setPlaying(false); void call('workflow/reset', { workflowId: open.id }).then(value => { if (value?.workflows) setPack(value) }) },
          onAssign: () => { setAssignOpen(true); void loadTasks() },
          onSend: () => {
            const text = draft.trim()
            if (!text) return
            setDraft('')
            void call('workflow/say', { workflowId: open.id, text }).then(value => { if (value?.workflows) setPack(value) })
          },
          onTip: setTip,
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
          h('div', null, tip.node.instructions)) : null)
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
.wf-ico{width:32px;height:32px;border-radius:9px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));display:grid;place-items:center;color:var(--bt-accent,#4d6bfe);flex:none}
.wf-ico-lg{width:42px;height:42px;margin:0 auto}
.wf-av{border-radius:50%;display:inline-grid;place-items:center;color:#fff;font-weight:650;flex:none}
.wf-stage{position:fixed;top:0;right:0;bottom:0;z-index:30;display:flex;background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414)}
.wf-main{flex:1;min-width:0;display:flex;flex-direction:column}
.wf-top{height:56px;display:flex;align-items:center;justify-content:center;position:relative;flex:none}
.wf-pill{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px 0 8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);cursor:pointer;color:inherit;font:inherit}
.wf-stack{display:inline-flex}.wf-stack .wf-av,.wf-stack>*{margin-left:-6px}.wf-stack>*:first-child{margin-left:0}
.wf-pill-name{font-weight:600}.wf-sub{font-size:11px;color:var(--bt-ink-3,#9a9a9a)}.wf-chev{color:var(--bt-ink-3,#9a9a9a)}
.wf-actions{position:absolute;right:14px;top:12px;display:flex;gap:6px}
.wf-btn{height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.wf-btn.wf-pri{background:var(--bt-accent,#4d6bfe);border-color:var(--bt-accent,#4d6bfe);color:#fff}
.wf-btn.wf-dark{background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);border-color:var(--bt-user,#070707)}
.wf-btn.wf-sm{height:28px}
.wf-strip{margin:0 auto 4px;width:min(720px,calc(100% - 48px));border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:12px;padding:9px 12px;display:flex;align-items:center;gap:12px}
.wf-tk{font-weight:600}.wf-meta{font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
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
.wf-sys{align-self:center;font-size:11.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));border:1px dashed var(--bt-line,rgba(20,20,20,.08));padding:4px 10px;border-radius:12px;max-width:90%;text-align:center}
.wf-sys.accent{color:var(--bt-accent,#4d6bfe);background:rgba(77,107,254,.1);border-style:solid}
.wf-sys.ok{color:#16a34a;background:rgba(22,163,74,.1);border-color:transparent}
.wf-sys.bad{color:#e5484d;background:rgba(229,72,77,.1);border-color:transparent}
.wf-msg{display:flex;gap:8px;align-items:flex-end;max-width:78%}
.wf-who{font-size:11px;margin:0 0 3px 2px;display:flex;gap:6px}
.wf-step{color:var(--bt-ink-3,#9a9a9a)}
.wf-bub{background:var(--bt-bubble,#eee);border-radius:12px;padding:8px 11px;line-height:1.6}
.wf-att{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
.wf-att span{font-size:11.5px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:8px;padding:3px 8px}
.wf-user{align-self:flex-end;background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);border-radius:12px;padding:8px 12px;max-width:70%;line-height:1.6}
.wf-typing{display:flex;gap:4px;padding:11px 12px}
.wf-typing i{width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3,#9a9a9a)}
.wf-composer-wrap{flex:none;padding:0 0 10px}
.wf-composer{width:min(760px,calc(100% - 48px));margin:0 auto;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:14px;background:var(--bt-card,#fff);display:flex;align-items:center;gap:8px;padding:8px}
.wf-composer input{flex:1;border:0;outline:0;background:transparent;font:inherit;color:inherit}
.wf-mic{width:28px;height:28px;border-radius:9px;border:0;background:var(--bt-accent,#4d6bfe);color:#fff;cursor:pointer}
.wf-under{text-align:center;margin-top:6px;font-size:11px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-drawer{width:400px;flex:none;border-left:1px solid var(--bt-line,rgba(20,20,20,.08));display:flex;flex-direction:column;background:var(--bt-main,#fcfcfc)}
.wf-dr-head{display:flex;justify-content:flex-end;padding:12px}
.wf-icon{width:28px;height:28px;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);cursor:pointer;color:inherit}
.wf-dr-body{flex:1;overflow:auto;padding:4px 18px 20px}
.wf-dr-title{display:flex;flex-direction:column;align-items:center;gap:4px;margin-bottom:10px}
.wf-dr-title h2{font-size:16px;font-weight:600;margin:0}
.wf-dr-title p{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:center;line-height:1.5;margin:0}
.wf-tabs{display:flex;justify-content:center;gap:4px;margin:6px 0 12px}
.wf-tabs button{padding:4px 10px;border-radius:7px;border:0;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));cursor:pointer;font:inherit}
.wf-tabs button.on{background:var(--bt-active,rgba(119,119,119,.17));color:var(--bt-ink,#141414)}
.wf-flow{display:flex;flex-direction:column;align-items:center;gap:0;padding:8px 0}
.wf-term{font-size:11px;color:var(--bt-ink-2,rgba(20,20,20,.6));border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;padding:3px 10px}
.wf-term.on{color:#16a34a;background:rgba(22,163,74,.1);border-color:transparent}
.wf-step{display:flex;flex-direction:column;align-items:center}
.wf-vline{width:1.6px;height:22px;background:var(--bt-line,rgba(20,20,20,.16))}
.wf-frow{display:flex;justify-content:center;gap:14px}
.wf-par{position:relative;border:1px dashed var(--bt-ink-3,#9a9a9a);border-radius:14px;padding:16px 8px 8px}
.wf-plabel{position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:10.5px;color:var(--bt-ink-2,rgba(20,20,20,.6));background:var(--bt-card,#fff);padding:0 6px;white-space:nowrap}
.wf-canvas{display:flex;flex-direction:column;align-items:center;gap:8px;min-height:440px}
.wf-palette{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;width:100%}
.wf-plane{position:relative;width:0;margin:8px auto 0}
.wf-wires{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.wf-wires path{fill:none;stroke:var(--bt-line,rgba(20,20,20,.35));stroke-width:1.6}
.wf-wires .wf-end{pointer-events:auto;fill:var(--bt-card,#fff);stroke:var(--bt-accent,#4d6bfe);cursor:crosshair}
.wf-abs{position:absolute}
.wf-port{position:absolute;left:50%;bottom:-6px;width:12px;height:12px;margin-left:-6px;border-radius:50%;border:2px solid var(--bt-accent,#4d6bfe);background:var(--bt-card,#fff);padding:0;cursor:crosshair}
.wf-mini{position:absolute;top:-8px;right:-8px;width:18px;height:18px;border-radius:50%;border:1px solid var(--bt-line,rgba(20,20,20,.16));background:var(--bt-card,#fff);cursor:pointer;line-height:16px;padding:0}
.wf-node{width:168px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:12px;padding:8px 9px;display:flex;align-items:center;gap:8px;position:relative}
.wf-node.running{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.12)}
.wf-node.done{border-color:rgba(22,163,74,.35)}.wf-node.failed{border-color:#e5484d}
.wf-node .wf-chip{position:absolute;top:-9px;right:8px}
.wf-nt{min-width:0;flex:1;display:flex;flex-direction:column}
.wf-nm{font-weight:600;font-size:12.5px}.wf-rl{font-size:11px;color:var(--bt-ink-3,#9a9a9a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-box{border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);padding:10px 12px}
.wf-kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:12px}
.wf-kv span:first-child{color:var(--bt-ink-2,rgba(20,20,20,.6))}
.wf-hist{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--bt-line,rgba(20,20,20,.08));font-size:12px}
.wf-ctl{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
.wf-mask{position:fixed;inset:0;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;z-index:80}
.wf-modal{width:560px;max-width:calc(100% - 32px);background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414);border-radius:16px;border:1px solid var(--bt-line,rgba(20,20,20,.08));padding:18px 20px}
.wf-modal h3{font-size:15px;display:flex;justify-content:space-between;align-items:center;margin:0}
.wf-hint{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));margin:4px 0 0}
.wf-step-h{font-size:12px;color:var(--bt-ink-2,rgba(20,20,20,.6));margin:14px 0 8px;display:flex;gap:6px;align-items:center}
.wf-step-h b{width:18px;height:18px;border-radius:50%;background:var(--bt-user,#070707);color:var(--bt-user-ink,#fcfcfc);display:grid;place-items:center;font-size:11px}
.wf-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.wf-kcard{border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:10px;padding:9px 10px;text-align:left;cursor:pointer;color:inherit;font:inherit}
.wf-kcard.sel,.wf-tgt.sel{border-color:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.12)}
.wf-id,.wf-kcol{font-size:11px;color:var(--bt-ink-3,#9a9a9a)}.wf-tt{font-size:12.5px;margin:3px 0 6px;font-weight:500}
.wf-targets{display:flex;flex-direction:column;gap:6px}
.wf-tgt{display:flex;align-items:center;gap:10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);border-radius:10px;padding:8px 10px;text-align:left;cursor:pointer;color:inherit;font:inherit;width:100%}
.wf-rad{margin-left:auto;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--bt-ink-3,#9a9a9a);flex:none}
.wf-tgt.sel .wf-rad{border:5px solid var(--bt-accent,#4d6bfe)}
.wf-mfoot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.wf-field{display:flex;flex-direction:column;gap:6px;font-size:12px;margin-top:12px}
.wf-field input,.wf-field select{height:32px;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;padding:0 8px}
.wf-prompts{width:min(360px,100%);display:flex;flex-direction:column;gap:8px}
.wf-prompt{display:flex;flex-direction:column;gap:4px;font-size:12px;width:100%}
.wf-field textarea,.wf-prompt textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--bt-line,rgba(20,20,20,.08));background:var(--bt-card,#fff);color:inherit;font:inherit;padding:6px 8px;resize:vertical}
.wf-add{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wf-plan{margin:10px 0 0;padding-left:18px;font-size:13px}
.wf-tip{position:fixed;z-index:90;width:250px;background:var(--bt-card,#fff);border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.55}
.wf-tip .wf-k{color:var(--bt-ink-3,#9a9a9a);font-size:11px;margin-top:6px}
.wf-muted{font-size:12px;color:var(--bt-ink-3,#9a9a9a);padding:4px 8px}
.wf-err{font-size:12px;color:#e5484d;padding:4px 8px}
.wf-assign-row{opacity:.9}
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

    return { name: 'flybot-workflow', inject: ['flybot'], apply, Section, WorkflowSettings, tr, columnOf, shortId, FIXTURE_TASKS }
  },
})
