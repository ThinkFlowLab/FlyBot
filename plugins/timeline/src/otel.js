// OpenTelemetry GenAI export (#TBD). The timeline trace already holds compact spans (turns,
// tool calls, deliveries) with ids, times and cleaned names only — never message text, tool
// arguments or output (src/recorder.js). This module maps those records to OTLP spans so a
// trace can be sent to any OTLP endpoint (Jaeger, Arize Phoenix, Langfuse, …), off by default.
//
// It is pure: `spansFrom` and `otlpPayload` take records and return plain objects; `createExporter`
// only owns a cursor (the newest record time it has sent) and calls the caller's send function.
// The feed carries no model name and no token counts, so those GenAI attributes are simply
// absent here rather than guessed.
import { createHash } from 'node:crypto'

const SCOPE_NAME = '@flybot/timeline'
const SCOPE_VERSION = '0.1.0'
const KIND_INTERNAL = 1
const KIND_SERVER = 2
const STATUS_OK = 1
const STATUS_ERROR = 2

// A deterministic, non-zero hex id of `bytes` bytes from a seed, so the same record maps to
// the same span across exports and a tool span can name a turn span that is not in its batch.
export function hexId(seed, bytes) {
  const hex = createHash('sha1').update(String(seed)).digest('hex').slice(0, bytes * 2)
  return hex === '0'.repeat(bytes * 2) ? `1${hex.slice(1)}` : hex
}

const nanos = ms => String(BigInt(Math.max(0, Math.round(ms))) * 1_000_000n)
const str = value => ({ stringValue: String(value) })
const int = value => ({ intValue: String(Math.round(value)) })
const bool = value => ({ boolValue: Boolean(value) })

const nameOf = (names, group, id) => (id && names?.[group]?.[id]) || undefined

const partyAttrs = (prefix, party) => {
  if (!party || typeof party !== 'object') return []
  const out = []
  if (typeof party.k === 'string') out.push({ key: `${prefix}.kind`, value: str(party.k) })
  if (party.id) out.push({ key: `${prefix}.id`, value: str(party.id) })
  return out
}

/**
 * Records -> OTLP span objects. Only CLOSED spans are built: a turn needs its `te` and a tool
 * call its `ke`. An open turn is never exported as a finished one — the exporter carries it
 * with `pendingRecords` until its end arrives. Deliveries are instant spans.
 */
export function spansFrom(records, { names = {} } = {}) {
  const starts = new Map()
  const ends = new Map()
  const toolStarts = new Map()
  const toolEnds = new Map()
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.r === 'ts') starts.set(record.id, record)
    else if (record.r === 'te') ends.set(record.id, record)
    else if (record.r === 'ks') toolStarts.set(record.id, record)
    else if (record.r === 'ke') toolEnds.set(record.id, record)
  }
  const spans = []
  for (const [id, te] of ends) {
    const ts = starts.get(id)
    if (!ts) continue
    const attrs = [
      { key: 'gen_ai.operation.name', value: str('invoke_agent') },
      { key: 'gen_ai.system', value: str('flybot') },
      ...(ts.bot ? [{ key: 'gen_ai.agent.id', value: str(ts.bot) }] : []),
      ...(nameOf(names, 'bots', ts.bot) ? [{ key: 'gen_ai.agent.name', value: str(nameOf(names, 'bots', ts.bot)) }] : []),
      { key: 'flybot.place', value: str(ts.pl) },
      ...(ts.room ? [{ key: 'flybot.room.id', value: str(ts.room) }] : []),
      ...(nameOf(names, 'rooms', ts.room) ? [{ key: 'flybot.room.name', value: str(nameOf(names, 'rooms', ts.room)) }] : []),
      ...(ts.ro ? [{ key: 'flybot.trigger.role', value: str(ts.ro) }] : []),
      ...(typeof te.o === 'string' ? [{ key: 'flybot.outcome', value: str(te.o) }] : []),
    ]
    spans.push({
      traceId: hexId(`turn:${id}`, 16),
      spanId: hexId(`turn-span:${id}`, 8),
      name: ts.bot && nameOf(names, 'bots', ts.bot) ? `invoke_agent ${nameOf(names, 'bots', ts.bot)}` : 'invoke_agent',
      kind: KIND_SERVER,
      startTimeUnixNano: nanos(ts.t),
      endTimeUnixNano: nanos(te.t),
      attributes: attrs,
      status: { code: te.o === 'error' || te.o === 'aborted' ? STATUS_ERROR : STATUS_OK, ...(te.ec ? { message: te.ec } : {}) },
    })
  }
  for (const [id, ke] of toolEnds) {
    const ks = toolStarts.get(id)
    if (!ks) continue
    spans.push({
      traceId: hexId(`turn:${ks.tid}`, 16),
      spanId: hexId(`tool-span:${ks.id}`, 8),
      parentSpanId: hexId(`turn-span:${ks.tid}`, 8),
      name: `execute_tool ${ks.nm}`,
      kind: KIND_INTERNAL,
      startTimeUnixNano: nanos(ks.t),
      endTimeUnixNano: nanos(ke.t),
      attributes: [
        { key: 'gen_ai.operation.name', value: str('execute_tool') },
        { key: 'gen_ai.tool.name', value: str(ks.nm) },
        ...(ks.bot ? [{ key: 'gen_ai.agent.id', value: str(ks.bot) }] : []),
        ...(ks.room ? [{ key: 'flybot.room.id', value: str(ks.room) }] : []),
        { key: 'flybot.tool.ok', value: bool(ke.ok === true) },
      ],
      status: { code: ke.ok === true ? STATUS_OK : STATUS_ERROR },
    })
  }
  for (const record of records.filter(item => item?.r === 'm')) {
    if (!Number.isFinite(record.t)) continue
    spans.push({
      traceId: hexId(`message:${record.id}`, 16),
      spanId: hexId(`message-span:${record.id}`, 8),
      name: 'flybot.message',
      kind: KIND_INTERNAL,
      startTimeUnixNano: nanos(record.t),
      endTimeUnixNano: nanos(record.t),
      attributes: [
        { key: 'flybot.message.role', value: str(record.ro) },
        ...(Number.isFinite(record.hop) ? [{ key: 'flybot.hop', value: int(record.hop) }] : []),
        ...(Number.isFinite(record.n) ? [{ key: 'flybot.text.length', value: int(record.n) }] : []),
        ...(record.room ? [{ key: 'flybot.room.id', value: str(record.room) }] : []),
        ...partyAttrs('flybot.source', record.f),
        ...partyAttrs('flybot.target', record.to),
      ],
      status: { code: STATUS_OK },
    })
  }
  return spans
}

/**
 * The records whose span is not closed yet (a `ts` with no `te`, a `ks` with no `ke`). The
 * exporter carries them to the next push so an open turn is held, never exported as finished.
 */
export function pendingRecords(records) {
  const openTurns = new Map()
  const openTools = new Map()
  for (const record of records) {
    if (record?.r === 'ts') openTurns.set(record.id, record)
    else if (record?.r === 'te') openTurns.delete(record.id)
    else if (record?.r === 'ks') openTools.set(record.id, record)
    else if (record?.r === 'ke') openTools.delete(record.id)
  }
  return [...openTurns.values(), ...openTools.values()]
}

/** One OTLP/HTTP JSON payload (resourceSpans) for a batch of spans. */
export function otlpPayload(spans, { serviceName = 'flybot', serviceVersion = SCOPE_VERSION } = {}) {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: str(serviceName) },
          { key: 'service.version', value: str(serviceVersion) },
        ],
      },
      scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans }],
    }],
  }
}

/**
 * A cursor exporter: `push(records, names)` sends every CLOSED span newer than the last one it
 * sent, through `send(payload, { count })` (which may be async). A turn or tool call still open
 * at a push is carried to the next one, so it is never exported as finished; a span already sent
 * is never sent twice. A send failure is reported through `warn` and the cursor stays put, so the
 * next push retries. `exportNames` off (the default) sends ids only, never Bot or room names.
 */
export function createExporter({ send, serviceName = 'flybot', serviceVersion = SCOPE_VERSION, warn = () => {}, minRecords = 1, exportNames = false } = {}) {
  let lastT = -1
  let carried = []
  const emitted = new Set()
  const remember = (spanId) => {
    emitted.add(spanId)
    if (emitted.size > 5000) emitted.delete(emitted.values().next().value)
  }
  return {
    async push(records, nameTables = {}) {
      const fresh = records.filter(record => record && Number.isFinite(record.t) && record.t > lastT)
      if (fresh.length < minRecords) return 0
      const batch = [...carried, ...fresh]
      const spans = spansFrom(batch, { names: exportNames ? nameTables : {} }).filter(span => !emitted.has(span.spanId))
      const nextCarried = pendingRecords(batch)
      const nextT = Math.max(lastT, ...fresh.map(record => record.t))
      if (spans.length === 0) { carried = nextCarried; lastT = nextT; return 0 }
      try {
        await send(otlpPayload(spans, { serviceName, serviceVersion }), { count: spans.length })
        for (const span of spans) remember(span.spanId)
        carried = nextCarried
        lastT = nextT
        return spans.length
      } catch (error) {
        warn('flybot-timeline: OTLP export failed: %s', error?.message ?? error)
        return 0
      }
    },
  }
}
