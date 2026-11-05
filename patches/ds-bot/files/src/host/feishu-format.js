export const MAX_IN = 20 * 1024 * 1024
export const MAX_IMAGE = 10 * 1024 * 1024
export const MAX_FILE = 30 * 1024 * 1024
export const MAX_POST = 30 * 1024
const asText = v => typeof v === 'string' ? v : ''

export function fromPost(post) {
  const localized = post?.content ? post : Object.values(post ?? {}).find(v => Array.isArray(v?.content))
  const lines = (localized?.content ?? []).map(line => line.map(node => {
    let text = asText(node.text)
    if (node.tag === 'a') text = `[${text}](${asText(node.href)})`
    if (node.tag === 'at') text = `@${asText(node.user_name) || asText(node.user_id)}`
    if (node.tag === 'code_block') return `\n\`\`\`${asText(node.language)}\n${text}\n\`\`\`\n`
    if (node.tag === 'hr') return '\n---\n'
    for (const [style, marker] of [['bold', '**'], ['italic', '*'], ['lineThrough', '~~']]) if (node.style?.includes(style)) text = `${marker}${text}${marker}`
    return text
  }).join(''))
  return [localized?.title, ...lines].filter(Boolean).join('\n')
}
export function readMessage(envelope) {
  if (envelope?.header?.event_type !== 'im.message.receive_v1') return null
  const m = envelope.event?.message, sender = envelope.event?.sender
  if (!m?.chat_id || !m.message_id || !sender?.sender_id?.open_id) return null
  let c
  try { c = JSON.parse(m.content) } catch { return null }
  let text = m.message_type === 'text' ? asText(c.text) : m.message_type === 'post' ? fromPost(c) : m.message_type === 'interactive' ? cardWords(c) : ''
  const files = []
  if (m.message_type === 'image' && c.image_key) files.push({ key: c.image_key, type: 'image', name: 'image.png' })
  if (['file', 'audio', 'media'].includes(m.message_type) && c.file_key) files.push({ key: c.file_key, type: 'file', name: c.file_name ?? `${m.message_type}.bin` })
  if (m.message_type === 'post') {
    const post = c.content ? c : Object.values(c).find(v => v?.content)
    for (const row of post?.content ?? []) for (const n of row) if (n.tag === 'img' && n.image_key) files.push({ key: n.image_key, type: 'image', name: 'image.png' })
  }
  if (!text && !files.length) return null
  text = text.replace(/@_user_\d+/g, key => { const person = (m.mentions ?? []).find(p => p.key === key); return person?.name ? `@${person.name}` : '' }).trim()
  return { id: envelope.header.event_id ?? m.message_id, messageId: m.message_id, chatId: m.chat_id, rootId: m.root_id || m.parent_id || null, openId: sender.sender_id.open_id, bot: sender.sender_type === 'app', group: m.chat_type === 'group', mentions: m.mentions ?? [], text, files }
}
export function markdown(text, mentions = new Map()) {
  let fence
  return String(text).split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) { const entering = !fence; if (entering) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return line }
    if (fence) return line
    return line.replace(/^#{1,3} /, h => h.length === 2 ? '#### ' : '##### ').split(/(`+[^`]*`+)/g).map((part, i) => {
      if (i % 2) return part
      let out = part.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '🖼 [$1]($2)')
        .replace(/<(?!\/?u>)([^>]+)>/g, (all, tag) => /^https?:\/\//.test(tag) ? all : `&lt;${tag}&gt;`)
        .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (all, label, url) => /^https?:\/\//.test(url) ? all : label)
      for (const [name, id] of [...mentions].sort(([a], [b]) => b.length - a.length)) out = out.split(`@${name}`).join(`<at user_id="${id}">${name.replace(/[<>]/g, '')}</at>`)
      return out
    }).join('')
  }).join('\n')
}
export function cardWords(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(cardWords).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  return Object.entries(value).filter(([k]) => ['text', 'content', 'title', 'elements', 'body', 'blocks', 'description'].includes(k)).map(([, v]) => cardWords(v)).filter(Boolean).join('\n')
}

export function validateCard(card) {
  if (!card || !Array.isArray(card.blocks) || card.blocks.length > 80 || JSON.stringify(card).length > 100000) throw new Error('Invalid card')
  const kinds = ['text', 'fields', 'list', 'progress', 'table', 'chart', 'pages', 'input', 'applet']
  const names = new Set(); let count = 0
  const visit = (blocks, depth = 0) => {
    if (!Array.isArray(blocks) || depth > 5) throw new Error('Invalid card pages')
    for (const b of blocks) {
      if (!b || !kinds.includes(b.type) || ++count > 80) throw new Error('Unknown or excessive card blocks')
      if (b.type === 'input') {
        if (typeof b.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(b.name) || names.has(b.name)) throw new Error('Card inputs need unique names')
        names.add(b.name)
      }
      if (b.type === 'pages') {
        if (!Array.isArray(b.pages) || b.pages.length > 20) throw new Error('Invalid card pages')
        for (const p of b.pages) visit(p.blocks, depth + 1)
      }
      if (b.type === 'table' && (!Array.isArray(b.columns) || !Array.isArray(b.rows))) throw new Error('Invalid card table')
      if (['list', 'fields'].includes(b.type) && !Array.isArray(b.items)) throw new Error('Invalid card items')
      if (b.type === 'chart' && (!b.spec || typeof b.spec !== 'object')) throw new Error('Invalid card chart')
    }
  }
  visit(card.blocks)
  if (!Array.isArray(card.actions ?? []) || (card.actions?.length ?? 0) > 12) throw new Error('Invalid card actions')
  const ids = (card.actions ?? []).map(a => a.id)
  if (ids.some(id => typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid card action ID')
  return structuredClone(card)
}
const plain = content => ({ tag: 'plain_text', content: String(content ?? '') })
const md = content => ({ tag: 'markdown', content: markdown(content) })
export function toCard(record) {
  const inputs = []
  const block = b => {
    if (b.type === 'input') { inputs.push({ tag: 'input', name: b.name, label: plain(b.label), placeholder: plain(b.placeholder) }); return [] }
    if (b.type === 'table') return [{ tag: 'table', page_size: Math.max(1, Math.min(10, b.rows?.length ?? 1)), columns: (b.columns ?? []).map((c, i) => ({ name: `c${i}`, display_name: c.label ?? c, data_type: 'text' })), rows: (b.rows ?? []).map(r => Object.fromEntries((b.columns ?? []).map((c, i) => [`c${i}`, String(Array.isArray(r) ? r[i] ?? '' : r[c.key] ?? '')]))) }]
    if (b.type === 'chart') return [{ tag: 'chart', chart_spec: b.spec, aspect_ratio: '16:9' }]
    if (b.type === 'pages') return (b.pages ?? []).flatMap(p => {
      const parts = (p.blocks ?? []).flatMap(block)
      return parts.some(e => e.tag === 'table') ? [md(`**${p.title}**`), ...parts] : [{ tag: 'collapsible_panel', header: { title: plain(p.title) }, elements: parts }]
    })
    if (b.type === 'fields') return [md((b.items ?? []).map(f => `**${f.label}**　${f.value}`).join('\n'))]
    if (b.type === 'list') return [md((b.items ?? []).map(f => `- ${typeof f === 'string' ? f : f.title}`).join('\n'))]
    if (b.type === 'progress') { const n = Math.round(Math.min(1, Math.max(0, Number(b.value) / (Number(b.max) || 100))) * 10); return [md(`${b.label ?? ''} ${'█'.repeat(n)}${'░'.repeat(10 - n)} ${n * 10}%`)] }
    if (b.type === 'applet') return [md(`${b.description ?? ''}\n请在 FlyBot 控制台中打开使用。`)]
    return [md(b.text ?? '')]
  }
  const elements = record.card.blocks.flatMap(block)
  const buttons = (record.card.actions ?? []).map(a => ({ tag: 'button', name: a.id, text: plain(a.label ?? a.id), type: 'primary', action_type: 'form_submit', disabled: record.closed === true, value: { flybot_card: record.id, action: a.id, version: record.version } }))
  if (inputs.length || buttons.length) elements.push({ tag: 'form', name: 'card_form', elements: [...inputs, ...buttons] })
  if (record.submissions?.length) elements.push(md(record.submissions.map(s => `${s.name}：${s.action}`).join('\n')))
  return { schema: '2.0', config: { update_multi: true }, header: { title: plain(record.card.title ?? 'FlyBot') }, body: { elements } }
}
