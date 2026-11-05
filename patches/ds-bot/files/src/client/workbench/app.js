import { createNativeIslands } from './native-islands.js'
import { nativeAssetLoader } from './native-assets.js'
import { createScopedConversation } from './native-source.js'
// The shared entry uses only Project-scoped APIs. Never bootstrap from the owner roster.
export function mountWorkbench(root, api, { pollMs = 4000 } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView
  let bootstrap, mode, selected = '', tab = 'board', taskId = '', personalPart = '', detail, resources, agents, members, history, taskDetail, workflowState
  let loading, epoch = 0, controller, error = '', notice = '', timer, disposed = false, busy = false
  let personal, personalMemory
  let conversationSource = createScopedConversation(api)
  function clearConversation() { conversationSource.dispose(); conversationSource = createScopedConversation(api) }
  async function readConversation(binding) {
    const current = conversationSource.getSnapshot().binding
    if (current && current.projectId === binding.projectId && current.roomId === binding.roomId && current.visibility === binding.visibility && current.personalId === binding.personalId && current.personalPart === binding.personalPart) await conversationSource.refresh()
    else await conversationSource.open(binding)
    return conversationSource.getSnapshot()
  }
  const feishuActions = { feishu: payload => api.call('feishu', payload), connectorConnect: (_id, body) => api.call('feishu', { operation: 'webhook', ...body.credentials }) }
  const drafts = new Map(), expanded = new Map()
  let runtimeTerminal, terminalTimer, terminalPolling = false, rooms, roomView, pools
  async function closeTerminal() {
    const terminal = runtimeTerminal; runtimeTerminal = null; win.clearInterval(terminalTimer)
    if (terminal) await api.call('project-terminal-close', { terminalId: terminal.terminalId }).catch(() => {}) // Revoked sessions may already have closed the server PTY.
  }
  async function openTerminal(resourceId, harness, role) {
    await closeTerminal()
    const projectId = selected, captured = epoch
    const opened = await scoped('project-terminal-open', { resourceId, harness, role })
    if (captured !== epoch || projectId !== selected || disposed) { await api.call('project-terminal-close', { terminalId: opened.terminalId }); return }
    runtimeTerminal = { ...opened, projectId, screen: '', seq: 0 }
    terminalTimer = win.setInterval(async () => {
      if (!runtimeTerminal || terminalPolling) return
      const terminal = runtimeTerminal; terminalPolling = true
      try {
        const value = await api.call('project-terminal-poll', { terminalId: terminal.terminalId, since: terminal.seq })
        if (terminal !== runtimeTerminal) return
        terminal.seq = value.seq
        terminal.screen = (terminal.screen + (value.output ?? []).map(row => row.text).join('')).slice(-60000)
        terminal.closed = value.closed; terminal.reason = value.reason
        if (value.closed) win.clearInterval(terminalTimer)
        render()
      } catch { if (terminal === runtimeTerminal) { await closeTerminal(); error = 'Configuration terminal ended or access was revoked'; render() } }
      finally { terminalPolling = false }
    }, 500)
    render()
  }
  const el = (tag, text, cls) => { const node = doc.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node }
  const button = (text, action, disabled = false) => { const node = el('button', text); node.type = 'button'; node.disabled = disabled; node.onclick = action; return node }
  const link = (text, url, allowLoopback = false) => { const node = el('a', text); try { const parsed = new URL(url); if (parsed.protocol === 'https:' || allowLoopback && parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) { node.href = parsed.href; node.target = '_blank'; node.rel = 'noopener noreferrer' } } catch { /* Invalid external evidence URL remains plain text. */ } return node }
  const box = (title, ...children) => { const node = el('section', null, 'card'); node.append(el('h2', title), ...children.filter(Boolean)); return node }
  const route = (id, next = 'board', task = '') => { win.location.hash = `/projects/${encodeURIComponent(id)}/${next}${task ? `/${encodeURIComponent(task)}` : ''}` }
  function form(name, fields, submit, label = 'Save') {
    const node = el('form'), key = `${selected}:${tab}:${name}`
    const saved = drafts.get(key) ?? {}
    for (const [field, title, type = 'text', options, initial] of fields) {
      if (type === 'checkboxes') {
        const group = el('fieldset'); group.append(el('legend', title))
        for (const option of options ?? []) {
          const value = typeof option === 'string' ? option : option.value, label = typeof option === 'string' ? option : option.label
          const wrapper = el('label', label, 'choice'), input = el('input')
          input.type = 'checkbox'; input.name = field; input.value = value; input.checked = (saved[field] ?? initial ?? []).includes(value)
          input.oninput = () => { const values = drafts.get(key) ?? {}; values[field] = [...group.querySelectorAll('input:checked')].map(row => row.value); drafts.set(key, values) }
          wrapper.prepend(input); group.append(wrapper)
        }
        node.append(group); continue
      }
      const wrapper = el('label', title)
      const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input')
      if (options) for (const option of options) { const row = el('option', option || 'No repository'); row.value = option; input.append(row) }
      else if (type !== 'textarea') input.type = type
      input.setAttribute('aria-label', title)
      input.name = field; input.id = `${name}-${field}`; input.value = saved[field] ?? initial ?? (options?.[0] ?? ''); input.required = type !== 'optional' && !options
      if (type === 'optional') input.type = 'text'
      input.oninput = () => { const values = drafts.get(key) ?? {}; values[field] = input.value; drafts.set(key, values) }
      wrapper.append(input); node.append(wrapper)
    }
    node.append(button(label, () => {}, busy))
    node.lastChild.type = 'submit'
    node.onsubmit = event => { event.preventDefault(); const data = new win.FormData(node), values = Object.fromEntries(data); for (const [field, , type] of fields) if (type === 'checkboxes') values[field] = data.getAll(field); void act(async () => { await submit(values); drafts.delete(key) }) }
    return node
  }
  async function signOut() {
    // Invalidate every pending read/action before waiting for remote revocation.
    ++epoch; controller?.abort(); loading = null; clearConversation()
    const revoke = api.call('auth-revoke')
    api.setToken(''); void closeTerminal()
    if (win.location.hash === '#/connections' || new URLSearchParams(win.location.search).has('feishu-app') && !win.location.hash) { selected = ''; tab = 'connections'; taskId = '' }
    personal = personalMemory = null; drafts.clear(); notice = ''; error = ''
    bootstrap = null; selected = ''; busy = false
    detail = resources = agents = members = history = taskDetail = workflowState = rooms = roomView = pools = null
    render()
    try { await revoke } catch { /* Local logout remains effective if the server is unavailable. */ }
  }
  async function act(action) {
    if (busy) return
    const captured = epoch
    busy = true; error = ''; render()
    try { await action(); if (captured === epoch) await refresh() }
    catch (failure) { if (captured === epoch) error = failure.message }
    finally { busy = false; if (!disposed) render() }
  }
  const scoped = async (endpoint, body = {}) => {
    const captured = epoch, id = selected
    const result = await api.call(endpoint, { projectId: id, ...body })
    if (disposed || captured !== epoch || selected !== id) throw Object.assign(new Error('Project view changed'), { name: 'AbortError' })
    return result
  }
  function refresh() {
    if (loading) return loading
    const pending = load()
    loading = pending
    void pending.finally(() => { if (loading === pending) loading = null })
    return pending
  }
  async function load() {
    const current = ++epoch
    controller?.abort(); controller = new AbortController()
    const id = selected, section = tab, tid = taskId
    try {
      const state = await api.call('workbench-state', {}, controller.signal)
      if (current !== epoch || disposed) return
      bootstrap = state
      if (section === 'connections') {
        personal = await api.call('personal-space', { operation: 'list' }, controller.signal)
        if (current !== epoch || disposed) return
        render(); return
      }
      if (section === 'personal') {
        const roster = await api.call('personal-space', { operation: 'list' }, controller.signal)
        if (current !== epoch || disposed) return
        personal = roster
        if (personalPart && roster.bots.find(bot => bot.id === tid)?.sessionId === personalPart) {
          personalPart = ''
          win.history.replaceState(null, '', `#/personal/${encodeURIComponent(tid)}`)
        }
        if (tid) history = await readConversation({ personalId: tid, ...(personalPart ? { personalPart } : {}) })
        if (current !== epoch || disposed) return
        render(); return
      }
      if (!id) { render(); return }
      if (!state.projects.some(project => project.id === id)) throw new Error('Project access was removed or the Project is unavailable')
      render()
      const calls = [
        api.call('project-detail', { projectId: id, view: 'summary' }, controller.signal),
        api.call('project-resources', { projectId: id, view: ['settings', 'resources', 'activity'].includes(section) ? 'full' : 'summary' }, controller.signal),
        ['board', 'bots', 'private', 'settings'].includes(section) ? api.call('project-agents', { projectId: id, view: section === 'board' ? 'summary' : 'full' }, controller.signal) : null,
        ['members', 'rooms'].includes(section) ? api.call('project-members', { projectId: id }, controller.signal) : null,
      ]
      const extra = section === 'private' || section === 'bots' ? readConversation({ projectId: id, visibility: section === 'private' ? 'private' : 'public' }) : null
      const task = tid && section === 'tasks' ? api.call('project-task-detail', { taskId: tid }, controller.signal) : null
      const values = await Promise.all([...calls, extra, task, section === 'tasks' ? api.call('project-workflow', { projectId: id, operation: 'state' }, controller.signal) : null])
      if (values[5] && values[5].task.projectId !== id) throw new Error('Task belongs to another Project')
      if (current !== epoch || disposed) return
      ;[detail, resources, agents, members, history, taskDetail, workflowState] = values
      const collaboration = await Promise.all([api.call('project-rooms', { projectId: id }, controller.signal), section === 'activity' ? api.call('project-task-pools', { projectId: id }, controller.signal) : null, section === 'rooms' && tid ? readConversation({ projectId: id, roomId: tid }) : null])
      if (current !== epoch || disposed) return
      ;[rooms, pools, roomView] = collaboration
      error = ''; render()
    } catch (failure) {
      if (current !== epoch || disposed || failure.name === 'AbortError') return
      clearConversation()
      detail = resources = agents = members = history = taskDetail = workflowState = rooms = roomView = pools = null
      error = failure.message; render()
    }
  }
  function changeRoute() {
    clearConversation()
    void closeTerminal()
    const match = win.location.hash.match(/^#\/projects\/([^/]+)\/(board|tasks|members|bots|resources|private|rooms|activity|settings)(?:\/([^/]+))?$/)
    try { selected = match ? decodeURIComponent(match[1]) : ''; tab = match?.[2] ?? 'board'; taskId = match?.[3] ? decodeURIComponent(match[3]) : '' } catch { selected = ''; tab = 'board'; taskId = '' }
    if (win.location.hash.startsWith('#/personal')) { selected = ''; tab = 'personal'; try { taskId = decodeURIComponent(win.location.hash.split('/')[2] ?? ''); personalPart = decodeURIComponent(win.location.hash.split('/')[3] ?? '') } catch { taskId = '' } }
    personal = personalMemory = null
    ++epoch; controller?.abort(); loading = null; detail = resources = agents = members = history = taskDetail = workflowState = rooms = roomView = pools = null; error = ''; notice = ''
    render(); void refresh()
  }
  function taskPanel(task) {
    const node = el('article', null, 'task')
    const run = (workflowState?.workflows ?? []).flatMap(row => row.runs ?? []).find(row => row.task?.id === task.id)
    const phase = Object.entries(run?.nodeStatus ?? {}).filter(([, status]) => status === 'running').map(([role]) => role).join(', ')
    const execution = resources.taskExecution?.find(row => row.taskId === task.id)
    const queued = resources.queue.some(row => row.taskId === task.id && row.status === 'waiting')
    node.append(button(task.title, () => route(selected, 'tasks', task.id)), el('small', `${task.priority ?? 'normal'} · ${task.status} · ${execution?.phase || phase || (queued ? 'waiting for quota' : task.requesterId)}`))
    const metadata = el('div', null, 'task-meta')
    for (const [label, value] of [['Current role', task.collaboration?.botId?.split(':').at(-1) ?? (phase || 'Unassigned')], ['Execution', execution?.phase ?? (queued ? 'Queued' : 'Not started')], ['Next step', task.status === 'blocked' ? 'Provide requested input' : task.status === 'result-ready' ? 'Await Chief / acceptance' : ['accepted', 'cancelled'].includes(task.status) ? 'View evidence' : 'Open Task for actions']]) {
      const field = el('div'); field.append(el('small', label), el('strong', value)); metadata.append(field)
    }
    node.append(metadata)
    return node
  }
  function attemptsPanel() {
    const task = taskDetail.task, canWrite = detail.permissions.configure || task.requesterId === bootstrap.self.memberId
    const node = box(task.title, el('p', task.criteria ?? 'No acceptance criteria'), el('p', task.note ?? 'No additional context'), el('p', `Priority: ${task.priority ?? 'normal'} · status: ${task.status}`))
    if (Number.isFinite(task.createdAt)) node.append(el('p', `Task age: ${Math.max(0, Math.round((Date.now() - task.createdAt) / 60000))} min, including waiting`))
    if (task.target?.href) node.append(link('Source Issue / PR', task.target.href))
    if (task.status === 'blocked') node.append(box('Waiting for input / approval', el('p', task.inputRequest?.question ?? task.waitingFor ?? 'Approval required'), task.approvalId ? el('p', 'An authorized approver must resolve this request; answering text cannot approve it.') : null))
    if (task.waitingFor === 'input' && task.requesterId === bootstrap.self.memberId && !task.approvalId && !task.inputApprovalIds?.length) node.append(form('answer', [['answer', 'Answer current question', 'textarea']], values => scoped('task-answer-input', { id: task.id, questionId: task.inputRequest.id, ...values }), 'Answer'))
    if (!resources.repository.configured && resources.repository.reason) node.append(box('Repository execution blocked', el('p', resources.repository.reason)))
    const activeAttempt = taskDetail.attempts.some(attempt => ['preparing', 'running', 'waiting-acceptance'].includes(attempt.status))
    node.append(button('Run / retry', () => act(() => scoped('project-task-run', { taskId: task.id, requestId: win.crypto.randomUUID() })), !canWrite || !resources.repository.configured || activeAttempt || ['accepted', 'cancelled'].includes(task.status) || busy))
    for (const attempt of taskDetail.attempts) {
      const card = box(`Attempt · ${attempt.status}`, el('p', attempt.candidateSha ? `Candidate ${attempt.candidateSha.slice(0, 12)}` : 'No candidate commit'), evidencePanel(attempt.evidence))
      if (attempt.failure?.message) card.append(box('Failure / requested changes', el('p', attempt.failure.message)))
      const ended = attempt.acceptedAt ?? attempt.failure?.at
      card.append(el('p', `Attempt elapsed: ${Math.max(0, Math.round(((ended ?? Date.now()) - attempt.createdAt) / 1000))} sec (includes preparation and waiting)`))
      const workflow = workflowState?.workflows?.find(row => row.id === attempt.workflowId)
      const run = [...(workflow?.runs ?? []), workflow?.run].find(row => row?.id === attempt.runId)
      card.append(box('Role progress and workspaces', ...Object.entries(run?.nodeStatus ?? {}).map(([role, status]) => el('p', `${role}: ${status}`)), ...(attempt.agentDefinitions?.roles ?? []).map(row => el('p', `${row.name ?? row.role} · ${row.execution?.harness ?? 'flybot'} · ${row.execution?.model ?? row.model ?? 'Default model'} · Skills: ${(row.skills ?? []).join(', ') || 'None'}`))))
      if (attempt.pr?.url) card.append(link('Open pull request', attempt.pr.url))
      card.append(button('Test log', () => act(async () => { const log = await scoped('project-attempt-log', { attemptId: attempt.id }); notice = log.text ?? log.reason })))
      if (detail.permissions.accept && attempt.status === 'waiting-acceptance') {
        card.append(button('Accept this commit', () => act(() => scoped('project-task-accept', { attemptId: attempt.id, sha: attempt.candidateSha })), busy))
        card.append(form(`reject-${attempt.id}`, [['reason', 'Requested changes', 'textarea']], values => scoped('project-task-reject', { attemptId: attempt.id, ...values }), 'Request changes'))
      }
      for (const [role, evidence] of Object.entries(attempt.evidence?.execution ?? {})) card.append(el('p', `${role}: ${evidence.harness} ${evidence.sdkVersion} · resource ${evidence.resourceId} · Session ${evidence.sessionId}`), button(`Read ${role} execution evidence`, () => act(async () => { notice = (await scoped('project-attempt-log', { attemptId: attempt.id, role })).text ?? 'No execution log'; })))
      if (detail.permissions.configure) card.append(button('Stop execution', () => act(() => scoped('project-attempt-stop', { attemptId: attempt.id })), busy), button('Clean workspaces', () => act(() => scoped('project-attempt-cleanup', { attemptId: attempt.id })), busy))
      node.append(card)
    }
    return node
  }
  function evidencePanel(evidence = {}) {
    const panel = box('Verified artifacts')
    if (evidence.implementation?.diffStat) panel.append(el('pre', evidence.implementation.diffStat))
    if (evidence.tests) panel.append(el('p', `Host tests: ${evidence.tests.ok === true || evidence.tests.passed === true ? 'passed' : evidence.tests.ok === false ? 'failed' : 'See test log'}`))
    if (evidence.review) panel.append(el('p', `Candidate review: ${evidence.review.verdict ?? 'unavailable'} · ${evidence.review.summary ?? ''}`))
    if (!Object.keys(evidence).length) panel.append(el('p', 'No sealed evidence yet'))
    return panel
  }
  function roomsPanel() {
    const node = box('Project conversations', el('p', 'Rooms use independent scoped Sessions. @chief, @developer, @tester and @reviewer route to participating Bots. Conversations do not execute Tasks.'))
    const navigation = el('nav', null, 'room-list')
    for (const room of rooms?.rooms ?? []) navigation.append(button(room.name, () => route(selected, 'rooms', room.id)))
    node.append(navigation)
    if (roomView) {
      node.append(el('h2', roomView.name), el('p', roomView.memberIds.length ? 'Restricted to selected Project members' : 'Shared with current Project members'))
      const conversation = el('div', null, 'conversation'); conversation.setAttribute('role', 'log'); conversation.setAttribute('aria-label', 'Room conversation')
      mountConversation(conversation, [])
      for (const session of roomView.sessions ?? []) {
        conversation.append(el('p', `${session.role}: ${session.phase} · ${session.harness} · ${session.model ?? 'Default model'}`))
        if (['queued', 'running'].includes(session.phase)) conversation.append(button(`Stop ${session.role}`, () => act(() => scoped('project-room-stop', { roomId: roomView.id, role: session.role })), busy))
      }
      const composer = el('div', null, 'composer')
      composer.append(form(`room-message-${roomView.id}`, [['text', 'Room message (@role)', 'textarea'], ['attachmentIds', 'Include registered documents', 'checkboxes', roomView.attachments.map(row => ({ value: row.id, label: row.name }))]], values => scoped('project-room-message', { roomId: roomView.id, ...values }), 'Send to room'))
      node.append(conversation, composer)
      mountComposer(composer, (roomView.roles ?? []).map(role => ({ id: role, name: role })), roomView.attachments)
      const attachments = box('Registered documents and artifacts', el('p', 'Text documents stay in this room; raw filesystem paths and remote images are unavailable.'))
      for (const row of roomView.attachments) attachments.append(button(row.name, () => act(async () => { const captured = epoch, id = selected; const result = await scoped('project-room-attachment', { roomId: roomView.id, attachmentId: row.id }); if (captured === epoch && selected === id) notice = `${result.name}\n${result.text}` })))
      attachments.append(form(`attachment-${roomView.id}`, [['name', 'Document name'], ['text', 'Document content', 'textarea']], values => scoped('project-room-attachment', { roomId: roomView.id, ...values }), 'Register document'))
      node.append(attachments)
    }
    if (detail.permissions.create) node.append(box('Create a room', form('room-create', [['name', 'Room name'], ['roles', 'Participating Bots', 'checkboxes', ['chief', 'developer', 'tester', 'reviewer'], ['chief']], ['memberIds', 'Restrict to members (empty shares with Project)', 'checkboxes', members.members.map(row => row.memberId)]], async values => { const room = await scoped('project-room-create', values); route(selected, 'rooms', room.id) }, 'Create room')))
    return node
  }
  function activityPanel() {
    const node = box('Logical Bot pools', el('p', 'Tasks keep their identity across returns and transfers. Completion requests wait for Chief judgement; a fixed DAG is optional.'))
    for (const pool of pools?.pools ?? []) node.append(box(pool.role, ...(pool.tasks ?? []).map(task => button(task.title ?? task.id, () => route(selected, 'tasks', task.id)))))
    const events = []
    for (const task of detail.tasks ?? []) {
      if (task.collaboration?.claim) events.push({ at: task.collaboration.claim.createdAt ?? task.updatedAt, title: task.title, text: `Claimed by ${task.collaboration.botId?.split(':').at(-1) ?? 'Bot'}` })
      for (const receipt of task.collaboration?.history ?? []) events.push({ at: receipt.createdAt, title: task.title, text: `${receipt.from?.split(':').at(-1) ?? 'Requester'} → ${receipt.to?.split(':').at(-1)} · ${receipt.purpose ?? receipt.status} · ${receipt.reason}` })
    }
    for (const run of resources.chief?.runs ?? []) events.push({ at: run.createdAt, title: `Chief ${run.purpose}`, text: `${run.status} · ${run.summary ?? run.failure ?? ''}` })
    const timeline = box('Timeline')
    for (const event of events.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 100)) timeline.append(box(event.title, el('small', event.at ? new Date(event.at).toLocaleString() : 'Time unavailable'), el('p', event.text)))
    if (!events.length) timeline.append(el('p', 'No recorded collaboration events yet'))
    node.append(timeline)
    for (const workflow of workflowState?.workflows ?? []) node.append(box(workflow.name ?? 'Workflow', ...(workflow.runs ?? []).map(run => el('p', `${run.task?.title ?? 'Run'} · ${run.status}`))))
    return node
  }
  function boardPanel() {
    const node = el('div')
    const metrics = resources.metrics
    const stats = el('div', null, 'stats')
    for (const [label, value] of [['Accepted / 7 days', metrics.acceptedTasks], ['Active slots', `${resources.activeSlots}/${resources.quota.maxConcurrent}`], ['Waiting', resources.queue.filter(row => row.status === 'waiting').length], ['Median delivery', metrics.duration.medianMs == null ? 'No samples' : `${Math.round(metrics.duration.medianMs / 60000)} min`]]) stats.append(box(label, el('strong', value)))
    node.append(stats, el('p', 'Delivery duration: Task creation to human acceptance, including queue and human wait.'))
    const columns = el('div', null, 'task-groups')
    const groups = [['Open', task => !['working', 'result-ready', 'blocked', 'accepted', 'cancelled', 'failed'].includes(task.status)], ['In progress', task => ['working', 'result-ready'].includes(task.status)], ['Needs attention', task => ['blocked', 'failed'].includes(task.status)], ['Completed', task => ['accepted', 'cancelled'].includes(task.status)]]
    for (const [label, predicate] of groups) {
      const tasks = (detail.tasks ?? []).filter(predicate).sort((a, b) => ['urgent', 'high', 'normal', 'low'].indexOf(a.priority ?? 'normal') - ['urgent', 'high', 'normal', 'low'].indexOf(b.priority ?? 'normal'))
      const group = el('details', null, 'task-group'), key = `${selected}:${label}`; group.open = expanded.get(key) ?? label !== 'Completed'
      group.ontoggle = () => { if (group.isConnected) expanded.set(key, group.open) }
      group.append(el('summary', `${label} · ${tasks.length}`), ...tasks.map(taskPanel))
      if (!tasks.length) group.append(el('p', 'No Tasks in this group', 'empty-state'))
      columns.append(group)
    }
    node.append(columns)
    if (detail.permissions.create) node.append(box('Create Task', form('task', [['title', 'Requirement'], ['criteria', 'Acceptance criteria', 'textarea'], ['note', 'Context', 'optional'], ['priority', 'Priority', 'text', ['normal', 'high', 'urgent', 'low']], ['target', 'Source Issue / PR (optional)', 'optional']], values => scoped('task-create', { ...values, botId: agents.public.botId }), 'Create Task')))
    return node
  }
  function membersPanel() {
    const node = box('Project members')
    for (const member of members.members) {
      const row = el('div', null, 'row'); row.append(el('span', `${member.displayName} · ${member.role}`))
      if (member.role !== 'owner' && detail.permissions.configure) row.append(button('Remove', () => act(() => scoped('project-member-remove', { memberId: member.memberId })), busy))
      if (member.role !== 'owner' && detail.permissions.manage) row.append(button(member.role === 'maintainer' ? 'Make Member' : 'Make Maintainer', () => act(() => scoped('project-role', { id: selected, memberId: member.memberId, role: member.role === 'maintainer' ? 'member' : 'maintainer' })), busy))
      node.append(row)
    }
    if (detail.permissions.configure) node.append(button('Create one-use Project invitation', () => act(async () => { const invite = await scoped('project-invite'); notice = `Project invitation (expires ${new Date(invite.expiresAt).toLocaleString()}): ${invite.token}` }), busy))
    return node
  }
  const loadNative = nativeAssetLoader(doc, win)
  const nativeIslands = createNativeIslands(root, loadNative, (failure, node) => { node.replaceChildren(el('p', failure.message, 'error')) })
  const nativeKey = kind => `${bootstrap?.self.memberId ?? ''}:${selected}:${tab}:${taskId}:${personalPart}:${kind}`
  function mountPersonalList(target) {
    nativeIslands.register(target, nativeKey('list'), conversationSource, (node, options) => win.FlyBotNativeConversation.mountNativeChatList(node, options), {
      ...personal, selectedId: taskId,
      openSession: id => { win.location.hash = `/personal/${encodeURIComponent(id)}` },
      openDetails: id => { for (const row of root.querySelectorAll('[data-persona-id]')) if (row.dataset.personaId === id) { row.open = true; row.scrollIntoView?.({ block: 'nearest' }) } },
    })
  }
  function mountConversation(transcript, bots) {
    transcript.append(el('p', 'Loading original conversation components…'))
    nativeIslands.register(transcript, nativeKey('conversation'), conversationSource, (node, options) => win.FlyBotNativeConversation.mountNativeConversation(node, options), {
      source: conversationSource, bots,
      openBot: id => { if (tab === 'personal' && personal?.bots.some(bot => bot.id === id)) win.location.hash = `/personal/${encodeURIComponent(id)}` },
      onQuote: text => {
        const input = root.querySelector('textarea[name=text]')
        if (input) { input.value = `> ${text.replace(/\n/g, '\n> ')}\n\n` + input.value; input.dispatchEvent(new win.Event('input', { bubbles: true })); input.focus() }
      },
    })
  }
  function mountComposer(container, mentions = [], attachments = []) {
    const source = conversationSource, chat = source.chat()
    const draftKey = `${bootstrap.self.memberId}:${selected}:${tab}:${taskId}:native-composer`
    nativeIslands.register(container, nativeKey('composer'), source, (node, options) => win.FlyBotNativeConversation.mountNativeComposer(node, options), {
      chat, mentions, attachments, initialText: drafts.get(draftKey) ?? container.querySelector('textarea[name=text]')?.value ?? '',
      allowImages: tab === 'personal', initialImages: drafts.get(draftKey + ':images') ?? [],
      onImages: images => { if (source === conversationSource) drafts.set(draftKey + ':images', images) },
      onDraft: text => { if (source === conversationSource) drafts.set(draftKey, text) },
    })
  }
  function mountExecutionInput(container, worker) {
    const source = conversationSource, projectId = selected
    nativeIslands.register(container, nativeKey(`execution:${worker.id}:${worker.generation}:${worker.pending?.id ?? 'message'}`), conversationSource, (node, options) => win.FlyBotNativeConversation.mountNativeRuntimeInput(node, options), {
      worker, answer: args => {
        if (disposed || source !== conversationSource || selected !== projectId) return Promise.reject(new Error('Execution control is retired'))
        return scoped('project-execution-input', { workerId: worker.id, generation: worker.generation, ...args })
      },
    })
  }
  function agentsPanel() {
    const privateView = tab === 'private', visibility = privateView ? 'private' : 'public'
    const node = box(privateView ? 'My Project agent' : 'Public Chief', el('p', privateView ? 'Your conversation, notes and unpublished proposals are private to this Project and account.' : 'This conversation is shared with current Project members.'))
    const transcript = el('div', null, 'conversation'); transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', privateView ? 'Private conversation' : 'Chief conversation')
    if (tab !== 'settings') {
      node.classList.add('chat-panel')
      mountConversation(transcript, [{ id: privateView ? agents.mine?.botId : agents.public?.botId, role: privateView ? 'private' : 'chief', name: privateView ? 'Project companion' : 'Chief' }].filter(bot => bot.id))
      if (history?.busy) node.append(button('Stop reply', () => act(() => scoped('project-agent-stop', { visibility })), busy))
      if (!history?.messages?.length && !history?.live) transcript.append(el('p', privateView ? 'Your private Project companion. Ask a question or discuss your next step.' : 'Coordinate work with Chief. Ask about progress or discuss a requirement.', 'empty-state'))
      node.append(transcript)
      const composer = el('div', null, 'composer')
      composer.append(form('message', [['text', 'Message', 'textarea']], values => conversationSource.chat().send(values.text), history?.busy ? 'Agent busy' : 'Send'))
      node.append(composer)
      mountComposer(composer)
    } else { node.replaceChildren(el('h2', 'Project settings'), el('p', 'Role definitions, published memory and Chief inspection. Running Sessions retain their execution snapshots.')) }
    if (privateView) {
      node.append(el('p', `Agent mode: ${agents.delegation?.mode ?? 'safe'}. Safe mode requires approval before Task publication. Watch mode acts with your current Project permissions until revoked.`))
      node.append(form('agent-mode', [['mode', 'Agent mode', 'select', ['safe', 'watch'], agents.delegation?.mode ?? 'safe']], values => scoped('project-agent-mode', values), 'Set agent mode'))
      node.append(form('chief-question', [['text', 'Question for Chief', 'textarea']], values => scoped('project-chief-question', { ...values, requestId: win.crypto.randomUUID() }), 'Ask Chief without a Task'))
      node.append(box('Private notes', ...agents.privateMemory.map(note => el('p', note.text)), form('memory', [['text', 'Remember privately', 'textarea']], values => scoped('project-agent-memory-write', values))))
      for (const proposal of agents.proposals) node.append(box(proposal.taskId ? 'Published Task' : 'Unpublished proposal', el('p', proposal.taskId ? 'Published; execution requires a separate run request.' : 'Private proposal; it has not been published or assigned.'), el('h3', proposal.fields.title), el('p', proposal.fields.criteria), el('p', proposal.fields.note), button(proposal.taskId ? 'Published' : 'Publish as shared Task', () => act(() => scoped('project-agent-proposal-apply', { proposalId: proposal.id })), Boolean(proposal.taskId) || busy)))
    } else if (tab === 'settings') {
      const chief = resources.chief, settings = chief?.policy.inspection ?? chief?.template
      if (chief && settings) {
        const card = box('Chief arbitration and scheduled inspection', el('p', `Arbitration ${chief.policy.enabled ? 'enabled' : 'disabled'} · inspection ${chief.schedule?.status ?? 'not configured'}`))
        for (const run of chief.runs.slice(-3)) card.append(el('p', `${run.purpose}: ${run.status}${run.summary ? ' · ' + run.summary : run.failure ? ' · ' + run.failure : ''}`))
        if (detail.permissions.configure) {
          const timing = chief.schedule?.config.when ?? settings.when, limits = settings.thresholds
          card.append(form('chief-policy', [
            ['enabled', 'Chief arbitration', 'select', ['true', 'false'], String(Boolean(chief.policy.enabled))],
            ['inspectionEnabled', 'Scheduled inspection', 'select', ['true', 'false'], String(Boolean(settings.enabled))],
            ['minutes', 'Repeat minutes (blank keeps other timing)', 'optional', null, timing.kind === 'every' ? String(timing.seconds / 60) : ''],
            ['prompt', 'Inspection instructions', 'textarea', null, chief.schedule?.config.prompt ?? settings.prompt],
            ['handoffs', 'Handoffs without verified progress', 'number', null, String(limits.maxHandoffsWithoutProgress)],
            ['execution', 'Execution warning minutes', 'number', null, String(limits.longExecutionMs / 60000)],
            ['heartbeat', 'Heartbeat warning minutes', 'number', null, String(limits.missingHeartbeatMs / 60000)],
            ['wait', 'Waiting warning minutes', 'number', null, String(limits.longWaitMs / 60000)],
          ], values => scoped('project-chief-configure', { enabled: values.enabled === 'true', inspection: { enabled: values.inspectionEnabled === 'true', prompt: values.prompt, when: values.minutes.trim() ? { kind: 'every', seconds: Number(values.minutes) * 60 } : timing, thresholds: { maxHandoffsWithoutProgress: Number(values.handoffs), longExecutionMs: Number(values.execution) * 60000, missingHeartbeatMs: Number(values.heartbeat) * 60000, longWaitMs: Number(values.wait) * 60000 } } }), 'Save Chief configuration'))
          card.append(button('Inspect now', () => act(() => scoped('project-chief-inspect', { requestId: win.crypto.randomUUID() })), !chief.policy.enabled || busy))
        }
        node.append(card)
      }
      for (const role of agents.definitions.roles) {
        const card = box(role.role, el('p', `Model: ${role.model ?? 'Project default'} · revision ${role.revision ?? agents.definitions.revision}`), el('p', role.instructions))
        if (detail.permissions.configure) {
          card.append(el('p', 'Saving checks each selected resource with one bounded connection probe; a configured provider may charge for the small inference. Running Sessions retain their saved revision.'))
          const available = (resources.executionResources ?? []).map(row => row.id)
          card.append(form(`role-${role.role}`, [
            ['instructions', 'Instructions', 'textarea', null, role.instructions], ['model', 'Native model identifier', 'optional', null, role.model ?? ''],
            ['skills', 'Skills (comma separated)', 'optional', null, (role.skills ?? []).join(', ')], ['memoryRefs', 'Published role memory IDs', 'optional', null, (role.memoryRefs ?? []).join(', ')],
            ['harness', 'Execution Harness', 'text', ['flybot', 'codex', 'claude-agent'], role.execution?.harness ?? 'flybot'],
            ['sdkModel', 'SDK model identifier', 'optional', null, role.execution?.model ?? ''],
            ['resourceIds', 'Candidate execution resources', 'checkboxes', available, role.execution?.resourceIds ?? []],
            ['maxConcurrent', 'Concurrent Sessions for this role', 'number', null, role.execution?.maxConcurrent ?? 1],
          ], async values => {
            const split = text => text.split(',').map(value => value.trim()).filter(Boolean)
            await scoped('project-agent-definition', { role: role.role, instructions: values.instructions, model: values.model, skills: split(values.skills), memoryRefs: split(values.memoryRefs),
              execution: { harness: values.harness, model: values.sdkModel, resourceIds: values.resourceIds, maxConcurrent: Number(values.maxConcurrent) } })
            await Promise.allSettled(values.resourceIds.map(resourceId => scoped('project-runtime-check', { resourceId, harness: values.harness, role: role.role })))
          }))
          card.append(form(`role-memory-${role.role}`, [['text', 'Publish verified role memory', 'textarea'], ['reference', 'Source / evidence reference']], async values => {
            const saved = await scoped('project-role-memory-write', { role: role.role, text: values.text, source: { kind: 'human', reference: values.reference } })
            await scoped('project-agent-definition', { role: role.role, memoryRefs: [...(role.memoryRefs ?? []), saved.memory.id] })
          }, 'Publish and attach memory'))
        }
        node.append(card)
      }
      node.append(box('Shared knowledge', ...agents.knowledge.map(row => el('p', row.text)), form('share-summary', [['text', 'Publish a verified summary', 'textarea']], values => scoped('project-knowledge-write', { ...values, kind: 'fact' }), 'Share summary')))
    }
    if (tab === 'bots') {
      const roster = el('div', null, 'role-strip')
      for (const role of agents.definitions.roles) {
        const card = box(role.role, el('small', `${role.execution?.harness ?? 'flybot'} · ${role.execution?.model ?? role.model ?? 'Project default'}`))
        const inspection = el('details'); inspection.append(el('summary', `About ${role.role}`), el('h3', 'Persona'), el('p', role.instructions || 'No published persona'))
        inspection.append(el('h3', 'Attached public memory'))
        const attached = (agents.roleMemory ?? []).filter(row => (role.memoryRefs ?? []).includes(row.id) && row.role === role.role && row.projectId === selected)
        for (const memory of attached) inspection.append(box(`Revision ${memory.revision}`, el('p', memory.text), el('small', `Source: ${memory.source?.reference ?? 'Not recorded'}`)))
        if (!attached.length) inspection.append(el('p', 'No attached public memory'))
        card.append(inspection); roster.append(card)
      }
      node.prepend(roster)
    }
    return node
  }
  function resourcesPanel() {
    const node = box('Execution resources', el('p', `Concurrency ${resources.activeSlots}/${resources.quota.maxConcurrent}. Repository ${resources.repository.configured ? 'provisioned' : 'not provisioned by operator'}.`))
    if (resources.repository.reason) node.append(el('p', resources.repository.reason))
    if (detail.permissions.configure) node.append(form('quota', [['maxConcurrent', 'Concurrent Runs (1–32)', 'number']], values => scoped('project-quota', { maxConcurrent: Number(values.maxConcurrent) })))
    for (const resource of resources.executionResources ?? []) {
      const row = box(resource.id, el('p', `${resource.type} · slots ${resource.capacity.occupied}/${resource.capacity.configured} · environment ${resource.health.status}`))
      for (const status of resource.harnessStatus ?? []) {
        row.append(el('p', `${status.harness}: ${status.status}${status.sdkVersion ? ` · SDK ${status.sdkVersion}` : status.harness === 'flybot' ? '' : ' · SDK not detected'}${status.reason ? ` · ${status.reason}` : ''}${status.at ? ` · checked ${new Date(status.at).toLocaleTimeString()}` : ''}`))
        if (detail.permissions.configure) row.append(button(`Check ${status.harness} connection`, () => act(() => scoped('project-runtime-check', { resourceId: resource.id, harness: status.harness })), busy))
        if (resource.canManage && detail.permissions.configure) row.append(button(`Open ${status.harness} configuration terminal`, () => act(() => openTerminal(resource.id, status.harness)), busy))
      }
      node.append(row)
    }
    for (const worker of resources.harnessWorkers ?? []) {
      const row = box(`${worker.role} · ${worker.harness}`, el('p', `${worker.status} · ${worker.resourceId} · ${worker.sdkVersion ? 'SDK ' + worker.sdkVersion : 'SDK pending'} · ${worker.model ?? 'Model unavailable'}`))
      if (worker.pending?.kind === 'permission' && detail.permissions.configure) row.append(el('p', `Permission requested: ${worker.pending.request?.name ?? 'Runtime action'}`), el('p', worker.pending.request?.description ?? 'Review the scoped execution evidence before allowing this action.'), button('Allow requested action', () => act(() => scoped('project-execution-input', { workerId: worker.id, generation: worker.generation, requestId: worker.pending.id, allow: true })), busy), button('Deny requested action', () => act(() => scoped('project-execution-input', { workerId: worker.id, generation: worker.generation, requestId: worker.pending.id, allow: false })), busy))
      else if (worker.pending) row.append(el('p', worker.pending.text), form(`execution-${worker.id}`, [['text', 'Continue the same execution Session', 'textarea']], values => scoped('project-execution-input', { workerId: worker.id, generation: worker.generation, text: values.text })))
      if (worker.pending && (worker.pending.kind !== 'permission' || detail.permissions.configure)) {
        const controls = el('div');
        for (const child of [...row.children].slice(1)) controls.append(child)
        row.append(controls); mountExecutionInput(controls, worker)
      }
      node.append(row)
    }
    for (const entry of resources.queue) {
      const row = box(`Queued Task ${entry.taskId}`, el('p', `${entry.status} · ${entry.reason ?? ''}`))
      if (['waiting', 'blocked'].includes(entry.status) && (detail.permissions.configure || entry.memberId === bootstrap.self.memberId)) row.append(button('Cancel queue request', () => act(() => scoped('project-queue-cancel', { queueId: entry.id })), busy))
      node.append(row)
    }
    node.append(box('Workers and workspaces', ...(resources.workers ?? []).map(row => el('p', `${row.role ?? 'Worker'} · ${row.createdAt ? new Date(row.createdAt).toLocaleString() : 'Time unavailable'}`)), ...(resources.workspaces ?? []).map(row => el('p', `${row.role ?? row.kind ?? 'Workspace'} · ${row.status ?? 'registered'}`))), box('Shared host process', el('p', resources.host ? `RSS ${Math.round(resources.host.rssBytes / 1048576)} MiB · CPU ${resources.host.cpuPercent == null ? 'not sampled' : `${resources.host.cpuPercent.toFixed(1)}%`}` : 'Unavailable'), el('p', resources.host?.reason)), box('My platform instance', el('p', 'Account instance from control-plane; separate from the shared execution host.'), el('p', resources.platformInstance?.status ?? 'Unavailable')))
    return node
  }
  function render() {
    const terminalInputValue = doc.getElementById('runtime-terminal-input')?.value ?? ''
    if (disposed) return
    const active = doc.activeElement, focus = active?.id, start = active?.selectionStart, end = active?.selectionEnd
    nativeIslands.begin()
    const shell = el('div', null, 'shell'), sidebar = el('aside'), main = el('main')
    sidebar.append(el('h1', '✦ FlyBot'), el('small', 'SHARED PROJECT WORKSPACE'))
    if (!bootstrap) {
      main.append(box('Sign in', el('p', mode?.mode === 'platform' ? 'Use your existing control-plane account.' : 'Use an operator-issued member invitation.'), form('login', mode?.mode === 'platform' ? [['email', 'Email', 'email'], ['password', 'Password', 'password']] : [['token', 'Member invitation'], ['displayName', 'Display name']], async values => { const result = await api.call(mode?.mode === 'platform' ? 'platform-login' : 'auth-redeem', values); api.setToken(result.sessionToken); bootstrap = await api.call('workbench-state') }, 'Sign in')))
    } else {
      sidebar.append(el('p', bootstrap.self.displayName), button('Personal space', () => { win.location.hash = '/personal' }))
      if (bootstrap.demoMode) main.append(el('p', bootstrap.demoMode === 'deterministic-fixture' ? 'Demo: deterministic model fixture. Delivery requires real evidence; this is not real-model acceptance.' : 'Demo: configured real model provider. Inspect delivery evidence before acceptance.'))
      const picker = el('select'); picker.setAttribute('aria-label', 'Project'); picker.append(el('option', 'Choose Project'))
      for (const project of bootstrap.projects) { const option = el('option', project.name); option.value = project.id; option.selected = project.id === selected; picker.append(option) }
      picker.onchange = () => route(picker.value); sidebar.append(picker)
      const navigation = el('nav', null, 'project-nav'); navigation.setAttribute('aria-label', 'Project navigation')
      for (const [key, title] of [['board', 'Task board'], ['members', 'Members'], ['bots', 'Public Bots'], ['rooms', 'Rooms & mentions'], ['activity', 'Pools & Timeline'], ['resources', 'Resources'], ['private', 'My Project agent'], ['settings', 'Settings']]) {
        const item = button(title, () => route(selected, key), !selected)
        if (tab === key || key === 'board' && tab === 'tasks') item.setAttribute('aria-current', 'page')
        navigation.append(item)
      }
      sidebar.append(navigation)
      if (selected) {
        const roomNav = el('nav', null, 'room-nav'); roomNav.setAttribute('aria-label', 'Project rooms'); roomNav.append(el('small', 'PROJECT CONVERSATIONS'))
        for (const room of rooms?.rooms ?? []) roomNav.append(button(room.name, () => route(selected, 'rooms', room.id)))
        sidebar.append(roomNav)
      }
      sidebar.append(button('Connections', () => { win.location.hash = '/connections' }))
      sidebar.append(button('All Projects', () => { win.location.hash = '' }), button('Sign out', () => { void signOut() }))
      if (tab === 'connections') {
        main.append(el('h1', 'Connections'))
        const node = el('div', null, 'native-feishu-setup'); main.append(node)
        nativeIslands.register(node, nativeKey('feishu'), conversationSource, (target, options) => win.FlyBotNativeConversation.mountNativeFeishu(target, options), { actions: feishuActions, roster: { ...personal, self: bootstrap.self }, onClose: () => { win.location.hash = '/personal' } })
      } else if (tab === 'personal') {
        const chatList = el('div', null, 'native-personal-list'); sidebar.append(chatList); mountPersonalList(chatList)
        main.append(el('h1', 'Personal space'), el('p', 'Your original Chief, Bots and internal group conversations. Project agents remain separate.'))
        for (const bot of (personal?.bots ?? []).filter(bot => !bot.remote)) {
          const card = box(`${personal.mainBotIds.includes(bot.id) ? 'Chief · ' : ''}${bot.name}`, button('Open conversation', () => { win.location.hash = `/personal/${encodeURIComponent(bot.id)}` }))
          const persona = el('details'); persona.dataset.personaId = bot.id; persona.append(el('summary', 'Persona'), el('p', bot.instructions ?? 'No persona')); card.append(persona); card.append(button('Own long-term memory', () => act(async () => { const captured = epoch; const memory = await api.call('personal-space', { operation: 'memory', id: bot.id }); if (captured === epoch && !disposed) personalMemory = { botId: bot.id, ...memory } }))); main.append(card)
        }
        if (personalMemory) main.append(box('Own long-term memory', ...personalMemory.entries.map(entry => el('p', entry.text ?? entry.content ?? ''))))
        for (const room of personal?.rooms ?? []) main.append(button(room.name ?? 'Group conversation', () => { win.location.hash = `/personal/${encodeURIComponent(room.id)}` }))
        if (taskId && history) {
          const bot = personal?.bots.find(row => row.id === taskId)
          if (bot?.parts?.length > 1) {
            const parts = el('select'); parts.setAttribute('aria-label', 'Conversation part')
            for (const part of bot.parts) { const option = el('option', `Part ${part.number}`); option.value = part.sessionId; option.selected = (personalPart || bot.sessionId) === part.sessionId; parts.append(option) }
            parts.onchange = () => { win.location.hash = `/personal/${encodeURIComponent(taskId)}${parts.value === bot.sessionId ? '' : '/' + encodeURIComponent(parts.value)}` }; main.append(parts)
          }
          if (history.hasMore) main.append(button('Load earlier messages', () => act(async () => { await conversationSource.loadEarlier(); history = conversationSource.getSnapshot() })))
          const transcript = el('div'); main.append(box('Original conversation', transcript)); mountConversation(transcript, personal?.bots ?? [])
          if (!personalPart) {
            const composer = el('div', null, 'composer')
            composer.append(form('personal-message', [['text', 'Message', 'textarea']], values => conversationSource.chat().send(values.text), 'Send'))
            main.append(composer); mountComposer(composer, personal.rooms.find(room => room.id === taskId)?.members.map(id => personal.bots.find(bot => bot.id === id)).filter(Boolean) ?? personal.bots)
          }
        }
      } else if (!selected) {
        main.append(el('h1', 'Projects'), ...bootstrap.projects.map(project => box(project.name, el('p', `${project.role} · ${project.status}`), button('Open Project', () => route(project.id)))))
        main.append(box('New Project', form('project', [['name', 'Project name'], ['repository', 'Provisioned repository', 'text', ['', ...bootstrap.repositories]]], async values => { const result = await api.call('project-create', values); route(result.project.id) }, 'Create Project')), box('Join shared Project', form('join', [['token', 'Project invitation']], async values => { const result = await api.call('project-join', values); route(result.project.id) }, 'Join')))
      } else if (detail) {
        const heading = el('header', null, 'project-header'); heading.append(el('small', 'Projects / ' + ({ bots: 'Public Chief', private: 'My Project agent', rooms: 'Conversations', settings: 'Settings', tasks: 'Task detail' }[tab] ?? tab)), el('h1', detail.project.name), el('p', `${detail.project.role} · ${detail.project.status} · ${detail.project.repository ?? 'No repository'}`)); main.append(heading)
        main.append(taskDetail ? attemptsPanel() : tab === 'members' ? membersPanel() : ['bots', 'private', 'settings'].includes(tab) ? agentsPanel() : tab === 'resources' ? resourcesPanel() : tab === 'rooms' ? roomsPanel() : tab === 'activity' ? activityPanel() : boardPanel())
      } else {
        main.append(el('h1', bootstrap.projects.find(project => project.id === selected)?.name ?? 'Project'), el('p', error ? 'Project unavailable. Select another Project or refresh.' : 'Loading Project…'))
      }
    }
    if (mode?.panelUrl) sidebar.append(link('Control-plane account panel', mode.panelUrl, true))
    if (error) { const alert = el('p', error, 'error'); alert.setAttribute('role', 'alert'); main.prepend(alert) }
    if (notice) main.prepend(box('Result', el('pre', notice)))
    if (runtimeTerminal?.projectId === selected) {
      const terminal = runtimeTerminal
      const screen = el('pre', terminal.screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), 'terminal-screen')
      const pane = box(`${terminal.resourceId} · ${terminal.harness} private configuration`, el('p', terminal.instructions), screen)
      if (terminal.closed) pane.append(el('p', terminal.reason ?? 'Configuration terminal ended'))
      if (!terminal.closed) {
        const input = el('input'); input.id = 'runtime-terminal-input'; input.type = 'password'; input.value = terminalInputValue; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Private terminal input (not saved)')
        const send = () => { const text = input.value; input.value = ''; void api.call('project-terminal-input', { terminalId: terminal.terminalId, text: text + '\n' }).catch(() => closeTerminal()) }
        input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); send() } }
        pane.append(input, button('Send to terminal', send), button('Interrupt', () => api.call('project-terminal-input', { terminalId: terminal.terminalId, text: '\x03' })))
      }
      pane.append(button('Close and recheck configuration', () => act(closeTerminal))); main.append(pane)
    }
    shell.append(sidebar, main); nativeIslands.commit(shell)
    if (focus) { const target = doc.getElementById(focus); if (target) { target.focus(); if (typeof start === 'number' && target.setSelectionRange && !['number', 'email'].includes(target.type)) target.setSelectionRange(start, end) } }
  }
  async function start() {
    try { mode = await api.call('auth-mode'); try { bootstrap = await api.call('workbench-state') } catch { /* An expired or absent member session displays the sign-in form. */ } }
    catch (failure) { error = failure.message }
    if (disposed) return
    changeRoute(); timer = win.setInterval(() => { if (bootstrap && !busy && !doc.hidden) void refresh() }, pollMs)
  }
  win.addEventListener('hashchange', changeRoute)
  render(); void start()
  return { refresh, dispose() { clearConversation(); nativeIslands.dispose(); void closeTerminal(); disposed = true; ++epoch; controller?.abort(); win.clearInterval(timer); win.removeEventListener('hashchange', changeRoute); root.replaceChildren(); drafts.clear() } }
}
