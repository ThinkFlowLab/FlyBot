// One-shot owner approvals. No execution is authorized by provider/model text.
// Kept separate from the settings layout so unrelated UI polish stays isolated.
export async function mountToolApprovals(document, fetcher = globalThis.fetch, schedule = globalThis.setInterval) {
  const keyCard = document.getElementById('composio-key-card')
  if (!keyCard || (globalThis.location && globalThis.location.pathname !== '/settings/connectors')) return
  const section = document.createElement('section')
  section.className = 'composio-key-card'
  const title = document.createElement('h2')
  title.className = 'composio-key-title'
  title.textContent = '智能体工具调用 · 逐次确认'
  const note = document.createElement('p')
  note.textContent = '下方每次确认只允许这一项工具和这些参数执行一次（读取也需要确认）。外部工具可能发送消息、修改或删除数据；仅在核实完整参数后允许。拒绝或超时不会自动重试。'
  const list = document.createElement('div')
  list.setAttribute('aria-live', 'polite')
  section.append(title, note, list)
  keyCard.after(section)
  let busy = false
  let previous = ''
  async function refresh() {
    if (busy || document.hidden) return
    busy = true
    try {
      const response = await fetcher('/v1/composio/approvals', {credentials: 'same-origin'})
      if (!response.ok) return
      const payload = await response.json()
      const pending = (payload.items || []).slice(0, 10)
      const raw = JSON.stringify(pending)
      if (raw === previous) return
      previous = raw
      list.replaceChildren()
      if (!pending.length) list.textContent = '暂无待确认调用。请在私人聊天中请求智能体使用你授权的应用；群聊、定时任务和对外 API 尚未接通个人工具。'
      for (const item of pending) {
        const row = document.createElement('div')
        const label = document.createElement('strong')
        label.textContent = item.name + ' · ' + item.status + ' · 任务 ' + item.task_id.slice(0, 8)
        const context = document.createElement('p')
        context.textContent = '请求：' + item.prompt + '\n连接：' + (item.account ? item.account.toolkit + ' / ' + item.account.account_id : '连接已移除')
        const args = document.createElement('pre')
        args.style.whiteSpace = 'pre-wrap'
        args.style.overflowWrap = 'anywhere'
        args.textContent = JSON.stringify(item.arguments, null, 2)
        const status = document.createElement('p')
        if (item.status === 'unknown' || item.status === 'executing') status.textContent = '执行结果不明；不要重试，请先到提供方核实。'
        const actions = item.status === 'pending' ? [['deny', '拒绝'], ['approve', '允许此调用一次']] : []
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
        list.append(row)
      }
    } catch { /* A polling failure grants nothing. */ }
    finally { busy = false }
  }
  await refresh()
  if (schedule) schedule(refresh, 2000)
  return {refresh}
}
if (globalThis.document) mountToolApprovals(globalThis.document)
