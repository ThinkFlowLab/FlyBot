// Images for text-only models. Every model may take images; before a Session request
// reaches a model that cannot read them, each image becomes text from a vision model.
// Texts are kept per attachment, so later requests repeat the same words and the
// prompt cache still hits.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { OCR_CACHE_MAX, OCR_PROMPT, OCR_RETRY_MS, OCR_TIMEOUT_MS } from './constants.js'
import { splitRef } from './text.js'

export function offloadTargets(session, beforeSeq) {
  const targets = []
  for (const seq of session.surface.nodes) {
    if (seq >= beforeSeq) continue
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    const imageIndexes = []
    let imageIndex = 0
    for (const block of message?.content ?? []) {
      if (block?.type !== 'image') continue
      if (block.offloaded !== true) imageIndexes.push(imageIndex)
      imageIndex += 1
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  return targets
}

const IMAGE_ID = /^sha256:([0-9a-f]{64})$/

// Where one chat image is stored: <home>/attachments/v1/objects/<first two>/<sha256>, the layout the
// local attachment store writes (#779). Only a content-addressed image id can be turned into it.
export function attachmentObjectPath(home, attachmentId) {
  const match = IMAGE_ID.exec(String(attachmentId ?? ''))
  return match === null ? undefined : join(home, 'attachments', 'v1', 'objects', match[1].slice(0, 2), match[1])
}

/**
 * The path a Bot's own file tools can open for one image, or undefined. The attachment store's host
 * path goes through the file sandbox's mapping (what `dsh-spill-policy` does for spooled tool output),
 * because a host path the execution world cannot read is worse than no path at all; the local object
 * layout above is the fallback when the store or the mapping is not there. Either way the file must
 * exist: a placeholder that names a missing file sends a Bot after nothing.
 */
export async function attachmentFilePath(attachment, { home, attachments, fs } = {}) {
  const readable = async path => {
    if (typeof path !== 'string' || path === '') return undefined
    try { return (await stat(path)).isFile() ? path : undefined } catch { return undefined }
  }
  const hostPath = attachments?.imageHostPath?.(attachment)
  if (hostPath !== undefined) {
    const mapped = fs?.processPathFromHostPath?.(hostPath)
    const viaStore = await readable(mapped)
    if (viaStore !== undefined) return viaStore
  }
  return readable(attachmentObjectPath(home, attachment?.attachmentId))
}

const imageLabel = attachment => (attachment?.name
  ? `"${attachment.name}"`
  : `sha256:${String(attachment?.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)}`)

const imageFacts = attachment => {
  const facts = []
  if (typeof attachment?.mediaType === 'string') facts.push(attachment.mediaType)
  if (Number.isFinite(attachment?.width) && Number.isFinite(attachment?.height)) facts.push(`${attachment.width}x${attachment.height}`)
  if (Number.isFinite(attachment?.bytes)) facts.push(`${attachment.bytes} bytes`)
  return facts.length === 0 ? '' : ` (${facts.join(', ')})`
}

// One placeholder for both places an unread image becomes text: a Bot chat (`imageAsText`) and the
// group relay (`imagesForGroup`). It names the bytes only when `path` is a file this Bot can open.
export function imagePlaceholder(attachment, { path, group = false } = {}) {
  const where = path === undefined ? '' : ` The file is at "${path}"; your own file tools can open it.`
  const cannot = group ? '' : 'you cannot see images and '
  return `[Image ${imageLabel(attachment)}${imageFacts(attachment)}: ${cannot}it could not be read right now.${where} Ask the user what it shows if it matters.]`
}

export function install(rt) {
  const { ctx, config, home } = rt

  // `textOnlyModels` names models whose provider claims image input but rejects it.
  const textOnlyModels = new Set(config.textOnlyModels ?? [])
  const ocrPath = join(home, 'ocr.json')
  let ocrCache = null
  let ocrWriting = Promise.resolve()
  const ocrPending = new Map()
  const ocrFailed = new Map()

  const liveImages = message => Array.isArray(message?.content)
    && message.content.some(block => block?.type === 'image' && !block.offloaded)

  async function readsImages(provider, model) {
    if (textOnlyModels.has(`${provider}/${model}`)) return false
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      return info.inputModalities === undefined || info.inputModalities.includes('image')
    } catch {
      return true
    }
  }

  // The configured `ocrModel` first, then served models that declare image input, the
  // DSH default among them first.
  async function ocrRoute() {
    const models = await rt.catalog()
    const served = new Set(models.map(entry => entry.ref))
    const declared = models.filter(entry => entry.input?.includes('image')).map(entry => entry.ref)
    const fallback = rt.defaultRef()
    for (const ref of new Set([config.ocrModel, ...declared.filter(ref => ref === fallback), ...declared])) {
      const route = splitRef(ref)
      if (route && served.has(ref) && await readsImages(route.provider, route.model)) return { ref, ...route }
    }
    return undefined
  }

  async function loadOcr() {
    if (ocrCache !== null) return
    try {
      ocrCache = new Map(Object.entries(JSON.parse(await readFile(ocrPath, 'utf8'))))
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: unreadable OCR cache %s: %s', ocrPath, error)
      ocrCache = new Map()
    }
  }

  function saveOcr() {
    while (ocrCache.size > OCR_CACHE_MAX) ocrCache.delete(ocrCache.keys().next().value)
    const snapshot = JSON.stringify(Object.fromEntries(ocrCache))
    ocrWriting = ocrWriting.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${ocrPath}.${process.pid}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, ocrPath)
    }).catch(error => rt.warn('ds-bot: OCR cache write failed: %s', error))
  }

  // `sessionId` is the Session the reading is for; its usage counts there.
  async function readImage(attachment, sessionId) {
    const route = await ocrRoute()
    if (route === undefined) throw new Error('no vision model is available')
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      sessionId,
      messages: rt.tagUsage([{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: OCR_PROMPT }] }], { sessionId, kind: 'image' }),
      maxTokens: 8192,
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind)
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (text === '') throw new Error('the vision model returned no text')
    const model = (await rt.catalog()).find(entry => entry.ref === route.ref)?.name ?? route.model
    return { text, model }
  }

  // Resolves to the cached reading, or to null when the image cannot be read now.
  async function imageReading(attachment, sessionId) {
    const id = String(attachment.attachmentId)
    if (ocrCache.has(id)) return ocrCache.get(id)
    const failed = ocrFailed.get(id)
    if (failed && Date.now() - failed.at < OCR_RETRY_MS) return null
    if (!ocrPending.has(id)) {
      ocrPending.set(id, readImage(attachment, sessionId).then((reading) => {
        ocrCache.set(id, reading)
        ocrFailed.delete(id)
        saveOcr()
        return reading
      }, (error) => {
        rt.warn('ds-bot: could not read image %s: %s', id, error)
        ocrFailed.set(id, { at: Date.now() })
        return null
      }).finally(() => ocrPending.delete(id)))
    }
    return ocrPending.get(id)
  }

  // The store and the file sandbox, read once per call: either can be absent (a deployment without
  // attachments, a test), and `attachmentFilePath` then falls back to the local object layout.
  const attachmentServices = () => ({ home, attachments: ctx.get('attachments'), fs: ctx.get('fs') })

  // `path` is set only when the reading failed and the bytes really are on disk: the placeholder then
  // tells the Bot where to find them, which is the point of #779.
  function imageAsText(attachment, reading, path) {
    const label = imageLabel(attachment)
    return {
      type: 'text',
      text: reading === null
        ? imagePlaceholder(attachment, { path })
        : `[Image ${label}. You cannot see images, so ${reading.model} read it for you:]\n${reading.text}\n[End of image ${label}]`,
    }
  }

  // Members read the group as text, so a picture posted there reaches every member,
  // vision model or not, as its reading.
  async function imagesForGroup(attachments, sessionId) {
    await loadOcr()
    return Promise.all(attachments.map(async (attachment) => {
      const reading = await imageReading(attachment, sessionId)
      const label = imageLabel(attachment)
      return reading === null
        ? imagePlaceholder(attachment, { path: await attachmentFilePath(attachment, attachmentServices()), group: true })
        : `[Image ${label}, read by ${reading.model}:]\n${reading.text}\n[End of image ${label}]`
    }))
  }

  async function withImagesAsText(messages, sessionId) {
    await loadOcr()
    const images = new Map()
    for (const message of messages) {
      if (!liveImages(message)) continue
      for (const block of message.content) {
        if (block?.type === 'image' && !block.offloaded) images.set(String(block.attachment.attachmentId), block.attachment)
      }
    }
    const resolved = new Map(await Promise.all([...images].map(async ([id, attachment]) => {
      const reading = await imageReading(attachment, sessionId)
      // The path is worth looking up only when the reading failed; readable text needs none.
      const path = reading === null ? await attachmentFilePath(attachment, attachmentServices()) : undefined
      return [id, { reading, path }]
    })))
    return messages.map(message => (liveImages(message)
      ? {
          ...message,
          content: message.content.map(block => {
            if (block?.type !== 'image' || block.offloaded) return block
            const { reading, path } = resolved.get(String(block.attachment.attachmentId))
            return imageAsText(block.attachment, reading, path)
          }),
        }
      : message))
  }

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || rt.ownRequest(options) || !(options.messages ?? []).some(liveImages)) return next()
    return (async function* imagesAsTextOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) !== undefined || await readsImages(options.provider, options.model)) {
        yield* next()
        return
      }
      // `next` cannot take new messages, so the rewritten request starts over; it
      // carries no image, so this listener lets it through.
      yield* ctx.llm.stream({ ...options, messages: await withImagesAsText(options.messages, options.sessionId) })
    })()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !agent?.session || !rt.isBotSession(agent.id) || rt.readOnly() !== undefined) return
    const beforeSeq = agent.session.seq
    setImmediate(() => {
      void (async () => {
        try {
          if (!ctx.sessions.messageProjections.some(projection => projection.type === 'image/offload')) return
          const targets = offloadTargets(agent.session, beforeSeq)
          if (targets.length === 0) return
          agent.session.append('image/offload', { targets })
          await ctx.sessions.flush(agent.session)
        } catch (error) {
          rt.warn('ds-bot: old images for %s not offloaded: %s', agent.id, error)
        }
      })()
    })
  })

  Object.assign(rt, { imagesForGroup })
}
