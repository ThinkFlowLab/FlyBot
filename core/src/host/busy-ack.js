// Busy-ack (#1584): a human message that lands while a Bot turn is already running
// gets a short spoken acknowledgment on the live payload immediately. Steer admits
// to next-step, but a blocking job wait may never yield a step (#1509), so without
// this the chat stays silent until the wait ends.
//
// The line is composed here, deterministically, from the message itself and what the
// turn is doing right now (its running tool), not a fixed sentence (#1629). A model
// call would wait behind the very turn that is busy, cost a call per message and need
// a fallback anyway; a template is instant, free and cannot fail. Wording rotates and
// never repeats the previous ack of the same chat; the language follows the message.
export const COALESCE_MS = 3_000
export const TOPIC_MAX = { zh: 16, en: 36 }

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g

/** 'zh' when the message is mostly Chinese, 'en' when mostly Latin, else the UI language. */
export function ackLanguage(text, uiLanguage) {
  const value = String(text ?? '')
  const cjk = (value.match(CJK) ?? []).length
  const latin = (value.match(/[A-Za-z]/g) ?? []).length
  if (cjk > 0 && cjk * 2 >= latin) return 'zh'
  if (latin > 0) return 'en'
  return /chinese|简体|\bzh\b/i.test(String(uiLanguage ?? '')) ? 'zh' : 'en'
}

/** A short topic out of the message: first line, trimmed, clipped; '' when too thin to echo. */
export function topicOf(text, lang) {
  const line = String(text ?? '').split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? ''
  const clean = line.replace(/\s+/g, ' ').replace(/^[@#]\S+\s*/, '').replace(/[。！？!?.,，、~～…]+$/u, '').trim()
  if (clean === '' || /^(hi|hello|hey|ok|okay|嗯+|好的?|在吗|在不在|\?+|？+)$/i.test(clean)) return ''
  const max = TOPIC_MAX[lang] ?? TOPIC_MAX.en
  const chars = [...clean]
  if (chars.length <= max) return clean
  let cut = chars.slice(0, max - 1).join('')
  if (lang === 'en' && cut.lastIndexOf(' ') > max / 2) cut = cut.slice(0, cut.lastIndexOf(' '))
  return `${cut.trimEnd()}…`
}

const TOOL_WORDS = [
  [/^(bash|shell|exec|run|command|terminal)$/i, { zh: '跑命令', en: 'running a command' }],
  [/^(wait|job|poll|await)$/i, { zh: '等一个任务跑完', en: 'waiting on a job' }],
  [/^(search|grep|glob|find)$/i, { zh: '查资料', en: 'searching' }],
  [/^(fetch|browse|browser|web|http|url)$/i, { zh: '看网页', en: 'reading a page' }],
  [/^(write|edit|patch|apply)$/i, { zh: '改文件', en: 'editing files' }],
  [/^(read|cat|open|view|ls)$/i, { zh: '翻文件', en: 'reading files' }],
  [/^(message|delegate|subagent|agent)$/i, { zh: '和别的 Bot 对接', en: 'checking with another Bot' }],
  [/^(task|todo|plan)$/i, { zh: '整理任务', en: 'sorting out tasks' }],
]

/** What the running tool is, in a few words; undefined with no tool. */
export function doingOf(tool, lang) {
  if (typeof tool !== 'string' || tool.trim() === '' || tool === 'ask_user') return undefined
  // Match whole name parts (`web_fetch` → web, fetch) so `frobnicate` is not "cat".
  const parts = tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const hit = TOOL_WORDS.find(([pattern]) => parts.some(part => pattern.test(part)) )
  if (hit) return hit[1][lang]
  return lang === 'zh' ? `用 ${tool}` : `using ${tool}`
}

const TEMPLATES = {
  zh: {
    topicDoing: [
      '看到你说「{t}」了，我正在{d}，弄完马上接上。',
      '「{t}」收到，手上在{d}，这步完了就来。',
      '记下「{t}」了，{d}这边一结束就处理。',
    ],
    topic: [
      '看到「{t}」了，当前这步一完就回你。',
      '「{t}」记下了，马上接着处理。',
      '好，「{t}」这个我排上了，稍等一下。',
    ],
    doing: [
      '看到了，我正在{d}，弄完就回你。',
      '收到新消息，手上在{d}，稍等片刻。',
      '嗯，{d}这边一结束就回来。',
    ],
    bare: [
      '看到了，这步做完就回你。',
      '新消息收到，稍等我一下。',
      '好的，马上接上你这条。',
    ],
  },
  en: {
    topicDoing: [
      'Saw "{t}" — I’m {d} right now, back on it in a moment.',
      'Noted "{t}" — still {d}, then it’s next.',
      'Got "{t}" — I’ll get to it once I’m done {d}.',
    ],
    topic: [
      'Saw "{t}" — I’ll pick it up right after this step.',
      'Noted "{t}", coming to it shortly.',
      '"{t}" is next on my list — one moment.',
    ],
    doing: [
      'Seen — I’m {d}, back to you shortly.',
      'New message noted; still {d}, one moment.',
      'On it as soon as I’m done {d}.',
    ],
    bare: [
      'Seen — back to you right after this step.',
      'Noted, one moment.',
      'Picking this up as soon as the current step ends.',
    ],
  },
}

/**
 * One short ack line for `message` while the turn is doing `tool`. `seed` picks the
 * variant; `previous` is never returned again (the next variant is taken instead).
 */
export function composeBusyAck({ message, tool, uiLanguage, seed = 0, previous } = {}) {
  const lang = ackLanguage(message, uiLanguage)
  const topic = topicOf(message, lang)
  const doing = doingOf(tool, lang)
  const kind = topic && doing ? 'topicDoing' : topic ? 'topic' : doing ? 'doing' : 'bare'
  const pool = TEMPLATES[lang][kind]
  // One pass only: the topic is the person's own text, so a `{t}`/`{d}` they typed
  // must not be rescanned as template markup after it is inserted (#1634).
  const fill = index => pool[index % pool.length].replace(/\{(t|d)\}/g, (_, key) => (key === 't' ? topic : (doing ?? '')))
  const start = Math.abs(Math.trunc(seed)) % pool.length
  for (let step = 0; step < pool.length; step += 1) {
    const text = fill(start + step)
    if (text !== previous) return text
  }
  return fill(start)
}

export function shouldNoteBusyAck({ sourceKind, turnRunning, ownChat }) {
  return sourceKind === 'user' && turnRunning === true && ownChat === true
}

// A person's line reaching a member's group Session (#1646). A round relays it as
// `role: 'room'` with no Bot sender: a Bot's own call carries `senderSessionId`, an
// @-mention by another Bot carries `askedBy`, and a friend's Bot carries `remote`.
export function isHumanRoomLine(source) {
  return source?.role === 'room'
    && source.senderSessionId === undefined
    && source.askedBy === undefined
    && source.remote === undefined
}

// The relay prefix delivery.js puts on the line; the ack quotes the person's text, not it.
const relayHeader = /^\[[^\]\n]*\]\r?\n/

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { text: string, at: number }>} */
  const acks = new Map()
  /** Last ack text per chat, kept across clears so consecutive acks differ. */
  const lastText = new Map()
  let counter = 0

  const turnRunning = sessionId => rt.live?.get(sessionId)?.turn !== undefined
  const ownChat = sessionId => rt.chatOwners?.has(sessionId) === true
  const groupSession = sessionId => rt.groupOwners?.has(sessionId) === true
  /** A person's line into this member's running group Session (#1646), once only. */
  const roomLine = (sessionId, source) => groupSession(sessionId) && isHumanRoomLine(source)

  const note = (sessionId, message) => {
    const now = Date.now()
    const existing = acks.get(sessionId)
    if (existing && now - existing.at < COALESCE_MS) {
      existing.at = now
      return existing
    }
    counter += 1
    const text = composeBusyAck({
      message,
      tool: rt.live?.get(sessionId)?.tool,
      uiLanguage: rt.uiLanguage?.(),
      seed: counter + now,
      previous: lastText.get(sessionId),
    })
    lastText.set(sessionId, text)
    const entry = { text, at: now }
    acks.set(sessionId, entry)
    return entry
  }

  const clear = (sessionId) => { acks.delete(sessionId) }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || event?.type === undefined) return
    if (event.type === 'user/message') {
      const source = event.data?.source
      const room = roomLine(id, source)
      const own = shouldNoteBusyAck({ sourceKind: source?.kind, turnRunning: turnRunning(id), ownChat: ownChat(id) })
      if (!own && !(room && turnRunning(id))) return
      const text = textOf(event.data?.content ?? event.data?.message?.content)
      note(id, room ? text.replace(relayHeader, '') : text)
      return
    }
    if (event.type === 'assistant/message') {
      if (textOf(event.data?.message?.content).trim() !== '') clear(id)
      return
    }
    if (event.type === 'turn/end') clear(id)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const id = agent?.session?.id ?? agent?.id
    if (typeof id === 'string') clear(id)
  })

  Object.assign(rt, {
    busyAcksView: () => Object.fromEntries([...acks].map(([id, ack]) => [id, { text: ack.text, at: ack.at }])),
    // A room draws the ack on its running member's row (#1646), so its flow is keyed by
    // member, not by the Session a person cannot see. A member whose turn runs before its
    // line is composed is published with an empty text: the client draws the same blinking
    // indicator an own-chat pending ack draws (#1656), never a fixed sentence.
    roomBusyAcksView: sessions => Object.fromEntries(Object.entries(sessions ?? {}).flatMap(([botId, sessionId]) => {
      if (!turnRunning(sessionId)) return []
      const ack = acks.get(sessionId)
      return [[botId, ack === undefined ? { text: '', at: 0 } : { text: ack.text, at: ack.at }]]
    })),
    noteBusyAck: note,
    clearBusyAck: clear,
  })
}
