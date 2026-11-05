import { createSource } from '../observable-source.js'

// This is a projection over authenticated Project APIs, not a Harness service.
// No arbitrary Session id, endpoint or owner credential can enter this binding.
export function createScopedConversation(api) {
  const state = createSource({ messages: [], live: null, binding: null })
  let binding, generation = 0, disposed = false, pending
  const clear = () => state.set({ messages: [], live: null, binding: null })
  async function refresh(earlier = false) {
    if (disposed || !binding) return
    if (pending) return pending
    const captured = generation, selected = binding
    const previous = state.getSnapshot()
    if (earlier && (!selected.personalId || !previous.hasMore || !Number.isInteger(previous.beforeSeq))) return
    const request = (async () => {
      try {
        const value = await api.call(selected.personalId ? 'personal-space' : selected.roomId ? 'project-room-read' : 'project-agent-history', selected.personalId ? { operation: 'read', id: selected.personalId, ...(selected.personalPart ? { partId: selected.personalPart } : {}), ...(earlier ? { beforeSeq: previous.beforeSeq } : {}) } : selected)
        if (disposed || captured !== generation) return
        const incoming = Array.isArray(value.messages) ? value.messages : []
        const retained = selected.personalId ? previous.messages : []
        const messages = selected.personalId ? [...new Map((earlier ? [...incoming, ...retained] : [...retained, ...incoming]).map(message => [message.id, message])).values()] : incoming
        const tools = selected.personalId ? [...new Map((earlier ? [...(value.tools ?? []), ...(previous.tools ?? [])] : [...(previous.tools ?? []), ...(value.tools ?? [])]).map(tool => [tool.id, tool])).values()].slice(-100) : value.tools
        const paged = selected.personalId && !earlier && retained.length > 0
        state.set({ ...value, messages, tools, ...(paged ? { hasMore: previous.hasMore, beforeSeq: previous.beforeSeq } : {}), binding: selected })
      } catch (error) {
        if (!disposed && captured === generation) { clear(); throw error }
      }
    })()
    pending = request
    try { return await request } finally { if (pending === request) pending = undefined }
  }
  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    async open(value) {
      if (disposed) throw new Error('Conversation is disposed')
      if (value?.personalId && (typeof value.personalId !== 'string' || value.projectId || value.roomId || value.visibility)) throw new Error('Personal and Project bindings must be separate')
      if (!value?.personalId && (!value?.projectId || Boolean(value.roomId) === Boolean(value.visibility) || value.visibility && !['private', 'public'].includes(value.visibility))) throw new Error('Conversation requires a Project and exactly one room or visibility')
      binding = Object.freeze(value.personalId ? { personalId: value.personalId, ...(value.personalPart ? { personalPart: String(value.personalPart) } : {}) } : value.roomId ? { projectId: value.projectId, roomId: value.roomId } : { projectId: value.projectId, visibility: value.visibility })
      generation++; pending = undefined; clear()
      return refresh()
    },
    // Like the native uiConversation target, this handle belongs to one opened
    // Session. A retained composer must never retarget itself after navigation.
    chat() {
      const selected = binding, captured = generation
      const control = async (operation, args = {}) => {
        if (disposed || !selected || captured !== generation) throw new Error('Conversation handle is retired')
        if (!selected.personalId || selected.personalPart) throw new Error('Controls require the current personal conversation')
        const result = await api.call('personal-space', { operation, id: selected.personalId, ...args })
        if (!disposed && captured === generation) await refresh()
        return result
      }
      return {
        async readAttachment(file) {
          if (disposed || !selected || captured !== generation) throw new Error('Conversation handle is retired')
          let value
          if (selected.personalId && file.feishuAppId) { const result = await api.call('feishu', { operation: 'attachment', appId: file.feishuAppId, attachmentId: file.id }); value = { ...file, data: result.content_base64 } }
          else if (selected.personalId) value = await api.call('personal-space', { operation: 'attachment-read', id: selected.personalId, ...(selected.personalPart ? { partId: selected.personalPart } : {}), seq: file.seq, attachmentId: file.id })
          else if (selected.roomId) value = await api.call('project-room-attachment', { projectId: selected.projectId, roomId: selected.roomId, attachmentId: file.id })
          else throw new Error('Attachment is unavailable in this conversation')
          if (disposed || captured !== generation) throw new Error('Conversation handle is retired')
          return value
        },
        stop: () => control('stop'),
        stopMember: botId => control('member-stop', { botId }),
        answerQuestion: (questionId, answer) => control('answer', { questionId, answer }),
        dismissQuestion: questionId => control('dismiss', { questionId }),
        answerApproval: (approvalId, choice) => control('approval', { approvalId, choice }),
        async send(text, options) {
          if (disposed || !selected || captured !== generation) throw new Error('Conversation handle is retired')
          if (selected.personalPart) throw new Error('Cannot send to a historical conversation part')
          if (typeof text !== 'string' || !text.trim() && !options?.images?.length && !options?.files?.length) throw new Error('Message is empty')
          const endpoint = selected.personalId ? 'personal-space' : selected.roomId ? 'project-room-message' : 'project-agent-message'
          const payload = selected.personalId ? { operation: 'send', id: selected.personalId, text } : { ...selected, text }
          if (options?.attachmentIds?.length) {
            if (!selected.roomId || !Array.isArray(options.attachmentIds) || options.attachmentIds.some(id => typeof id !== 'string')) throw new Error('Attachments require a registered room document')
            payload.attachmentIds = [...new Set(options.attachmentIds)]
          }
          if (options?.images?.length) {
            if (!selected.personalId) throw new Error('Native images require a personal Bot conversation')
            payload.images = options.images.map(({ name, mediaType, data }) => ({ name, mediaType, data }))
          }
          if (options?.files?.length) {
            if (!selected.personalId) throw new Error('Native files require a personal conversation')
            payload.files = options.files.map(({ name, data }) => ({ name, data }))
          }
          await api.call(endpoint, payload)
          if (!disposed && captured === generation) await refresh()
        },
      }
    },
    refresh: () => refresh(),
    loadEarlier: () => refresh(true),
    dispose() { disposed = true; generation++; binding = undefined; pending = undefined; clear() },
  }
}
