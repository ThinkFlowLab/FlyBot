const enc = value => encodeURIComponent(String(value))
const rank = role => ['free_busy_reader', 'reader', 'writer', 'owner'].indexOf(role)

async function pages(api, path, query, key) {
  const result = []; let token
  do {
    const response = await api.call('GET', path, { query: { ...query, ...(token ? { page_token: token } : {}) } })
    result.push(...(response[key] ?? []))
    token = response.has_more ? response.page_token : undefined
  } while (token)
  return result
}

export function createFeishuCalendars(service) {
  const inFlight = new Set()
  const shares = () => service.data().calendarShares ??= {}
  const scopedApi = (appId, authorize) => ({ call: (method, path, options) => service.api(appId).call(method, path, { ...options, authorize }) })
  async function synchronize(record, authorize = () => service.authorizeTool(record.botId, record.appId, 'calendar', true)) {
    const key = `${record.appId}:${record.calendarId}:${record.chatId}`
    if (inFlight.has(key)) return { pending: true }
    inFlight.add(key)
    try {
      const api = scopedApi(record.appId, authorize), root = `calendar/v4/calendars/${enc(record.calendarId)}`
      const users = await pages(api, `im/v1/chats/${enc(record.chatId)}/members`, { member_id_type: 'open_id', page_size: 100 }, 'items')
      const existing = await pages(api, `${root}/acls`, { user_id_type: 'open_id', page_size: 50 }, 'acls')
      const failed = []
      for (const person of users) {
        const id = person.member_id
        if (!id || existing.some(a => a.scope?.user_id === id && rank(a.role) >= rank(record.role))) continue
        try {
          const created = await api.call('POST', `${root}/acls`, { query: { user_id_type: 'open_id' }, body: { role: record.role, scope: { type: 'user', user_id: id } } })
          await service.commit(() => { const current = shares()[key]; if (current) { current.added ??= {}; current.added[id] = { aclId: created.acl_id, role: record.role } } })
        } catch (error) { failed.push(id); await service.diagnose(record.appId, 'calendar-share', error) }
      }
      await service.commit(() => { if (shares()[key]) shares()[key].syncedAt = Date.now() })
      return { members: users.length, failed }
    } finally { inFlight.delete(key) }
  }
  async function share(appId, botId, args, authorize = () => service.authorizeTool(botId, appId, 'calendar', true)) {
    const calendarId = String(args.calendar_id ?? ''), chatId = String(args.chat_id ?? ''), role = args.role ?? 'reader'
    if (!calendarId || !chatId || rank(role) < 0) throw new Error('Choose a calendar, chat and valid calendar role')
    const key = `${appId}:${calendarId}:${chatId}`
    if (args.stop) {
      const record = shares()[key]
      if (!record) return { removed: 0 }
      const api = scopedApi(appId, authorize), existing = await pages(api, `calendar/v4/calendars/${enc(calendarId)}/acls`, { user_id_type: 'open_id', page_size: 50 }, 'acls')
      let removed = 0
      for (const [id, added] of Object.entries(record.added ?? {})) {
        const acl = existing.find(a => a.acl_id === added.aclId && a.scope?.user_id === id && a.role === added.role)
        if (!acl || Object.values(shares()).some(s => s !== record && s.appId === appId && s.calendarId === calendarId && s.added?.[id])) continue
        await api.call('DELETE', `calendar/v4/calendars/${enc(calendarId)}/acls/${enc(acl.acl_id)}`); removed++
      }
      await service.commit(() => { delete shares()[key] })
      return { removed }
    }
    await service.commit(() => { shares()[key] = { ...shares()[key], appId, botId, calendarId, chatId, role } })
    return synchronize(shares()[key], authorize)
  }
  async function follow(appId, chatId) {
    for (const record of Object.values(shares())) if (record.appId === appId && record.chatId === chatId && (record.syncedAt ?? 0) < Date.now() - 600000) {
      // Revoking the Bot's grant also stops automatic additions; membership messages never grant writes.
      try { service.authorizeTool(record.botId, appId, 'calendar', true); await synchronize(record) }
      catch (error) { await service.diagnose(appId, 'calendar-share', error) }
    }
  }
  async function link(appId, calendarId, authorize) {
    const api = scopedApi(appId, authorize), root = `calendar/v4/calendars/${enc(calendarId)}`
    const calendar = await api.call('GET', root)
    const events = await api.call('GET', `${root}/events`, { query: { page_size: 100 } })
    const id = (events.items ?? []).map(e => /[?&]calendarId=(\d+)/.exec(e.app_link ?? '')?.[1]).find(Boolean)
    if (!id) throw new Error('日历需要至少一个日程才能分享，请先创建日程。')
    return { name: calendar.calendar?.summary ?? calendar.summary ?? calendarId, permissions: calendar.calendar?.permissions ?? calendar.permissions, url: `https://applink.feishu.cn/client/calendar/detail?calendarId=${id}&source=calendar_share_by_owner` }
  }
  return { share, follow, link }
}
