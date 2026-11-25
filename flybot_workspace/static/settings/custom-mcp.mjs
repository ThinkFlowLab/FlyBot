// No upstream URL/token in browser storage. Save clears the secret input.
export async function mountCustomMcp(document, fetcher = globalThis.fetch) {
  const form = document.getElementById('custom-mcp-form')
  const list = document.getElementById('custom-mcp-list')
  const note = document.getElementById('custom-mcp-status')
  if (!form || !list || !note) return
  const request = async (method, path, body) => {
    const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(document.cookie || '')
    const response = await fetcher(path, {method, credentials: 'same-origin', headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': match ? decodeURIComponent(match[1]) : '',
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)})})
    let data = {}; try { data = await response.json() } catch {}
    if (!response.ok) throw new Error(data.error?.message || '请求失败；请登录后重试。')
    return data
  }
  const refresh = async () => {
    const data = await request('GET', '/v1/mcp/servers')
    list.replaceChildren()
    for (const server of data.items || []) {
      const row = document.createElement('p')
      const title = document.createElement('span')
      title.textContent = server.name + ' · ' + server.origin + ' '
      const remove = document.createElement('button')
      remove.type = 'button'; remove.textContent = '断开连接'
      remove.addEventListener('click', async () => {
        remove.disabled = true
        try { await request('DELETE', '/v1/mcp/servers/' + server.id); await refresh(); note.textContent = '已断开；旧授权不再有效。' }
        catch (error) { note.textContent = error.message; remove.disabled = false }
      })
      row.append(title, remove); list.append(row)
    }
    if (!(data.items || []).length) list.textContent = '尚未添加自定义 MCP 服务器。'
  }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const input = name => form.elements.namedItem(name)
    const button = form.querySelector('button[type="submit"]')
    button.disabled = true
    const body = {name: input('name').value, url: input('url').value, bearer_token: input('bearer_token').value}
    input('bearer_token').value = ''
    try { await request('POST', '/v1/mcp/servers', body); form.reset(); await refresh(); note.textContent = '已保存；下一条私人聊天会加载到你的 DS-Bot。' }
    catch (error) { note.textContent = error.message }
    finally { body.bearer_token = ''; button.disabled = false }
  })
  try { await refresh() } catch { note.textContent = '登录后可管理自己的 MCP 服务器。' }
  return {refresh}
}
if (globalThis.document) mountCustomMcp(globalThis.document)
