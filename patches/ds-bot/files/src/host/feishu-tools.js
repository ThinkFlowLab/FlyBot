import { defineTool } from './tool-schema.js'
import { output } from './tools.js'
import { MAX_IMAGE, MAX_FILE } from './feishu-format.js'

const TOO_LARGE = 'Feishu accepts images up to 10 MB and files up to 30 MB; this attachment is too large to send'

const seg = (args, key) => {
  const value = args[key]
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) throw new Error(`Enter ${key}`)
  return encodeURIComponent(value)
}
// The operation list is the authority boundary; a model cannot supply a URL, method, token or host.
export const FEISHU_OPERATIONS = {
  calendar_share_group: ['calendar', 'POST', () => 'calendar/v4/calendars'],
  calendar_share_link: ['calendar', 'GET', () => 'calendar/v4/calendars'],
  calendar_share_card: ['calendar', 'POST', () => 'calendar/v4/calendars'],
  calendar_list: ['calendar', 'GET', () => 'calendar/v4/calendars'],
  calendar_get: ['calendar', 'GET', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}`],
  calendar_search: ['calendar', 'POST', () => 'calendar/v4/calendars/search', false],
  calendar_create: ['calendar', 'POST', () => 'calendar/v4/calendars'],
  calendar_update: ['calendar', 'PATCH', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}`],
  calendar_subscribe: ['calendar', 'POST', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/subscribe`],
  calendar_members: ['calendar', 'GET', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/acls`],
  calendar_member_add: ['calendar', 'POST', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/acls`],
  calendar_member_remove: ['calendar', 'DELETE', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/acls/${seg(a, 'acl_id')}`],
  calendar_events: ['calendar', 'GET', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/events`],
  calendar_event_get: ['calendar', 'GET', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/events/${seg(a, 'event_id')}`],
  calendar_event_create: ['calendar', 'POST', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/events`],
  calendar_event_update: ['calendar', 'PATCH', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/events/${seg(a, 'event_id')}`],
  calendar_event_delete: ['calendar', 'DELETE', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/events/${seg(a, 'event_id')}`],
  calendar_attendees: ['calendar', 'POST', a => `calendar/v4/calendars/${seg(a, 'calendar_id')}/events/${seg(a, 'event_id')}/attendees`],
  calendar_freebusy: ['calendar', 'POST', () => 'calendar/v4/freebusy/list', false],
  docs_read: ['docs', 'GET', a => `docx/v1/documents/${seg(a, 'document_id')}/raw_content`],
  docs_create: ['docs', 'POST', () => 'docx/v1/documents'],
  docs_append: ['docs', 'POST', a => `docx/v1/documents/${seg(a, 'document_id')}/blocks/${seg(a, 'document_id')}/children`],
  docs_folder: ['docs', 'GET', () => 'drive/v1/files'],
  docs_share: ['docs', 'POST', a => `drive/v1/permissions/${seg(a, 'document_id')}/members`],
  wiki_spaces: ['docs', 'GET', () => 'wiki/v2/spaces'],
  wiki_nodes: ['docs', 'GET', a => `wiki/v2/spaces/${seg(a, 'space_id')}/nodes`],
  wiki_node: ['docs', 'GET', () => 'wiki/v2/spaces/get_node'],
  bitable_tables: ['bitable', 'GET', a => `bitable/v1/apps/${seg(a, 'app_token')}/tables`],
  bitable_fields: ['bitable', 'GET', a => `bitable/v1/apps/${seg(a, 'app_token')}/tables/${seg(a, 'table_id')}/fields`],
  bitable_records: ['bitable', 'POST', a => `bitable/v1/apps/${seg(a, 'app_token')}/tables/${seg(a, 'table_id')}/records/search`, false],
  bitable_create: ['bitable', 'POST', a => `bitable/v1/apps/${seg(a, 'app_token')}/tables/${seg(a, 'table_id')}/records`],
  bitable_update: ['bitable', 'PUT', a => `bitable/v1/apps/${seg(a, 'app_token')}/tables/${seg(a, 'table_id')}/records/${seg(a, 'record_id')}`],
  sheets_read: ['sheets', 'GET', a => `sheets/v2/spreadsheets/${seg(a, 'spreadsheet_token')}/values/${seg(a, 'range')}`],
  sheets_write: ['sheets', 'PUT', a => `sheets/v2/spreadsheets/${seg(a, 'spreadsheet_token')}/values`],
  meeting_reserve: ['meeting', 'POST', () => 'vc/v1/reserves/apply'],
  task_create: ['task', 'POST', () => 'task/v2/tasks'],
}
export const operationWrites = op => op[3] ?? op[1] !== 'GET'
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 60000) throw new Error('Arguments must be a bounded object')
  return value
}

export function installFeishuTools(rt, service) {
  const decisions = new Map()
  const botOf = exec => {
    const bot = rt.whoseAgent?.(exec.agent)?.bot
    if (!bot || bot.remote || bot.ephemeral || bot.projectAgent) throw new Error('Feishu tools require a local Bot')
    return bot
  }
  const context = exec => rt.liveOf(exec.agent?.id ?? exec.agent?.session?.id)?.info?.feishu
  const requester = (appId, exec) => {
    const live = rt.liveOf(exec.agent?.id ?? exec.agent?.session?.id), source = live?.info?.feishu
    const linked = source && service.identity(source.appId, source.openId)
    if (source?.appId === appId) return linked
    const memberId = source ? linked?.memberId : live?.requesterMemberId
    if (!memberId) return undefined
    const matches = Object.values(service.data().identities).filter(i => i.appId === appId && i.memberId === memberId && service.identity(appId, i.openId))
    // Multiple linked accounts need an explicit Feishu request; never pick a default host.
    return matches.length === 1 ? matches[0] : undefined
  }
  const check = exec => {
    const op = FEISHU_OPERATIONS[exec.arguments?.operation]
    if (!op) throw new Error('Unknown Feishu operation')
    return service.authorizeTool(botOf(exec).id, exec.arguments.appId, op[0], operationWrites(op))
  }
  rt.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'feishu_tool') return next()
    try {
      const grant = check(exec), op = FEISHU_OPERATIONS[exec.arguments.operation]
      decisions.set(exec.callId, { grant, appId: exec.arguments.appId, operation: exec.arguments.operation })
      if (decisions.size > 1000) decisions.delete(decisions.keys().next().value)
      if (operationWrites(op) && grant === 'ask') return { kind: 'ask', reason: `Feishu ${exec.arguments.appId}: ${exec.arguments.operation}`, displayReason: { en: 'Allow this write to Feishu?', zh: '是否允许这次飞书写入？' } }
      return next()
    } catch (error) { return { kind: 'deny', reason: error.message } }
  })
  rt.ctx.tools.register(defineTool({ name: 'feishu_apps', description: 'List Feishu applications and capabilities explicitly granted to you, with linked member open_ids. Credentials remain on the platform.', parameters: {}, output,
    async execute(_args, exec) {
      const bot = botOf(exec)
      return JSON.stringify(Object.values(service.data().apps).filter(app => app.ownerId === (bot.ownerId ?? 'owner-1') && Object.values(service.data().grants[app.id]?.[bot.id] ?? {}).some(grant => grant !== 'disabled')).map(app => ({ appId: app.id, name: app.name, grants: service.data().grants[app.id]?.[bot.id] ?? {}, people: Object.values(service.data().identities).filter(i => i.appId === app.id).map(i => ({ openId: i.openId, name: rt.state.members?.[i.memberId]?.displayName })) })))
    } }))
  rt.ctx.tools.register(defineTool({ name: 'feishu_tool', description: `Use one explicitly granted Feishu app. Operations: ${Object.keys(FEISHU_OPERATIONS).join(', ')}. Parameters contain path IDs plus body and query matching the Feishu API. Examples: calendar_create body:{summary,permissions}; calendar_event_create calendar_id and body:{summary,start_time:{timestamp},end_time:{timestamp}}; calendar_member_add body:{role,scope:{type:"user",user_id}}; docs_create body:{title}; docs_append document_id and body:{children:[{block_type:2,text:{elements:[{text_run:{content:"text"}}]}}]}; bitable_create app_token,table_id and body:{fields:{fieldName:value}}; sheets_write spreadsheet_token and body:{valueRange:{range,values}}; meeting_reserve body:{end_time,meeting_settings:{topic}}; task_create body:{summary,due:{timestamp,is_all_day:false},members:[{id,type:"user",role:"assignee"}]},query:{user_id_type:"open_id"}. Calendar includes events, attendees, ACL members and freebusy; docs_append accepts document blocks; bitable accepts fields; sheets_write accepts valueRange; task_create accepts summary, due, members. meeting_reserve uses the actual linked requester as host. Permissions are per app/product; ask mode waits for human approval before any write.`,
    parameters: { appId: { type: 'string', required: true }, operation: { type: 'string', enum: Object.keys(FEISHU_OPERATIONS), required: true }, parameters: { type: 'json', required: true } }, output,
    async execute(args, exec) {
      check({ ...exec, arguments: args })
      const [product, method, path] = FEISHU_OPERATIONS[args.operation], params = object(args.parameters)
      const decision = decisions.get(exec.callId)
      const authorize = () => {
        const latest = service.authorizeTool(botOf(exec).id, args.appId, product, operationWrites(FEISHU_OPERATIONS[args.operation]))
        if (latest === 'ask' && operationWrites(FEISHU_OPERATIONS[args.operation]) && (decision?.grant !== 'ask' || decision.appId !== args.appId || decision.operation !== args.operation)) throw new Error('This write now requires human approval; retry the tool')
      }
      authorize()
      if (args.operation === 'calendar_share_group') return JSON.stringify(await service.calendars.share(args.appId, botOf(exec).id, params, authorize))
      if (args.operation === 'calendar_share_link' || args.operation === 'calendar_share_card') {
        const link = await service.calendars.link(args.appId, params.calendar_id, authorize)
        if (args.operation === 'calendar_share_card') {
          const source = context(exec)
          const chatId = params.chat_id ?? (source?.appId === args.appId ? source.chatId : undefined)
          if (!chatId) throw new Error('Choose a Feishu chat')
          await service.send(args.appId, { chatId, rootId: params.chat_id ? null : source?.rootId }, 'interactive', { schema: '2.0', header: { title: { tag: 'plain_text', content: link.name } }, body: { elements: [{ tag: 'markdown', content: String(link.permissions ?? '') }, { tag: 'button', text: { tag: 'plain_text', content: '在日历中查看' }, type: 'primary', multi_url: { url: link.url } }] } }, exec.callId, authorize)
        }
        return JSON.stringify(link)
      }
      let body = params.body === undefined ? undefined : structuredClone(object(params.body))
      const query = params.query === undefined ? {} : { ...object(params.query) }
      if (args.operation === 'meeting_reserve') {
        const linked = requester(args.appId, exec)
        if (!linked) throw new Error('提问的人没有关联这家公司的飞书账号，不能预约会议。')
        body = { ...body, owner_id: linked.openId }
        query.user_id_type = 'open_id'
      }
      // Recheck after asynchronous approvals and before the platform uses its credentials.
      service.authorizeTool(botOf(exec).id, args.appId, product, operationWrites(FEISHU_OPERATIONS[args.operation]))
      try {
        const result = await service.api(args.appId).call(method, path(params), { body, query, authorize })
        if (args.operation === 'docs_create' && result.document?.document_id) {
          const linked = requester(args.appId, exec)
          if (linked) try { await service.api(args.appId).call('POST', `drive/v1/permissions/${encodeURIComponent(result.document.document_id)}/members`, { authorize, query: { type: 'docx', need_notification: true }, body: { member_type: 'openid', member_id: linked.openId, perm: 'edit' } }) } catch (error) { await service.diagnose(args.appId, 'document-share', error); result.sharing = 'Document created, but sharing failed; check connection diagnostics' }
        }
        return JSON.stringify(result)
      } catch (error) {
        await service.diagnose(args.appId, 'tool', error)
        throw new Error(`${error.message}。请检查应用权限是否开通并发布，文档、表格或知识库是否已把应用添加为成员。`)
      }
    } }))
  rt.ctx.tools.register(defineTool({ name: 'feishu_card', description: 'Send or update a persistent Feishu card in the current request conversation. card has title, blocks and actions [{id,label}], optional once:false. Blocks: text{text}, fields{items:[{label,value}]}, list{items}, progress{value,max,label}, table{columns:[{key,label}],rows}, chart{spec}, pages{pages:[{title,blocks}]}, input{name,label,placeholder}, applet{description}. Inputs/buttons form the final form. Submissions return to this Bot; they never approve tools. Pass cardId to update your own original card.',
    parameters: { card: { type: 'json', required: true }, cardId: { type: 'string' } }, output,
    async execute(args, exec) {
      const stored = args.cardId ? service.data().cards[args.cardId] : undefined
      const source = context(exec) ?? (stored ? { appId: stored.appId, ...stored.message } : undefined)
      if (!source) throw new Error('Send cards while answering a Feishu request')
      return JSON.stringify(await service.card(source.appId, botOf(exec).id, { chatId: source.chatId, rootId: source.rootId }, args.card, args.cardId))
    } }))
  rt.ctx.tools.register(defineTool({ name: 'feishu_file', description: 'Send an attachment already present in this Session to the current Feishu request. Images up to 10 MB, files up to 30 MB; a larger attachment cannot be sent. No host paths or arbitrary URLs are accepted.',
    parameters: { attachmentId: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      const bot = botOf(exec), source = context(exec)
      if (!source) throw new Error('Send files while answering a Feishu request')
      service.appOf(source.appId)
      if ((bot.ownerId ?? 'owner-1') !== service.appOf(source.appId).ownerId) throw new Error('Wrong Feishu app owner')
      let ref
      const session = exec.agent?.session
      for (const seq of session?.surface?.nodes ?? []) {
        const event = session.eventAt(seq)
        for (const b of event?.data?.message?.content ?? event?.data?.content ?? []) if ((b.attachment?.attachmentId ?? b.attachment?.id) === args.attachmentId) ref = b.attachment
        for (const file of (event?.data?.source ?? event?.data?.message?.source)?.attachments ?? []) if (file.id === args.attachmentId) ref = file
      }
      if (!ref) throw new Error('Attachment is not present in this Session')
      const image = (ref.mediaType ?? ref.mime)?.startsWith('image/') && (ref.bytes ?? ref.size) <= MAX_IMAGE
      // A `mediaType` marks an image attachment, readable only as an image: past 10 MB it cannot go out as a file either.
      if ((ref.bytes ?? ref.size) > MAX_FILE || !image && ref.mediaType) throw new Error(TOO_LARGE)
      const chunks = []
      if (image) chunks.push((await rt.ctx.attachments.readImage(ref, exec.signal)).data)
      else for await (const chunk of rt.ctx.attachments.readFileStream(ref, exec.signal)) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      if (bytes.length > (image ? MAX_IMAGE : MAX_FILE)) throw new Error(TOO_LARGE)
      const form = new FormData()
      form.set(image ? 'image_type' : 'file_type', image ? 'message' : 'stream')
      if (!image) form.set('file_name', ref.name ?? 'attachment')
      form.set(image ? 'image' : 'file', new Blob([bytes]), ref.name ?? 'attachment')
      try {
        const result = await service.api(source.appId).call('POST', image ? 'im/v1/images' : 'im/v1/files', { body: form })
        await service.send(source.appId, source, image ? 'image' : 'file', image ? { image_key: result.image_key } : { file_key: result.file_key }, exec.callId)
        return 'Sent'
      } catch (error) { await service.diagnose(source.appId, 'attachment-send', error); throw new Error('Feishu did not accept the attachment; the connection diagnostics have the details') }
    } }))
}
