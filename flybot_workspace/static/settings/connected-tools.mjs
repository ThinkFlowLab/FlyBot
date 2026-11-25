// Activity and one-time decisions for the current account's connected tools.
const APPROVAL_STATUS = {
  pending: '待确认', approved: '已允许', executing: '执行中', succeeded: '已完成',
  denied: '已拒绝', failed: '执行失败', expired: '已过期', unknown: '结果未确认',
}
const AUTOMATIC_MODES = new Map([['automatic', '自动执行'], ['automatic_read', '自动只读']])

export async function mountToolApprovals(document, fetcher = globalThis.fetch, schedule = globalThis.setInterval) {
  const keyCard = document.getElementById('composio-key-card')
  if (!keyCard || (globalThis.location && globalThis.location.pathname !== '/settings/connectors')) return
  const section = document.createElement('section')
  section.id = 'connected-tool-approvals'
  section.className = 'composio-key-card'
  const title = document.createElement('h2')
  title.className = 'composio-key-title'
  title.textContent = '应用工具调用'
  const note = document.createElement('p')
  note.textContent = '在支持 GitHub 工具的对话中，账号已授权的 GitHub 读取和写入操作会自动执行。其他应用的工具调用需逐次确认，每次只允许所示工具和参数执行一次。'
  const list = document.createElement('div')
  list.setAttribute('aria-live', 'polite')
  section.append(title, note, list)
  keyCard.after(section)
  if (globalThis.location?.hash === '#connected-tool-approvals') section.scrollIntoView?.({block: 'start'})
  let busy = false
  let previous = ''
  async function refresh() {
    if (busy || document.hidden) return
    busy = true
    try {
      const response = await fetcher('/v1/composio/approvals', {credentials: 'same-origin'})
      if (!response.ok) return
      const payload = await response.json()
      const calls = (payload.items || []).slice(0, 10)
      const raw = JSON.stringify(calls)
      if (raw === previous) return
      const rows = calls.map(item => {
        const row = document.createElement('div')
        const label = document.createElement('strong')
        const task = typeof item.task_id === 'string' && item.task_id ? ' · 任务 ' + item.task_id.slice(0, 8) : ''
        const automatic = AUTOMATIC_MODES.get(item.approval_mode)
        const mode = automatic ? ' · ' + automatic : ''
        const state = automatic && ['pending', 'approved'].includes(item.status) ? '待执行' : APPROVAL_STATUS[item.status]
        label.textContent = item.name + mode + ' · ' + (state ?? '状态未知') + task
        const context = document.createElement('p')
        const prompt = item.prompt ? '请求：' + item.prompt + '\n' : ''
        context.textContent = prompt + '连接：' + (item.account ? item.account.toolkit + ' / ' + item.account.account_id : '连接已移除')
        const args = document.createElement('pre')
        args.style.whiteSpace = 'pre-wrap'
        args.style.overflowWrap = 'anywhere'
        args.textContent = JSON.stringify(item.arguments, null, 2)
        const status = document.createElement('p')
        if (item.status === 'unknown') status.textContent = '请先到应用核实执行结果。'
        const actions = !automatic && item.status === 'pending' ? [['deny', '拒绝'], ['approve', '允许此调用一次']] : []
        for (const [decision, text] of actions) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = text
          button.addEventListener('click', async () => {
            for (const b of row.querySelectorAll('button')) b.disabled = true
            try {
              const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(document.cookie || '')
              const result = await fetcher('/v1/composio/approvals/' + item.id, {
                method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json',
                  'X-CSRF-Token': match ? decodeURIComponent(match[1]) : ''}, body: JSON.stringify({decision}),
              })
              status.textContent = result.ok ? (decision === 'approve' ? '已批准一次；智能体仍会检查连接和任务是否有效。' : '已拒绝。') : '请求未被接受，可能已过期。'
            } catch { status.textContent = '网络错误，未重试。请刷新核实状态。' }
          })
          row.append(button)
        }
        row.prepend(label, context, args)
        row.append(status)
        return row
      })
      list.replaceChildren(...rows)
      if (!rows.length) list.textContent = '暂无工具调用记录。'
      previous = raw
    } catch { /* A polling failure grants nothing. */ }
    finally { busy = false }
  }
  await refresh()
  if (schedule) schedule(refresh, 2000)
  return {refresh}
}
if (globalThis.document) mountToolApprovals(globalThis.document)
